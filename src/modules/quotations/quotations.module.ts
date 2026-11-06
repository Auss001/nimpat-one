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
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Payment, PaymentPurpose, PaymentStatus, Prisma, QuotationStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsEnum, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min, ValidateNested } from 'class-validator';
import { Authenticated, CurrentUser, RequirePermissions } from '../../common/decorators/auth.decorators';
import { PaginationQueryDto, pageArgs, paginate } from '../../common/dto/pagination.dto';
import { formatNgn, multiplyMinor, sumMinor } from '../../common/utils/money';
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

class RequestQuotationDto {
  @ApiProperty({ example: 'real-estate-interior-design' }) @IsString() division: string;
  @ApiProperty({ example: 'Interior design for 4-bedroom duplex' }) @IsString() @Length(3, 200) subject: string;
  @ApiProperty() @IsString() @Length(10, 5000) requestDetails: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() serviceBookingId?: string;
}

class QuotationItemDto {
  @ApiProperty() @IsString() @Length(1, 300) description: string;
  @ApiProperty() @IsInt() @Min(1) @Max(100000) quantity: number;
  @ApiProperty({ description: 'kobo' }) @MinorAmount() @IsInt() @Min(0) unitPriceMinor: number;
}

class SendQuotationDto {
  @ApiProperty({ type: [QuotationItemDto] })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => QuotationItemDto)
  items: QuotationItemDto[];
  @ApiProperty() @IsDateString() validUntil: string;
}

class QuotationQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: QuotationStatus }) @IsOptional() @IsEnum(QuotationStatus) status?: QuotationStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() division?: string;
}

/**
 * Request-for-quote flow for divisions that cannot price online: real estate
 * & interior design, media/event rentals, wholesale drinks, retail tenders.
 * REQUESTED → (staff) SENT → (customer) ACCEPTED → paid (purpose QUOTATION)
 */
@Injectable()
export class QuotationsService implements OnModuleInit, PayableHandler {
  readonly purpose = PaymentPurpose.QUOTATION;

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

  async request(user: AuthUser, dto: RequestQuotationDto) {
    const d = await this.divisions.resolve(dto.division);
    if (dto.serviceBookingId) {
      const b = await this.prisma.serviceBooking.findFirst({ where: { id: dto.serviceBookingId, userId: user.id, divisionId: d.id } });
      if (!b) throw new BadRequestException('Linked booking not found');
    }
    const q = await withUniqueRetry(() =>
      this.prisma.quotation.create({
        data: { quoteNumber: businessNumber(d.code, 'Q'), divisionId: d.id, userId: user.id, subject: dto.subject, requestDetails: dto.requestDetails, serviceBookingId: dto.serviceBookingId },
      }),
    );
    await this.audit.record({ actorId: user.id, action: 'quotation.request', entityType: 'quotation', entityId: q.id, divisionId: d.id });
    return q;
  }

