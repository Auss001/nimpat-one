import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Injectable,
  Module,
  NotFoundException,
  OnModuleInit,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags, PartialType } from '@nestjs/swagger';
import { BookingStatus, DivisionCode, Payment, PaymentPurpose, PaymentStatus, Prisma, RecordVerification } from '@prisma/client';
import { ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsEnum, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';
import { AppConfig } from '../../config/app-config.service';
import { Authenticated, CurrentUser, Public, RequirePermissions } from '../../common/decorators/auth.decorators';
import { PaginationQueryDto, pageArgs, paginate } from '../../common/dto/pagination.dto';
import { isExclusionViolation } from '../../common/filters/prisma-exception.filter';
import { homeAddressFor } from '../../common/utils/address';
import { addMinutes, parseDateOnly } from '../../common/utils/dates';
import { formatNgn } from '../../common/utils/money';
import { businessNumber, withUniqueRetry } from '../../common/utils/references';
import { PrismaService, Tx } from '../../prisma/prisma.service';
import { AuthUser } from '../access/auth-user';
import { P } from '../access/permissions';
import { AuditService } from '../audit/audit.service';
import { MinorAmount } from '../catalog/catalog.dto';
import { DivisionsService } from '../divisions/divisions.service';
import { NotifyInput } from '../notifications/notifications.service';
import { PayableContext, PayableHandler, PayableRegistry } from '../payments/payable.registry';
import { PaymentSummary } from '../payments/payment-ledger.service';
import { PaymentPolicyService } from '../payments/payment-policy.service';

// Opening hours in Africa/Lagos (UTC+1, no daylight saving).
const OPEN_HOUR = 9;
const CLOSE_HOUR = 19;
const LAGOS_OFFSET_MIN = 60;
const SLOT_STEP_MIN = 30;
const ACTIVE: BookingStatus[] = [BookingStatus.REQUESTED, BookingStatus.PENDING, BookingStatus.CONFIRMED, BookingStatus.IN_PROGRESS];

class CreateTreatmentDto {
  @ApiProperty() @IsString() @Length(2, 120) name: string;
  @ApiProperty() @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) slug: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 3000) description?: string;
  @ApiPropertyOptional({ example: 'Massage' }) @IsOptional() @IsString() category?: string;
  @ApiProperty({ example: 60 }) @IsInt() @Min(15) @Max(480) durationMinutes: number;
  @ApiProperty({ description: 'kobo' }) @MinorAmount() @IsInt() @Min(0) priceMinor: number;
  @ApiPropertyOptional({ description: 'Online deposit in kobo (0 = pay at the spa)' }) @IsOptional() @MinorAmount() @IsInt() @Min(0) depositMinor?: number;
  @ApiPropertyOptional({ description: 'A therapist can come to the customer\'s home' }) @IsOptional() @IsBoolean() homeService?: boolean;
  @ApiPropertyOptional({ description: 'kobo, added to the price for a home visit' }) @IsOptional() @MinorAmount() @IsInt() @Min(0) homeFeeMinor?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
class UpdateTreatmentDto extends PartialType(CreateTreatmentDto) {}

class CreatePractitionerDto {
  @ApiProperty() @IsString() @Length(2, 80) displayName: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 1000) bio?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() staffProfileId?: string;
  @ApiProperty({ type: [String] }) @IsArray() @ArrayMaxSize(100) @IsUUID('all', { each: true }) treatmentIds: string[];
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

class UpdatePractitionerDto extends PartialType(CreatePractitionerDto) {}

class SlotQueryDto {
  @ApiProperty({ example: '2026-12-05' }) @Matches(/^\d{4}-\d{2}-\d{2}$/) date: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() practitionerId?: string;
}

class BookAppointmentDto {
  @ApiProperty() @IsUUID() treatmentId: string;
  @ApiProperty({ example: '2026-12-05T10:00:00+01:00' }) @IsDateString() startsAt: string;
  @ApiPropertyOptional({ description: 'Leave empty for any available therapist' }) @IsOptional() @IsUUID() practitionerId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 500) customerNote?: string;
  @ApiPropertyOptional({ description: 'Have the therapist come to you (treatments offered at home only)' }) @IsOptional() @IsBoolean() atHome?: boolean;
  @ApiPropertyOptional({ description: 'One of your saved addresses, for a home visit' }) @IsOptional() @IsUUID() addressId?: string;
}

class AppointmentQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: BookingStatus }) @IsOptional() @IsEnum(BookingStatus) status?: BookingStatus;
  @ApiPropertyOptional() @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) date?: string;
}

class UpdateAppointmentDto {
  @ApiProperty({ enum: BookingStatus }) @IsEnum(BookingStatus) status: BookingStatus;
}

@Injectable()
export class SpaService implements OnModuleInit, PayableHandler {
  readonly purpose = PaymentPurpose.SPA_APPOINTMENT;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly divisions: DivisionsService,
    private readonly audit: AuditService,
    private readonly payables: PayableRegistry,
    private readonly policies: PaymentPolicyService,
  ) {}

  onModuleInit() {
    this.payables.register(this);
  }

  treatments() {
    return this.prisma.spaTreatment.findMany({ where: { isActive: true, verification: RecordVerification.VERIFIED }, orderBy: [{ category: 'asc' }, { name: 'asc' }] });
  }

  async treatment(slug: string) {
    const t = await this.prisma.spaTreatment.findFirst({
      where: { slug, isActive: true, verification: RecordVerification.VERIFIED },
      include: { practitioners: { where: { practitioner: { isActive: true } }, include: { practitioner: { select: { id: true, displayName: true, bio: true } } } } },
    });
    if (!t) throw new NotFoundException('Treatment not found');
    return { ...t, practitioners: t.practitioners.map((p) => p.practitioner) };
  }

  /** Free start times for a treatment on a Lagos calendar day. */
  async slots(treatmentId: string, dateStr: string, practitionerId?: string) {
    const treatment = await this.activeTreatment(treatmentId);
    const day = parseDateOnly(dateStr);
    const open = new Date(day.getTime() + (OPEN_HOUR * 60 - LAGOS_OFFSET_MIN) * 60_000);
    const close = new Date(day.getTime() + (CLOSE_HOUR * 60 - LAGOS_OFFSET_MIN) * 60_000);
    await this.expireHolds();
    const practitioners = await this.capablePractitioners(treatmentId, practitionerId);
    const busy = await this.prisma.spaAppointment.findMany({
      where: { practitionerId: { in: practitioners.map((p) => p.id) }, status: { in: ACTIVE }, startsAt: { lt: close }, endsAt: { gt: open } },
      select: { practitionerId: true, startsAt: true, endsAt: true },
    });
    const now = Date.now();
    const slots: { startsAt: string; endsAt: string; practitionerIds: string[] }[] = [];
    for (let t = open.getTime(); t + treatment.durationMinutes * 60_000 <= close.getTime(); t += SLOT_STEP_MIN * 60_000) {
      if (t < now + 30 * 60_000) continue;
      const end = t + treatment.durationMinutes * 60_000;
      const free = practitioners.filter((p) => !busy.some((b) => b.practitionerId === p.id && b.startsAt.getTime() < end && b.endsAt.getTime() > t));
      if (free.length) slots.push({ startsAt: new Date(t).toISOString(), endsAt: new Date(end).toISOString(), practitionerIds: free.map((p) => p.id) });
    }
    return { treatmentId, date: dateStr, timezone: 'Africa/Lagos', durationMinutes: treatment.durationMinutes, slots };
  }

  async book(user: AuthUser, dto: BookAppointmentDto) {
    const treatment = await this.activeTreatment(dto.treatmentId);
    const startsAt = new Date(dto.startsAt);
    const endsAt = addMinutes(startsAt, treatment.durationMinutes);
    if (startsAt.getTime() < Date.now() + 30 * 60_000) throw new BadRequestException('Appointments must be booked at least 30 minutes ahead');
    const lagosMinutes = (startsAt.getUTCHours() * 60 + startsAt.getUTCMinutes() + LAGOS_OFFSET_MIN) % 1440;
    const lagosEndMinutes = lagosMinutes + treatment.durationMinutes;
    if (lagosMinutes < OPEN_HOUR * 60 || lagosEndMinutes > CLOSE_HOUR * 60) throw new BadRequestException(`Opening hours are ${OPEN_HOUR}:00–${CLOSE_HOUR}:00`);

    await this.expireHolds();
    const candidates = await this.capablePractitioners(treatment.id, dto.practitionerId);
    if (!candidates.length) throw new ConflictException('No therapist offers this treatment');
    if (dto.atHome && !treatment.homeService) throw new BadRequestException('This treatment is only offered at the spa');
    const homeAddress = dto.atHome ? await homeAddressFor(this.prisma, user.id, dto.addressId) : undefined;
    const homeFeeMinor = dto.atHome ? (treatment.homeFeeMinor ?? 0n) : 0n;
    const priceMinor = treatment.priceMinor + homeFeeMinor;
    const division = await this.divisions.byCode(DivisionCode.SPA_WELLNESS);
    const policy = await this.policies.get(treatment.divisionId, PaymentPurpose.SPA_APPOINTMENT);
    const depositRequiredMinor = this.policies.depositFor(policy, priceMinor, treatment.depositMinor);
    const needsDeposit = depositRequiredMinor > 0n && policy.confirmationRule !== 'STAFF_APPROVAL';

    // Try each capable therapist; the DB exclusion constraint arbitrates races.
    for (const p of candidates) {
      try {
        const appt = await withUniqueRetry(() =>
          this.prisma.spaAppointment.create({
            data: {
              appointmentNumber: businessNumber(division.code),
              treatmentId: treatment.id,
              practitionerId: p.id,
              userId: user.id,
              startsAt,
              endsAt,
              status: needsDeposit ? BookingStatus.PENDING : BookingStatus.REQUESTED,
              priceMinor,
              depositMinor: treatment.depositMinor,
              depositRequiredMinor,
              atHome: !!dto.atHome,
              homeAddress,
              homeFeeMinor,
              customerNote: dto.customerNote,
            },
          }),
        );
        await this.audit.record({ actorId: user.id, action: 'spa_appointment.create', entityType: 'spa_appointment', entityId: appt.id, divisionId: division.id });
        return { ...appt, payBy: needsDeposit ? addMinutes(appt.createdAt, this.config.get('SPA_HOLD_TTL_MINUTES')) : null };
      } catch (e) {
        if (!isExclusionViolation(e)) throw e;
      }
    }
    throw new ConflictException('That time is no longer available. Please pick another slot.');
  }

  async mine(user: AuthUser, q: AppointmentQueryDto) {
    const where: Prisma.SpaAppointmentWhereInput = { userId: user.id, status: q.status };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.spaAppointment.findMany({ where, orderBy: { startsAt: 'desc' }, ...pageArgs(q), include: { treatment: { select: { name: true } }, practitioner: { select: { displayName: true } } } }),
      this.prisma.spaAppointment.count({ where }),
    ]);
    return paginate(rows, total, q);
  }

  async cancelMine(user: AuthUser, id: string) {
    const appt = await this.prisma.spaAppointment.findFirst({ where: { id, userId: user.id } });
    if (!appt) throw new NotFoundException('Appointment not found');
    if (appt.status === BookingStatus.CONFIRMED) throw new BadRequestException('Paid appointments must be cancelled with the spa so the deposit policy can be applied');
    const res = await this.prisma.spaAppointment.updateMany({ where: { id, status: { in: [BookingStatus.REQUESTED, BookingStatus.PENDING] } }, data: { status: BookingStatus.CANCELLED } });
    if (res.count !== 1) throw new BadRequestException('This appointment cannot be cancelled');
    return { ok: true };
  }

  /** Releases unpaid deposit holds after SPA_HOLD_TTL_MINUTES. */
  async expireHolds(): Promise<number> {
    const cutoff = addMinutes(new Date(), -this.config.get('SPA_HOLD_TTL_MINUTES'));
    const stale = await this.prisma.spaAppointment.findMany({ where: { status: BookingStatus.PENDING, createdAt: { lt: cutoff } }, select: { id: true } });
    let n = 0;
    for (const a of stale) {
      if (await this.prisma.payment.count({ where: { spaAppointmentId: a.id, status: { in: [PaymentStatus.SUCCESS, PaymentStatus.AWAITING_VERIFICATION] } } })) continue;
      const res = await this.prisma.spaAppointment.updateMany({ where: { id: a.id, status: BookingStatus.PENDING }, data: { status: BookingStatus.CANCELLED } });
      n += res.count;
    }
    return n;
  }

  // Admin
  async adminAppointments(user: AuthUser, q: AppointmentQueryDto) {
    const d = await this.divisions.byCode(DivisionCode.SPA_WELLNESS);
    user.assertCan(P.bookingsRead, d.id);
    const where: Prisma.SpaAppointmentWhereInput = { status: q.status };
    if (q.date) {
      const day = parseDateOnly(q.date);
      where.startsAt = { gte: addMinutes(day, -LAGOS_OFFSET_MIN), lt: addMinutes(day, 1440 - LAGOS_OFFSET_MIN) };
    }
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.spaAppointment.findMany({ where, orderBy: { startsAt: 'asc' }, ...pageArgs(q), include: { treatment: true, practitioner: true, user: { select: { email: true, isGuest: true, contactEmail: true, contactPhone: true, phone: true } } } }),
      this.prisma.spaAppointment.count({ where }),
    ]);
    return paginate(rows, total, q);
  }

  async adminUpdateAppointment(user: AuthUser, id: string, status: BookingStatus) {
    const d = await this.divisions.byCode(DivisionCode.SPA_WELLNESS);
    user.assertCan(P.bookingsManage, d.id);
    const appt = await this.prisma.spaAppointment.update({ where: { id }, data: { status } });
    await this.audit.record({ actorId: user.id, action: 'spa_appointment.status', entityType: 'spa_appointment', entityId: id, divisionId: d.id, changes: { status } });
    return appt;
  }

  async createTreatment(user: AuthUser, dto: CreateTreatmentDto) {
    const d = await this.divisions.byCode(DivisionCode.SPA_WELLNESS);
    user.assertCan(P.listingsManage, d.id);
    const { homeFeeMinor, ...rest } = dto;
    return this.prisma.spaTreatment.create({ data: { ...rest, priceMinor: BigInt(dto.priceMinor), depositMinor: BigInt(dto.depositMinor ?? 0), homeFeeMinor: homeFeeMinor !== undefined ? BigInt(homeFeeMinor) : undefined, divisionId: d.id } });
  }

  async updateTreatment(user: AuthUser, id: string, dto: UpdateTreatmentDto) {
    const d = await this.divisions.byCode(DivisionCode.SPA_WELLNESS);
    user.assertCan(P.listingsManage, d.id);
    const t = await this.prisma.spaTreatment.update({
      where: { id },
      data: { ...dto, priceMinor: dto.priceMinor !== undefined ? BigInt(dto.priceMinor) : undefined, depositMinor: dto.depositMinor !== undefined ? BigInt(dto.depositMinor) : undefined, homeFeeMinor: dto.homeFeeMinor !== undefined ? BigInt(dto.homeFeeMinor) : undefined },
    });
    await this.audit.record({ actorId: user.id, action: 'spa_treatment.update', entityType: 'spa_treatment', entityId: id, divisionId: d.id, changes: { ...dto } });
    return t;
  }

  async createPractitioner(user: AuthUser, dto: CreatePractitionerDto) {
    const d = await this.divisions.byCode(DivisionCode.SPA_WELLNESS);
    user.assertCan(P.listingsManage, d.id);
    const { treatmentIds, ...data } = dto;
    return this.prisma.spaPractitioner.create({
      data: { ...data, divisionId: d.id, treatments: { create: treatmentIds.map((treatmentId) => ({ treatmentId })) } },
      include: { treatments: true },
    });
  }

  async adminTreatments(user: AuthUser) {
    const d = await this.divisions.byCode(DivisionCode.SPA_WELLNESS);
    user.assertCan(P.listingsManage, d.id);
    return this.prisma.spaTreatment.findMany({
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { practitioners: true } } },
    });
  }

  async adminPractitioners(user: AuthUser) {
    const d = await this.divisions.byCode(DivisionCode.SPA_WELLNESS);
    user.assertCan(P.listingsManage, d.id);
    return this.prisma.spaPractitioner.findMany({
      orderBy: { displayName: 'asc' },
      include: { treatments: { select: { treatmentId: true } } },
    });
  }

  /** Update a therapist; `treatmentIds`, when sent, replaces what they offer. */
  async updatePractitioner(user: AuthUser, id: string, dto: UpdatePractitionerDto) {
    const d = await this.divisions.byCode(DivisionCode.SPA_WELLNESS);
    user.assertCan(P.listingsManage, d.id);
    const { treatmentIds, ...data } = dto;
    const p = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.spaPractitioner.update({ where: { id }, data });
      if (treatmentIds) {
        await tx.spaPractitionerTreatment.deleteMany({ where: { practitionerId: id } });
        await tx.spaPractitionerTreatment.createMany({ data: treatmentIds.map((treatmentId) => ({ practitionerId: id, treatmentId })) });
      }
      return updated;
    });
    await this.audit.record({ actorId: user.id, action: 'spa_practitioner.update', entityType: 'spa_practitioner', entityId: id, divisionId: d.id, changes: { ...dto } });
    return p;
  }

  // PayableHandler — deposit online / balance online or at the spa
  async resolve(id: string, user: AuthUser): Promise<PayableContext> {
    const appt = await this.prisma.spaAppointment.findFirst({ where: { id, userId: user.id }, include: { treatment: true } });
    if (!appt) throw new NotFoundException('Appointment not found');
    return this.context(appt);
  }

  async load(db: Tx | PrismaService, id: string): Promise<PayableContext> {
    const appt = await db.spaAppointment.findUnique({ where: { id }, include: { treatment: true } });
    if (!appt) throw new NotFoundException('Appointment not found');
    return this.context(appt);
  }

  private context(appt: Prisma.SpaAppointmentGetPayload<{ include: { treatment: true } }>): PayableContext {
    const payBy = appt.status === BookingStatus.PENDING && appt.amountPaidMinor === 0n ? addMinutes(appt.createdAt, this.config.get('SPA_HOLD_TTL_MINUTES')) : null;
    let acceptsPayments = true;
    let closedReason: string | undefined;
    if (appt.status === BookingStatus.CANCELLED || appt.status === BookingStatus.NO_SHOW) {
      acceptsPayments = false;
      closedReason = `Appointment is ${appt.status.toLowerCase()}`;
    } else if (payBy && payBy < new Date()) {
      acceptsPayments = false;
      closedReason = 'The hold on this slot has expired. Please book again.';
    }
    return {
      totalDueMinor: appt.priceMinor,
      depositRequiredMinor: appt.depositRequiredMinor,
      currency: 'NGN',
      divisionId: appt.treatment.divisionId,
      userId: appt.userId,
      label: appt.appointmentNumber,
      description: `${appt.treatment.name} — ${appt.appointmentNumber}`,
      payBy,
      acceptsPayments,
      closedReason,
    };
  }

  async onPaymentStateChanged(tx: Tx, id: string, summary: PaymentSummary, trigger: Payment): Promise<NotifyInput[]> {
    if (trigger.status !== PaymentStatus.SUCCESS) return [];
    const appt = await tx.spaAppointment.findUniqueOrThrow({ where: { id }, include: { treatment: true } });
    const policy = await this.policies.get(appt.treatment.divisionId, PaymentPurpose.SPA_APPOINTMENT, tx);
    const received: NotifyInput = {
      userId: appt.userId,
      type: 'spa.payment_received',
      title: `Payment received for ${appt.treatment.name}`,
      body: `We confirmed ${formatNgn(trigger.amountMinor)}. Balance to pay at the spa: ${formatNgn(summary.outstandingMinor)}.`,
      data: { spaAppointmentId: appt.id },
    };
    if (!this.policies.confirmationMet(policy, summary) || appt.status === BookingStatus.CONFIRMED || appt.status === BookingStatus.IN_PROGRESS || appt.status === BookingStatus.COMPLETED) {
      return [received];
    }
    if (appt.status === BookingStatus.PENDING || appt.status === BookingStatus.REQUESTED) {
      await tx.spaAppointment.update({ where: { id: appt.id }, data: { status: BookingStatus.CONFIRMED } });
    } else if (appt.status === BookingStatus.CANCELLED) {
      await tx.$executeRaw`SAVEPOINT spa_late`;
      try {
        await tx.spaAppointment.update({ where: { id: appt.id }, data: { status: BookingStatus.CONFIRMED } });
        await tx.$executeRaw`RELEASE SAVEPOINT spa_late`;
      } catch (e) {
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT spa_late`;
        if (!isExclusionViolation(e)) throw e;
        await tx.payment.update({ where: { id: trigger.id }, data: { refundStatus: 'PENDING', failureReason: 'Slot taken after hold expiry — refund required' } });
        return [{ userId: appt.userId, type: 'spa.deposit_refund', title: 'Your spa slot is no longer available', body: `Your payment of ${formatNgn(trigger.amountMinor)} will be refunded.`, email: true }];
      }
    }
    return [{
      userId: appt.userId,
      type: 'spa.confirmed',
      title: `${appt.treatment.name} confirmed`,
      body: `Your appointment ${appt.appointmentNumber} on ${appt.startsAt.toISOString()} is confirmed. Paid: ${formatNgn(summary.paidMinor)}; balance due at the spa: ${formatNgn(summary.outstandingMinor)}.`,
      data: { spaAppointmentId: appt.id },
      email: true,
    }];
  }

  private async activeTreatment(id: string) {
    const t = await this.prisma.spaTreatment.findFirst({ where: { id, isActive: true, verification: RecordVerification.VERIFIED } });
    if (!t) throw new NotFoundException('Treatment not found');
    return t;
  }

  private capablePractitioners(treatmentId: string, practitionerId?: string) {
    return this.prisma.spaPractitioner.findMany({
      where: { id: practitionerId, isActive: true, treatments: { some: { treatmentId } } },
      orderBy: { displayName: 'asc' },
      select: { id: true, displayName: true },
    });
  }
}

@ApiTags('Spa & Wellness')
@Controller('spa')
export class SpaController {
  constructor(private readonly spa: SpaService) {}

  @Public() @Get('treatments')
  treatments() {
    return this.spa.treatments();
  }

  @Public() @Get('treatments/:slug')
  treatment(@Param('slug') slug: string) {
    return this.spa.treatment(slug);
  }

  @Public() @Get('treatments/:id/slots')
  @ApiOperation({ summary: 'Available start times on a day (Africa/Lagos)' })
  slots(@Param('id', ParseUUIDPipe) id: string, @Query() q: SlotQueryDto) {
    return this.spa.slots(id, q.date, q.practitionerId);
  }

  @Authenticated() @Post('appointments')
  @ApiOperation({ summary: 'Book an appointment (deposit treatments are held pending payment)' })
  book(@CurrentUser() user: AuthUser, @Body() dto: BookAppointmentDto) {
    return this.spa.book(user, dto);
  }

  @Authenticated() @Get('appointments')
  mine(@CurrentUser() user: AuthUser, @Query() q: AppointmentQueryDto) {
    return this.spa.mine(user, q);
  }

  @Authenticated() @Post('appointments/:id/cancel') @HttpCode(200)
  cancel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.spa.cancelMine(user, id);
  }
}

@ApiTags('Admin · Spa & Wellness')
@Controller('admin/spa')
export class AdminSpaController {
  constructor(private readonly spa: SpaService) {}

  @Get('appointments') @RequirePermissions(P.bookingsRead)
  appointments(@CurrentUser() user: AuthUser, @Query() q: AppointmentQueryDto) {
    return this.spa.adminAppointments(user, q);
  }

  @Patch('appointments/:id') @RequirePermissions(P.bookingsManage)
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAppointmentDto) {
    return this.spa.adminUpdateAppointment(user, id, dto.status);
  }

  @Post('treatments') @RequirePermissions(P.listingsManage)
  createTreatment(@CurrentUser() user: AuthUser, @Body() dto: CreateTreatmentDto) {
    return this.spa.createTreatment(user, dto);
  }

  @Patch('treatments/:id') @RequirePermissions(P.listingsManage)
  updateTreatment(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTreatmentDto) {
    return this.spa.updateTreatment(user, id, dto);
  }

  @Get('treatments') @RequirePermissions(P.listingsManage)
  @ApiOperation({ summary: 'All treatments, including switched-off ones' })
  allTreatments(@CurrentUser() user: AuthUser) {
    return this.spa.adminTreatments(user);
  }

  @Get('practitioners') @RequirePermissions(P.listingsManage)
  practitioners(@CurrentUser() user: AuthUser) {
    return this.spa.adminPractitioners(user);
  }

  @Patch('practitioners/:id') @RequirePermissions(P.listingsManage)
  updatePractitioner(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePractitionerDto) {
    return this.spa.updatePractitioner(user, id, dto);
  }

  @Post('practitioners') @RequirePermissions(P.listingsManage)
  createPractitioner(@CurrentUser() user: AuthUser, @Body() dto: CreatePractitionerDto) {
    return this.spa.createPractitioner(user, dto);
  }
}

@Module({ providers: [SpaService], controllers: [SpaController, AdminSpaController], exports: [SpaService] })
export class SpaModule {}
