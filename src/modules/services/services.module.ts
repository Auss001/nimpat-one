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
import { BookingStatus, Payment, PaymentPurpose, PaymentStatus, Prisma, RecordVerification, ServicePricingType } from '@prisma/client';
import { IsBoolean, IsDateString, IsEnum, IsInt, IsObject, IsOptional, IsString, Length, Matches, Min } from 'class-validator';
import { Authenticated, CurrentUser, Public, RequirePermissions } from '../../common/decorators/auth.decorators';
import { PaginationQueryDto, pageArgs, paginate } from '../../common/dto/pagination.dto';
import { formatNgn } from '../../common/utils/money';
import { businessNumber, withUniqueRetry } from '../../common/utils/references';
import { PrismaService, Tx } from '../../prisma/prisma.service';
import { AuthUser } from '../access/auth-user';
import { P } from '../access/permissions';
import { AuditService } from '../audit/audit.service';
import { MinorAmount } from '../catalog/catalog.dto';
import { DivisionsService } from '../divisions/divisions.service';
import { NotificationsService, NotifyInput } from '../notifications/notifications.service';
import { PayableContext, PayableHandler, PayableRegistry } from '../payments/payable.registry';
import { PaymentSummary } from '../payments/payment-ledger.service';
import { PaymentPolicyService } from '../payments/payment-policy.service';

class CreateOfferingDto {
  @ApiProperty({ example: 'automobiles' }) @IsString() division: string;
  @ApiProperty({ example: 'AUT-SERVICE-MINOR' }) @Matches(/^[A-Z0-9][A-Z0-9-]{2,47}$/) code: string;
  @ApiProperty() @IsString() @Length(2, 120) name: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 3000) description?: string;
  @ApiProperty({ enum: ServicePricingType }) @IsEnum(ServicePricingType) pricingType: ServicePricingType;
  @ApiPropertyOptional({ description: 'kobo' }) @IsOptional() @MinorAmount() @IsInt() @Min(0) basePriceMinor?: number;
  @ApiPropertyOptional({ description: 'kobo' }) @IsOptional() @MinorAmount() @IsInt() @Min(0) depositMinor?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(5) durationMinutes?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
class UpdateOfferingDto extends PartialType(CreateOfferingDto) {}

class CreateBookingDto {
  @ApiProperty() @IsString() offeringId: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() scheduledStart?: string;
  @ApiPropertyOptional({ description: 'Service-specific details, e.g. vehicle make/model/plate' }) @IsOptional() @IsObject() details?: Record<string, unknown>;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 1000) customerNote?: string;
}

class AdminUpdateBookingDto {
  @ApiPropertyOptional({ enum: BookingStatus }) @IsOptional() @IsEnum(BookingStatus) status?: BookingStatus;
  @ApiPropertyOptional() @IsOptional() @IsDateString() scheduledStart?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() scheduledEnd?: string;
  @ApiPropertyOptional({ description: 'Final price in kobo (required before PENDING for quoted services)' })
  @IsOptional() @MinorAmount() @IsInt() @Min(1) priceMinor?: number;
}

class BookingQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() division?: string;
  @ApiPropertyOptional({ enum: BookingStatus }) @IsOptional() @IsEnum(BookingStatus) status?: BookingStatus;
}

const BOOKING_TRANSITIONS: Partial<Record<BookingStatus, BookingStatus[]>> = {
  REQUESTED: ['PENDING', 'CONFIRMED', 'CANCELLED'],
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW'],
  IN_PROGRESS: ['COMPLETED'],
};

/**
 * Generic bookable services for any division: automotive servicing and
 * detailing, media/event equipment rental, interior design consultations,
 * entertainment experiences. Staff confirm, price (if quoted) and request
 * payment (PENDING → purpose SERVICE_BOOKING). The department policy decides
 * whether a verified deposit, full payment or staff approval confirms it.
 */
@Injectable()
export class ServicesService implements OnModuleInit, PayableHandler {
  readonly purpose = PaymentPurpose.SERVICE_BOOKING;

  constructor(
    private readonly prisma: PrismaService,
    private readonly divisions: DivisionsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly payables: PayableRegistry,
    private readonly policies: PaymentPolicyService,
  ) {}

  onModuleInit() {
    this.payables.register(this);
  }

