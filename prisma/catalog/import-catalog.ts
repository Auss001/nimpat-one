/**
 * Imports the Nimpat One catalogue (prisma/catalog/nimpat-catalog.json).
 *
 *   npm run catalog:import
 *
 * Safe to run repeatedly: it only CREATES items that do not exist yet
 * (matched by SKU / slug / code). Anything already in the database — for
 * example a price changed in the admin dashboard — is left untouched.
 *
 * It also switches off the "[DEV SAMPLE]" placeholder data from the seed
 * (archived / inactive, never deleted).
 *
 * Opening stock is 0 for every product: no real counts were supplied.
 * Set stock in the dashboard (Stock → Receive) before selling.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DivisionCode, ListingStatus, PrismaClient, ProductStatus, VehicleCondition, VehicleStatus } from '@prisma/client';

const prisma = new PrismaClient();
const data = JSON.parse(readFileSync(join(__dirname, 'nimpat-catalog.json'), 'utf8'));
const created: Record<string, number> = {};
const bump = (k: string) => (created[k] = (created[k] ?? 0) + 1);

const DRINK_CATEGORIES: [string, string][] = [
  ['table-water', 'Table Water'],
  ['dispenser-water', 'Dispenser Water'],
  ['juices-and-soft-drinks', 'Juices & Soft Drinks'],
  ['energy-drinks', 'Energy Drinks'],
  ['wines-and-ports', 'Wines & Ports'],
  ['spirits-and-liqueurs', 'Spirits, Whiskies & Cognacs'],
  ['champagnes', 'Champagnes'],
];
const RETAIL_CATEGORIES: [string, string][] = [
  ['office-supplies', 'Office Supplies'],
  ['safety-gear', 'Safety Gear'],
  ['cleaning-chemicals', 'Cleaning & Sanitation'],
];

async function division(code: DivisionCode) {
  return prisma.division.findUniqueOrThrow({ where: { code } });
}

/** Ensures the division has an active default stock location. */
async function mainLocation(divisionId: string, code: string, name: string) {
  const existing = await prisma.stockLocation.findUnique({ where: { code } });
  if (existing) return existing;
  await prisma.stockLocation.updateMany({ where: { divisionId, isDefault: true }, data: { isDefault: false } });
  bump('stock locations');
  return prisma.stockLocation.create({ data: { code, name, divisionId, isDefault: true, city: 'Abuja', state: 'FCT' } });
}

async function importProducts(
  divisionCode: DivisionCode,
  categories: [string, string][],
  items: any[],
  location: { id: string },
) {
  const d = await division(divisionCode);
  const catIds = new Map<string, string>();
  for (const [i, [slug, name]] of categories.entries()) {
    const c = await prisma.productCategory.upsert({
      where: { divisionId_slug: { divisionId: d.id, slug } },
      create: { divisionId: d.id, slug, name, sortOrder: i },
      update: {},
    });
    catIds.set(slug, c.id);
  }
  for (const p of items) {
    const existingVariant = await prisma.productVariant.findUnique({ where: { sku: p.sku } });
    if (existingVariant) continue;
    const product = await prisma.product.create({
      data: {
        divisionId: d.id,
        categoryId: catIds.get(p.category) ?? null,
        name: p.name,
        slug: (await prisma.product.findUnique({ where: { slug: p.slug } })) ? `${p.slug}-${p.sku.toLowerCase()}` : p.slug,
        brand: p.brand ?? null,
        description: p.description,
        status: ProductStatus.ACTIVE,
        isAgeRestricted: !!p.isAgeRestricted,
        images: p.image ? { create: { url: p.image, altText: p.name } } : undefined,
        variants: {
          create: {
            sku: p.sku,
            name: p.variantName,
            unitPriceMinor: BigInt(p.priceMinor),
            unitsPerPack: p.unitsPerPack ?? 1,
            minOrderQty: p.minOrderQty ?? 1,
          },
        },
      },
      include: { variants: true },
    });
    await prisma.stockLevel.create({ data: { variantId: product.variants[0].id, locationId: location.id, quantityOnHand: 0, reorderLevel: 5 } });
    bump(`${divisionCode} products`);
  }
}

async function importApartments() {
  const d = await division('LUXURY_APARTMENTS');
  for (const p of data.apartments) {
    let property = await prisma.property.findUnique({ where: { slug: p.slug } });
    if (!property) {
      property = await prisma.property.create({
        data: {
          divisionId: d.id, slug: p.slug, name: p.name, description: p.description, addressLine: p.addressLine,
          city: p.city, state: p.state, amenities: p.amenities, status: ListingStatus.ACTIVE,
        },
      });
      bump('properties');
    }
    for (const u of p.units) {
      const exists = await prisma.apartmentUnit.findUnique({ where: { propertyId_code: { propertyId: property.id, code: u.code } } });
      if (exists) continue;
      const unit = await prisma.apartmentUnit.create({
        data: {
          propertyId: property.id, code: u.code, name: u.name, description: u.description, bedrooms: u.bedrooms,
          bathrooms: u.bathrooms, maxGuests: u.maxGuests, nightlyRateMinor: BigInt(u.nightlyRateMinor),
          cautionDepositMinor: BigInt(u.cautionDepositMinor), cleaningFeeMinor: BigInt(u.cleaningFeeMinor), status: ListingStatus.ACTIVE,
        },
      });
      for (const [i, url] of (u.images as string[]).entries()) {
        await prisma.propertyImage.create({ data: { propertyId: property.id, unitId: unit.id, url, altText: u.name, sortOrder: i } });
      }
      bump('apartment units');
    }
  }
}

