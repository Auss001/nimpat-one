import { BadRequestException, Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
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

  @Get('low-stock')
  @RequirePermissions(P.inventoryRead)
  @ApiOperation({ summary: 'Variants at or below their reorder level' })
  lowStock(@CurrentUser() user: AuthUser) {
    return this.reports.lowStock(user);
  }
}

@Module({ providers: [ReportsService], controllers: [ReportsController] })
export class ReportsModule {}
