import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  OnModuleInit,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { DivisionCode, LogisticsStatus, LogisticsType, Payment, PaymentPurpose, PaymentStatus, Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsDateString, IsEnum, IsInt, IsOptional, IsString, Length, Matches, Min, ValidateNested } from 'class-validator';
import { Authenticated, CurrentUser, Public, RequirePermissions } from '../../common/decorators/auth.decorators';
import { PaginationQueryDto, pageArgs, paginate } from '../../common/dto/pagination.dto';
import { formatNgn } from '../../common/utils/money';
import { trackingNumber, withUniqueRetry } from '../../common/utils/references';
import { PrismaService, Tx } from '../../prisma/prisma.service';
import { AuthUser } from '../access/auth-user';
import { P } from '../access/permissions';
import { AuditService } from '../audit/audit.service';
import { NG_PHONE } from '../auth/dto/auth.dto';
import { MinorAmount } from '../catalog/catalog.dto';
import { DivisionsService } from '../divisions/divisions.service';
import { NotificationsService, NotifyInput } from '../notifications/notifications.service';
import { PayableContext, PayableHandler, PayableRegistry } from '../payments/payable.registry';
import { PaymentSummary } from '../payments/payment-ledger.service';

class LogisticsAddressDto {
  @ApiProperty() @IsString() @Length(2, 120) contactName: string;
  @ApiProperty() @Matches(NG_PHONE) phone: string;
  @ApiProperty() @IsString() @Length(3, 200) line1: string;
  @ApiProperty() @IsString() @Length(2, 80) city: string;
  @ApiProperty() @IsString() @Length(2, 40) state: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 200) landmark?: string;
}

class CreateLogisticsRequestDto {
  @ApiProperty({ enum: LogisticsType }) @IsEnum(LogisticsType) type: LogisticsType;
  @ApiProperty({ type: LogisticsAddressDto }) @ValidateNested() @Type(() => LogisticsAddressDto) origin: LogisticsAddressDto;
  @ApiProperty({ type: LogisticsAddressDto }) @ValidateNested() @Type(() => LogisticsAddressDto) destination: LogisticsAddressDto;
  @ApiProperty() @IsString() @Length(3, 1000) packageDescription: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) weightGrams?: number;
  @ApiPropertyOptional({ description: 'kobo' }) @IsOptional() @MinorAmount() @IsInt() @Min(0) declaredValueMinor?: number;
  @ApiPropertyOptional() @IsOptional() @IsDateString() pickupDate?: string;
}

class QuoteLogisticsDto {
  @ApiProperty({ description: 'kobo' }) @MinorAmount() @IsInt() @Min(1) quotedPriceMinor: number;
}

class ShipmentEventDto {
  @ApiProperty({ enum: LogisticsStatus }) @IsEnum(LogisticsStatus) status: LogisticsStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 120) location?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 500) note?: string;
}

class LogisticsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: LogisticsStatus }) @IsOptional() @IsEnum(LogisticsStatus) status?: LogisticsStatus;
}

const FLOW: Partial<Record<LogisticsStatus, LogisticsStatus[]>> = {
  REQUESTED: ['QUOTED', 'CANCELLED'],
  QUOTED: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PICKED_UP', 'CANCELLED'],
  PICKED_UP: ['IN_TRANSIT', 'DELIVERED'],
  IN_TRANSIT: ['IN_TRANSIT', 'DELIVERED'],
};

/** Transport & Logistics: dispatch requests, staff quotes, payment and tracking events. */
@Injectable()
export class LogisticsService implements OnModuleInit, PayableHandler {
  readonly purpose = PaymentPurpose.LOGISTICS_REQUEST;

  constructor(
    private readonly prisma: PrismaService,
    private readonly divisions: DivisionsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly payables: PayableRegistry,
  ) {}

  onModuleInit() {
    this.payables.register(this);
  }

  async create(user: AuthUser, dto: CreateLogisticsRequestDto) {
    const d = await this.divisions.byCode(DivisionCode.TRANSPORT_LOGISTICS);
    const req = await withUniqueRetry(() =>
      this.prisma.logisticsRequest.create({
        data: {
          trackingNumber: trackingNumber(),
          divisionId: d.id,
          userId: user.id,
          type: dto.type,
          originAddress: { ...dto.origin },
          destinationAddress: { ...dto.destination },
          packageDescription: dto.packageDescription,
          weightGrams: dto.weightGrams,
          declaredValueMinor: dto.declaredValueMinor !== undefined ? BigInt(dto.declaredValueMinor) : undefined,
          pickupDate: dto.pickupDate ? new Date(dto.pickupDate) : undefined,
          events: { create: { status: LogisticsStatus.REQUESTED, note: 'Request received' } },
        },
      }),
    );
    await this.audit.record({ actorId: user.id, action: 'logistics.create', entityType: 'logistics_request', entityId: req.id, divisionId: d.id });
    return req;
  }

