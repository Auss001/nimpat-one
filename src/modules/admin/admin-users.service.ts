import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, RoleCode, UserStatus, UserType } from '@prisma/client';
import { generateToken, hashPassword } from '../../common/utils/crypto';
import { pageArgs, paginate } from '../../common/dto/pagination.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { AuthUser } from '../access/auth-user';
import { GRANTABLE_BY, P } from '../access/permissions';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { AssignRoleDto, CreateStaffDto, UpdateUserStatusDto, UserQueryDto } from './admin-users.dto';

@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
  ) {}

  async list(actor: AuthUser, q: UserQueryDto) {
    // Managers see the staff of their own divisions; only group staff admins see everyone.
    const staffScope = q.type === UserType.STAFF && !actor.hasAny(P.staffManage) ? actor.divisionFilter(P.rolesAssign) : undefined;
    const where: Prisma.UserWhereInput = {
      type: q.type,
      roles: staffScope ? { some: { divisionId: { in: staffScope } } } : undefined,
      OR: q.q
        ? [
            { email: { contains: q.q, mode: 'insensitive' } },
            { phone: { contains: q.q } },
            { customerProfile: { OR: [{ firstName: { contains: q.q, mode: 'insensitive' } }, { lastName: { contains: q.q, mode: 'insensitive' } }] } },
            { staffProfile: { OR: [{ firstName: { contains: q.q, mode: 'insensitive' } }, { lastName: { contains: q.q, mode: 'insensitive' } }] } },
          ]
        : undefined,
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...pageArgs(q),
        select: {
          id: true, email: true, phone: true, type: true, status: true, emailVerifiedAt: true, lastLoginAt: true, createdAt: true,
          customerProfile: { select: { firstName: true, lastName: true } },
          staffProfile: { select: { firstName: true, lastName: true, employeeNumber: true, jobTitle: true, departmentId: true } },
          roles: { select: { id: true, divisionId: true, role: { select: { code: true, name: true } }, division: { select: { id: true, name: true, slug: true } } } },
        },
      }),
      this.prisma.user.count({ where }),
    ]);
    return paginate(rows, total, q);
  }

  async get(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true, email: true, phone: true, type: true, status: true, emailVerifiedAt: true, lastLoginAt: true, createdAt: true,
        customerProfile: true,
        staffProfile: { include: { department: true } },
        roles: { include: { role: true, division: { select: { id: true, name: true, code: true } } } },
        loyaltyAccount: true,
      },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async createStaff(actor: AuthUser, dto: CreateStaffDto) {
    await this.assertCanGrant(actor, dto.role, dto.divisionId);
    const exists = await this.prisma.user.findUnique({ where: { email: dto.email }, select: { id: true } });
    if (exists) throw new ConflictException('A user with this email already exists');
    const role = await this.prisma.role.findUniqueOrThrow({ where: { code: dto.role } });

    // Random unusable password; the invitee sets their own via the invite link.
    const passwordHash = await hashPassword(generateToken(32));
    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email: dto.email,
          passwordHash,
          type: UserType.STAFF,
          staffProfile: {
            create: {
              firstName: dto.firstName,
              lastName: dto.lastName,
              employeeNumber: dto.employeeNumber,
              jobTitle: dto.jobTitle,
              departmentId: dto.departmentId,
            },
          },
          roles: { create: { roleId: role.id, divisionId: role.isDivisionScoped ? dto.divisionId : null, grantedById: actor.id } },
        },
      });
      await this.audit.record(
        { actorId: actor.id, action: 'staff.create', entityType: 'user', entityId: created.id, divisionId: dto.divisionId, changes: { role: dto.role } },
        tx,
      );
      return created;
    });
    const inviteLink = await this.auth.sendStaffInvite(user.id, user.email);
    return { ...(await this.get(user.id)), inviteLink };
  }

  /** Issues a new invitation for staff who have never signed in, for example when the link expired. */
  async resendInvite(actor: AuthUser, userId: string) {
    const target = await this.prisma.user.findUnique({ where: { id: userId }, include: { roles: { include: { role: true } } } });
    if (!target || target.type !== UserType.STAFF) throw new NotFoundException('Staff member not found');
    if (target.lastLoginAt) throw new BadRequestException('This person has already signed in, so they do not need an invitation');
    let allowed = false;
    for (const grant of target.roles) {
      allowed = await this.assertCanGrant(actor, grant.role.code, grant.divisionId ?? undefined).then(() => true, () => false);
      if (allowed) break;
    }
    if (!allowed) throw new ForbiddenException('You cannot invite this staff member');
    const inviteLink = await this.auth.sendStaffInvite(target.id, target.email);
    await this.audit.record({ actorId: actor.id, action: 'staff.invite', entityType: 'user', entityId: target.id });
    return { inviteLink };
  }

  async assignRole(actor: AuthUser, userId: string, dto: AssignRoleDto) {
    await this.assertCanGrant(actor, dto.role, dto.divisionId);
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (dto.role !== RoleCode.CUSTOMER && user.type !== UserType.STAFF) {
      throw new BadRequestException('Staff roles can only be granted to staff accounts');
    }
    const role = await this.prisma.role.findUniqueOrThrow({ where: { code: dto.role } });
    const divisionId = role.isDivisionScoped ? dto.divisionId! : null;
    const existing = await this.prisma.userRole.findFirst({ where: { userId, roleId: role.id, divisionId } });
    if (existing) return existing;
    const grant = await this.prisma.userRole.create({ data: { userId, roleId: role.id, divisionId, grantedById: actor.id } });
    this.access.invalidate(userId);
    await this.audit.record({ actorId: actor.id, action: 'role.assign', entityType: 'user', entityId: userId, divisionId, changes: { role: dto.role } });
    return grant;
  }

  async revokeRole(actor: AuthUser, userId: string, userRoleId: string) {
    const grant = await this.prisma.userRole.findFirst({ where: { id: userRoleId, userId }, include: { role: true } });
    if (!grant) throw new NotFoundException('Role assignment not found');
    await this.assertCanGrant(actor, grant.role.code, grant.divisionId ?? undefined);
    if (grant.role.code === RoleCode.SUPER_ADMIN) {
      const remaining = await this.prisma.userRole.count({ where: { role: { code: RoleCode.SUPER_ADMIN }, user: { status: UserStatus.ACTIVE } } });
      if (remaining <= 1) throw new BadRequestException('Cannot remove the last active Super Administrator');
    }
    await this.prisma.userRole.delete({ where: { id: grant.id } });
    this.access.invalidate(userId);
    await this.audit.record({ actorId: actor.id, action: 'role.revoke', entityType: 'user', entityId: userId, divisionId: grant.divisionId, changes: { role: grant.role.code } });
    return { ok: true };
  }

  async updateStatus(actor: AuthUser, userId: string, dto: UpdateUserStatusDto) {
    if (userId === actor.id) throw new BadRequestException('You cannot change your own account status');
    const target = await this.prisma.user.findUnique({ where: { id: userId }, include: { roles: { include: { role: true } } } });
    if (!target) throw new NotFoundException('User not found');
    if (target.roles.some((r) => r.role.code === RoleCode.SUPER_ADMIN) && !actor.hasRole(RoleCode.SUPER_ADMIN)) {
      throw new ForbiddenException('Only a Super Administrator can change another administrator');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { status: dto.status } });
      if (dto.status !== UserStatus.ACTIVE) {
        await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
      }
      await this.audit.record(
        { actorId: actor.id, action: 'user.status', entityType: 'user', entityId: userId, changes: { status: dto.status, reason: dto.reason } },
        tx,
      );
    });
    this.access.invalidate(userId);
    return { ok: true };
  }

  listRoles() {
    return this.prisma.role.findMany({ include: { permissions: { include: { permission: true } } }, orderBy: { code: 'asc' } });
  }

  listDepartments() {
    return this.prisma.department.findMany({ include: { division: { select: { id: true, name: true, code: true } } }, orderBy: { name: 'asc' } });
  }

  /**
   * Enforces who may grant what: super admins grant anything; department
   * managers grant Department Staff only within divisions they manage.
   */
  private async assertCanGrant(actor: AuthUser, role: RoleCode, divisionId?: string) {
    const target = await this.prisma.role.findUnique({ where: { code: role } });
    if (!target) throw new BadRequestException('Unknown role');
    if (target.isDivisionScoped && !divisionId) throw new BadRequestException(`${role} requires a divisionId`);
    if (!target.isDivisionScoped && divisionId) throw new BadRequestException(`${role} is a group-wide role; omit divisionId`);

    const allowed = actor.roles.some((r) => GRANTABLE_BY[r.code]?.includes(role));
    if (!allowed) throw new ForbiddenException(`You cannot grant the ${role} role`);
    if (!actor.hasRole(RoleCode.SUPER_ADMIN)) actor.assertCan(P.rolesAssign, divisionId);
  }
}