  /** Every offering (active or not) in divisions the user manages. */
  async adminListOfferings(user: AuthUser, division?: string) {
    const where: Prisma.ServiceOfferingWhereInput = {};
    if (division) {
      const d = await this.divisions.resolve(division);
      user.assertCan(P.listingsManage, d.id);
      where.divisionId = d.id;
    } else {
      const allowed = user.divisionFilter(P.listingsManage);
      if (allowed) where.divisionId = { in: allowed };
    }
    return this.prisma.serviceOffering.findMany({
      where,
      orderBy: [{ division: { sortOrder: 'asc' } }, { name: 'asc' }],
      include: { division: { select: { code: true, name: true, slug: true } } },
    });
  }

  async listOfferings(division?: string) {
    const where: Prisma.ServiceOfferingWhereInput = { isActive: true, verification: RecordVerification.VERIFIED };
    if (division) where.divisionId = (await this.divisions.resolve(division)).id;
    return this.prisma.serviceOffering.findMany({ where, orderBy: { name: 'asc' }, include: { division: { select: { code: true, name: true, slug: true } } } });
  }

  async book(user: AuthUser, dto: CreateBookingDto) {
    const offering = await this.prisma.serviceOffering.findFirst({ where: { id: dto.offeringId, isActive: true, verification: RecordVerification.VERIFIED } });
    if (!offering) throw new NotFoundException('Service not found');
    const start = dto.scheduledStart ? new Date(dto.scheduledStart) : undefined;
    if (start && start < new Date()) throw new BadRequestException('scheduledStart must be in the future');
    const division = await this.divisions.byId(offering.divisionId);
    const servicePolicy = await this.policies.get(offering.divisionId, PaymentPurpose.SERVICE_BOOKING);
    const booking = await withUniqueRetry(() =>
      this.prisma.serviceBooking.create({
        data: {
          bookingNumber: businessNumber(division.code, 'S'),
          offeringId: offering.id,
          divisionId: offering.divisionId,
          userId: user.id,
          scheduledStart: start,
          scheduledEnd: start && offering.durationMinutes ? new Date(start.getTime() + offering.durationMinutes * 60_000) : undefined,
          priceMinor: offering.pricingType === ServicePricingType.FIXED ? offering.basePriceMinor : null,
          depositRequiredMinor: offering.pricingType === ServicePricingType.FIXED && offering.basePriceMinor
            ? this.policies.depositFor(servicePolicy, offering.basePriceMinor, offering.depositMinor)
            : 0n,
          details: dto.details as Prisma.InputJsonValue | undefined,
          customerNote: dto.customerNote,
        },
      }),
    );
    await this.audit.record({ actorId: user.id, action: 'service_booking.create', entityType: 'service_booking', entityId: booking.id, divisionId: offering.divisionId });
    return booking;
  }

