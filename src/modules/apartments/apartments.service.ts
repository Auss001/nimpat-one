import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { DivisionCode, ListingStatus, Payment, PaymentPurpose, PaymentStatus, Prisma, RecordVerification, ReservationStatus } from '@prisma/client';
import { AppConfig } from '../../config/app-config.service';
import { pageArgs, paginate } from '../../common/dto/pagination.dto';
import { isExclusionViolation } from '../../common/filters/prisma-exception.filter';
import { addMinutes, formatDateOnly, nightsBetween, parseDateOnly, todayInZone } from '../../common/utils/dates';
import { formatNgn, multiplyMinor } from '../../common/utils/money';
import { businessNumber, withUniqueRetry } from '../../common/utils/references';
import { PrismaService, Tx } from '../../prisma/prisma.service';
import { AuthUser } from '../access/auth-user';
import { P } from '../access/permissions';
import { AuditService } from '../audit/audit.service';
import { DivisionsService } from '../divisions/divisions.service';
import { NotificationsService, NotifyInput } from '../notifications/notifications.service';
import { PayableContext, PayableHandler, PayableRegistry } from '../payments/payable.registry';
import { PaymentSummary } from '../payments/payment-ledger.service';
import { PaymentPolicyService } from '../payments/payment-policy.service';
import {
  AdminReservationQueryDto,
  CreateBlackoutDto,
  CreatePropertyDto,
  CreateReservationDto,
  CreateUnitDto,
  PropertyQueryDto,
  ReservationQueryDto,
  UpdatePropertyDto,
  UpdateUnitDto,
} from './apartments.dto';

/** Reservation states that occupy the calendar (mirrors the DB exclusion constraint). */
const BLOCKING: ReservationStatus[] = [ReservationStatus.HOLD, ReservationStatus.CONFIRMED, ReservationStatus.CHECKED_IN];
const MAX_ADVANCE_DAYS = 540;

const STAFF_TRANSITIONS: Partial<Record<ReservationStatus, ReservationStatus[]>> = {
  HOLD: [ReservationStatus.CONFIRMED, ReservationStatus.CANCELLED], // CONFIRMED: staff approval policy
  CONFIRMED: [ReservationStatus.CHECKED_IN, ReservationStatus.CANCELLED],
  CHECKED_IN: [ReservationStatus.COMPLETED],
};

export interface StayQuote {
  unitId: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  nightlyRateMinor: bigint;
  accommodationMinor: bigint;
  cleaningFeeMinor: bigint;
  cautionDepositMinor: bigint;
  totalMinor: bigint;
  currency: 'NGN';
}

/**
 * Luxury Apartments booking engine.
 *
 *  HOLD (15 min, awaiting payment) → CONFIRMED (payment verified)
 *      → CHECKED_IN → COMPLETED;  HOLD/CONFIRMED → CANCELLED;  HOLD → EXPIRED
 *
 * Double booking is impossible: a PostgreSQL exclusion constraint rejects
 * any overlapping [checkIn, checkOut) range for the same unit among
 * HOLD/CONFIRMED/CHECKED_IN reservations, regardless of concurrency.
 */