  async mine(user: AuthUser, q: QuotationQueryDto) {
    await this.expireOverdue();
    const where: Prisma.QuotationWhereInput = { userId: user.id, status: q.status };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.quotation.findMany({ where, orderBy: { createdAt: 'desc' }, ...pageArgs(q), include: { items: { orderBy: { sortOrder: 'asc' } }, division: { select: { name: true, code: true } } } }),
      this.prisma.quotation.count({ where }),
    ]);
    return paginate(rows, total, q);
  }

  async respond(user: AuthUser, id: string, accept: boolean) {
    await this.expireOverdue();
    const res = await this.prisma.quotation.updateMany({
      where: { id, userId: user.id, status: QuotationStatus.SENT },
      data: { status: accept ? QuotationStatus.ACCEPTED : QuotationStatus.REJECTED, respondedAt: new Date() },
    });
    if (res.count !== 1) throw new BadRequestException('Only a sent, unexpired quotation can be accepted or rejected');
    await this.audit.record({ actorId: user.id, action: accept ? 'quotation.accept' : 'quotation.reject', entityType: 'quotation', entityId: id });
    return this.prisma.quotation.findUniqueOrThrow({ where: { id }, include: { items: true } });
  }

  async adminList(user: AuthUser, q: QuotationQueryDto) {
    const where: Prisma.QuotationWhereInput = { status: q.status };
    if (q.division) {
      const d = await this.divisions.resolve(q.division);
      user.assertCan(P.quotationsManage, d.id);
      where.divisionId = d.id;
    } else {
      const allowed = user.divisionFilter(P.quotationsManage);
      if (allowed) where.divisionId = { in: allowed };
    }
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.quotation.findMany({ where, orderBy: { createdAt: 'desc' }, ...pageArgs(q), include: { items: true, user: { select: { email: true, phone: true } } } }),
      this.prisma.quotation.count({ where }),
    ]);
    return paginate(rows, total, q);
  }

  /** Staff prepare line items; the total is always summed on the server. */
  async send(user: AuthUser, id: string, dto: SendQuotationDto) {
    const quote = await this.prisma.quotation.findUnique({ where: { id } });
    if (!quote) throw new NotFoundException('Quotation not found');
    user.assertCan(P.quotationsManage, quote.divisionId);
    if (![QuotationStatus.REQUESTED, QuotationStatus.UNDER_REVIEW, QuotationStatus.SENT].includes(quote.status as any)) {
      throw new BadRequestException(`A ${quote.status} quotation cannot be revised`);
    }
    const validUntil = new Date(dto.validUntil);
    if (validUntil <= new Date()) throw new BadRequestException('validUntil must be in the future');
    const items = dto.items.map((i, idx) => {
      const unit = BigInt(i.unitPriceMinor);
      return { description: i.description, quantity: i.quantity, unitPriceMinor: unit, lineTotalMinor: multiplyMinor(unit, i.quantity), sortOrder: idx };
    });
    const totalMinor = sumMinor(items.map((i) => i.lineTotalMinor));
    if (totalMinor <= 0n) throw new BadRequestException('Quotation total must be greater than zero');
    await this.prisma.$transaction(async (tx) => {
      await tx.quotationItem.deleteMany({ where: { quotationId: id } });
      await tx.quotation.update({
        where: { id },
        data: {
          status: QuotationStatus.SENT, totalMinor, validUntil, preparedById: user.id, sentAt: new Date(), items: { create: items },
          depositRequiredMinor: this.policies.depositFor(await this.policies.get(quote.divisionId, PaymentPurpose.QUOTATION, tx), totalMinor),
        },
      });
      await this.audit.record({ actorId: user.id, action: 'quotation.send', entityType: 'quotation', entityId: id, divisionId: quote.divisionId, changes: { totalMinor } }, tx);
    });
    await this.notifications.notify({ userId: quote.userId, type: 'quotation.sent', title: `Your quotation ${quote.quoteNumber} is ready`, body: `Total: ${formatNgn(totalMinor)}. Valid until ${validUntil.toDateString()}.`, data: { quotationId: id }, email: true });
    return this.prisma.quotation.findUniqueOrThrow({ where: { id }, include: { items: { orderBy: { sortOrder: 'asc' } } } });
  }

  async expireOverdue() {
    await this.prisma.quotation.updateMany({ where: { status: QuotationStatus.SENT, validUntil: { lt: new Date() } }, data: { status: QuotationStatus.EXPIRED } });
  }

  async resolve(id: string, user: AuthUser): Promise<PayableContext> {
    const q = await this.prisma.quotation.findFirst({ where: { id, userId: user.id } });
    if (!q) throw new NotFoundException('Quotation not found');
    return this.context(q);
  }

  async load(db: Tx | PrismaService, id: string): Promise<PayableContext> {
    const q = await db.quotation.findUnique({ where: { id } });
    if (!q) throw new NotFoundException('Quotation not found');
    return this.context(q);
  }

  private context(q: Prisma.QuotationGetPayload<object>): PayableContext {
    const open = q.status === QuotationStatus.ACCEPTED && !!q.totalMinor;
    return {
      totalDueMinor: q.totalMinor ?? 0n,
      depositRequiredMinor: q.depositRequiredMinor,
      currency: q.currency,
      divisionId: q.divisionId,
      userId: q.userId,
      label: q.quoteNumber,
      description: `Quotation ${q.quoteNumber}`,
      acceptsPayments: open,
      closedReason: open ? undefined : 'Accept the quotation before paying',
    };
  }

  async onPaymentStateChanged(_tx: Tx, id: string, summary: PaymentSummary, trigger: Payment): Promise<NotifyInput[]> {
    if (trigger.status !== PaymentStatus.SUCCESS) return [];
    return [{
      userId: trigger.userId,
      type: summary.fullyPaid ? 'quotation.paid' : 'quotation.part_payment',
      title: summary.fullyPaid ? 'Quotation paid in full' : 'Payment received',
      body: `We confirmed ${formatNgn(trigger.amountMinor)}.${summary.fullyPaid ? ' Our team will be in touch.' : ` Balance: ${formatNgn(summary.outstandingMinor)}.`}`,
      data: { quotationId: id },
      email: true,
    }];
  }
}

@ApiTags('Quotations')
@Authenticated()
@Controller('quotations')
export class QuotationsController {
  constructor(private readonly quotations: QuotationsService) {}

  @Post()
  @ApiOperation({ summary: 'Request a quotation from any division' })
  request(@CurrentUser() user: AuthUser, @Body() dto: RequestQuotationDto) {
    return this.quotations.request(user, dto);
  }

  @Get()
  mine(@CurrentUser() user: AuthUser, @Query() q: QuotationQueryDto) {
    return this.quotations.mine(user, q);
  }

  @Post(':id/accept') @HttpCode(200)
  accept(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.quotations.respond(user, id, true);
  }

  @Post(':id/reject') @HttpCode(200)
  reject(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.quotations.respond(user, id, false);
  }
}

@ApiTags('Admin · Quotations')
@Controller('admin/quotations')
export class AdminQuotationsController {
  constructor(private readonly quotations: QuotationsService) {}

  @Get() @RequirePermissions(P.quotationsManage)
  list(@CurrentUser() user: AuthUser, @Query() q: QuotationQueryDto) {
    return this.quotations.adminList(user, q);
  }

  @Post(':id/send') @RequirePermissions(P.quotationsManage)
  @ApiOperation({ summary: 'Price a quotation with line items and send it to the customer' })
  send(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SendQuotationDto) {
    return this.quotations.send(user, id, dto);
  }
}

@Module({ providers: [QuotationsService], controllers: [QuotationsController, AdminQuotationsController], exports: [QuotationsService] })
export class QuotationsModule {}