  async mine(user: AuthUser, q: BookingQueryDto) {
    const where: Prisma.ServiceBookingWhereInput = { userId: user.id, status: q.status };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.serviceBooking.findMany({ where, orderBy: { createdAt: 'desc' }, ...pageArgs(q), include: { offering: { select: { name: true, code: true } } } }),
      this.prisma.serviceBooking.count({ where }),
    ]);
    return paginate(rows, total, q);
  }

  async cancelMine(user: AuthUser, id: string) {
    const res = await this.prisma.serviceBooking.updateMany({
      where: { id, userId: user.id, status: { in: [BookingStatus.REQUESTED, BookingStatus.PENDING] }, amountPaidMinor: 0n },
      data: { status: BookingStatus.CANCELLED },
    });
    if (res.count !== 1) throw new BadRequestException('This booking cannot be cancelled online');
    return { ok: true };
  }

  async adminList(user: AuthUser, q: BookingQueryDto) {
    const where: Prisma.ServiceBookingWhereInput = { status: q.status };
    if (q.division) {
      const d = await this.divisions.resolve(q.division);
      user.assertCan(P.bookingsRead, d.id);
      where.divisionId = d.id;
    } else {
      const allowed = user.divisionFilter(P.bookingsRead);
      if (allowed) where.divisionId = { in: allowed };
    }
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.serviceBooking.findMany({ where, orderBy: { createdAt: 'desc' }, ...pageArgs(q), include: { offering: true, user: { select: { email: true, phone: true } } } }),
      this.prisma.serviceBooking.count({ where }),
    ]);
    return paginate(rows, total, q);
  }

  async adminUpdate(user: AuthUser, id: string, dto: AdminUpdateBookingDto) {
    const b = await this.prisma.serviceBooking.findUnique({ where: { id } });
    if (!b) throw new NotFoundException('Booking not found');
    user.assertCan(P.bookingsManage, b.divisionId);
    if (dto.status && dto.status !== b.status && !BOOKING_TRANSITIONS[b.status]?.includes(dto.status)) {
      throw new BadRequestException(`Cannot move booking from ${b.status} to ${dto.status}`);
    }
    const price = dto.priceMinor !== undefined ? BigInt(dto.priceMinor) : b.priceMinor;
    if (dto.status === BookingStatus.PENDING && !price) throw new BadRequestException('Set priceMinor before requesting payment');
    const offering = await this.prisma.serviceOffering.findUniqueOrThrow({ where: { id: b.offeringId } });
    const policy = await this.policies.get(b.divisionId, PaymentPurpose.SERVICE_BOOKING);
    if (dto.status === BookingStatus.CONFIRMED && policy.confirmationRule !== 'STAFF_APPROVAL' && price && b.amountPaidMinor < (b.depositRequiredMinor || 1n)) {
      throw new BadRequestException('This booking is confirmed by verified payment under the department policy');
    }
    const depositRequiredMinor = price ? this.policies.depositFor(policy, price, offering.depositMinor) : 0n;
    const updated = await this.prisma.serviceBooking.update({
      where: { id },
      data: {
        status: dto.status,
        priceMinor: dto.priceMinor !== undefined ? BigInt(dto.priceMinor) : undefined,
        depositRequiredMinor,
        scheduledStart: dto.scheduledStart ? new Date(dto.scheduledStart) : undefined,
        scheduledEnd: dto.scheduledEnd ? new Date(dto.scheduledEnd) : undefined,
      },
    });
    await this.audit.record({ actorId: user.id, action: 'service_booking.update', entityType: 'service_booking', entityId: id, divisionId: b.divisionId, changes: { ...dto } });
    if (dto.status && dto.status !== b.status) {
      await this.notifications.notify({
        userId: b.userId,
        type: `service_booking.${dto.status.toLowerCase()}`,
        title: `Booking ${b.bookingNumber}: ${dto.status.replace('_', ' ').toLowerCase()}`,
        body: dto.status === BookingStatus.PENDING ? `Your booking is ready for payment of ${formatNgn(price!)}${depositRequiredMinor > 0n ? ` (deposit ${formatNgn(depositRequiredMinor)})` : ''}.` : `Your booking ${b.bookingNumber} is now ${dto.status.replace('_', ' ').toLowerCase()}.`,
        data: { serviceBookingId: id },
        email: true,
      });
    }
    return updated;
  }

  async createOffering(user: AuthUser, dto: CreateOfferingDto) {
    const d = await this.divisions.resolve(dto.division);
    user.assertCan(P.listingsManage, d.id);
    const { division, basePriceMinor, depositMinor, ...rest } = dto;
    return this.prisma.serviceOffering.create({
      data: { ...rest, divisionId: d.id, basePriceMinor: basePriceMinor !== undefined ? BigInt(basePriceMinor) : undefined, depositMinor: depositMinor !== undefined ? BigInt(depositMinor) : undefined },
    });
  }

  async updateOffering(user: AuthUser, id: string, dto: UpdateOfferingDto) {
    const o = await this.prisma.serviceOffering.findUnique({ where: { id } });
    if (!o) throw new NotFoundException('Service not found');
    user.assertCan(P.listingsManage, o.divisionId);
    const { division, basePriceMinor, depositMinor, ...rest } = dto;
    const updated = await this.prisma.serviceOffering.update({
      where: { id },
      data: { ...rest, basePriceMinor: basePriceMinor !== undefined ? BigInt(basePriceMinor) : undefined, depositMinor: depositMinor !== undefined ? BigInt(depositMinor) : undefined },
    });
    await this.audit.record({ actorId: user.id, action: 'service_offering.update', entityType: 'service_offering', entityId: id, divisionId: o.divisionId, changes: { ...dto } });
    return updated;
  }

  async resolve(bookingId: string, user: AuthUser): Promise<PayableContext> {
    const b = await this.prisma.serviceBooking.findFirst({ where: { id: bookingId, userId: user.id }, include: { offering: true } });
    if (!b) throw new NotFoundException('Booking not found');
    return this.context(b);
  }

  async load(db: Tx | PrismaService, bookingId: string): Promise<PayableContext> {
    const b = await db.serviceBooking.findUnique({ where: { id: bookingId }, include: { offering: true } });
    if (!b) throw new NotFoundException('Booking not found');
    return this.context(b);
  }

  private context(b: Prisma.ServiceBookingGetPayload<{ include: { offering: true } }>): PayableContext {
    const priced = !!b.priceMinor && b.status !== BookingStatus.REQUESTED;
    const closed = b.status === BookingStatus.CANCELLED || b.status === BookingStatus.NO_SHOW;
    return {
      totalDueMinor: b.priceMinor ?? 0n,
      depositRequiredMinor: b.depositRequiredMinor,
      currency: 'NGN',
      divisionId: b.divisionId,
      userId: b.userId,
      label: b.bookingNumber,
      description: `${b.offering.name} — ${b.bookingNumber}`,
      acceptsPayments: priced && !closed,
      closedReason: closed ? `Booking is ${b.status.toLowerCase()}` : !priced ? 'This booking has not been priced and accepted yet' : undefined,
    };
  }

  async onPaymentStateChanged(tx: Tx, bookingId: string, summary: PaymentSummary, trigger: Payment): Promise<NotifyInput[]> {
    if (trigger.status !== PaymentStatus.SUCCESS) return [];
    const b = await tx.serviceBooking.findUniqueOrThrow({ where: { id: bookingId }, include: { offering: true } });
    const policy = await this.policies.get(b.divisionId, PaymentPurpose.SERVICE_BOOKING, tx);
    if (this.policies.confirmationMet(policy, summary)) {
      const res = await tx.serviceBooking.updateMany({ where: { id: b.id, status: { in: [BookingStatus.PENDING, BookingStatus.REQUESTED] } }, data: { status: BookingStatus.CONFIRMED } });
      if (res.count === 1) {
        return [{ userId: b.userId, type: 'service_booking.confirmed', title: `Booking ${b.bookingNumber} confirmed`, body: `Payment of ${formatNgn(trigger.amountMinor)} confirmed for ${b.offering.name}. Balance: ${formatNgn(summary.outstandingMinor)}.`, data: { serviceBookingId: b.id }, email: true }];
      }
    }
    return [{ userId: b.userId, type: 'service_booking.payment_received', title: `Payment received for ${b.bookingNumber}`, body: `We confirmed ${formatNgn(trigger.amountMinor)}. Balance: ${formatNgn(summary.outstandingMinor)}.`, data: { serviceBookingId: b.id } }];
  }
}

