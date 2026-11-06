/**
 * Development seed — idempotent (safe to run repeatedly).
 *
 * Always seeds reference data the platform needs to run:
 *   divisions, departments, roles, permissions, loyalty earn rules,
 *   and one local Super Administrator (SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD).
 *
 * With SEED_SAMPLE_DATA=true it also adds obviously-fake listings, every one
 * prefixed "[DEV SAMPLE]", so the API can be exercised locally. These are NOT
 * real Nimpat products, prices, properties or staff and must never be loaded
 * into production. Real catalogue data is entered through the admin API.
 */
import { DivisionCode, DivisionKind, ListingStatus, PrismaClient, ProductStatus, RoleCode, UserType, VehicleCondition, VehicleStatus } from '@prisma/client';
import { hashPassword } from '../src/common/utils/crypto';
import { ROLE_DEFINITIONS } from '../src/modules/access/permissions';

const prisma = new PrismaClient();

const DIVISIONS: { code: DivisionCode; name: string; slug: string; kind: DivisionKind; description: string }[] = [
  { code: 'WATER_DRINKS_WINES', name: 'Nimpat Water, Drinks & Wines', slug: 'water-drinks-wines', kind: 'PRIMARY', description: 'Table water, soft drinks, juices and wines.' },
  { code: 'LUXURY_APARTMENTS', name: 'Nimpat Luxury Apartments', slug: 'luxury-apartments', kind: 'PRIMARY', description: 'Serviced luxury apartments.' },
  { code: 'AUTOMOBILES', name: 'Nimpat Automobiles', slug: 'automobiles', kind: 'PRIMARY', description: 'Vehicle sales and automotive services.' },
  { code: 'SPA_WELLNESS', name: 'Nimpat Spa & Wellness', slug: 'spa-wellness', kind: 'PRIMARY', description: 'Spa treatments and wellness services.' },
  { code: 'TRANSPORT_LOGISTICS', name: 'Nimpat Transport & Logistics', slug: 'transport-logistics', kind: 'PRIMARY', description: 'Dispatch, haulage and logistics.' },
  { code: 'RETAIL_GENERAL_SUPPLIES', name: 'Nimpat Retail & General Supplies', slug: 'retail-general-supplies', kind: 'PRIMARY', description: 'Retail and general supplies.' },
  { code: 'MEDIA_EVENTS_RENTALS', name: 'Nimpat Media, Events & Rentals', slug: 'media-events-rentals', kind: 'PRIMARY', description: 'Media production, events and equipment rentals.' },
  { code: 'REAL_ESTATE_INTERIOR', name: 'Nimpat Real Estate & Interior Design', slug: 'real-estate-interior-design', kind: 'PRIMARY', description: 'Real estate and interior design.' },
  { code: 'ENTERTAINMENT', name: 'Nimpat Entertainment', slug: 'entertainment', kind: 'DISCOVERY', description: 'Club, pool, arcade, PS5 gaming and events.' },
];

const PREFIX: Record<DivisionCode, string> = {
  WATER_DRINKS_WINES: 'WDW', LUXURY_APARTMENTS: 'APT', AUTOMOBILES: 'AUT', SPA_WELLNESS: 'SPA', TRANSPORT_LOGISTICS: 'LOG',
  RETAIL_GENERAL_SUPPLIES: 'RTL', MEDIA_EVENTS_RENTALS: 'MER', REAL_ESTATE_INTERIOR: 'RED', ENTERTAINMENT: 'ENT',
};

/** Earn rates from the Nimpat One architecture brief (hundredths of a point per ₦100). */
const LOYALTY_RATES: Partial<Record<DivisionCode, number>> = {
  WATER_DRINKS_WINES: 100,
  LUXURY_APARTMENTS: 200,
  AUTOMOBILES: 150,
  SPA_WELLNESS: 200,
};

async function seedReferenceData() {
  for (const [i, d] of DIVISIONS.entries()) {
    await prisma.division.upsert({ where: { code: d.code }, create: { ...d, sortOrder: i + 1 }, update: { name: d.name, slug: d.slug, kind: d.kind, sortOrder: i + 1 } });
  }
  const divisions = await prisma.division.findMany();
  const byCode = new Map(divisions.map((d) => [d.code, d]));

  for (const d of divisions) {
    const code = `${PREFIX[d.code]}-OPS`;
    await prisma.department.upsert({ where: { code }, create: { code, name: `${d.name} — Operations`, divisionId: d.id }, update: {} });
  }
  for (const [code, name] of [['GRP-MGMT', 'Group Management'], ['GRP-FIN', 'Group Finance'], ['GRP-SUPPORT', 'Customer Support'], ['GRP-IT', 'Information Technology']]) {
    await prisma.department.upsert({ where: { code }, create: { code, name }, update: {} });
  }

  // Roles & permissions — kept in sync with src/modules/access/permissions.ts
  const allCodes = [...new Set(Object.values(ROLE_DEFINITIONS).flatMap((r) => r.permissions))];
  for (const code of allCodes) await prisma.permission.upsert({ where: { code }, create: { code }, update: {} });
  const perms = new Map((await prisma.permission.findMany()).map((p) => [p.code, p.id]));
  for (const [code, def] of Object.entries(ROLE_DEFINITIONS) as [RoleCode, (typeof ROLE_DEFINITIONS)[RoleCode]][]) {
    const role = await prisma.role.upsert({
      where: { code },
      create: { code, name: def.name, description: def.description, isDivisionScoped: def.isDivisionScoped },
      update: { name: def.name, description: def.description, isDivisionScoped: def.isDivisionScoped },
    });
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({ data: def.permissions.map((p) => ({ roleId: role.id, permissionId: perms.get(p)! })) });
  }

  for (const [code, rate] of Object.entries(LOYALTY_RATES) as [DivisionCode, number][]) {
    const divisionId = byCode.get(code)!.id;
    await prisma.loyaltyRule.upsert({ where: { divisionId }, create: { divisionId, pointsPer100NgnX100: rate }, update: { pointsPer100NgnX100: rate } });
  }
  return byCode;
}

