import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { RoleCode, TokenPurpose, User, UserStatus, UserType } from '@prisma/client';
import { AppConfig } from '../../config/app-config.service';
import { generateToken, hashPassword, sha256, verifyPassword } from '../../common/utils/crypto';
import { currentRequest } from '../../common/request-context';
import { PrismaService, Tx } from '../../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { AuthUser } from '../access/auth-user';
import { AuditService } from '../audit/audit.service';
import { MailService } from '../notifications/mail.service';
import { ChangePasswordDto, LoginDto, RegisterDto, ResetPasswordDto, TokenResponseDto } from './dto/auth.dto';

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  // Used to equalise timing when the email does not exist.
  private dummyHash?: Promise<string>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: AppConfig,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
  ) {}

  // ---------------------------------------------------------------------------
  // Registration & login
  // ---------------------------------------------------------------------------

  async register(dto: RegisterDto) {
    const existing = await this.prisma.user.findFirst({
      where: { OR: [{ email: dto.email }, ...(dto.phone ? [{ phone: dto.phone }] : [])] },
      select: { email: true },
    });
    if (existing) {
      throw new ConflictException(
        existing.email === dto.email
          ? 'An account with this email already exists. Please sign in instead.'
          : 'This phone number is already on another account. Please use a different number, or leave it blank.',
      );
    }

    const passwordHash = await hashPassword(dto.password);
    const customerRole = await this.prisma.role.findUniqueOrThrow({ where: { code: RoleCode.CUSTOMER } });

    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email: dto.email,
          phone: dto.phone,
          passwordHash,
          type: UserType.CUSTOMER,
          customerProfile: {
            create: { firstName: dto.firstName, lastName: dto.lastName, marketingOptIn: dto.marketingOptIn ?? false },
          },
          roles: { create: { roleId: customerRole.id } },
          loyaltyAccount: { create: {} },
        },
      });
      await this.audit.record({ actorId: created.id, action: 'auth.register', entityType: 'user', entityId: created.id }, tx);
      return created;
    });

    await this.sendVerificationEmail(user);
    const tokens = await this.issueSession(user.id);
    return { user: this.publicUser(user), ...tokens };
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (!user) {
      await verifyPassword(dto.password, await this.getDummyHash());
      await this.audit.record({ action: 'auth.login.failed', changes: { reason: 'unknown_email' } });
      throw new UnauthorizedException('Invalid email or password');
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new ForbiddenException('Too many failed attempts. Try again later or reset your password.');
    }

    const ok = await verifyPassword(dto.password, user.passwordHash);
    if (!ok) {
      const failed = user.failedLogins + 1;
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          failedLogins: failed >= MAX_FAILED_LOGINS ? 0 : failed,
          lockedUntil: failed >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCK_MINUTES * 60_000) : undefined,
        },
      });
      await this.audit.record({ actorId: user.id, action: 'auth.login.failed', entityType: 'user', entityId: user.id });
      throw new UnauthorizedException('Invalid email or password');
    }
    if (user.status !== UserStatus.ACTIVE) throw new ForbiddenException('This account is not active');

    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
    await this.audit.record({ actorId: user.id, action: 'auth.login', entityType: 'user', entityId: user.id });
    const tokens = await this.issueSession(user.id);
    return { user: this.publicUser(user), ...tokens };
  }

  /** Refresh-token rotation. Re-use of a rotated token revokes all sessions. */
  async refresh(refreshToken: string): Promise<TokenResponseDto> {
    const hash = sha256(refreshToken);
    const session = await this.prisma.session.findUnique({ where: { refreshTokenHash: hash }, include: { user: true } });
    if (!session) throw new UnauthorizedException('Invalid refresh token');

    if (session.revokedAt) {
      // Token replay: someone is using an already-rotated token. Kill everything.
      await this.prisma.session.updateMany({ where: { userId: session.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      this.access.invalidate(session.userId);
      await this.audit.record({ actorId: session.userId, action: 'auth.refresh.reuse_detected', entityType: 'session', entityId: session.id });
      throw new UnauthorizedException('Refresh token has been revoked');
    }
    if (session.expiresAt < new Date() || session.user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('Session expired');
    }

    // Conditional revoke guards against two concurrent refreshes of one token.
    const revoked = await this.prisma.session.updateMany({
      where: { id: session.id, revokedAt: null },
      data: { revokedAt: new Date(), lastUsedAt: new Date() },
    });
    if (revoked.count !== 1) throw new UnauthorizedException('Refresh token has been revoked');
    return this.issueSession(session.userId, session.id);
  }

  async logout(user: AuthUser) {
    await this.prisma.session.updateMany({ where: { id: user.sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
    this.access.invalidate(user.id);
    await this.audit.record({ actorId: user.id, action: 'auth.logout', entityType: 'session', entityId: user.sessionId });
    return { ok: true };
  }

  async logoutAll(user: AuthUser) {
    const res = await this.prisma.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
    this.access.invalidate(user.id);
    await this.audit.record({ actorId: user.id, action: 'auth.logout_all', entityType: 'user', entityId: user.id });
    return { revokedSessions: res.count };
  }

  // ---------------------------------------------------------------------------
  // Email verification & password reset
  // ---------------------------------------------------------------------------

  async verifyEmail(token: string) {
    const record = await this.consumeToken(token, TokenPurpose.EMAIL_VERIFICATION);
    await this.prisma.user.update({ where: { id: record.userId }, data: { emailVerifiedAt: new Date() } });
    this.access.invalidate(record.userId);
    await this.audit.record({ actorId: record.userId, action: 'auth.email_verified', entityType: 'user', entityId: record.userId });
    return { ok: true };
  }

  async resendVerification(email: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (user && !user.emailVerifiedAt && user.status === UserStatus.ACTIVE) await this.sendVerificationEmail(user);
    // Same response whether or not the account exists (no enumeration).
    return { ok: true };
  }

  async forgotPassword(email: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (user && user.status === UserStatus.ACTIVE) {
      const token = await this.createToken(user.id, TokenPurpose.PASSWORD_RESET, this.config.get('PASSWORD_RESET_TTL_MINUTES') * 60_000);
      const link = `${this.config.get('APP_PUBLIC_URL')}/reset-password?token=${token}`;
      await this.mail.send({
        to: user.email,
        subject: 'Reset your Nimpat One password',
        text: `Use this link to reset your password. It expires in ${this.config.get('PASSWORD_RESET_TTL_MINUTES')} minutes: ${link}`,
        devOnlyDetail: `reset link: ${link}`,
      });
      await this.audit.record({ actorId: user.id, action: 'auth.password_reset.requested', entityType: 'user', entityId: user.id });
    }
    return { ok: true };
  }

  async resetPassword(dto: ResetPasswordDto) {
    const record = await this.consumeToken(dto.token, TokenPurpose.PASSWORD_RESET);
    const passwordHash = await hashPassword(dto.newPassword);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: record.userId },
        // Proving control of the mailbox also verifies the email address.
        data: { passwordHash, failedLogins: 0, lockedUntil: null, emailVerifiedAt: record.user.emailVerifiedAt ?? new Date() },
      });
      await tx.session.updateMany({ where: { userId: record.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit.record({ actorId: record.userId, action: 'auth.password_reset', entityType: 'user', entityId: record.userId }, tx);
    });
    this.access.invalidate(record.userId);
    return { ok: true };
  }

  async changePassword(user: AuthUser, dto: ChangePasswordDto) {
    const record = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (!(await verifyPassword(dto.currentPassword, record.passwordHash))) {
      throw new BadRequestException('Current password is incorrect');
    }
    const passwordHash = await hashPassword(dto.newPassword);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
      // Sign out every other device.
      await tx.session.updateMany({
        where: { userId: user.id, revokedAt: null, id: { not: user.sessionId } },
        data: { revokedAt: new Date() },
      });
      await this.audit.record({ actorId: user.id, action: 'auth.password_changed', entityType: 'user', entityId: user.id }, tx);
    });
    this.access.invalidate(user.id);
    return { ok: true };
  }

  async me(user: AuthUser) {
    const record = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      include: { customerProfile: true, staffProfile: { include: { department: true } }, loyaltyAccount: true },
    });
    return {
      ...this.publicUser(record),
      customerProfile: record.customerProfile,
      staffProfile: record.staffProfile,
      loyalty: record.loyaltyAccount
        ? { pointsBalance: record.loyaltyAccount.pointsBalance, tier: record.loyaltyAccount.tier }
        : null,
      roles: user.roles,
      permissions: Object.fromEntries([...user.permissions.entries()].map(([k, v]) => [k, [...v]])),
    };
  }

  /** Creates a staff invitation token (used by admin staff creation). */
  /**
   * Emails a staff invitation. Returns the link only while no real mail provider
   * is connected, so that an administrator can pass it on; otherwise returns null.
   */
  async sendStaffInvite(userId: string, email: string): Promise<string | null> {
    const token = await this.createToken(userId, TokenPurpose.PASSWORD_RESET, 72 * 3600_000);
    const link = `${this.config.get('ADMIN_PUBLIC_URL')}/reset-password?token=${token}`;
    await this.mail.send({
      to: email,
      subject: 'You have been invited to Nimpat One',
      text: `An account has been created for you. Set your password within 72 hours: ${link}`,
      devOnlyDetail: `invite link: ${link}`,
    });
    return this.config.get('MAIL_TRANSPORT') === 'console' ? link : null;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async issueSession(userId: string, rotatedFromId?: string, tx?: Tx): Promise<TokenResponseDto> {
    const db = tx ?? this.prisma;
    const refreshToken = generateToken(48);
    const ttlDays = this.config.get('REFRESH_TOKEN_TTL_DAYS');
    const expiresAt = new Date(Date.now() + ttlDays * 86_400_000);
    const ctx = currentRequest();
    const session = await db.session.create({
      data: {
        userId,
        refreshTokenHash: sha256(refreshToken),
        expiresAt,
        rotatedFromId,
        ipAddress: ctx?.ip,
        userAgent: ctx?.userAgent,
      },
    });
    const ttl = this.config.get('JWT_ACCESS_TTL_SECONDS');
    const accessToken = await this.jwt.signAsync({ sub: userId, sid: session.id, typ: 'access' }, { expiresIn: ttl });
    return {
      accessToken,
      accessTokenExpiresIn: ttl,
      refreshToken,
      refreshTokenExpiresAt: expiresAt.toISOString(),
      tokenType: 'Bearer',
    };
  }

  private async sendVerificationEmail(user: User) {
    const hours = this.config.get('EMAIL_VERIFICATION_TTL_HOURS');
    const token = await this.createToken(user.id, TokenPurpose.EMAIL_VERIFICATION, hours * 3600_000);
    const link = `${this.config.get('APP_PUBLIC_URL')}/verify-email?token=${token}`;
    await this.mail.send({
      to: user.email,
      subject: 'Verify your Nimpat One email address',
      text: `Welcome to Nimpat One. Confirm your email address within ${hours} hours: ${link}`,
      devOnlyDetail: `verification link: ${link}`,
    });
  }

  private async createToken(userId: string, purpose: TokenPurpose, ttlMs: number): Promise<string> {
    const token = generateToken(32);
    await this.prisma.$transaction([
      // Only the newest token of each purpose stays valid.
      this.prisma.verificationToken.updateMany({ where: { userId, purpose, usedAt: null }, data: { usedAt: new Date() } }),
      this.prisma.verificationToken.create({
        data: { userId, purpose, tokenHash: sha256(token), expiresAt: new Date(Date.now() + ttlMs) },
      }),
    ]);
    return token;
  }

  private async consumeToken(token: string, purpose: TokenPurpose) {
    const record = await this.prisma.verificationToken.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
    if (!record || record.purpose !== purpose || record.usedAt || record.expiresAt < new Date()) {
      throw new BadRequestException('This link is invalid or has expired');
    }
    const used = await this.prisma.verificationToken.updateMany({ where: { id: record.id, usedAt: null }, data: { usedAt: new Date() } });
    if (used.count !== 1) throw new BadRequestException('This link is invalid or has expired');
    return record;
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= hashPassword(generateToken(16));
    return this.dummyHash;
  }

  private publicUser(u: User) {
    return {
      id: u.id,
      email: u.email,
      phone: u.phone,
      type: u.type,
      status: u.status,
      emailVerified: !!u.emailVerifiedAt,
      createdAt: u.createdAt,
    };
  }
}
