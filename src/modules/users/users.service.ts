import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { BookingStatus, OrderStatus, ReservationStatus, UserStatus, UserType } from '@prisma/client';
import { generateToken, hashPassword, verifyPassword } from '../../common/utils/crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { AuthUser } from '../access/auth-user';
import { AuditService } from '../audit/audit.service';
import { CreateAddressDto, UpdateAddressDto, UpdateProfileDto } from './users.dto';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Account deletion, which Apple and Google require apps with sign-up to offer.
   * Personal details are erased and sign-in stops. Orders and payments stay, with
   * no name attached, because they are financial records.
   */
  async deleteAccount(actor: AuthUser, password: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.id } });
    if (user.type !== UserType.CUSTOMER) throw new BadRequestException('Staff accounts are closed by an administrator');
    if (!(await verifyPassword(password, user.passwordHash))) throw new BadRequestException('The password is not correct');

    const closed = [OrderStatus.COMPLETED, OrderStatus.CANCELLED, OrderStatus.EXPIRED];
    const liveBookings = [BookingStatus.REQUESTED, BookingStatus.PENDING, BookingStatus.CONFIRMED, BookingStatus.IN_PROGRESS];
    const [orders, stays, services, spa] = await Promise.all([
      this.prisma.order.count({ where: { userId: user.id, status: { notIn: closed } } }),
      this.prisma.reservation.count({ where: { userId: user.id, status: { in: [ReservationStatus.HOLD, ReservationStatus.CONFIRMED, ReservationStatus.CHECKED_IN] } } }),
      this.prisma.serviceBooking.count({ where: { userId: user.id, status: { in: liveBookings } } }),
      this.prisma.spaAppointment.count({ where: { userId: user.id, status: { in: liveBookings } } }),
    ]);
    if (orders + stays + services + spa > 0) {
      throw new ConflictException('You have an open order or booking. Please complete or cancel it before deleting your account.');
    }

    const passwordHash = await hashPassword(generateToken(32));
    await this.prisma.$transaction(async (tx) => {
      await tx.cartItem.deleteMany({ where: { cart: { userId: user.id } } });
      await tx.address.updateMany({ where: { userId: user.id }, data: { deletedAt: new Date(), isDefault: false, recipientName: 'Deleted', phone: '', line1: 'Deleted', line2: null, landmark: null } });
      await tx.customerProfile.updateMany({ where: { userId: user.id }, data: { firstName: 'Deleted', lastName: 'Customer', dateOfBirth: null, marketingOptIn: false } });
      await tx.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.verificationToken.deleteMany({ where: { userId: user.id } });
      await tx.user.update({
        where: { id: user.id },
        data: { email: `deleted-${user.id}@deleted.invalid`, phone: null, passwordHash, status: UserStatus.DEACTIVATED },
      });
      await this.audit.record({ actorId: user.id, action: 'user.delete_account', entityType: 'user', entityId: user.id }, tx);
    });
    this.access.invalidate(user.id);
    return { ok: true };
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    if (dto.phone) {
      const taken = await this.prisma.user.findFirst({ where: { phone: dto.phone, id: { not: userId } }, select: { id: true } });
      if (taken) throw new ConflictException('This phone number is already in use');
    }
    return this.prisma.$transaction(async (tx) => {
      if (dto.phone !== undefined) await tx.user.update({ where: { id: userId }, data: { phone: dto.phone } });
      const profileData = {
        firstName: dto.firstName,
        lastName: dto.lastName,
        dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : undefined,
        marketingOptIn: dto.marketingOptIn,
      };
      const existing = await tx.customerProfile.findUnique({ where: { userId } });
      if (existing) return tx.customerProfile.update({ where: { userId }, data: profileData });
      return tx.customerProfile.create({
        data: {
          userId,
          firstName: dto.firstName ?? '',
          lastName: dto.lastName ?? '',
          dateOfBirth: profileData.dateOfBirth,
          marketingOptIn: profileData.marketingOptIn,
        },
      });
    });
  }

  listAddresses(userId: string) {
    return this.prisma.address.findMany({
      where: { userId, deletedAt: null },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async getOwnedAddress(userId: string, id: string) {
    const address = await this.prisma.address.findFirst({ where: { id, userId, deletedAt: null } });
    if (!address) throw new NotFoundException('Address not found');
    return address;
  }

  async createAddress(userId: string, dto: CreateAddressDto) {
    return this.prisma.$transaction(async (tx) => {
      const count = await tx.address.count({ where: { userId, deletedAt: null } });
      if (count >= 20) throw new ConflictException('Address book limit reached (20)');
      const makeDefault = dto.isDefault || count === 0;
      if (makeDefault) await tx.address.updateMany({ where: { userId, isDefault: true }, data: { isDefault: false } });
      return tx.address.create({ data: { ...dto, userId, isDefault: makeDefault } });
    });
  }

  async updateAddress(userId: string, id: string, dto: UpdateAddressDto) {
    await this.getOwnedAddress(userId, id);
    return this.prisma.$transaction(async (tx) => {
      if (dto.isDefault) await tx.address.updateMany({ where: { userId, isDefault: true }, data: { isDefault: false } });
      return tx.address.update({ where: { id }, data: dto });
    });
  }

  /** Soft delete: past orders keep their own address snapshot. */
  async deleteAddress(userId: string, id: string) {
    await this.getOwnedAddress(userId, id);
    await this.prisma.address.update({ where: { id }, data: { deletedAt: new Date(), isDefault: false } });
    return { ok: true };
  }
}