  async mine(user: AuthUser, q: LogisticsQueryDto) {
    const where: Prisma.LogisticsRequestWhereInput = { userId: user.id, status: q.status };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.logisticsRequest.findMany({ where, orderBy: { createdAt: 'desc' }, ...pageArgs(q), include: { events: { orderBy: { createdAt: 'asc' } } } }),
      this.prisma.logisticsRequest.count({ where }),
    ]);
    return paginate(rows, total, q);
  }

  /** Public tracking: status timeline only, no personal data. */
  async track(trackingNo: string) {
    const r = await this.prisma.logisticsRequest.findUnique({
      where: { trackingNumber: trackingNo.toUpperCase() },
      select: { trackingNumber: true, type: true, status: true, createdAt: true, events: { orderBy: { createdAt: 'asc' }, select: { status: true, location: true, createdAt: true } } },
    });
    if (!r) throw new NotFoundException('Tracking number not found');
    return r;
  }

  async adminList(user: AuthUser, q: LogisticsQueryDto) {
    const d = await this.divisions.byCode(DivisionCode.TRANSPORT_LOGISTICS);
    user.assertCan(P.logisticsManage, d.id);
    const where = { status: q.status };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.logisticsRequest.findMany({ where, orderBy: { createdAt: 'desc' }, ...pageArgs(q), include: { user: { select: { email: true, phone: true } } } }),
      this.prisma.logisticsRequest.count({ where }),
    ]);
    return paginate(rows, total, q);
  }

  async quote(user: AuthUser, id: string, priceMinor: number) {
    const r = await this.getManaged(user, id);
    if (r.status !== LogisticsStatus.REQUESTED && r.status !== LogisticsStatus.QUOTED) throw new BadRequestException('Request can no longer be re-quoted');
    await this.prisma.$transaction([
      this.prisma.logisticsRequest.update({ where: { id }, data: { status: LogisticsStatus.QUOTED, quotedPriceMinor: BigInt(priceMinor) } }),
      this.prisma.shipmentEvent.create({ data: { logisticsRequestId: id, status: LogisticsStatus.QUOTED, actorId: user.id, note: `Quoted ${formatNgn(BigInt(priceMinor))}` } }),
    ]);
    await this.audit.record({ actorId: user.id, action: 'logistics.quote', entityType: 'logistics_request', entityId: id, divisionId: r.divisionId, changes: { priceMinor } });
    await this.notifications.notify({ userId: r.userId, type: 'logistics.quoted', title: `Quote ready for ${r.trackingNumber}`, body: `Your dispatch quote is ${formatNgn(BigInt(priceMinor))}. Pay in the app to confirm.`, data: { logisticsRequestId: id }, email: true });
    return this.prisma.logisticsRequest.findUniqueOrThrow({ where: { id } });
  }

  async addEvent(user: AuthUser, id: string, dto: ShipmentEventDto) {
    const r = await this.getManaged(user, id);
    if (dto.status !== LogisticsStatus.CANCELLED && !FLOW[r.status]?.includes(dto.status)) {
      throw new BadRequestException(`Cannot move shipment from ${r.status} to ${dto.status}`);
    }
    if (dto.status === LogisticsStatus.CONFIRMED) throw new BadRequestException('Shipments are confirmed by payment');
    await this.prisma.$transaction([
      this.prisma.logisticsRequest.update({ where: { id }, data: { status: dto.status } }),
      this.prisma.shipmentEvent.create({ data: { logisticsRequestId: id, status: dto.status, location: dto.location, note: dto.note, actorId: user.id } }),
    ]);
    await this.audit.record({ actorId: user.id, action: 'logistics.event', entityType: 'logistics_request', entityId: id, divisionId: r.divisionId, changes: { ...dto } });
    return this.track(r.trackingNumber);
  }

  async resolve(id: string, user: AuthUser): Promise<PayableContext> {
    const r = await this.prisma.logisticsRequest.findFirst({ where: { id, userId: user.id } });
    if (!r) throw new NotFoundException('Request not found');
    return this.context(r);
  }

  async load(db: Tx | PrismaService, id: string): Promise<PayableContext> {
    const r = await db.logisticsRequest.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Request not found');
    return this.context(r);
  }

  private context(r: Prisma.LogisticsRequestGetPayload<object>): PayableContext {
    const open = !!r.quotedPriceMinor && r.status !== LogisticsStatus.REQUESTED && r.status !== LogisticsStatus.CANCELLED;
    return {
      totalDueMinor: r.quotedPriceMinor ?? 0n,
      depositRequiredMinor: r.depositRequiredMinor,
      currency: 'NGN',
      divisionId: r.divisionId,
      userId: r.userId,
      label: r.trackingNumber,
      description: `Dispatch ${r.trackingNumber}`,
      acceptsPayments: open,
      closedReason: open ? undefined : r.status === LogisticsStatus.CANCELLED ? 'Request is cancelled' : 'This request has no quote yet',
    };
  }

  async onPaymentStateChanged(tx: Tx, id: string, summary: PaymentSummary, trigger: Payment): Promise<NotifyInput[]> {
    if (trigger.status !== PaymentStatus.SUCCESS) return [];
    const r = await tx.logisticsRequest.findUniqueOrThrow({ where: { id } });
    if (!summary.fullyPaid) {
      return [{ userId: r.userId, type: 'logistics.part_payment', title: `Payment received for ${r.trackingNumber}`, body: `We confirmed ${formatNgn(trigger.amountMinor)}. Balance: ${formatNgn(summary.outstandingMinor)}.`, data: { logisticsRequestId: r.id } }];
    }
    const res = await tx.logisticsRequest.updateMany({ where: { id: r.id, status: LogisticsStatus.QUOTED }, data: { status: LogisticsStatus.CONFIRMED } });
    if (res.count === 1) await tx.shipmentEvent.create({ data: { logisticsRequestId: r.id, status: LogisticsStatus.CONFIRMED, note: `Payment ${trigger.reference} verified` } });
    return [{ userId: r.userId, type: 'logistics.confirmed', title: `Dispatch ${r.trackingNumber} confirmed`, body: `Payment verified. Track your shipment with ${r.trackingNumber}.`, data: { logisticsRequestId: r.id }, email: true }];
  }

  private async getManaged(user: AuthUser, id: string) {
    const r = await this.prisma.logisticsRequest.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Request not found');
    user.assertCan(P.logisticsManage, r.divisionId);
    return r;
  }
}