@Injectable()
export class ApartmentsService implements OnModuleInit, PayableHandler {
  readonly purpose = PaymentPurpose.APARTMENT_RESERVATION;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly divisions: DivisionsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly payables: PayableRegistry,
    private readonly policies: PaymentPolicyService,
  ) {}

  onModuleInit(): void {
    this.payables.register(this);
  }

  // ---------------------------------------------------------------------------
  // Discovery
  // ---------------------------------------------------------------------------

  async listProperties(q: PropertyQueryDto) {
    const where: Prisma.PropertyWhereInput = {
      status: ListingStatus.ACTIVE,
      city: q.city ? { equals: q.city, mode: 'insensitive' } : undefined,
      location: q.location ? { equals: q.location, mode: 'insensitive' } : undefined,
      units: { some: { status: ListingStatus.ACTIVE, verification: RecordVerification.VERIFIED, maxGuests: q.guests ? { gte: q.guests } : undefined } },
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.property.findMany({
        where,
        orderBy: { name: 'asc' },
        ...pageArgs(q),
        include: {
          // Property-level photo first; otherwise the first photo of any unit.
          images: { orderBy: [{ unitId: { sort: 'asc', nulls: 'first' } }, { sortOrder: 'asc' }], take: 1 },
          units: { where: { status: ListingStatus.ACTIVE, verification: RecordVerification.VERIFIED }, select: { id: true, nightlyRateMinor: true, maxGuests: true, bedrooms: true } },
        },
      }),
      this.prisma.property.count({ where }),
    ]);

    let availableUnitIds: Set<string> | null = null;
    if (q.checkIn && q.checkOut) {
      const { checkIn, checkOut } = this.parseStay(q.checkIn, q.checkOut);
      availableUnitIds = await this.availableUnits(rows.flatMap((p) => p.units.map((u) => u.id)), checkIn, checkOut);
    }
    return paginate(
      rows.map((p) => {
        const units = p.units.filter((u) => (!q.guests || u.maxGuests >= q.guests) && (!availableUnitIds || availableUnitIds.has(u.id)));
        return {
          id: p.id, name: p.name, slug: p.slug, location: p.location, city: p.city, state: p.state, amenities: p.amenities,
          image: p.images[0]?.url ?? null,
          unitCount: p.units.length,
          availableUnitCount: availableUnitIds ? units.length : null,
          nightlyFromMinor: units.length ? units.reduce((m, u) => (u.nightlyRateMinor < m ? u.nightlyRateMinor : m), units[0].nightlyRateMinor) : null,
        };
      }),
      total,
      q,
    );
  }

  async getProperty(slug: string) {
    const property = await this.prisma.property.findFirst({
      where: { slug, status: ListingStatus.ACTIVE },
      include: {
        images: { orderBy: { sortOrder: 'asc' } },
        units: { where: { status: ListingStatus.ACTIVE, verification: RecordVerification.VERIFIED }, orderBy: { nightlyRateMinor: 'asc' }, include: { images: { orderBy: { sortOrder: 'asc' } } } },
      },
    });
    if (!property) throw new NotFoundException('Property not found');
    return property;
  }

  /** Booked/blocked date ranges for a unit, for calendar rendering. */
  async calendar(unitId: string, fromStr: string, toStr: string) {
    const from = parseDateOnly(fromStr, 'from');
    const to = parseDateOnly(toStr, 'to');
    if (to <= from || nightsBetween(from, to) > 400) throw new BadRequestException('Range must be 1–400 days');
    await this.activeUnit(unitId);
    await this.expireHolds({ unitId });
    const [reservations, blackouts] = await Promise.all([
      this.prisma.reservation.findMany({
        where: { unitId, status: { in: BLOCKING }, checkIn: { lt: to }, checkOut: { gt: from } },
        select: { checkIn: true, checkOut: true },
        orderBy: { checkIn: 'asc' },
      }),
      this.prisma.unitBlackout.findMany({ where: { unitId, startDate: { lt: to }, endDate: { gt: from } }, select: { startDate: true, endDate: true } }),
    ]);
    return {
      unitId,
      from: fromStr,
      to: toStr,
      unavailable: [
        ...reservations.map((r) => ({ start: formatDateOnly(r.checkIn), end: formatDateOnly(r.checkOut), type: 'booked' })),
        ...blackouts.map((b) => ({ start: formatDateOnly(b.startDate), end: formatDateOnly(b.endDate), type: 'blocked' })),
      ].sort((a, b) => a.start.localeCompare(b.start)),
    };
  }

  /** Server-side price for a stay plus availability. */
  async quote(unitId: string, checkInStr: string, checkOutStr: string, guests?: number) {
    const unit = await this.activeUnit(unitId);
    const { checkIn, checkOut, nights } = this.parseStay(checkInStr, checkOutStr);
    this.assertStayRules(unit, nights, guests);
    await this.expireHolds({ unitId });
    const available = (await this.availableUnits([unitId], checkIn, checkOut)).has(unitId);
    return { ...this.price(unit, checkIn, checkOut, nights), available };
  }

  // ---------------------------------------------------------------------------
  // Reservations (customer)
  // ---------------------------------------------------------------------------

  async createReservation(user: AuthUser, dto: CreateReservationDto, idempotencyKey?: string) {
    if (idempotencyKey) {
      const prior = await this.prisma.reservation.findUnique({ where: { userId_idempotencyKey: { userId: user.id, idempotencyKey } } });
      if (prior) return this.getForCustomer(user, prior.id);
    }
    const unit = await this.activeUnit(dto.unitId);
    const { checkIn, checkOut, nights } = this.parseStay(dto.checkIn, dto.checkOut);
    this.assertStayRules(unit, nights, dto.guests);

    const blackout = await this.prisma.unitBlackout.findFirst({ where: { unitId: unit.id, startDate: { lt: checkOut }, endDate: { gt: checkIn } } });
    if (blackout) throw new ConflictException('The apartment is unavailable for some of these dates');

    // Free up expired holds on this unit so they do not block the new booking.
    await this.expireHolds({ unitId: unit.id });

    const quote = this.price(unit, checkIn, checkOut, nights);
    const policy = await this.policies.get(unit.property.divisionId, PaymentPurpose.APARTMENT_RESERVATION);
    const depositRequiredMinor = this.policies.depositFor(policy, quote.totalMinor);
    const holdExpiresAt = addMinutes(new Date(), this.config.get('APARTMENT_HOLD_TTL_MINUTES'));
    try {
      const reservation = await withUniqueRetry(() =>
        this.prisma.reservation.create({
          data: {
            reservationNumber: businessNumber(DivisionCode.LUXURY_APARTMENTS),
            unitId: unit.id,
            userId: user.id,
            checkIn,
            checkOut,
            nights,
            guests: dto.guests,
            status: ReservationStatus.HOLD,
            holdExpiresAt,
            nightlyRateMinor: quote.nightlyRateMinor,
            accommodationMinor: quote.accommodationMinor,
            cleaningFeeMinor: quote.cleaningFeeMinor,
            cautionDepositMinor: quote.cautionDepositMinor,
            totalMinor: quote.totalMinor,
            depositRequiredMinor,
            guestNote: dto.guestNote,
            idempotencyKey,
          },
        }),
      );
      await this.audit.record({
        actorId: user.id, action: 'reservation.hold', entityType: 'reservation', entityId: reservation.id,
        divisionId: unit.property.divisionId, changes: { checkIn: dto.checkIn, checkOut: dto.checkOut, totalMinor: quote.totalMinor },
      });
      return this.getForCustomer(user, reservation.id);
    } catch (e) {
      if (isExclusionViolation(e)) throw new ConflictException('Sorry — these dates were just booked. Please choose different dates.');
      throw e;
    }
  }

  async listForCustomer(user: AuthUser, q: ReservationQueryDto) {
    const where: Prisma.ReservationWhereInput = { userId: user.id, status: q.status };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.reservation.findMany({ where, orderBy: { checkIn: 'desc' }, ...pageArgs(q), include: reservationInclude }),
      this.prisma.reservation.count({ where }),
    ]);
    return paginate(rows, total, q);
  }

  async getForCustomer(user: AuthUser, id: string) {
    const r = await this.prisma.reservation.findFirst({ where: { id, userId: user.id }, include: { ...reservationInclude, payments: paymentSelect } });
    if (!r) throw new NotFoundException('Reservation not found');
    return r;
  }

  async cancelByCustomer(user: AuthUser, id: string, reason?: string) {
    const r = await this.prisma.reservation.findFirst({ where: { id, userId: user.id }, include: { unit: { include: { property: true } } } });
    if (!r) throw new NotFoundException('Reservation not found');
    if (r.status === ReservationStatus.HOLD && r.amountPaidMinor > 0n) {
      throw new BadRequestException('A payment has been received for this hold. Please contact Nimpat Luxury Apartments to cancel.');
    }
    if (r.status === ReservationStatus.HOLD) {
      await this.transition(r.id, ReservationStatus.HOLD, ReservationStatus.CANCELLED, user.id, reason ?? 'Cancelled by guest');
      return this.getForCustomer(user, id);
    }
    if (r.status === ReservationStatus.CONFIRMED) {
      // Paid stays need the refund policy applied by staff (not yet automated).
      throw new BadRequestException('This reservation is paid. Please contact Nimpat Luxury Apartments to cancel and arrange any refund.');
    }
    throw new BadRequestException(`A ${r.status.toLowerCase()} reservation cannot be cancelled`);
  }

  // ---------------------------------------------------------------------------
  // Admin
  // ---------------------------------------------------------------------------

  async adminListReservations(user: AuthUser, q: AdminReservationQueryDto) {
    const division = await this.divisions.byCode(DivisionCode.LUXURY_APARTMENTS);
    user.assertCan(P.bookingsRead, division.id);
    const where: Prisma.ReservationWhereInput = {
      status: q.status,
      unitId: q.unitId,
      unit: q.propertyId ? { propertyId: q.propertyId } : undefined,
      checkOut: q.from ? { gt: parseDateOnly(q.from, 'from') } : undefined,
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.reservation.findMany({
        where,
        orderBy: { checkIn: 'asc' },
        ...pageArgs(q),
        include: { ...reservationInclude, user: { select: { id: true, email: true, phone: true, customerProfile: { select: { firstName: true, lastName: true } } } } },
      }),
      this.prisma.reservation.count({ where }),
    ]);
    return paginate(rows, total, q);
  }

  async adminUpdateReservation(user: AuthUser, id: string, to: ReservationStatus, note?: string) {
    const division = await this.divisions.byCode(DivisionCode.LUXURY_APARTMENTS);
    user.assertCan(P.bookingsManage, division.id);
    const r = await this.prisma.reservation.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Reservation not found');
    if (!STAFF_TRANSITIONS[r.status]?.includes(to)) throw new BadRequestException(`Cannot change a reservation from ${r.status} to ${to}`);
    if (to === ReservationStatus.CHECKED_IN && r.checkIn > todayInZone(this.config.get('BUSINESS_TIMEZONE'))) {
      throw new BadRequestException('Guests cannot check in before the arrival date');
    }
    if (r.status === ReservationStatus.HOLD && to === ReservationStatus.CONFIRMED) {
      const policy = await this.policies.get(division.id, PaymentPurpose.APARTMENT_RESERVATION);
      if (policy.confirmationRule !== 'STAFF_APPROVAL') throw new BadRequestException('Reservations are confirmed automatically by verified payment under the current policy');
      if (r.amountPaidMinor < r.depositRequiredMinor || r.amountPaidMinor === 0n && r.depositRequiredMinor > 0n) {
        throw new BadRequestException('The required deposit has not been verified yet');
      }
      await this.prisma.reservation.update({ where: { id }, data: { holdExpiresAt: null, confirmedAt: new Date() } });
    }
    await this.transition(id, r.status, to, user.id, note);
    await this.notifications.notify({
      userId: r.userId,
      type: `reservation.${to.toLowerCase()}`,
      title: `Reservation ${r.reservationNumber}: ${to.replace('_', ' ').toLowerCase()}`,
      body:
        to === ReservationStatus.CANCELLED
          ? `Your reservation ${r.reservationNumber} has been cancelled.${r.status === 'CONFIRMED' ? ' Any refund due will be processed to your original payment method.' : ''}`
          : `Your reservation ${r.reservationNumber} is now ${to.replace('_', ' ').toLowerCase()}.`,
      data: { reservationId: id },
      email: true,
    });
    return this.prisma.reservation.findUniqueOrThrow({ where: { id }, include: reservationInclude });
  }

  async adminListProperties(user: AuthUser) {
    const division = await this.divisions.byCode(DivisionCode.LUXURY_APARTMENTS);
    user.assertCan(P.listingsManage, division.id);
    return this.prisma.property.findMany({ orderBy: { name: 'asc' }, include: { units: { orderBy: { code: 'asc' } }, images: true } });
  }

  async createProperty(user: AuthUser, dto: CreatePropertyDto) {
    const division = await this.divisions.byCode(DivisionCode.LUXURY_APARTMENTS);
    user.assertCan(P.listingsManage, division.id);
    const p = await this.prisma.property.create({ data: { ...dto, divisionId: division.id } });
    await this.audit.record({ actorId: user.id, action: 'property.create', entityType: 'property', entityId: p.id, divisionId: division.id, changes: { ...dto } });
    return p;
  }

  async updateProperty(user: AuthUser, id: string, dto: UpdatePropertyDto) {
    const p = await this.prisma.property.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Property not found');
    user.assertCan(P.listingsManage, p.divisionId);
    const updated = await this.prisma.property.update({ where: { id }, data: dto });
    await this.audit.record({ actorId: user.id, action: 'property.update', entityType: 'property', entityId: id, divisionId: p.divisionId, changes: { ...dto } });
    return updated;
  }

  async createUnit(user: AuthUser, propertyId: string, dto: CreateUnitDto) {
    const p = await this.prisma.property.findUnique({ where: { id: propertyId } });
    if (!p) throw new NotFoundException('Property not found');
    user.assertCan(P.listingsManage, p.divisionId);
    const unit = await this.prisma.apartmentUnit.create({ data: { ...this.unitMoney(dto), propertyId } as Prisma.ApartmentUnitUncheckedCreateInput });
    await this.audit.record({ actorId: user.id, action: 'unit.create', entityType: 'apartment_unit', entityId: unit.id, divisionId: p.divisionId, changes: { ...dto } });
    return unit;
  }

  async updateUnit(user: AuthUser, unitId: string, dto: UpdateUnitDto) {
    const unit = await this.prisma.apartmentUnit.findUnique({ where: { id: unitId }, include: { property: true } });
    if (!unit) throw new NotFoundException('Unit not found');
    user.assertCan(P.listingsManage, unit.property.divisionId);
    const updated = await this.prisma.apartmentUnit.update({ where: { id: unitId }, data: this.unitMoney(dto) as Prisma.ApartmentUnitUpdateInput });
    await this.audit.record({
      actorId: user.id, action: 'unit.update', entityType: 'apartment_unit', entityId: unitId, divisionId: unit.property.divisionId,
      changes: { before: { nightlyRateMinor: unit.nightlyRateMinor, status: unit.status }, after: { ...dto } },
    });
    return updated;
  }

  async addBlackout(user: AuthUser, unitId: string, dto: CreateBlackoutDto) {
    const unit = await this.prisma.apartmentUnit.findUnique({ where: { id: unitId }, include: { property: true } });
    if (!unit) throw new NotFoundException('Unit not found');
    user.assertCan(P.listingsManage, unit.property.divisionId);
    const start = parseDateOnly(dto.startDate, 'startDate');
    const end = parseDateOnly(dto.endDate, 'endDate');
    if (end <= start) throw new BadRequestException('endDate must be after startDate');
    const clash = await this.prisma.reservation.count({
      where: { unitId, status: { in: [ReservationStatus.CONFIRMED, ReservationStatus.CHECKED_IN] }, checkIn: { lt: end }, checkOut: { gt: start } },
    });
    if (clash) throw new ConflictException('There are confirmed reservations in this period');
    const b = await this.prisma.unitBlackout.create({ data: { unitId, startDate: start, endDate: end, reason: dto.reason, createdById: user.id } });
    await this.audit.record({ actorId: user.id, action: 'unit.blackout', entityType: 'apartment_unit', entityId: unitId, divisionId: unit.property.divisionId, changes: { ...dto } });
    return b;
  }

  // ---------------------------------------------------------------------------
  // Jobs & payments
  // ---------------------------------------------------------------------------

  /** Expires holds whose payment window passed (frees the dates). */
  async expireHolds(filter: { unitId?: string } = {}): Promise<number> {
    const stale = await this.prisma.reservation.findMany({
      where: { ...filter, status: ReservationStatus.HOLD, holdExpiresAt: { lt: new Date() } },
      select: { id: true },
      take: 500,
    });
    let count = 0;
    for (const r of stale) {
      const busy = await this.prisma.payment.count({ where: { reservationId: r.id, status: { in: [PaymentStatus.SUCCESS, PaymentStatus.AWAITING_VERIFICATION] } } });
      if (busy) continue;
      if (await this.transition(r.id, ReservationStatus.HOLD, ReservationStatus.EXPIRED, null, 'Hold expired without payment')) count++;
    }
    return count;
  }

  async resolve(reservationId: string, user: AuthUser): Promise<PayableContext> {
    const r = await this.prisma.reservation.findFirst({ where: { id: reservationId, userId: user.id }, include: { unit: { include: { property: true } } } });
    if (!r) throw new NotFoundException('Reservation not found');
    return this.context(r);
  }

  async load(db: Tx | PrismaService, reservationId: string): Promise<PayableContext> {
    const r = await db.reservation.findUnique({ where: { id: reservationId }, include: { unit: { include: { property: true } } } });
    if (!r) throw new NotFoundException('Reservation not found');
    return this.context(r);
  }

  private context(r: Prisma.ReservationGetPayload<{ include: { unit: { include: { property: true } } } }>): PayableContext {
    let acceptsPayments = true;
    let closedReason: string | undefined;
    if (r.status === ReservationStatus.HOLD && r.holdExpiresAt && r.holdExpiresAt < new Date() && r.amountPaidMinor === 0n) {
      acceptsPayments = false;
      closedReason = 'Your hold has expired. Please make a new reservation.';
    } else if (r.status === ReservationStatus.CANCELLED || r.status === ReservationStatus.EXPIRED || r.status === ReservationStatus.COMPLETED) {
      acceptsPayments = false;
      closedReason = `Reservation is ${r.status.toLowerCase()}`;
    }
    return {
      totalDueMinor: r.totalMinor,
      depositRequiredMinor: r.depositRequiredMinor,
      currency: r.currency,
      divisionId: r.unit.property.divisionId,
      userId: r.userId,
      label: r.reservationNumber,
      description: `Reservation ${r.reservationNumber} — ${r.unit.property.name}, ${r.nights} night(s)`,
      payBy: r.status === ReservationStatus.HOLD ? r.holdExpiresAt : null,
      acceptsPayments,
      closedReason,
    };
  }

  /** Keep the dates held while a bank transfer is waiting for verification. */
  async onBankTransferStarted(tx: Tx, reservationId: string, payBy: Date): Promise<void> {
    await tx.reservation.updateMany({ where: { id: reservationId, status: ReservationStatus.HOLD, OR: [{ holdExpiresAt: null }, { holdExpiresAt: { lt: payBy } }] }, data: { holdExpiresAt: payBy } });
  }

  /**
   * Confirms a hold only when the department's rule is met by VERIFIED money:
   * FULL_PAYMENT → paid in full; DEPOSIT_VERIFIED → verified deposit;
   * STAFF_APPROVAL → never automatically (staff confirm in the dashboard).
   */
  async onPaymentStateChanged(tx: Tx, reservationId: string, summary: PaymentSummary, trigger: Payment): Promise<NotifyInput[]> {
    const r = await tx.reservation.findUniqueOrThrow({ where: { id: reservationId }, include: { unit: { include: { property: true } } } });
    if (trigger.status !== PaymentStatus.SUCCESS) return [];
    const policy = await this.policies.get(r.unit.property.divisionId, PaymentPurpose.APARTMENT_RESERVATION, tx);
    const received: NotifyInput = {
      userId: r.userId,
      type: 'reservation.payment_received',
      title: `Payment received for ${r.reservationNumber}`,
      body: `We confirmed ${formatNgn(trigger.amountMinor)}. Outstanding balance: ${formatNgn(summary.outstandingMinor)}.`,
      data: { reservationId: r.id },
    };
    if (r.status === ReservationStatus.CONFIRMED || r.status === ReservationStatus.CHECKED_IN || r.status === ReservationStatus.COMPLETED) return [received];
    if (!this.policies.confirmationMet(policy, summary)) {
      // Keep the hold while a partial/deposit payment is in hand.
      if (r.status === ReservationStatus.HOLD) await tx.reservation.update({ where: { id: r.id }, data: { holdExpiresAt: null } });
      return [received];
    }

    if (r.status === ReservationStatus.HOLD || r.status === ReservationStatus.EXPIRED || r.status === ReservationStatus.CANCELLED) {
      // Late payments re-enter the calendar; the exclusion constraint rejects them if the dates were re-booked.
      await tx.$executeRaw`SAVEPOINT confirm_stay`;
      try {
        await tx.reservation.update({
          where: { id: r.id },
          data: { status: ReservationStatus.CONFIRMED, confirmedAt: new Date(), holdExpiresAt: null, cancelledAt: null },
        });
        await tx.$executeRaw`RELEASE SAVEPOINT confirm_stay`;
      } catch (e) {
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT confirm_stay`;
        if (!isExclusionViolation(e)) throw e;
        await tx.payment.update({ where: { id: trigger.id }, data: { refundStatus: 'PENDING', failureReason: 'Paid after hold expiry; dates no longer available — refund required' } });
        await this.audit.record({ action: 'reservation.late_payment.refund_required', entityType: 'reservation', entityId: r.id, divisionId: trigger.divisionId }, tx);
        return [{
          userId: r.userId,
          type: 'reservation.payment_after_expiry',
          title: `We received your payment for ${r.reservationNumber}`,
          body: `Unfortunately your hold expired and the dates were booked by another guest. A refund of ${formatNgn(trigger.amountMinor)} will be processed.`,
          data: { reservationId: r.id },
          email: true,
        }];
      }
    }
    return [{
      userId: r.userId,
      type: 'reservation.confirmed',
      title: `Reservation ${r.reservationNumber} confirmed`,
      body: `Your stay at ${r.unit.property.name} (${r.unit.name}) from ${formatDateOnly(r.checkIn)} to ${formatDateOnly(r.checkOut)} is confirmed.${summary.outstandingMinor > 0n ? ` Balance due: ${formatNgn(summary.outstandingMinor)}.` : ''} Check-in from ${r.unit.property.checkInTime}.`,
      data: { reservationId: r.id },
      email: true,
    }];
  }

  // ---------------------------------------------------------------------------

  private async transition(id: string, from: ReservationStatus, to: ReservationStatus, actorId: string | null, note?: string): Promise<boolean> {
    const res = await this.prisma.reservation.updateMany({
      where: { id, status: from },
      data: {
        status: to,
        cancelledAt: to === ReservationStatus.CANCELLED || to === ReservationStatus.EXPIRED ? new Date() : undefined,
        cancellationReason: to === ReservationStatus.CANCELLED ? note : undefined,
      },
    });
    if (res.count !== 1) return false;
    if (to === ReservationStatus.CANCELLED || to === ReservationStatus.EXPIRED) {
      await this.prisma.payment.updateMany({ where: { reservationId: id, status: { in: ['INITIALIZED', 'PENDING'] } }, data: { status: 'ABANDONED' } });
    }
    const division = await this.divisions.byCode(DivisionCode.LUXURY_APARTMENTS);
    await this.audit.record({ actorId, action: `reservation.${to.toLowerCase()}`, entityType: 'reservation', entityId: id, divisionId: division.id, changes: { from, to, note } });
    return true;
  }

  private parseStay(checkInStr: string, checkOutStr: string) {
    const checkIn = parseDateOnly(checkInStr, 'checkIn');
    const checkOut = parseDateOnly(checkOutStr, 'checkOut');
    const nights = nightsBetween(checkIn, checkOut);
    if (nights < 1) throw new BadRequestException('checkOut must be after checkIn');
    const today = todayInZone(this.config.get('BUSINESS_TIMEZONE'));
    if (checkIn < today) throw new BadRequestException('checkIn cannot be in the past');
    if (nightsBetween(today, checkIn) > MAX_ADVANCE_DAYS) throw new BadRequestException(`Bookings open ${MAX_ADVANCE_DAYS} days in advance`);
    return { checkIn, checkOut, nights };
  }

  private assertStayRules(unit: { minNights: number; maxNights: number; maxGuests: number }, nights: number, guests?: number) {
    if (nights < unit.minNights) throw new BadRequestException(`Minimum stay is ${unit.minNights} night(s)`);
    if (nights > unit.maxNights) throw new BadRequestException(`Maximum stay is ${unit.maxNights} nights`);
    if (guests && guests > unit.maxGuests) throw new BadRequestException(`This apartment sleeps up to ${unit.maxGuests} guests`);
  }

  private price(unit: { id: string; nightlyRateMinor: bigint; cleaningFeeMinor: bigint; cautionDepositMinor: bigint }, checkIn: Date, checkOut: Date, nights: number): StayQuote {
    const accommodationMinor = multiplyMinor(unit.nightlyRateMinor, nights);
    return {
      unitId: unit.id,
      checkIn: formatDateOnly(checkIn),
      checkOut: formatDateOnly(checkOut),
      nights,
      nightlyRateMinor: unit.nightlyRateMinor,
      accommodationMinor,
      cleaningFeeMinor: unit.cleaningFeeMinor,
      cautionDepositMinor: unit.cautionDepositMinor,
      totalMinor: accommodationMinor + unit.cleaningFeeMinor + unit.cautionDepositMinor,
      currency: 'NGN',
    };
  }

  private async availableUnits(unitIds: string[], checkIn: Date, checkOut: Date): Promise<Set<string>> {
    if (!unitIds.length) return new Set();
    const now = new Date();
    const [booked, blocked] = await Promise.all([
      this.prisma.reservation.findMany({
        where: {
          unitId: { in: unitIds },
          checkIn: { lt: checkOut },
          checkOut: { gt: checkIn },
          OR: [
            { status: { in: [ReservationStatus.CONFIRMED, ReservationStatus.CHECKED_IN] } },
            { status: ReservationStatus.HOLD, holdExpiresAt: { gt: now } },
          ],
        },
        select: { unitId: true },
      }),
      this.prisma.unitBlackout.findMany({ where: { unitId: { in: unitIds }, startDate: { lt: checkOut }, endDate: { gt: checkIn } }, select: { unitId: true } }),
    ]);
    const taken = new Set([...booked, ...blocked].map((r) => r.unitId));
    return new Set(unitIds.filter((id) => !taken.has(id)));
  }

  private async activeUnit(unitId: string) {
    const unit = await this.prisma.apartmentUnit.findUnique({ where: { id: unitId }, include: { property: true } });
    if (!unit || unit.status !== ListingStatus.ACTIVE || unit.property.status !== ListingStatus.ACTIVE || unit.verification !== RecordVerification.VERIFIED) {
      throw new NotFoundException('Apartment not found');
    }
    return unit;
  }

  private unitMoney<T extends { nightlyRateMinor?: number; cautionDepositMinor?: number; cleaningFeeMinor?: number }>(dto: T) {
    return {
      ...dto,
      nightlyRateMinor: dto.nightlyRateMinor !== undefined ? BigInt(dto.nightlyRateMinor) : undefined,
      cautionDepositMinor: dto.cautionDepositMinor !== undefined ? BigInt(dto.cautionDepositMinor) : undefined,
      cleaningFeeMinor: dto.cleaningFeeMinor !== undefined ? BigInt(dto.cleaningFeeMinor) : undefined,
    };
  }
}

const reservationInclude = {
  unit: { select: { id: true, code: true, name: true, property: { select: { id: true, name: true, slug: true, city: true, addressLine: true, checkInTime: true, checkOutTime: true } } } },
} satisfies Prisma.ReservationInclude;

const paymentSelect = {
  orderBy: { createdAt: 'desc' as const },
  select: { id: true, reference: true, status: true, amountMinor: true, paidAt: true, refundStatus: true },
};
