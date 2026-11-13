import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { BookingStatus, OrderStatus, ReservationStatus, UserStatus, UserType, FavoriteKind } from '@prisma/client';
import { generateToken, hashPassword, verifyPassword } from '../../common/utils/crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { AuthUser } from '../access/auth-user';
import { ApartmentsService } from '../apartments/apartments.service';
import { AuditService } from '../audit/audit.service';
import { OrdersService } from '../orders/orders.service';
import { ServicesService } from '../services/services.module';
import { SpaService } from '../spa/spa.module';
import { CreateAddressDto, UpdateAddressDto, UpdateProfileDto } from './users.dto';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly orders: OrdersService,
    private readonly apartments: ApartmentsService,
    private readonly spa: SpaService,
    private readonly services: ServicesService,
  ) {}

  /**
   * Account deletion, which Apple and Google require apps with sign-up to offer.
   * Personal details are erased and sign-in stops. Orders and payments stay, with
   * no name attached, because they are financial records.
   */
  async deleteAccount(actor: AuthUser, password?: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.id } });
    if (user.type !== UserType.CUSTOMER) throw new BadRequestException('Staff accounts are closed by an administrator');
    // A guest has no password; holding their own session is the proof.
    if (!user.isGuest && !(password && (await verifyPassword(password, user.passwordHash)))) throw new BadRequestException('The password is not correct');

    // Deleting an account is never blocked (owner, 13 November 2026). Unpaid orders and bookings are let go. Anything
    // paid and still under way stays with the team, who finish or refund it using the details saved on it (the delivery
    // snapshot); the customer is told so, and the audit entry lists those numbers for staff.
    const finished = [OrderStatus.COMPLETED, OrderStatus.CANCELLED, OrderStatus.EXPIRED, OrderStatus.DELIVERED];
    const live = [BookingStatus.REQUESTED, BookingStatus.PENDING, BookingStatus.CONFIRMED, BookingStatus.IN_PROGRESS];
    const waiting: BookingStatus[] = [BookingStatus.REQUESTED, BookingStatus.PENDING];
    const [orders, stays, services, spa] = await Promise.all([
      this.prisma.order.findMany({ where: { userId: user.id, status: { notIn: finished } }, select: { id: true, orderNumber: true, status: true, amountPaidMinor: true } }),
      this.prisma.reservation.findMany({ where: { userId: user.id, groupLeadId: null, status: { in: [ReservationStatus.HOLD, ReservationStatus.CONFIRMED, ReservationStatus.CHECKED_IN] } }, select: { id: true, reservationNumber: true, status: true, amountPaidMinor: true } }),
      this.prisma.serviceBooking.findMany({ where: { userId: user.id, status: { in: live } }, select: { id: true, bookingNumber: true, status: true, amountPaidMinor: true } }),
      this.prisma.spaAppointment.findMany({ where: { userId: user.id, status: { in: live } }, select: { id: true, appointmentNumber: true, status: true, amountPaidMinor: true } }),
    ]);
    const unpaidOrder = (o: (typeof orders)[number]) => o.status === OrderStatus.PENDING && o.amountPaidMinor === 0n;
    const unpaidStay = (r: (typeof stays)[number]) => r.status === ReservationStatus.HOLD && r.amountPaidMinor === 0n;
    const unpaidBooking = (b: { status: BookingStatus; amountPaidMinor: bigint }) => waiting.includes(b.status) && b.amountPaidMinor === 0n;
    const keptForTeam = [
      ...orders.filter((o) => !unpaidOrder(o)).map((o) => o.orderNumber),
      ...stays.filter((r) => !unpaidStay(r)).map((r) => r.reservationNumber),
      ...services.filter((b) => !unpaidBooking(b)).map((b) => b.bookingNumber),
      ...spa.filter((a) => !unpaidBooking(a)).map((a) => a.appointmentNumber),
    ];
    const letGo = async (number: string, cancel: () => Promise<unknown>) => {
      try {
        await cancel();
      } catch {
        keptForTeam.push(number); // e.g. a transfer receipt is waiting to be checked: staff decide
      }
    };
    for (const o of orders.filter(unpaidOrder)) await letGo(o.orderNumber, () => this.orders.cancelByCustomer(actor, o.id));
    for (const r of stays.filter(unpaidStay)) await letGo(r.reservationNumber, () => this.apartments.cancelByCustomer(actor, r.id, 'Account deleted'));
    for (const b of services.filter(unpaidBooking)) await letGo(b.bookingNumber, () => this.services.cancelMine(actor, b.id));
    for (const a of spa.filter(unpaidBooking)) await letGo(a.appointmentNumber, () => this.spa.cancelMine(actor, a.id));

    await this.erase(user.id, user.id, keptForTeam);
    return { ok: true, keptForTeam };
  }

  /**
   * Erases a customer's personal details and stops sign-in. Orders, bookings and payments stay as financial records,
   * with no name attached. Used by the customer themselves and by an administrator deleting customers in bulk.
   */
  async erase(userId: string, actorId: string, keptForTeam: string[] = []) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.type !== UserType.CUSTOMER) throw new BadRequestException('Staff accounts are closed by an administrator');
    const passwordHash = await hashPassword(generateToken(32));
    await this.prisma.$transaction(async (tx) => {
      await tx.cartItem.deleteMany({ where: { cart: { userId: user.id } } });
      await tx.favorite.deleteMany({ where: { userId: user.id } });
      await tx.pushDevice.deleteMany({ where: { userId: user.id } });
      await tx.address.updateMany({ where: { userId: user.id }, data: { deletedAt: new Date(), isDefault: false, recipientName: 'Deleted', phone: '', line1: 'Deleted', line2: null, landmark: null } });
      await tx.customerProfile.updateMany({ where: { userId: user.id }, data: { firstName: 'Deleted', lastName: 'Customer', dateOfBirth: null, marketingOptIn: false } });
      await tx.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.verificationToken.deleteMany({ where: { userId: user.id } });
      await tx.user.update({
        where: { id: user.id },
        data: { email: `deleted-${user.id}@deleted.invalid`, phone: null, contactEmail: null, contactPhone: null, passwordHash, status: UserStatus.DEACTIVATED },
      });
      await this.audit.record({ actorId, action: actorId === user.id ? 'user.delete_account' : 'customer.delete', entityType: 'user', entityId: user.id, changes: keptForTeam.length ? { keptForTeam } : undefined }, tx);
    });
    this.access.invalidate(user.id);
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
  listFavorites(userId: string) {
    return this.prisma.favorite.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 200, select: { kind: true, itemSlug: true, createdAt: true } });
  }

  async addFavorite(userId: string, kind: FavoriteKind, itemSlug: string) {
    await this.prisma.favorite.upsert({ where: { userId_kind_itemSlug: { userId, kind, itemSlug } }, create: { userId, kind, itemSlug }, update: {} });
    return { ok: true };
  }

  async removeFavorite(userId: string, kind: FavoriteKind, itemSlug: string) {
    await this.prisma.favorite.deleteMany({ where: { userId, kind, itemSlug } });
    return { ok: true };
  }

  async deleteAddress(userId: string, id: string) {
    await this.getOwnedAddress(userId, id);
    await this.prisma.address.update({ where: { id }, data: { deletedAt: new Date(), isDefault: false } });
    return { ok: true };
  }
}
