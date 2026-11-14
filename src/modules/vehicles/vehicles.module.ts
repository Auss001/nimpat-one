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
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { readSpreadsheet, SpreadsheetError } from '../../common/utils/spreadsheet';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags, PartialType } from '@nestjs/swagger';
import { DivisionCode, InquiryStatus, InquiryType, Payment, PaymentPurpose, PaymentStatus, Prisma, RecordVerification, VehicleCondition, VehicleStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsEmail, IsEnum, IsInt, IsObject, IsOptional, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';
import { Authenticated, CurrentUser, Public, RequirePermissions } from '../../common/decorators/auth.decorators';
import { PaginationQueryDto, pageArgs, paginate } from '../../common/dto/pagination.dto';
import { formatNgn } from '../../common/utils/money';
import { PrismaService, Tx } from '../../prisma/prisma.service';
import { AuthUser } from '../access/auth-user';
import { P } from '../access/permissions';
import { AuditService } from '../audit/audit.service';
import { IsPhone } from '../../common/utils/phone';
import { MinorAmount } from '../catalog/catalog.dto';
import { DivisionsService } from '../divisions/divisions.service';
import { NotifyInput } from '../notifications/notifications.service';
import { PayableContext, PayableHandler, PayableRegistry } from '../payments/payable.registry';
import { PaymentSummary } from '../payments/payment-ledger.service';
import { markInApp } from '../../common/in-app';

// ----------------------------------------------------------------------------- DTOs

/** Cars customers see: confirmed ones, or any with a price (photos are required separately). Never development samples. */
const SHOWN_CAR: Prisma.VehicleWhereInput[] = [{ verification: RecordVerification.VERIFIED }, { verification: { not: RecordVerification.DEV_SAMPLE }, priceMinor: { not: null } }];

class VehicleQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() make?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() model?: string;
  @ApiPropertyOptional({ enum: VehicleCondition }) @IsOptional() @IsEnum(VehicleCondition) condition?: VehicleCondition;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() minYear?: number;
  @ApiPropertyOptional({ description: 'kobo' }) @IsOptional() @MinorAmount() @IsInt() @Min(0) maxPriceMinor?: number;
}

class AdminVehicleQueryDto extends VehicleQueryDto {
  @ApiPropertyOptional({ enum: VehicleStatus }) @IsOptional() @IsEnum(VehicleStatus) status?: VehicleStatus;
}

class CreateVehicleDto {
  @ApiProperty() @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) slug: string;
  @ApiProperty({ example: 'Toyota' }) @IsString() @Length(1, 60) make: string;
  @ApiProperty({ example: 'Land Cruiser' }) @IsString() @Length(1, 60) model: string;
  @ApiProperty({ example: 2024 }) @IsInt() @Min(1950) @Max(2100) year: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 60) trim?: string;
  @ApiPropertyOptional({ enum: VehicleCondition, nullable: true }) @IsOptional() @IsEnum(VehicleCondition) condition?: VehicleCondition | null;
  @ApiPropertyOptional() @IsOptional() @IsString() bodyType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() transmission?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() fuelType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() colour?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) mileageKm?: number;
  @ApiPropertyOptional() @IsOptional() @Matches(/^[A-HJ-NPR-Z0-9]{17}$/, { message: 'vin must be a 17-character VIN' }) vin?: string;
  @ApiPropertyOptional({ description: 'Price in kobo. Null means not published.', nullable: true }) @IsOptional() @MinorAmount() @IsInt() @Min(1) priceMinor?: number | null;
  @ApiPropertyOptional({ description: 'Reservation deposit in kobo' }) @IsOptional() @MinorAmount() @IsInt() @Min(1) depositMinor?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() customsCleared?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsObject() specs?: Record<string, unknown>;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 5000) description?: string;
  @ApiPropertyOptional({ enum: VehicleStatus }) @IsOptional() @IsEnum(VehicleStatus) status?: VehicleStatus;
}

class UpdateVehicleDto extends PartialType(CreateVehicleDto) {}

class CreateInquiryDto {
  @ApiProperty({ enum: InquiryType }) @IsEnum(InquiryType) type: InquiryType;
  @ApiProperty() @IsString() @Length(2, 120) contactName: string;
  @ApiProperty() @IsEmail() contactEmail: string;
  @ApiProperty({ example: '+2348031234567' }) @IsPhone() contactPhone: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 2000) message?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() preferredDate?: string;
}

