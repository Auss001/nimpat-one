/**
 * Applies the catalogue supplied on 2026-11-06 (catalogue-2026-11.json).
 *
 *   npm run catalog:apply
 *
 * Run this once, after catalog:import. Later runs would overwrite names, packs
 * and photos edited in the dashboard, so run it again only on purpose.
 *
 * Prices of existing products are never changed here. Products are not marked
 * as confirmed, so the mockup photos stay away from customers until staff check
 * the record. An item marked "Pending accurate photo" loses its old shared
 * picture: no photo is better than a picture of the wrong product.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma, PrismaClient, ProductStatus } from '@prisma/client';

const prisma = new PrismaClient();
const catalogue = JSON.parse(readFileSync(join(__dirname, 'catalogue-2026-11.json'), 'utf8'));
const base = JSON.parse(readFileSync(join(__dirname, 'nimpat-catalog.json'), 'utf8'));

const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-');

interface Item {
  sku: string;
  name: string;
  brand: string;
  category: string;
  packaging: string;
  priceNaira: number;
  image: string | null;
}

async function applyProducts(tx: Prisma.TransactionClient) {
  const items: Item[] = catalogue.items;
  const drinks = await tx.division.findUniqueOrThrow({ where: { code: 'WATER_DRINKS_WINES' } });
  const retail = await tx.division.findUniqueOrThrow({ where: { code: 'RETAIL_GENERAL_SUPPLIES' } });
  const divisionOf = (i: Item) => (i.sku.startsWith('NMP-SUP') ? retail : drinks);

  // Categories, in the order the catalogue lists them.
  const categoryIds = new Map<string, string>();
  for (const [order, item] of items.entries()) {
    const key = `${divisionOf(item).id}:${item.category}`;
    if (categoryIds.has(key)) continue;
    const d = divisionOf(item);
    const slug = slugify(item.category);
    const c = await tx.productCategory.upsert({
      where: { divisionId_slug: { divisionId: d.id, slug } },
      create: { divisionId: d.id, slug, name: item.category, sortOrder: order },
      update: { name: item.category, sortOrder: order, isActive: true },
    });
    categoryIds.set(key, c.id);
  }

  const counts = { updated: 0, created: 0, withPhoto: 0, withoutPhoto: 0, priceDifferences: [] as string[] };
  for (const item of items) {
    const d = divisionOf(item);
    const categoryId = categoryIds.get(`${d.id}:${item.category}`)!;
    const photo = item.image ? { create: { url: item.image, altText: item.name } } : undefined;
    const variant = await tx.productVariant.findUnique({ where: { sku: item.sku } });
    if (variant) {
      if (Number(variant.unitPriceMinor) !== item.priceNaira * 100) {
        counts.priceDifferences.push(`${item.sku}: system ${Number(variant.unitPriceMinor) / 100}, catalogue ${item.priceNaira}`);
      }
      await tx.productVariant.update({ where: { id: variant.id }, data: { name: item.packaging } });
      await tx.productImage.deleteMany({ where: { productId: variant.productId } });
      await tx.product.update({
        where: { id: variant.productId },
        data: { name: item.name, brand: item.brand, categoryId, images: photo },
      });
      counts.updated++;
    } else {
      const location = await tx.stockLocation.findFirstOrThrow({ where: { divisionId: d.id, isDefault: true, isActive: true } });
      const product = await tx.product.create({
        data: {
          divisionId: d.id, categoryId, name: item.name, slug: slugify(item.name), brand: item.brand, status: ProductStatus.ACTIVE,
          images: photo,
          variants: { create: { sku: item.sku, name: item.packaging, unitPriceMinor: BigInt(item.priceNaira * 100) } },
        },
        include: { variants: true },
      });
      await tx.stockLevel.create({ data: { variantId: product.variants[0].id, locationId: location.id, quantityOnHand: 0, reorderLevel: 5 } });
      counts.created++;
    }
    if (item.image) counts.withPhoto++;
    else counts.withoutPhoto++;
  }

  // Categories the new catalogue no longer uses are switched off, once empty.
  const emptied = await tx.productCategory.updateMany({
    where: { divisionId: { in: [drinks.id, retail.id] }, id: { notIn: [...categoryIds.values()] }, products: { none: {} }, isActive: true },
    data: { isActive: false },
  });
  return { ...counts, oldCategoriesSwitchedOff: emptied.count };
}

const LOCATION_RULES: [RegExp, string][] = [[/mabushi/i, 'Mabushi'], [/wuye/i, 'Wuye'], [/lagos/i, 'Lagos'], [/port harcourt/i, 'Port Harcourt']];

async function applyApartments(tx: Prisma.TransactionClient) {
  // Locations, for a database created after the migration ran.
  const properties = await tx.property.findMany({ where: { location: null } });
  let located = 0;
  for (const p of properties) {
    const rule = LOCATION_RULES.find(([re]) => re.test(`${p.addressLine} ${p.city}`));
    if (!rule) continue;
    await tx.property.update({ where: { id: p.id }, data: { location: rule[1] } });
    located++;
  }

  // Mabushi flats get exactly the photos listed for them in the catalogue.
  const source = base.apartments.find((p: { name: string }) => /mabushi/i.test(p.name));
  const property = await tx.property.findFirstOrThrow({ where: { slug: source.slug }, include: { units: true } });
  let photos = 0;
  for (const u of source.units as { code: string; name: string; images: string[] }[]) {
    const unit = property.units.find((x) => x.code === u.code);
    if (!unit) throw new Error(`Mabushi unit not found: ${u.code}`);
    await tx.propertyImage.deleteMany({ where: { unitId: unit.id } });
    await tx.propertyImage.createMany({
      data: u.images.map((url, sortOrder) => ({ propertyId: property.id, unitId: unit.id, url, altText: unit.name, sortOrder })),
    });
    photos += u.images.length;
  }
  return { locationsSet: located, mabushiPhotos: photos };
}

async function main() {
  console.log(await prisma.$transaction(async (tx) => ({ products: await applyProducts(tx), apartments: await applyApartments(tx) }), { timeout: 60000 }));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