@ApiTags('Services & Bookings')
@Controller('services')
export class ServicesController {
  constructor(private readonly services: ServicesService) {}

  @Public() @Get()
  @ApiOperation({ summary: 'Bookable services, optionally for one division' })
  list(@Query('division') division?: string) {
    return this.services.listOfferings(division);
  }

  @Authenticated() @Post('bookings')
  @ApiOperation({ summary: 'Request a service booking' })
  book(@CurrentUser() user: AuthUser, @Body() dto: CreateBookingDto) {
    return this.services.book(user, dto);
  }

  @Authenticated() @Get('bookings')
  mine(@CurrentUser() user: AuthUser, @Query() q: BookingQueryDto) {
    return this.services.mine(user, q);
  }

  @Authenticated() @Post('bookings/:id/cancel') @HttpCode(200)
  cancel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.services.cancelMine(user, id);
  }
}

@ApiTags('Admin · Services & Bookings')
@Controller('admin/services')
export class AdminServicesController {
  constructor(private readonly services: ServicesService) {}

  @Get() @RequirePermissions(P.listingsManage)
  @ApiOperation({ summary: 'All services, rentals and listings, including switched-off ones' })
  list(@CurrentUser() user: AuthUser, @Query('division') division?: string) {
    return this.services.adminListOfferings(user, division);
  }

  @Post() @RequirePermissions(P.listingsManage)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateOfferingDto) {
    return this.services.createOffering(user, dto);
  }

  @Patch(':id') @RequirePermissions(P.listingsManage)
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateOfferingDto) {
    return this.services.updateOffering(user, id, dto);
  }

  @Get('bookings') @RequirePermissions(P.bookingsRead)
  bookings(@CurrentUser() user: AuthUser, @Query() q: BookingQueryDto) {
    return this.services.adminList(user, q);
  }

  @Patch('bookings/:id') @RequirePermissions(P.bookingsManage)
  @ApiOperation({ summary: 'Accept, price, schedule or close a booking' })
  updateBooking(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AdminUpdateBookingDto) {
    return this.services.adminUpdate(user, id, dto);
  }
}

@Module({ providers: [ServicesService], controllers: [ServicesController, AdminServicesController] })
export class ServicesModule {}