class UpdateInquiryDto {
  @ApiPropertyOptional({ enum: InquiryStatus }) @IsOptional() @IsEnum(InquiryStatus) status?: InquiryStatus;
  @ApiPropertyOptional() @IsOptional() @IsUUID() assignedToId?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() preferredDate?: string;
}

class InquiryQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: InquiryStatus }) @IsOptional() @IsEnum(InquiryStatus) status?: InquiryStatus;
}

// ----------------------------------------------------------------------------- Service

/**
 * Automobiles: showroom listings and inquiries. High-value vehicles are not
 * sold by instant checkout; customers request inspection/test drives, and a
 * DEPOSIT_HOLD inquiry approved by staff (status SCHEDULED) can be paid as a
 * refundable deposit (purpose VEHICLE_DEPOSIT) that reserves the vehicle.
 */
@Injectable()
export class VehiclesService implements OnModuleInit, PayableHandler {
  readonly purpose = PaymentPurpose.VEHICLE_DEPOSIT;

  constructor(
    private readonly prisma: PrismaService,
    private readonly divisions: DivisionsService,
    private readonly audit: AuditService,
    private readonly payables: PayableRegistry,
  ) {}

  onModuleInit() {
    this.payables.register(this);
  }

  async list(q: VehicleQueryDto, status: VehicleStatus | { in: VehicleStatus[] } = { in: [VehicleStatus.AVAILABLE, VehicleStatus.RESERVED] }, includeUnverified = false) {
    const where: Prisma.VehicleWhereInput = {
      status,
      // Confirmed cars, or any car with a price and photos (owner, 11 November 2026).
      OR: includeUnverified ? undefined : SHOWN_CAR,
      // Customers only see cars with photos; staff lists (includeUnverified) show every car.
      images: includeUnverified ? undefined : { some: {} },
      make: q.make ? { equals: q.make, mode: 'insensitive' } : undefined,
      model: q.model ? { contains: q.model, mode: 'insensitive' } : undefined,
      condition: q.condition,
      year: q.minYear ? { gte: q.minYear } : undefined,
      priceMinor: q.maxPriceMinor !== undefined ? { lte: BigInt(q.maxPriceMinor) } : undefined,
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.vehicle.findMany({ where, orderBy: { createdAt: 'desc' }, ...pageArgs(q), include: { images: { orderBy: { sortOrder: 'asc' }, take: 1 } } }),
      this.prisma.vehicle.count({ where }),
    ]);
    return paginate(rows.map(({ vin, ...v }) => v), total, q);
  }

  async get(slug: string) {
    const v = await this.prisma.vehicle.findFirst({
      where: { slug, status: { in: [VehicleStatus.AVAILABLE, VehicleStatus.RESERVED] }, OR: SHOWN_CAR, images: { some: {} } },
      include: { images: { orderBy: { sortOrder: 'asc' } } },
    });
    if (!v) throw new NotFoundException('Vehicle not found');
    const { vin, ...rest } = v;
    return { ...rest, vinLast6: vin ? vin.slice(-6) : null };
  }

  async createInquiry(user: AuthUser, vehicleId: string, dto: CreateInquiryDto) {
    const v = await this.prisma.vehicle.findFirst({ where: { id: vehicleId, images: { some: {} }, OR: SHOWN_CAR } });
    if (!v || (v.status !== VehicleStatus.AVAILABLE && v.status !== VehicleStatus.RESERVED)) throw new NotFoundException('Vehicle not found');
    if (dto.type === InquiryType.DEPOSIT_HOLD && (v.status !== VehicleStatus.AVAILABLE || !v.depositMinor)) {
      throw new BadRequestException('A deposit hold is not available for this vehicle');
    }
    const inquiry = await this.prisma.vehicleInquiry.create({
      data: { ...dto, preferredDate: dto.preferredDate ? new Date(dto.preferredDate) : undefined, vehicleId, userId: user.id },
    });
    await this.audit.record({ actorId: user.id, action: 'vehicle_inquiry.create', entityType: 'vehicle_inquiry', entityId: inquiry.id, divisionId: v.divisionId });
    return inquiry;
  }

  myInquiries(user: AuthUser) {
    return this.prisma.vehicleInquiry.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      include: { vehicle: { select: { id: true, slug: true, make: true, model: true, year: true, depositMinor: true, status: true } } },
    });
  }

  // Admin
  async adminList(user: AuthUser, q: AdminVehicleQueryDto) {
    const d = await this.divisions.byCode(DivisionCode.AUTOMOBILES);
    user.assertCan(P.listingsManage, d.id);
    const page = await this.list(q, q.status ?? { in: Object.values(VehicleStatus) }, true);
    // "In the app": the customers' own car query, run on these cars.
    const forSale: VehicleStatus[] = [VehicleStatus.AVAILABLE, VehicleStatus.RESERVED];
    const ids = page.data.map((v) => v.id);
    const shown = new Set((await this.prisma.vehicle.findMany({ where: { id: { in: ids }, status: { in: forSale }, OR: SHOWN_CAR, images: { some: {} } }, select: { id: true } })).map((v) => v.id));
    return {
      ...page,
      data: markInApp(page.data, shown, (v) => {
        if (!forSale.includes(v.status)) return v.status === VehicleStatus.SOLD ? 'Sold' : 'Not for sale';
        if (v.verification === RecordVerification.DEV_SAMPLE) return 'Development sample';
        if (!v.images?.length) return 'No photo';
        if (v.priceMinor === null) return 'No price';
        return 'Not confirmed';
      }),
    };
  }

  async create(user: AuthUser, dto: CreateVehicleDto) {
    const d = await this.divisions.byCode(DivisionCode.AUTOMOBILES);
    user.assertCan(P.listingsManage, d.id);
    const v = await this.prisma.vehicle.create({ data: { ...this.money(dto), divisionId: d.id } as Prisma.VehicleUncheckedCreateInput });
    await this.audit.record({ actorId: user.id, action: 'vehicle.create', entityType: 'vehicle', entityId: v.id, divisionId: d.id, changes: { ...dto } });
    return v;
  }

  async update(user: AuthUser, id: string, dto: UpdateVehicleDto) {
    const v = await this.prisma.vehicle.findUnique({ where: { id } });
    if (!v) throw new NotFoundException('Vehicle not found');
    user.assertCan(P.listingsManage, v.divisionId);
    const updated = await this.prisma.vehicle.update({ where: { id }, data: this.money(dto) as Prisma.VehicleUpdateInput });
    await this.audit.record({ actorId: user.id, action: 'vehicle.update', entityType: 'vehicle', entityId: id, divisionId: v.divisionId, changes: { before: { priceMinor: v.priceMinor, status: v.status }, after: { ...dto } } });
    return updated;
  }

  /**
   * Fills in car details from a spreadsheet. The "Web address" (or "Slug") column finds the car;
   * Trim, Body type, Transmission, Fuel, Colour and Description fill those fields, and any other
   * column (Engine, Drive, Seats, Power…) is shown as a feature. Empty cells change nothing.
   */
  async importDetails(user: AuthUser, file?: { buffer: Buffer; originalname: string }) {
    const d = await this.divisions.byCode(DivisionCode.AUTOMOBILES);
    user.assertCan(P.listingsManage, d.id);
    if (!file?.buffer?.length) throw new BadRequestException('Choose a spreadsheet to upload.');
    let sheets;
    try {
      sheets = readSpreadsheet(file.buffer, file.originalname ?? '');
    } catch (e) {
      throw new BadRequestException(e instanceof SpreadsheetError ? e.message : 'This file could not be read. Please save it as .xlsx or .csv.');
    }
    const FIELDS: Record<string, 'trim' | 'bodyType' | 'transmission' | 'fuelType' | 'colour' | 'description'> = {
      TRIM: 'trim', 'BODY TYPE': 'bodyType', BODY: 'bodyType', TRANSMISSION: 'transmission', GEARBOX: 'transmission', FUEL: 'fuelType', 'FUEL TYPE': 'fuelType',
      COLOUR: 'colour', COLOR: 'colour', DESCRIPTION: 'description',
    };
    const SKIP = new Set(['WEB ADDRESS', 'SLUG', 'CAR', 'MAKE', 'MODEL', 'YEAR', 'PRICE', 'NOTES', 'NOTE']);
    let updated = 0;
    const notFound: string[] = [];
    for (const sheet of sheets) {
      const head = (sheet.rows[0] ?? []).map((h) => String(h).toUpperCase().trim());
      const slugCol = head.findIndex((h) => h === 'WEB ADDRESS' || h === 'SLUG');
      if (slugCol < 0) continue;
      for (const row of sheet.rows.slice(1)) {
        const slug = String(row[slugCol] ?? '').trim().toLowerCase().replace(/^.*\/cars\//, '');
        if (!slug) continue;
        const v = await this.prisma.vehicle.findFirst({ where: { slug, divisionId: d.id } });
        if (!v) {
          notFound.push(slug);
          continue;
        }
        const data: Prisma.VehicleUpdateInput = {};
        const specs: Record<string, string> = { ...((v.specs && typeof v.specs === 'object' && !Array.isArray(v.specs) ? v.specs : {}) as Record<string, string>) };
        head.forEach((h, i) => {
          const value = String(row[i] ?? '').trim();
          if (!value || i === slugCol || SKIP.has(h)) return;
          const field = FIELDS[h];
          if (field) (data as Record<string, string>)[field] = value.slice(0, field === 'description' ? 5000 : 120);
          else specs[sheet.rows[0][i].trim().slice(0, 40)] = value.slice(0, 120);
        });
        data.specs = specs;
        await this.prisma.vehicle.update({ where: { id: v.id }, data });
        await this.audit.record({ actorId: user.id, action: 'vehicle.details_import', entityType: 'vehicle', entityId: v.id, divisionId: v.divisionId, changes: { file: file.originalname, ...data } as Record<string, unknown> });
        updated++;
      }
    }
    if (!updated && !notFound.length) throw new BadRequestException('No cars were found. The first row needs a "Web address" column, for example toyota-camry-2013-r8.');
    return { updated, notFound };
  }

  async adminInquiries(user: AuthUser, q: InquiryQueryDto) {
    const d = await this.divisions.byCode(DivisionCode.AUTOMOBILES);
    user.assertCan(P.inquiriesManage, d.id);
    const where = { status: q.status };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.vehicleInquiry.findMany({ where, orderBy: { createdAt: 'desc' }, ...pageArgs(q), include: { vehicle: { select: { slug: true, make: true, model: true, year: true } } } }),
      this.prisma.vehicleInquiry.count({ where }),
    ]);
    return paginate(rows, total, q);
  }

  async updateInquiry(user: AuthUser, id: string, dto: UpdateInquiryDto) {
    const inquiry = await this.prisma.vehicleInquiry.findUnique({ where: { id }, include: { vehicle: true } });
    if (!inquiry) throw new NotFoundException('Inquiry not found');
    user.assertCan(P.inquiriesManage, inquiry.vehicle.divisionId);
    const updated = await this.prisma.vehicleInquiry.update({
      where: { id },
      data: { ...dto, preferredDate: dto.preferredDate ? new Date(dto.preferredDate) : undefined },
    });
    await this.audit.record({ actorId: user.id, action: 'vehicle_inquiry.update', entityType: 'vehicle_inquiry', entityId: id, divisionId: inquiry.vehicle.divisionId, changes: { ...dto } });
    return updated;
  }

  // PayableHandler — deposit for an approved DEPOSIT_HOLD inquiry
  async resolve(inquiryId: string, user: AuthUser): Promise<PayableContext> {
    const inquiry = await this.prisma.vehicleInquiry.findFirst({ where: { id: inquiryId, userId: user.id }, include: { vehicle: true } });
    if (!inquiry) throw new NotFoundException('Inquiry not found');
    return this.context(inquiry);
  }

  async load(db: Tx | PrismaService, inquiryId: string): Promise<PayableContext> {
    const inquiry = await db.vehicleInquiry.findUnique({ where: { id: inquiryId }, include: { vehicle: true } });
    if (!inquiry) throw new NotFoundException('Inquiry not found');
    return this.context(inquiry);
  }

  private context(inquiry: Prisma.VehicleInquiryGetPayload<{ include: { vehicle: true } }>): PayableContext {
    let closedReason: string | undefined;
    if (inquiry.type !== InquiryType.DEPOSIT_HOLD) closedReason = 'Only deposit-hold inquiries can be paid';
    else if (inquiry.status !== InquiryStatus.SCHEDULED) closedReason = 'This deposit has not been approved by the showroom yet';
    else if (!inquiry.vehicle.depositMinor) closedReason = 'No deposit is set for this vehicle';
    else if (inquiry.vehicle.status !== VehicleStatus.AVAILABLE && inquiry.amountPaidMinor === 0n) closedReason = 'This vehicle is no longer available';
    return {
      totalDueMinor: inquiry.vehicle.depositMinor ?? 0n,
      depositRequiredMinor: 0n,
      currency: 'NGN',
      divisionId: inquiry.vehicle.divisionId,
      userId: inquiry.userId ?? '',
      label: `${inquiry.vehicle.year} ${inquiry.vehicle.make} ${inquiry.vehicle.model}`,
      description: `Deposit — ${inquiry.vehicle.year} ${inquiry.vehicle.make} ${inquiry.vehicle.model}`,
      acceptsPayments: !closedReason,
      closedReason,
    };
  }

  async onPaymentStateChanged(tx: Tx, inquiryId: string, summary: PaymentSummary, trigger: Payment): Promise<NotifyInput[]> {
    if (trigger.status !== PaymentStatus.SUCCESS || !summary.fullyPaid) return [];
    const inquiry = await tx.vehicleInquiry.findUniqueOrThrow({ where: { id: inquiryId }, include: { vehicle: true } });
    const reserved = await tx.vehicle.updateMany({ where: { id: inquiry.vehicleId, status: VehicleStatus.AVAILABLE }, data: { status: VehicleStatus.RESERVED } });
    if (reserved.count !== 1 && inquiry.vehicle.status !== VehicleStatus.RESERVED) {
      await tx.payment.update({ where: { id: trigger.id }, data: { refundStatus: 'PENDING', failureReason: 'Vehicle no longer available — refund required' } });
      return [{ userId: trigger.userId, type: 'vehicle.deposit_refund', title: 'Vehicle no longer available', body: `Your deposit of ${formatNgn(trigger.amountMinor)} will be refunded.`, email: true }];
    }
    return [{
      userId: trigger.userId,
      type: 'vehicle.deposit_paid',
      title: 'Vehicle reserved',
      body: `Your deposit of ${formatNgn(summary.paidMinor)} for the ${inquiry.vehicle.year} ${inquiry.vehicle.make} ${inquiry.vehicle.model} was confirmed. Our showroom team will contact you.`,
      data: { inquiryId: inquiry.id },
      email: true,
    }];
  }

  private money<T extends { priceMinor?: number | null; depositMinor?: number }>(dto: T) {
    return {
      ...dto,
      priceMinor: dto.priceMinor === undefined ? undefined : dto.priceMinor === null ? null : BigInt(dto.priceMinor),
      depositMinor: dto.depositMinor !== undefined ? BigInt(dto.depositMinor) : undefined,
      specs: (dto as { specs?: Prisma.InputJsonValue }).specs,
    };
  }
}

