import { BadRequestException, Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { ListingStatus, Prisma, ProductStatus, RecordVerification, UnitReadiness, VehicleStatus } from '@prisma/client';
import { IsDateString, IsOptional, IsString } from 'class-validator';
import { CurrentUser, RequirePermissions } from '../../common/decorators/auth.decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../access/auth-user';
import { P } from '../access/permissions';
import { DivisionsService } from '../divisions/divisions.service';

class ReportQueryDto {
  @ApiPropertyOptional({ example: '2026-11-01T00:00:00+01:00' }) @IsOptional() @IsDateString() from?: string;
  @ApiPropertyOptional({ example: '2026-12-01T00:00:00+01:00' }) @IsOptional() @IsDateString() to?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() division?: string;
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly divisions: DivisionsService,
  ) {}

  /** Revenue summary from verified payments, grouped by division and purpose. */
  async summary(user: AuthUser, q: ReportQueryDto) {
    const to = q.to ? new Date(q.to) : new Date();
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * 86_400_000);
    if (from >= to) throw new BadRequestException('from must be before to');
    let divisionIds = user.divisionFilter(P.reportsRead);
    if (q.division) {
      const d = await this.divisions.resolve(q.division);
      user.assertCan(P.reportsRead, d.id);
      divisionIds = [d.id];
    }
    const divisionWhere = divisionIds ? { in: divisionIds } : undefined;
    const paidWhere: Prisma.PaymentWhereInput = { status: 'SUCCESS', paidAt: { gte: from, lt: to }, divisionId: divisionWhere };

    const [byDivision, byPurpose, refunds, orderCounts, topProducts, reservations] = await Promise.all([
      this.prisma.payment.groupBy({ by: ['divisionId'], where: paidWhere, _sum: { amountMinor: true, refundedMinor: true, feesMinor: true }, _count: true }),
      this.prisma.payment.groupBy({ by: ['purpose'], where: paidWhere, _sum: { amountMinor: true }, _count: true }),
      this.prisma.refund.aggregate({ where: { status: 'PROCESSED', processedAt: { gte: from, lt: to }, payment: { divisionId: divisionWhere } }, _sum: { amountMinor: true }, _count: true }),
      this.prisma.order.groupBy({ by: ['status'], where: { createdAt: { gte: from, lt: to }, divisionId: divisionWhere }, _count: true }),
      this.prisma.orderItem.groupBy({
        by: ['sku', 'productName', 'variantName'],
        where: { order: { paidAt: { gte: from, lt: to }, divisionId: divisionWhere } },
        _sum: { quantity: true, lineTotalMinor: true },
        orderBy: { _sum: { lineTotalMinor: 'desc' } },
        take: 10,
      }),
      this.prisma.reservation.groupBy({ by: ['status'], where: { createdAt: { gte: from, lt: to } }, _count: true, _sum: { nights: true } }),
    ]);

    const names = new Map((await this.divisions.all()).map((d) => [d.id, d.name]));
    const gross = byDivision.reduce((s, r) => s + (r._sum.amountMinor ?? 0n), 0n);
    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      currency: 'NGN',
      grossRevenueMinor: gross,
      refundsMinor: refunds._sum.amountMinor ?? 0n,
      netRevenueMinor: gross - (refunds._sum.amountMinor ?? 0n),
      byDivision: byDivision.map((r) => ({
        divisionId: r.divisionId,
        division: names.get(r.divisionId),
        payments: r._count,
        grossMinor: r._sum.amountMinor ?? 0n,
        refundedMinor: r._sum.refundedMinor ?? 0n,
        providerFeesMinor: r._sum.feesMinor ?? 0n,
      })),
      byPurpose: byPurpose.map((r) => ({ purpose: r.purpose, payments: r._count, grossMinor: r._sum.amountMinor ?? 0n })),
      orders: Object.fromEntries(orderCounts.map((o) => [o.status, o._count])),
      topProducts: topProducts.map((t) => ({ sku: t.sku, product: t.productName, variant: t.variantName, quantity: t._sum.quantity ?? 0, revenueMinor: t._sum.lineTotalMinor ?? 0n })),
      reservations: divisionIds && !divisionIds.length ? {} : Object.fromEntries(reservations.map((r) => [r.status, { count: r._count, nights: r._sum.nights ?? 0 }])),
    };
  }

  /**
   * What Nimpat has, for the dashboard homepage. Test samples and anything
   * switched off are left out, and managers see only their own divisions.
   */
  async overview(user: AuthUser) {
    const ids = user.divisionFilter(P.reportsRead);
    const divisionId = ids ? { in: ids } : undefined;
    const notSample = { not: RecordVerification.DEV_SAMPLE };
    const to = new Date();
    const from = new Date(to.getTime() - 30 * 86_400_000);

    const productWhere: Prisma.ProductWhereInput = { divisionId, status: ProductStatus.ACTIVE, verification: notSample };
    const unitWhere: Prisma.ApartmentUnitWhereInput = { status: { not: ListingStatus.INACTIVE }, verification: notSample, property: { divisionId, status: ListingStatus.ACTIVE } };
    const spaWhere: Prisma.SpaTreatmentWhereInput = { divisionId, isActive: true, verification: notSample };
    const vehicleWhere: Prisma.VehicleWhereInput = { divisionId, status: { in: [VehicleStatus.AVAILABLE, VehicleStatus.RESERVED] }, verification: notSample };
    const serviceWhere: Prisma.ServiceOfferingWhereInput = { divisionId, isActive: true, verification: notSample };
    const confirmed = { verification: RecordVerification.VERIFIED };

    const [products, units, spa, vehicles, services, levels, revenue, confirmedCounts] = await Promise.all([
      this.prisma.product.groupBy({ by: ['divisionId'], where: productWhere, _count: true }),
      this.prisma.apartmentUnit.findMany({ where: unitWhere, select: { readiness: true, property: { select: { location: true } } } }),
      this.prisma.spaTreatment.count({ where: spaWhere }),
      this.prisma.vehicle.count({ where: vehicleWhere }),
      this.prisma.serviceOffering.count({ where: serviceWhere }),
      this.prisma.stockLevel.findMany({
        where: { location: { divisionId, isActive: true }, variant: { isActive: true, product: productWhere } },
        select: { quantityOnHand: true, quantityReserved: true, reorderLevel: true },
      }),
      this.prisma.payment.groupBy({ by: ['divisionId'], where: { status: 'SUCCESS', paidAt: { gte: from, lt: to }, divisionId }, _sum: { amountMinor: true, refundedMinor: true } }),
      Promise.all([
        this.prisma.product.count({ where: { ...productWhere, ...confirmed } }),
        this.prisma.apartmentUnit.count({ where: { ...unitWhere, ...confirmed } }),
        this.prisma.spaTreatment.count({ where: { ...spaWhere, ...confirmed } }),
        this.prisma.vehicle.count({ where: { ...vehicleWhere, ...confirmed } }),
        this.prisma.serviceOffering.count({ where: { ...serviceWhere, ...confirmed } }),
      ]),
    ]);

    const divisions = await this.divisions.all();
    const names = new Map(divisions.map((d) => [d.id, d.name.replace(/^Nimpat /, '')]));
    const tally = <T extends string>(values: T[]) => {
      const out: Record<string, number> = {};
      for (const v of values) out[v] = (out[v] ?? 0) + 1;
      return out;
    };
    const productTotal = products.reduce((n, p) => n + p._count, 0);
    const available = (l: { quantityOnHand: number; quantityReserved: number }) => l.quantityOnHand - l.quantityReserved;
    const condition = tally(units.map((u) => u.readiness));

    return {
      scope: ids ? 'divisions' : 'group',
      period: { from: from.toISOString(), to: to.toISOString() },
      holdings: [
        ...products.map((p) => ({ label: names.get(p.divisionId) ?? 'Products', count: p._count })),
        { label: 'Apartments', count: units.length },
        { label: 'Spa treatments', count: spa },
        { label: 'Vehicles', count: vehicles },
        { label: 'Rentals and listings', count: services },
      ].filter((h) => h.count > 0).sort((a, b) => b.count - a.count),
      apartments: {
        total: units.length,
        ready: condition[UnitReadiness.READY] ?? 0,
        byLocation: Object.entries(tally(units.map((u) => u.property.location ?? 'Other'))).map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
        byCondition: Object.values(UnitReadiness).map((code) => ({ code, count: condition[code] ?? 0 })).filter((c) => c.count > 0),
      },
      stock: {
        total: levels.length,
        inStock: levels.filter((l) => available(l) > l.reorderLevel).length,
        low: levels.filter((l) => available(l) > 0 && available(l) <= l.reorderLevel).length,
        out: levels.filter((l) => available(l) <= 0).length,
      },
      records: { confirmed: confirmedCounts.reduce((a, b) => a + b, 0), total: productTotal + units.length + spa + vehicles + services },
      revenue: {
        totalMinor: revenue.reduce((n, r) => n + (r._sum.amountMinor ?? 0n) - (r._sum.refundedMinor ?? 0n), 0n),
        byDivision: revenue.map((r) => ({ label: names.get(r.divisionId) ?? 'Other', minor: (r._sum.amountMinor ?? 0n) - (r._sum.refundedMinor ?? 0n) })).filter((r) => r.minor > 0n).sort((a, b) => Number(b.minor - a.minor)),
      },
    };
  }

  async lowStock(user: AuthUser) {
    const ids = user.divisionFilter(P.inventoryRead);
    const rows = await this.prisma.$queryRaw<{ sku: string; name: string; location: string; on_hand: number; reserved: number; reorder_level: number }[]>`
      SELECT v.sku, p.name, l.code AS location, s.quantity_on_hand AS on_hand, s.quantity_reserved AS reserved, s.reorder_level
        FROM stock_levels s
        JOIN product_variants v ON v.id = s.variant_id
        JOIN products p ON p.id = v.product_id
        JOIN stock_locations l ON l.id = s.location_id
       WHERE s.quantity_on_hand - s.quantity_reserved <= s.reorder_level
         AND (${ids === undefined} OR l.division_id = ANY(${ids ?? []}::uuid[]))
       ORDER BY (s.quantity_on_hand - s.quantity_reserved) ASC
       LIMIT 200`;
    return rows.map((r) => ({ ...r, available: r.on_hand - r.reserved }));
  }
}

@ApiTags('Admin · Reports')
@Controller('admin/reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('summary')
  @RequirePermissions(P.reportsRead)
  @ApiOperation({ summary: 'Revenue, refunds, order and reservation summary (verified payments only)' })
  summary(@CurrentUser() user: AuthUser, @Query() q: ReportQueryDto) {
    return this.reports.summary(user, q);
  }

  @Get('overview')
  @RequirePermissions(P.reportsRead)
  @ApiOperation({ summary: 'What Nimpat has: holdings, apartments, stock, confirmed records and verified revenue' })
  overview(@CurrentUser() user: AuthUser) {
    return this.reports.overview(user);
  }

  @Get('low-stock')
  @RequirePermissions(P.inventoryRead)
  @ApiOperation({ summary: 'Variants at or below their reorder level' })
  lowStock(@CurrentUser() user: AuthUser) {
    return this.reports.lowStock(user);
  }
}

@Module({ providers: [ReportsService], controllers: [ReportsController] })
export class ReportsModule {}
