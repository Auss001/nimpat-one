import { BadRequestException, Injectable } from '@nestjs/common';
import { DivisionCode, PrescriptionStatus, ProductStatus } from '@prisma/client';
import { readSpreadsheet, SpreadsheetError } from '../../common/utils/spreadsheet';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../access/auth-user';
import { P } from '../access/permissions';
import { AuditService } from '../audit/audit.service';
import { DivisionsService } from '../divisions/divisions.service';
import { ApplyPriceListDto } from './catalog.dto';
import { Candidate, listRows, matchRow, nameWords, slugOf, SURE, tidyName } from './price-list';

export type PriceAction = 'update' | 'same' | 'new' | 'check' | 'skip';

/** A big jump either way is worth a second look before it goes live. */
const BIG_CHANGE = 0.5;

const SKU_PREFIX: Partial<Record<DivisionCode, string>> = {
  [DivisionCode.PHARMACY]: 'NMP-PHM-U',
  [DivisionCode.WATER_DRINKS_WINES]: 'NMP-WDW-U',
};

/**
 * Upload a store's latest price list: preview what would change, then apply the
 * rows staff keep ticked. Prices go live as soon as they are applied.
 */
@Injectable()
export class PriceListService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly divisions: DivisionsService,
    private readonly audit: AuditService,
  ) {}

  async preview(user: AuthUser, division: string, file?: { buffer: Buffer; originalname: string }) {
    const d = await this.divisions.resolve(division);
    user.assertCan(P.catalogManage, d.id);
    if (!file?.buffer?.length) throw new BadRequestException('Choose a spreadsheet to upload.');
    let sheets;
    try {
      sheets = readSpreadsheet(file.buffer, file.originalname ?? '');
    } catch (e) {
      throw new BadRequestException(e instanceof SpreadsheetError ? e.message : 'This file could not be read. Please save it as .xlsx or .csv and try again.');
    }
    const { rows, skippedSheets } = listRows(sheets);
    if (!rows.length) {
      throw new BadRequestException('No products were found. The first row should have headings such as "Description" (or "Product") and "Sales price".');
    }

    const variants = await this.prisma.productVariant.findMany({
      where: { isActive: true, product: { divisionId: d.id, status: { not: ProductStatus.ARCHIVED } } },
      select: { id: true, sku: true, stockCode: true, name: true, unitPriceMinor: true, product: { select: { name: true, _count: { select: { variants: true } } } } },
    });
    const current = new Map(variants.map((v) => [v.id, v.unitPriceMinor === null ? null : Number(v.unitPriceMinor)]));
    const candidates: Candidate[] = variants.map((v) => {
      const label = v.product._count.variants > 1 && v.name !== 'As listed' ? `${v.product.name} ${v.name}` : v.product.name;
      return { variantId: v.id, sku: v.sku, stockCode: v.stockCode, label, words: nameWords(label) };
    });
    const byCode = new Map<string, Candidate>();
    for (const c of candidates) {
      byCode.set(c.sku.toUpperCase(), c);
      if (c.stockCode) byCode.set(c.stockCode.toUpperCase(), c);
    }

    const out = rows.map((r) => {
      const m = matchRow(r, candidates, byCode);
      const warnings: string[] = [];
      const now = m ? current.get(m.c.variantId) ?? null : null;
      let action: PriceAction;
      if (r.salePriceMinor === null) {
        warnings.push('No selling price');
        action = 'skip';
      } else if (!m) action = 'new';
      else if (!SURE.includes(m.how)) {
        warnings.push('Please confirm this is the same product');
        action = 'check';
      } else action = now === r.salePriceMinor ? 'same' : 'update';
      if (r.salePriceMinor !== null && r.costPriceMinor !== null && r.costPriceMinor > r.salePriceMinor) {
        warnings.push('Cost is above the selling price');
        if (action !== 'skip') action = 'check';
      }
      if (m && now && r.salePriceMinor && Math.abs(r.salePriceMinor - now) / now > BIG_CHANGE) {
        warnings.push(`Price changes by ${Math.round(((r.salePriceMinor - now) / now) * 100)}%`);
        if (action === 'update') action = 'check';
      }
      return {
        key: `${r.sheet}:${r.line}`,
        ...r,
        match: m ? { variantId: m.c.variantId, sku: m.c.sku, product: m.c.label, currentPriceMinor: now, how: m.how } : null,
        action,
        warnings,
      };
    });

    // Two rows for one product at different prices: neither goes through on its own.
    const byVariant = new Map<string, typeof out>();
    for (const r of out) if (r.match) byVariant.set(r.match.variantId, [...(byVariant.get(r.match.variantId) ?? []), r]);
    for (const list of byVariant.values()) {
      if (list.length > 1 && new Set(list.map((r) => r.salePriceMinor)).size > 1) {
        for (const r of list) {
          r.warnings.push(`${list.length} rows match ${r.match!.product} at different prices`);
          if (r.action !== 'skip') r.action = 'check';
        }
      }
    }

    const count = (a: PriceAction) => out.filter((r) => r.action === a).length;
    return {
      division: { slug: d.slug, name: d.name, isPharmacy: d.code === DivisionCode.PHARMACY },
      fileName: file.originalname,
      skippedSheets,
      summary: { rows: out.length, update: count('update'), same: count('same'), new: count('new'), check: count('check'), skip: count('skip') },
      rows: out,
    };
  }

  async apply(user: AuthUser, dto: ApplyPriceListDto) {
    const d = await this.divisions.resolve(dto.division);
    user.assertCan(P.catalogManage, d.id);
    const ids = [...new Set(dto.items.map((i) => i.variantId).filter((x): x is string => !!x))];
    const known = await this.prisma.productVariant.findMany({
      where: { id: { in: ids }, product: { divisionId: d.id } },
      select: { id: true, sku: true, unitPriceMinor: true, recordedStockQty: true, stockCode: true, productId: true },
    });
    const byId = new Map(known.map((v) => [v.id, v]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length) throw new BadRequestException('Some rows point at products that are not in this store. Please preview the file again.');

    const pharmacy = d.code === DivisionCode.PHARMACY;
    const today = new Date(new Date().toISOString().slice(0, 10));
    const prefix = SKU_PREFIX[d.code] ?? `NMP-${d.code.slice(0, 3)}-U`;
    const last = await this.prisma.productVariant.findFirst({ where: { sku: { startsWith: prefix } }, orderBy: { sku: 'desc' }, select: { sku: true } });
    let next = last ? Number(last.sku.slice(prefix.length)) + 1 || 1 : 1;
    const location = await this.prisma.stockLocation.findFirst({ where: { divisionId: d.id, isDefault: true, isActive: true }, select: { id: true } });

    const result = await this.prisma.$transaction(
      async (tx) => {
        let updated = 0;
        let created = 0;
        const changes: { sku: string; from: number | null; to: number | null }[] = [];
        for (const item of dto.items) {
          const code = item.code?.trim() || null;
          if (item.variantId) {
            const v = byId.get(item.variantId)!;
            const keepCode = code && code.toUpperCase() !== v.sku.toUpperCase() ? code : undefined;
            await tx.productVariant.update({
              where: { id: v.id },
              data: {
                ...(item.salePriceMinor ? { unitPriceMinor: BigInt(item.salePriceMinor) } : {}),
                ...(item.quantity !== null && item.quantity !== undefined ? { recordedStockQty: item.quantity, recordedStockAt: today } : {}),
                ...(keepCode ? { stockCode: keepCode } : {}),
              },
            });
            changes.push({ sku: v.sku, from: v.unitPriceMinor === null ? null : Number(v.unitPriceMinor), to: item.salePriceMinor ?? null });
            updated++;
          } else {
            const sku = `${prefix}${String(next++).padStart(4, '0')}`;
            const name = tidyName(item.name);
            const product = await tx.product.create({
              data: {
                divisionId: d.id,
                name,
                slug: `${slugOf(name) || 'item'}-${sku.toLowerCase()}`,
                // Pharmacy items wait for the pharmacist and cannot be bought until then.
                // Other stores' new items stay drafts until staff publish them.
                status: pharmacy ? ProductStatus.ACTIVE : ProductStatus.DRAFT,
                ...(pharmacy ? { prescriptionStatus: PrescriptionStatus.NOT_REVIEWED, purchaseEnabled: false, isDeliverable: false } : {}),
                verificationNote: `Added from price list ${dto.fileName ?? ''}`.trim(),
                variants: {
                  create: {
                    sku,
                    name: 'As listed',
                    stockCode: code,
                    unitPriceMinor: item.salePriceMinor ? BigInt(item.salePriceMinor) : null,
                    recordedStockQty: item.quantity ?? null,
                    recordedStockAt: item.quantity !== null && item.quantity !== undefined ? today : null,
                  },
                },
              },
              include: { variants: { select: { id: true } } },
            });
            if (location) await tx.stockLevel.createMany({ data: product.variants.map((v) => ({ variantId: v.id, locationId: location.id })), skipDuplicates: true });
            changes.push({ sku, from: null, to: item.salePriceMinor ?? null });
            created++;
          }
        }
        await this.audit.record(
          { actorId: user.id, action: 'catalog.price_list', entityType: 'division', entityId: d.id, divisionId: d.id, changes: { fileName: dto.fileName, updated, created, prices: changes } },
          tx,
        );
        return { updated, created };
      },
      { timeout: 180_000, maxWait: 20_000 },
    );
    return { ...result, division: d.slug };
  }
}