// ----------------------------------------------------------------------------- Controllers

@ApiTags('Automobiles')
@Controller('vehicles')
export class VehiclesController {
  constructor(private readonly vehicles: VehiclesService) {}

  @Public() @Get()
  @ApiOperation({ summary: 'Showroom vehicles' })
  list(@Query() q: VehicleQueryDto) {
    return this.vehicles.list(q);
  }

  @Authenticated() @Get('inquiries/mine')
  @ApiOperation({ summary: 'My vehicle inquiries' })
  mine(@CurrentUser() user: AuthUser) {
    return this.vehicles.myInquiries(user);
  }

  @Public() @Get(':slug')
  get(@Param('slug') slug: string) {
    return this.vehicles.get(slug);
  }

  @Authenticated() @Post(':id/inquiries')
  @ApiOperation({ summary: 'Request information, a test drive, an inspection or a deposit hold' })
  inquire(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateInquiryDto) {
    return this.vehicles.createInquiry(user, id, dto);
  }
}

@ApiTags('Admin · Automobiles')
@Controller('admin/vehicles')
export class AdminVehiclesController {
  constructor(private readonly vehicles: VehiclesService) {}

  @Get() @RequirePermissions(P.listingsManage)
  list(@CurrentUser() user: AuthUser, @Query() q: AdminVehicleQueryDto) {
    return this.vehicles.adminList(user, q);
  }

