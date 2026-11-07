import { API, Harness } from './harness';

/** A flat sold whole or by the room: two rooms can be held together, and block the whole flat. */
const h = new Harness();
let admin: object;

beforeAll(async () => {
  await h.start();
  admin = (await h.admin()).auth;
});
afterAll(() => h.stop());

async function flat() {
  const stamp = `${Date.now()}`;
  const property = await h.prisma.property.create({
    data: {
      division: { connect: { slug: 'luxury-apartments' } }, name: `Rooms ${stamp}`, slug: `rooms-${stamp}`, addressLine: 'Test', city: 'Abuja', state: 'FCT', status: 'ACTIVE',
      units: { create: { code: `R${stamp}`, name: 'Flat', bedrooms: 3, bathrooms: 3, maxGuests: 6, nightlyRateMinor: 22000000n, cautionDepositMinor: 0n, cleaningFeeMinor: 0n, status: 'ACTIVE', verification: 'VERIFIED', readiness: 'READY',
        rooms: { create: [1, 2, 3].map((slot) => ({ slot, name: `Bedroom ${slot}`, nightlyRateMinor: 7500000n })) } } },
    },
    include: { units: { include: { rooms: { orderBy: { slot: 'asc' } } } } },
  });
  return property.units[0];
}

describe('booking rooms in a flat', () => {
  it('holds two rooms together, keeps the third open, and refuses the whole flat', async () => {
    void admin;
    const unit = await flat();
    const c = await h.customer();
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    const dates = { checkIn: day(100), checkOut: day(102) };
    const book = (roomId?: string) => h.http.post(`${API}/apartments/reservations`).set(c.auth).send({ unitId: unit.id, ...(roomId ? { roomId } : {}), ...dates, guests: 1 });
    const one = await book(unit.rooms[0].id).expect(201);
    const two = await book(unit.rooms[1].id).expect(201);
    expect(Number(one.body.totalMinor) + Number(two.body.totalMinor)).toBe(30000000);
    const third = await h.http.get(`${API}/apartments/units/${unit.id}/quote`).query({ ...dates, guests: 1, roomId: unit.rooms[2].id }).expect(200);
    expect(third.body.available).toBe(true);
    const whole = await h.http.get(`${API}/apartments/units/${unit.id}/quote`).query({ ...dates, guests: 1 }).expect(200);
    expect(whole.body.available).toBe(false);
    await h.http.post(`${API}/apartments/reservations/${one.body.id}/cancel`).set(c.auth).send({}).expect(200);
    const again = await h.http.get(`${API}/apartments/units/${unit.id}/quote`).query({ ...dates, guests: 1, roomId: unit.rooms[0].id }).expect(200);
    expect(again.body.available).toBe(true);
  });
});