async function seedAdmin() {
  const email = process.env.SEED_ADMIN_EMAIL?.toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password) {
    console.log('SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD not set — skipping admin user');
    return;
  }
  const role = await prisma.role.findUniqueOrThrow({ where: { code: 'SUPER_ADMIN' } });
  const dept = await prisma.department.findUnique({ where: { code: 'GRP-IT' } });
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`Admin ${email} already exists — leaving password unchanged`);
    return;
  }
  await prisma.user.create({
    data: {
      email,
      passwordHash: await hashPassword(password),
      type: UserType.STAFF,
      emailVerifiedAt: new Date(),
      staffProfile: { create: { firstName: 'Dev', lastName: 'Administrator', employeeNumber: 'DEV-0001', jobTitle: 'Local development administrator', departmentId: dept?.id } },
      roles: { create: { roleId: role.id } },
    },
  });
  console.log(`Created local Super Administrator ${email}`);
}

async function seedSamples(byCode: Map<DivisionCode, { id: string }>) {
  const wdw = byCode.get('WATER_DRINKS_WINES')!.id;

  // Stock location & delivery zones
  const loc = await prisma.stockLocation.upsert({
    where: { code: 'DEV-WDW-DEPOT' },
    create: { code: 'DEV-WDW-DEPOT', name: '[DEV SAMPLE] Water & Drinks depot', divisionId: wdw, city: 'Abuja', state: 'FCT', isDefault: true },
    update: {},
  });
  const zones = [
    { name: '[DEV SAMPLE] Abuja central', state: 'FCT', cities: ['wuye', 'maitama', 'wuse', 'garki', 'asokoro', 'utako', 'jabi'], feeMinor: 150_000n, freeAboveMinor: 2_000_000n, estimatedHours: 24 },
    { name: '[DEV SAMPLE] FCT outskirts', state: 'FCT', cities: [], feeMinor: 300_000n, freeAboveMinor: null, estimatedHours: 48 },
  ];
  for (const z of zones) {
    await prisma.deliveryZone.upsert({ where: { divisionId_name: { divisionId: wdw, name: z.name } }, create: { ...z, divisionId: wdw, verification: 'DEV_SAMPLE' }, update: {} });
  }

  // Categories & products
  const categories = [
    { slug: 'dev-water', name: '[DEV SAMPLE] Water' },
    { slug: 'dev-soft-drinks', name: '[DEV SAMPLE] Soft drinks' },
    { slug: 'dev-wines', name: '[DEV SAMPLE] Wines' },
  ];
  const cat = new Map<string, string>();
  for (const [i, c] of categories.entries()) {
    const row = await prisma.productCategory.upsert({ where: { divisionId_slug: { divisionId: wdw, slug: c.slug } }, create: { ...c, divisionId: wdw, sortOrder: i }, update: {} });
    cat.set(c.slug, row.id);
  }
  const products = [
    { slug: 'dev-sample-dispenser-water', name: '[DEV SAMPLE] Dispenser water', category: 'dev-water', restricted: false,
      variants: [{ sku: 'DEV-WATER-JAR', name: 'Sample jar', unitPriceMinor: 100_000n, stock: 200 }] },
    { slug: 'dev-sample-bottled-water', name: '[DEV SAMPLE] Bottled water', category: 'dev-water', restricted: false,
      variants: [
        { sku: 'DEV-WATER-PACK-12', name: 'Sample pack of 12', unitPriceMinor: 250_000n, stock: 120 },
        { sku: 'DEV-WATER-PACK-24', name: 'Sample pack of 24', unitPriceMinor: 450_000n, stock: 3 },
      ] },
    { slug: 'dev-sample-soft-drink', name: '[DEV SAMPLE] Soft drink', category: 'dev-soft-drinks', restricted: false,
      variants: [{ sku: 'DEV-SODA-CRATE', name: 'Sample crate', unitPriceMinor: 600_000n, stock: 40 }] },
    { slug: 'dev-sample-red-wine', name: '[DEV SAMPLE] Red wine', category: 'dev-wines', restricted: true,
      variants: [{ sku: 'DEV-WINE-75CL', name: 'Sample 75cl bottle', unitPriceMinor: 1_500_000n, stock: 10 }] },
  ];
  for (const p of products) {
    const product = await prisma.product.upsert({
      where: { slug: p.slug },
      create: {
        slug: p.slug, name: p.name, divisionId: wdw, categoryId: cat.get(p.category), status: ProductStatus.ACTIVE, isAgeRestricted: p.restricted, verification: 'DEV_SAMPLE',
        description: 'Development sample product for local API testing only. Not a real Nimpat product or price.',
      },
      update: {},
    });
    for (const [i, v] of p.variants.entries()) {
      const variant = await prisma.productVariant.upsert({
        where: { sku: v.sku },
        create: { productId: product.id, sku: v.sku, name: v.name, unitPriceMinor: v.unitPriceMinor, sortOrder: i },
        update: {},
      });
      await prisma.stockLevel.upsert({
        where: { variantId_locationId: { variantId: variant.id, locationId: loc.id } },
        create: { variantId: variant.id, locationId: loc.id, quantityOnHand: v.stock, reorderLevel: 5 },
        update: {},
      });
    }
  }

  // Apartments
  const property = await prisma.property.upsert({
    where: { slug: 'dev-sample-residence' },
    create: {
      slug: 'dev-sample-residence', name: '[DEV SAMPLE] Residence', divisionId: byCode.get('LUXURY_APARTMENTS')!.id,
      addressLine: 'Sample address (development only)', city: 'Abuja', state: 'FCT', amenities: ['Wi-Fi', 'Power backup', 'Parking'], status: ListingStatus.ACTIVE,
      description: 'Development sample property for local API testing only.',
    },
    update: {},
  });
  for (const u of [
    { code: 'DEV-1', name: '[DEV SAMPLE] One-bedroom unit', bedrooms: 1, bathrooms: 1, maxGuests: 2, nightlyRateMinor: 5_000_000n },
    { code: 'DEV-2', name: '[DEV SAMPLE] Two-bedroom unit', bedrooms: 2, bathrooms: 2, maxGuests: 4, nightlyRateMinor: 8_000_000n },
  ]) {
    await prisma.apartmentUnit.upsert({
      where: { propertyId_code: { propertyId: property.id, code: u.code } },
      create: { ...u, propertyId: property.id, cleaningFeeMinor: 1_000_000n, cautionDepositMinor: 2_000_000n, status: ListingStatus.ACTIVE, verification: 'DEV_SAMPLE' },
      update: {},
    });
  }

  // Spa
  const spaId = byCode.get('SPA_WELLNESS')!.id;
  const treatment = await prisma.spaTreatment.upsert({
    where: { slug: 'dev-sample-massage' },
    create: { slug: 'dev-sample-massage', name: '[DEV SAMPLE] Massage', divisionId: spaId, durationMinutes: 60, priceMinor: 2_500_000n, depositMinor: 500_000n, category: 'Massage', verification: 'DEV_SAMPLE' },
    update: {},
  });
  const practitioner = await prisma.spaPractitioner.findFirst({ where: { displayName: '[DEV SAMPLE] Therapist' } });
  if (!practitioner) {
    await prisma.spaPractitioner.create({ data: { displayName: '[DEV SAMPLE] Therapist', divisionId: spaId, treatments: { create: { treatmentId: treatment.id } } } });
  }

  // Automobiles & services
  await prisma.vehicle.upsert({
    where: { slug: 'dev-sample-suv' },
    create: {
      slug: 'dev-sample-suv', divisionId: byCode.get('AUTOMOBILES')!.id, make: 'DevSample', model: 'SUV', year: 2024, condition: VehicleCondition.BRAND_NEW,
      priceMinor: 5_000_000_000n, depositMinor: 50_000_000n, status: VehicleStatus.AVAILABLE, description: 'Development sample listing only.', verification: 'DEV_SAMPLE',
    },
    update: {},
  });
  await prisma.serviceOffering.upsert({
    where: { code: 'DEV-AUT-SERVICE' },
    create: { code: 'DEV-AUT-SERVICE', name: '[DEV SAMPLE] Vehicle service', divisionId: byCode.get('AUTOMOBILES')!.id, pricingType: 'FIXED', basePriceMinor: 3_000_000n, durationMinutes: 120, verification: 'DEV_SAMPLE' },
    update: {},
  });
  console.log('Seeded [DEV SAMPLE] data');
}

async function main() {
  const byCode = await seedReferenceData();
  await seedAdmin();
  if (process.env.SEED_SAMPLE_DATA === 'true') {
    if (process.env.NODE_ENV === 'production') throw new Error('Refusing to load sample data with NODE_ENV=production');
    await seedSamples(byCode);
  }
  console.log('Seed complete');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
