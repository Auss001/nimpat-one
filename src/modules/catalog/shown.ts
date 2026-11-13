import { PrescriptionStatus, Prisma, ProductAvailability, ProductStatus, RecordVerification } from '@prisma/client';
import { PrismaService, Tx } from '../../prisma/prisma.service';

/**
 * What customers see in the shops (owner, 11 November 2026): anything with a price and a photo shows and
 * can be bought, without waiting for staff to confirm it; confirmed products show as before. Archived
 * products and development samples never show, and pharmacy items still need the pharmacist before sale.
 * Supplies (office, safety, cleaning) only show with a real photo (owner, 12 November 2026): without one they
 * look like placeholders.
 */
export const PHOTO_REQUIRED_DIVISIONS = ['retail-general-supplies'];

/**
 * Customers only see what they can buy right now (owner, 13 November 2026). Anything marked out of stock, switched off
 * for sale, without a published price, or (in the pharmacy) waiting for the pharmacist or needing a prescription,
 * leaves the customer pages by itself, and comes back as soon as it can be bought again. Staff still see everything.
 */
export const BUYABLE_NOW: Prisma.ProductWhereInput = {
  purchaseEnabled: true,
  OR: [{ listedAvailability: null }, { listedAvailability: { not: ProductAvailability.OUT_OF_STOCK } }],
  variants: { some: { isActive: true, unitPriceMinor: { gt: 0 } } },
  AND: [{
    OR: [
      { prescriptionStatus: null },
      { prescriptionStatus: PrescriptionStatus.NOT_REQUIRED, pharmacistApprovedAt: { not: null } },
    ],
  }],
};

export const SHOWN_PRODUCT: Prisma.ProductWhereInput = {
  status: { not: ProductStatus.ARCHIVED },
  AND: [{ OR: [{ images: { some: {} } }, { division: { slug: { notIn: PHOTO_REQUIRED_DIVISIONS } } }] }, BUYABLE_NOW],
  OR: [
    { status: ProductStatus.ACTIVE, verification: RecordVerification.VERIFIED },
    {
      verification: { not: RecordVerification.DEV_SAMPLE },
      images: { some: {} },
      variants: { some: { isActive: true, unitPriceMinor: { gt: 0 } } },
    },
  ],
};

/** The ids among these products that customers may see and buy. */
export async function shownProductIds(db: PrismaService | Tx, productIds: string[]): Promise<Set<string>> {
  if (!productIds.length) return new Set();
  const rows = await db.product.findMany({ where: { id: { in: [...new Set(productIds)] }, ...SHOWN_PRODUCT }, select: { id: true } });
  return new Set(rows.map((r) => r.id));
}
