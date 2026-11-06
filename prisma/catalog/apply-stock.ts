/**
 * Imports the stock lists supplied on 2026-11-06 (stock-2026-11.json).
 *
 *   npm run catalog:stock
 *
 * Run once, after catalog:apply. Later runs would overwrite names, descriptions
 * and prices edited in the dashboard, so run it again only on purpose.
 *
 * Water: the 15 listed items, with prices cleared and shown as in stock from the
 * list. Items not on the list are archived, not deleted.
 *
 * Pharmacy: every row, unapproved and hidden from customers. The 29 October
 * quantity is kept as a dated record and is not usable stock. Nothing is inferred
 * about ingredients, strengths, prescription status, pack sizes or photos.
 *
 * Vehicles: the supplied list replaces the earlier listings, which are archived.
 * Supplied prices are kept as given, including ones that look wrong.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DivisionCode, PrescriptionStatus, Prisma, PrismaClient, ProductAvailability, ProductStatus, ServicePricingType, VehicleStatus } from '@prisma/client';

const prisma = new PrismaClient();
const data = JSON.parse(readFileSync(join(__dirname, 'stock-2026-11.json'), 'utf8'));
const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-');
type Tx = Prisma.TransactionClient;

async function mainLocation(tx: Tx, divisionId: string, code: string, name: string) {
  const existing = await tx.stockLocation.findUnique({ where: { code } });
  if (existing) return existing;
  await tx.stockLocation.updateMany({ where: { divisionId, isDefault: true }, data: { isDefault: false } });
  return tx.stockLocation.create({ data: { code, name, divisionId, isDefault: true, city: 'Abuja', state: 'FCT' } });
}

async function category(tx: Tx, divisionId: string, name: string, sortOrder: number) {
  const slug = slugify(name);
  return tx.productCategory.upsert({
    where: { divisionId_slug: { divisionId, slug } },
    create: { divisionId, slug, name, sortOrder },
    update: { name, sortOrder, isActive: true },
  });
}

async function importWater(tx: Tx) {
  const division = await tx.division.findUniqueOrThrow({ where: { code: DivisionCode.WATER_DRINKS_WINES } });
  const location = await mainLocation(tx, division.id, 'WDW-MAIN', 'Water, Drinks & Wines — main store');
  const water = await category(tx, division.id, 'Water', 0);
  const skus: string[] = data.water.map((w: { sku: string }) => w.sku);

  let matched = 0;
  let created = 0;
  for (const w of data.water) {
    const product = {
      name: w.name, brand: w.brand, description: w.description, categoryId: water.id, status: ProductStatus.ACTIVE,
      listedAvailability: ProductAvailability.IN_STOCK, purchaseEnabled: false, verificationNote: w.note,
    };
    const variant = await tx.productVariant.findUnique({ where: { sku: w.sku } });
    if (variant) {
      await tx.productVariant.update({ where: { id: variant.id }, data: { name: w.size, unitPriceMinor: null, compareAtPriceMinor: null, unitsPerPack: 1, minOrderQty: 1, maxOrderQty: null, isActive: true } });
      await tx.product.update({ where: { id: variant.productId }, data: product });
      matched++;
    } else {
      const made = await tx.product.create({
        data: { ...product, divisionId: division.id, slug: `${slugify(w.name)}-${w.sku.toLowerCase()}`, variants: { create: { sku: w.sku, name: w.size, unitPriceMinor: null } } },
        include: { variants: true },
      });
      await tx.stockLevel.create({ data: { variantId: made.variants[0].id, locationId: location.id, quantityOnHand: 0, reorderLevel: 5 } });
      created++;
    }
  }

  // Older water products that are not on the list. Other drinks are left alone.
  const old = await tx.productVariant.findMany({ where: { sku: { startsWith: 'NMP-WTR-', notIn: skus } }, select: { productId: true } });
  const archived = await tx.product.updateMany({ where: { id: { in: old.map((v) => v.productId) } }, data: { status: ProductStatus.ARCHIVED } });
  const emptied = await tx.productCategory.updateMany({
    where: { divisionId: division.id, slug: { in: ['venida-products-flagship-brand', 'other-drinking-dispenser-water-products'] }, products: { none: { status: { not: ProductStatus.ARCHIVED } } } },
    data: { isActive: false },
  });
  return { matched, created, archived: archived.count, oldCategoriesOff: emptied.count };
}

async function importPharmacy(tx: Tx) {
  const division = await tx.division.findUniqueOrThrow({ where: { code: DivisionCode.PHARMACY } });
  const location = await mainLocation(tx, division.id, 'PHM-MAIN', 'Pharmacy — main store');
  const recordedAt = new Date(`${data.recordedStockDate}T00:00:00.000Z`);
  const categories = new Map<string, string>();
  for (const p of data.pharmacy) {
    if (!categories.has(p.category)) categories.set(p.category, (await category(tx, division.id, p.category, categories.size)).id);
  }
  let created = 0;
  let updated = 0;
  for (const p of data.pharmacy) {
    const fields = {
      name: p.name, description: p.description, categoryId: categories.get(p.category)!, verificationNote: p.verification,
      status: ProductStatus.ACTIVE, purchaseEnabled: false, prescriptionStatus: PrescriptionStatus.NOT_REVIEWED, isDeliverable: false,
    };
    const variant = await tx.productVariant.findUnique({ where: { sku: p.sku } });
    if (variant) {
      await tx.productVariant.update({ where: { id: variant.id }, data: { recordedStockQty: p.recordedQty, recordedStockAt: recordedAt } });
      await tx.product.update({ where: { id: variant.productId }, data: fields });
      updated++;
    } else {
      const made = await tx.product.create({
        data: {
          ...fields, divisionId: division.id, slug: `${slugify(p.name)}-${p.sku.toLowerCase()}`,
          variants: { create: { sku: p.sku, name: 'As listed', unitPriceMinor: null, recordedStockQty: p.recordedQty, recordedStockAt: recordedAt } },
        },
        include: { variants: true },
      });
      await tx.stockLevel.create({ data: { variantId: made.variants[0].id, locationId: location.id, quantityOnHand: 0, reorderLevel: 0 } });
      created++;
    }
  }

  // Bookable services. No test menu or price has been supplied, so staff quote each request.
  const services = [
    { code: 'PHM-PHARMACIST-CONSULT', name: 'Pharmacist consultation', description: 'Book a time to speak with a Nimpat pharmacist.' },
    { code: 'PHM-PRESCRIPTION-REVIEW', name: 'Prescription review', description: 'Book a pharmacist to review your prescription before you buy.' },
    { code: 'LAB-TEST-BOOKING', name: 'Laboratory test booking', description: 'Request a laboratory appointment. Tell us which test you need, and we will confirm the time and price.' },
  ];
  for (const s of services) {
    await tx.serviceOffering.upsert({ where: { code: s.code }, create: { ...s, divisionId: division.id, pricingType: ServicePricingType.QUOTE_REQUIRED }, update: {} });
  }
  return { created, updated, categories: categories.size, services: services.length };
}

async function importVehicles(tx: Tx) {
  const division = await tx.division.findUniqueOrThrow({ where: { code: DivisionCode.AUTOMOBILES } });
  const slugs: string[] = [];
  for (const v of data.vehicles) {
    const slug = `${slugify(`${v.make} ${v.model} ${v.year}`)}-r${v.row}`;
    slugs.push(slug);
    const fields = { make: v.make, model: v.model, year: v.year, priceMinor: v.priceNaira === null ? null : BigInt(v.priceNaira) * 100n, status: v.status as VehicleStatus };
    await tx.vehicle.upsert({ where: { slug }, create: { ...fields, slug, divisionId: division.id }, update: fields });
  }
  const archived = await tx.vehicle.updateMany({
    where: { divisionId: division.id, slug: { notIn: slugs }, status: { not: VehicleStatus.ARCHIVED }, make: { not: 'DevSample' } },
    data: { status: VehicleStatus.ARCHIVED },
  });
  return { listed: slugs.length, earlierListingsArchived: archived.count };
}

async function main() {
  const result = await prisma.$transaction(
    async (tx) => ({ water: await importWater(tx), pharmacy: await importPharmacy(tx), vehicles: await importVehicles(tx) }),
    { timeout: 180_000, maxWait: 20_000 },
  );
  console.log(result);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