async function importVehicles() {
  const d = await division('AUTOMOBILES');
  for (const v of data.vehicles) {
    if (await prisma.vehicle.findUnique({ where: { slug: v.slug } })) continue;
    if (v.vin && (await prisma.vehicle.findUnique({ where: { vin: v.vin } }))) continue;
    await prisma.vehicle.create({
      data: {
        divisionId: d.id, slug: v.slug, make: v.make, model: v.model, year: v.year, condition: v.condition as VehicleCondition,
        transmission: v.transmission, fuelType: v.fuelType, colour: v.colour, mileageKm: v.mileageKm, vin: v.vin,
        priceMinor: BigInt(v.priceMinor), customsCleared: v.customsCleared, description: v.description, specs: v.specs,
        status: VehicleStatus.AVAILABLE,
        images: { create: (v.images as string[]).map((url, i) => ({ url, altText: `${v.make} ${v.model}`, sortOrder: i })) },
      },
    });
    bump('vehicles');
  }
}

async function importSpa() {
  const d = await division('SPA_WELLNESS');
  for (const s of data.spa) {
    if (await prisma.spaTreatment.findUnique({ where: { slug: s.slug } })) continue;
    await prisma.spaTreatment.create({
      data: {
        divisionId: d.id, slug: s.slug, name: s.name, category: s.category, description: s.description,
        durationMinutes: s.durationMinutes, priceMinor: BigInt(s.priceMinor), depositMinor: 0n,
      },
    });
    bump('spa treatments');
  }
}

async function importServices() {
  for (const s of data.services) {
    if (await prisma.serviceOffering.findUnique({ where: { code: s.code } })) continue;
    const d = await division(s.division);
    await prisma.serviceOffering.create({
      data: {
        divisionId: d.id, code: s.code, name: s.name, description: s.description, pricingType: s.pricingType,
        basePriceMinor: s.basePriceMinor != null ? BigInt(s.basePriceMinor) : null,
        depositMinor: s.depositMinor != null ? BigInt(s.depositMinor) : null,
        durationMinutes: s.durationMinutes,
      },
    });
    bump('services, rentals & listings');
  }
}

/** Switches off the seed's [DEV SAMPLE] placeholders (non-destructive). */
async function retireDevSamples() {
  const r = await Promise.all([
    prisma.product.updateMany({ where: { name: { startsWith: '[DEV SAMPLE]' }, status: { not: ProductStatus.ARCHIVED } }, data: { status: ProductStatus.ARCHIVED } }),
    prisma.productCategory.updateMany({ where: { name: { startsWith: '[DEV SAMPLE]' }, isActive: true }, data: { isActive: false } }),
    prisma.apartmentUnit.updateMany({ where: { name: { startsWith: '[DEV SAMPLE]' }, status: { not: ListingStatus.INACTIVE } }, data: { status: ListingStatus.INACTIVE } }),
    prisma.property.updateMany({ where: { name: { startsWith: '[DEV SAMPLE]' }, status: { not: ListingStatus.INACTIVE } }, data: { status: ListingStatus.INACTIVE } }),
    prisma.spaTreatment.updateMany({ where: { name: { startsWith: '[DEV SAMPLE]' }, isActive: true }, data: { isActive: false } }),
    prisma.spaPractitioner.updateMany({ where: { displayName: { startsWith: '[DEV SAMPLE]' }, isActive: true }, data: { isActive: false } }),
    prisma.vehicle.updateMany({ where: { make: 'DevSample', status: { not: VehicleStatus.ARCHIVED } }, data: { status: VehicleStatus.ARCHIVED } }),
    prisma.serviceOffering.updateMany({ where: { name: { startsWith: '[DEV SAMPLE]' }, isActive: true }, data: { isActive: false } }),
    prisma.stockLocation.updateMany({ where: { name: { startsWith: '[DEV SAMPLE]' }, isActive: true }, data: { isActive: false, isDefault: false } }),
  ]);
  const n = r.reduce((s, x) => s + x.count, 0);
  if (n) created['[DEV SAMPLE] items switched off'] = n;
}

async function main() {
  await retireDevSamples();
  const wdw = await division('WATER_DRINKS_WINES');
  const rtl = await division('RETAIL_GENERAL_SUPPLIES');
  const wdwLoc = await mainLocation(wdw.id, 'WDW-MAIN', 'Water, Drinks & Wines — main store');
  const rtlLoc = await mainLocation(rtl.id, 'RTL-MAIN', 'Retail & General Supplies — main store');
  await importProducts('WATER_DRINKS_WINES', DRINK_CATEGORIES, data.drinks, wdwLoc);
  await importProducts('RETAIL_GENERAL_SUPPLIES', RETAIL_CATEGORIES, data.retail, rtlLoc);
  await importApartments();
  await importVehicles();
  await importSpa();
  await importServices();
  console.log(Object.keys(created).length ? created : 'Nothing new to import — catalogue already loaded.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