  @Post() @RequirePermissions(P.listingsManage)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateVehicleDto) {
    return this.vehicles.create(user, dto);
  }

  @Patch(':id') @RequirePermissions(P.listingsManage)
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateVehicleDto) {
    return this.vehicles.update(user, id, dto);
  }

  @Post('details-import') @RequirePermissions(P.listingsManage)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024, files: 1 } }))
  @ApiOperation({ summary: 'Fill in car details (trim, transmission, fuel, colour, description, features) from a spreadsheet' })
  importDetails(@CurrentUser() user: AuthUser, @UploadedFile() file?: { buffer: Buffer; originalname: string }) {
    return this.vehicles.importDetails(user, file);
  }

  @Get('inquiries/all') @RequirePermissions(P.inquiriesManage)
  inquiries(@CurrentUser() user: AuthUser, @Query() q: InquiryQueryDto) {
    return this.vehicles.adminInquiries(user, q);
  }

  @Patch('inquiries/:id') @RequirePermissions(P.inquiriesManage)
  @ApiOperation({ summary: 'Assign, schedule or close an inquiry (SCHEDULED approves a deposit hold)' })
  updateInquiry(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateInquiryDto) {
    return this.vehicles.updateInquiry(user, id, dto);
  }
}

@Module({ providers: [VehiclesService], controllers: [VehiclesController, AdminVehiclesController] })
export class VehiclesModule {}
