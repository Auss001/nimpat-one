/**
 * Applies the apartment list supplied on 2026-11-06.
 *
 *   npm run catalog:apartments
 *
 * Run once, after catalog:apply. It sets condition notes and adds the extra
 * units, and later runs would overwrite condition changes made in the dashboard.
 *
 * New units copy the rate of a similar unit only because the system needs a
 * price. They are placeholders until the price list arrives. Nothing here marks
 * a record as confirmed, so customers cannot book any of it yet.
 *
 * Port Harcourt is switched off rather than deleted.
 */
import { ListingStatus, Prisma, PrismaClient, UnitReadiness } from '@prisma/client';

const prisma = new PrismaClient();
const NIGHTLY_ROOM_RATE_MINOR = 8_000_000n; // ₦80,000, from the AJ Turner listing in the catalogue.

async function property(tx: Prisma.TransactionClient, slugPart: string) {
  return tx.property.findFirstOrThrow({ where: { slug: { contains: slugPart } }, include: { units: { orderBy: { code: 'asc' } } } });
}

async function main() {
  const summary = await prisma.$transaction(async (tx) => {
    const setUnit = (propertyId: string, code: string, readiness: UnitReadiness, readinessNote: string | null) =>
      tx.apartmentUnit.update({ where: { propertyId_code: { propertyId, code } }, data: { readiness, readinessNote } });

    const addCopy = async (source: { propertyId: string; bedrooms: number; bathrooms: number; maxGuests: number; nightlyRateMinor: bigint; cautionDepositMinor: bigint; cleaningFeeMinor: bigint; minNights: number; maxNights: number }, code: string, name: string, readiness: UnitReadiness, readinessNote: string) => {
      const { propertyId, bedrooms, bathrooms, maxGuests, nightlyRateMinor, cautionDepositMinor, cleaningFeeMinor, minNights, maxNights } = source;
      const data = { bedrooms, bathrooms, maxGuests, nightlyRateMinor, cautionDepositMinor, cleaningFeeMinor, minNights, maxNights, name, status: ListingStatus.ACTIVE, readiness, readinessNote };
      await tx.apartmentUnit.upsert({ where: { propertyId_code: { propertyId, code } }, create: { ...data, propertyId, code }, update: { name, readiness, readinessNote } });
    };

    // Port Harcourt: removed from sale. Records are kept and can be switched back on.
    const ph = await tx.property.findMany({ where: { location: 'Port Harcourt' }, select: { id: true } });
    const phIds = ph.map((p) => p.id);
    await tx.apartmentUnit.updateMany({ where: { propertyId: { in: phIds } }, data: { status: ListingStatus.INACTIVE } });
    await tx.property.updateMany({ where: { id: { in: phIds } }, data: { status: ListingStatus.INACTIVE } });

    // Wuye F3 duplex, in Cyrus Estate 2: ready.
    const f3 = await property(tx, 'wuye-f3');
    await tx.property.update({ where: { id: f3.id }, data: { addressLine: 'Cyrus Estate 2, Wuye, Abuja' } });
    await setUnit(f3.id, f3.units[0].code, UnitReadiness.READY, null);

    // AJ Turner: two 4-bedroom duplexes. One is ready, with 3 rooms sellable.
    const aj = await property(tx, 'aj-turner');
    const villa = aj.units.find((u) => u.code === 'Villa 1');
    if (!villa) throw new Error('AJ Turner Villa 1 not found');
    await setUnit(aj.id, 'Villa 1', UnitReadiness.READY, '3 of the 4 bedrooms are sellable');
    for (const slot of [1, 2, 3]) {
      await tx.apartmentRoom.upsert({
        where: { unitId_slot: { unitId: villa.id, slot } },
        create: { unitId: villa.id, slot, name: `Bedroom ${slot}`, nightlyRateMinor: NIGHTLY_ROOM_RATE_MINOR },
        update: {},
      });
    }
    await addCopy(villa, 'Villa 2', 'AJ Turner Duplex 2', UnitReadiness.NOT_READY, 'In the neighbouring estate, under a minute away. Estate name and price needed.');

    // Queens Landing: four 3-bedroom units, two of them about 90% ready.
    const queens = await property(tx, 'queens-landing');
    const first = queens.units.find((u) => u.code === 'Residence 1');
    if (!first) throw new Error('Queens Landing Residence 1 not found');
    const q90 = '90% ready';
    await setUnit(queens.id, 'Residence 1', UnitReadiness.FINISHING, q90);
    await addCopy(first, 'Residence 2', 'Queens Landing Residence 2', UnitReadiness.FINISHING, `${q90}. Price and photos needed.`);
    await addCopy(first, 'Residence 3', 'Queens Landing Residence 3', UnitReadiness.NOT_READY, 'Not ready. Price and photos needed.');
    await addCopy(first, 'Residence 4', 'Queens Landing Residence 4', UnitReadiness.NOT_READY, 'Not ready. Price and photos needed.');

    // Mabushi: four 3-bedroom flats. Only Flat 1's listing mentions an inverter.
    const mabushi = await property(tx, 'mabushi');
    await setUnit(mabushi.id, 'Flat 1', UnitReadiness.READY, 'Has inverter');
    for (const code of ['Flat 2', 'Flat 3', 'Flat 4']) await setUnit(mabushi.id, code, UnitReadiness.READY, 'No inverter');
    await tx.property.update({ where: { id: mabushi.id }, data: { amenities: mabushi.amenities.filter((a) => !/inverter/i.test(a)) } });

    return { portHarcourtSwitchedOff: phIds.length };
  });
  console.log(summary);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