@ApiTags('Transport & Logistics')
@Controller('logistics')
export class LogisticsController {
  constructor(private readonly logistics: LogisticsService) {}

  @Authenticated() @Post('requests')
  @ApiOperation({ summary: 'Request a parcel dispatch, haulage or move (staff will quote)' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateLogisticsRequestDto) {
    return this.logistics.create(user, dto);
  }

  @Authenticated() @Get('requests')
  mine(@CurrentUser() user: AuthUser, @Query() q: LogisticsQueryDto) {
    return this.logistics.mine(user, q);
  }

  @Public() @Get('track/:trackingNumber')
  @ApiOperation({ summary: 'Public shipment tracking by consignment number (NMP-LOG-XXXXXXXX-NG)' })
  track(@Param('trackingNumber') tn: string) {
    return this.logistics.track(tn);
  }
}

@ApiTags('Admin · Transport & Logistics')
@Controller('admin/logistics')
export class AdminLogisticsController {
  constructor(private readonly logistics: LogisticsService) {}

  @Get('requests') @RequirePermissions(P.logisticsManage)
  list(@CurrentUser() user: AuthUser, @Query() q: LogisticsQueryDto) {
    return this.logistics.adminList(user, q);
  }

  @Post('requests/:id/quote') @RequirePermissions(P.logisticsManage)
  quote(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: QuoteLogisticsDto) {
    return this.logistics.quote(user, id, dto.quotedPriceMinor);
  }

  @Post('requests/:id/events') @RequirePermissions(P.logisticsManage)
  @ApiOperation({ summary: 'Record pickup / transit / delivery events' })
  event(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ShipmentEventDto) {
    return this.logistics.addEvent(user, id, dto);
  }
}

@Module({ providers: [LogisticsService], controllers: [LogisticsController, AdminLogisticsController] })
export class LogisticsModule {}

