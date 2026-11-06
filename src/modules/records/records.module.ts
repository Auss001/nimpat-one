import { BadRequestException, Body, Controller, Get, HttpCode, Injectable, Module, Post } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { ListingStatus, ProductStatus, RecordVerification } from '@prisma/client';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsUUID } from 'class-validator';
import { CurrentUser, RequirePermissions } from '../../common/decorators/auth.decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../access/auth-user';
import { P } from '../access/permissions';
import { AuditService } from '../audit/audit.service';

export const RECORD_TYPES = ['PRODUCT', 'APARTMENT_UNIT', 'VEHICLE', 'SPA_TREATMENT', 'SERVICE_OFFERING', 'DELIVERY_ZONE'] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

class VerifyRecordsDto {
  @ApiProperty({ enum: RECORD_TYPES }) @IsIn(RECORD_TYPES) type: RecordType;
  @ApiProperty({ type: [String] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @IsUUID('all', { each: true }) ids: string[];
  @ApiProperty({ enum: ['VERIFIED', 'AWAITING_CONFIRMATION'], description: 'VERIFIED makes the records sellable / bookable' })
  @IsIn(['VERIFIED', 'AWAITING_CONFIRMATION']) verification: 'VERIFIED' | 'AWAITING_CONFIRMATION';
}

/**
 * Company confirmation of catalogue and listing data. Only VERIFIED records
 * appear on the customer API and can be sold or booked. Development samples
 * can never be verified.
 */
@Injectable()
export class RecordsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async divisionsOf(type: RecordType, ids: string[]): Promise<{ id: string; divisionId: string; verification: RecordVerification; name: string }[]> {
    switch (type) {
      case 'PRODUCT':
        return this.prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, divisionId: true, verification: true, name: true } });
      case 'APARTMENT_UNIT':
        return (await this.prisma.apartmentUnit.findMany({ where: { id: { in: ids } }, select: { id: true, verification: true, name: true, property: { select: { divisionId: true } } } })).map((u) => ({ ...u, divisionId: u.property.divisionId }));
      case 'VEHICLE':
        return (await this.prisma.vehicle.findMany({ where: { id: { in: ids } }, select: { id: true, divisionId: true, verification: true, make: true, model: true } })).map((v) => ({ ...v, name: `${v.make} ${v.model}` }));
      case 'SPA_TREATMENT':
        return this.prisma.spaTreatment.findMany({ where: { id: { in: ids } }, select: { id: true, divisionId: true, verification: true, name: true } });
      case 'SERVICE_OFFERING':
        return this.prisma.serviceOffering.findMany({ where: { id: { in: ids } }, select: { id: true, divisionId: true, verification: true, name: true } });
      case 'DELIVERY_ZONE':
        return this.prisma.deliveryZone.findMany({ where: { id: { in: ids } }, select: { id: true, divisionId: true, verification: true, name: true } });
    }
  }

  async setVerification(actor: AuthUser, dto: VerifyRecordsDto) {
    const rows = await this.divisionsOf(dto.type, dto.ids);
    if (rows.length !== new Set(dto.ids).size) throw new BadRequestException('Some records were not found');
    for (const r of rows) {
      actor.assertCan(P.recordsVerify, r.divisionId);
      if (r.verification === RecordVerification.DEV_SAMPLE) throw new BadRequestException(`"${r.name}" is development sample data and cannot be verified`);
    }
    const data = dto.verification === 'VERIFIED'
      ? { verification: RecordVerification.VERIFIED, verifiedAt: new Date(), verifiedById: actor.id }
      : { verification: RecordVerification.AWAITING_CONFIRMATION, verifiedAt: null, verifiedById: null };
    const where = { id: { in: dto.ids }, verification: { not: RecordVerification.DEV_SAMPLE } };
    const model = { PRODUCT: 'product', APARTMENT_UNIT: 'apartmentUnit', VEHICLE: 'vehicle', SPA_TREATMENT: 'spaTreatment', SERVICE_OFFERING: 'serviceOffering', DELIVERY_ZONE: 'deliveryZone' }[dto.type];
    const res = await (this.prisma as any)[model].updateMany({ where, data });
    for (const r of rows) {
      await this.audit.record({ actorId: actor.id, action: `record.${dto.verification.toLowerCase()}`, entityType: dto.type.toLowerCase(), entityId: r.id, divisionId: r.divisionId, changes: { from: r.verification, to: dto.verification } });
    }
    return { updated: res.count };
  }

  /** Data audit: what is verified, awaiting confirmation or sample, and what is missing. */
  async audit_() {
    const by = async (model: string, extraWhere: object = {}) => {
      const rows: { verification: RecordVerification; _count: number }[] = await (this.prisma as any)[model].groupBy({ by: ['verification'], where: extraWhere, _count: true });
      return Object.fromEntries(Object.values(RecordVerification).map((v) => [v, rows.find((r) => r.verification === v)?._count ?? 0]));
    };
    const [products, units, vehicles, treatments, offerings, zones] = await Promise.all([
      by('product', { status: { not: ProductStatus.ARCHIVED } }),
      by('apartmentUnit', { status: { not: ListingStatus.ARCHIVED } }),
      by('vehicle'),
      by('spaTreatment'),
      by('serviceOffering'),
      by('deliveryZone'),
    ]);

    const real = { verification: { not: RecordVerification.DEV_SAMPLE } };
    const [noPrice, noStock, noPhotoProducts, unitsNoPhotos, vehiclesNoPhotos, vehiclesNoDeposit, therapists, treatmentsNoTherapist, liveZones, accounts, locations] = await Promise.all([
      this.prisma.productVariant.findMany({ where: { unitPriceMinor: { lte: 0 }, product: real }, select: { sku: true, name: true, product: { select: { name: true } } } }),
      this.prisma.$queryRaw<{ sku: string; name: string; on_hand: number }[]>`
        SELECT v.sku, p.name, COALESCE(SUM(s.quantity_on_hand), 0)::int AS on_hand
          FROM product_variants v JOIN products p ON p.id = v.product_id
          LEFT JOIN stock_levels s ON s.variant_id = v.id
          JOIN stock_locations l ON l.id = s.location_id AND l.is_active
         WHERE p.verification <> 'DEV_SAMPLE' AND p.status <> 'ARCHIVED'
         GROUP BY v.sku, p.name HAVING COALESCE(SUM(s.quantity_on_hand), 0) = 0 ORDER BY p.name`,
      this.prisma.product.findMany({ where: { ...real, status: { not: ProductStatus.ARCHIVED }, images: { none: {} } }, select: { name: true } }),
      this.prisma.apartmentUnit.findMany({ where: { ...real, images: { none: {} } }, select: { name: true, code: true } }),
      this.prisma.vehicle.findMany({ where: { ...real, images: { none: {} } }, select: { make: true, model: true } }),
      this.prisma.vehicle.findMany({ where: { ...real, depositMinor: null }, select: { make: true, model: true } }),
      this.prisma.spaPractitioner.count({ where: { isActive: true, displayName: { not: { startsWith: '[DEV SAMPLE]' } } } }),
      this.prisma.spaTreatment.findMany({ where: { ...real, isActive: true, practitioners: { none: { practitioner: { isActive: true } } } }, select: { name: true } }),
      this.prisma.deliveryZone.findMany({ where: { isActive: true }, select: { name: true, verification: true, feeMinor: true } }),
      this.prisma.bankAccount.count({ where: { isActive: true } }),
      this.prisma.serviceLocation.count({ where: { isActive: true } }),
    ]);

    return {
      generatedAt: new Date().toISOString(),
      verificationCounts: { products, apartmentUnits: units, vehicles, spaTreatments: treatments, serviceOfferings: offerings, deliveryZones: zones },
      missing: {
        productPrices: noPrice.map((v) => `${v.product.name} (${v.sku})`),
        inventoryQuantities: noStock.map((r) => `${r.name} (${r.sku})`),
        productPhotos: noPhotoProducts.map((p) => p.name),
        apartmentPhotos: unitsNoPhotos.map((u) => `${u.name} (${u.code})`),
        apartmentAvailability: 'Availability is derived from reservations and blocked dates; no owner/maintenance calendar has been supplied yet.',
        vehiclePhotos: vehiclesNoPhotos.map((v) => `${v.make} ${v.model}`),
        vehicleDeposits: vehiclesNoDeposit.map((v) => `${v.make} ${v.model}`),
        vehicleAvailability: 'Status (available / reserved / sold) must be confirmed by the showroom.',
        spaStaff: therapists === 0 ? 'No therapists configured — spa appointments cannot be booked' : `${therapists} active therapist(s)`,
        spaSchedules: 'Opening hours are a placeholder (09:00–19:00 Africa/Lagos); per-therapist rosters are not modelled yet.',
        spaTreatmentsWithoutTherapist: treatmentsNoTherapist.map((t) => t.name),
        deliveryFees: liveZones.filter((z) => z.verification !== RecordVerification.VERIFIED).map((z) => `${z.name} (${z.verification})`),
        receivingBankAccounts: accounts === 0 ? 'None configured — direct bank transfer is unavailable' : `${accounts} active`,
        serviceLocations: locations === 0 ? 'None configured — pay at location is unavailable' : `${locations} active`,
      },
    };
  }
}

@ApiTags('Admin · Data verification')
@Controller('admin/records')
export class RecordsController {
  constructor(private readonly records: RecordsService) {}

  @Get('audit')
  @RequirePermissions(P.recordsVerify, P.reportsRead)
  @ApiOperation({ summary: 'Catalogue data audit: verified / awaiting confirmation / samples, and missing data' })
  audit() {
    return this.records.audit_();
  }

  @Post('verification')
  @HttpCode(200)
  @RequirePermissions(P.recordsVerify)
  @ApiOperation({ summary: 'Confirm (VERIFIED) or un-confirm records. Only VERIFIED records can be sold or booked.' })
  set(@CurrentUser() user: AuthUser, @Body() dto: VerifyRecordsDto) {
    return this.records.setVerification(user, dto);
  }
}

@Module({ providers: [RecordsService], controllers: [RecordsController] })
export class RecordsModule {}
