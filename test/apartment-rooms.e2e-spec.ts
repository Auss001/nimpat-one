import { API, Harness } from './harness';

/** Whole-unit and single-room booking, plus the readiness gate. */
const h = new Harness();
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
let auth: object;
let admin: object;
let unitId: string;
let rooms: { id: string; slot: number }[];
let slug: string;

const reserve = (body: object) => h.http.post(`${API}/apartments/reservations`).set(auth).send({ guests: 1, ...body });
const quote = (from: string, to: string, roomId?: string) =>
  h.http.get(`${API}/apartments/units/${unitId}/quote`).query({ checkIn: from, checkOut: to, ...(roomId ? { roomId } : {}) });

beforeAll(async () => {
  await h.start();
  const division = await h.prisma.division.findUniqueOrThrow({ where: { slug: 'luxury-apartments' } });
  slug = `room-test-${Date.now()}`;
  const property = await h.prisma.property.create({
    data: { divisionId: division.id, name: 'Room Test Duplex', slug, addressLine: 'Wuye, Abuja', location: 'Wuye', city: 'Abuja', state: 'FCT', amenities: [], status: 'ACTIVE' },
  });
  const unit = await h.prisma.apartmentUnit.create({
    data: {
      propertyId: property.id, code: 'V1', name: 'Villa', bedrooms: 4, bathrooms: 4, maxGuests: 8, nightlyRateMinor: 24_000_000n, cleaningFeeMinor: 2_500_000n,
      cautionDepositMinor: 6_000_000n, status: 'ACTIVE', verification: 'VERIFIED',
    },
  });
  unitId = unit.id;
  admin = (await h.admin()).auth;
  auth = (await h.customer()).auth;
  rooms = [];
  for (const name of ['Bedroom 1', 'Bedroom 2']) {
    const res = await h.http.post(`${API}/admin/apartments/units/${unitId}/rooms`).set(admin).send({ name, nightlyRateMinor: 8_000_000 }).expect(201);
    rooms.push(res.body);
  }
});
afterAll(() => h.stop());

describe('single-room booking', () => {
  it('numbers rooms in order and shows them to customers without staff notes', async () => {
    expect(rooms.map((r) => r.slot)).toEqual([1, 2]);
    await h.http.patch(`${API}/admin/apartments/rooms/${rooms[1].id}`).set(admin).send({ readinessNote: 'staff only' }).expect(200);
    const res = await h.http.get(`${API}/apartments/properties/${slug}`).expect(200);
    expect(res.body.units[0].rooms).toHaveLength(2);
    expect(res.body.units[0].rooms[1].readinessNote).toBeUndefined();
  });

  it('prices one room at the room rate, not the whole unit', async () => {
    const res = await quote(day(10), day(12), rooms[0].id).expect(200);
    expect(res.body).toEqual(expect.objectContaining({ roomId: rooms[0].id, nightlyRateMinor: 8_000_000, totalMinor: 16_000_000, available: true }));
    const whole = await quote(day(10), day(12)).expect(200);
    expect(whole.body).toEqual(expect.objectContaining({ roomId: null, totalMinor: 48_000_000 + 6_000_000 }));
  });

  it('lets two guests book different rooms on the same dates, and blocks the whole unit', async () => {
    const first = await reserve({ unitId, roomId: rooms[0].id, checkIn: day(20), checkOut: day(23) }).expect(201);
    expect(first.body.room.name).toBe('Bedroom 1');
    await reserve({ unitId, roomId: rooms[1].id, checkIn: day(20), checkOut: day(23) }).expect(201);
    await reserve({ unitId, roomId: rooms[0].id, checkIn: day(22), checkOut: day(24) }).expect(409);
    await reserve({ unitId, checkIn: day(21), checkOut: day(22) }).expect(409);
    expect((await quote(day(20), day(21))).body.available).toBe(false);
  });

  it('frees back-to-back dates for a room', async () => {
    await reserve({ unitId, roomId: rooms[0].id, checkIn: day(23), checkOut: day(24) }).expect(201);
  });

  it('blocks every room while the whole unit is booked', async () => {
    await reserve({ unitId, checkIn: day(30), checkOut: day(32) }).expect(201);
    await reserve({ unitId, roomId: rooms[1].id, checkIn: day(31), checkOut: day(33) }).expect(409);
    expect((await quote(day(30), day(31), rooms[0].id)).body.available).toBe(false);
    const calendar = await h.http.get(`${API}/apartments/units/${unitId}/calendar`).query({ from: day(29), to: day(34), roomId: rooms[0].id }).expect(200);
    expect(calendar.body.unavailable).toHaveLength(1);
  });

  it('lets only one of many simultaneous requests win the same room', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => reserve({ unitId, roomId: rooms[1].id, checkIn: day(40), checkOut: day(42) })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
  });

  it('never lets a whole-unit and a room booking both win a race', async () => {
    const results = await Promise.all([
      reserve({ unitId, checkIn: day(50), checkOut: day(52) }),
      reserve({ unitId, roomId: rooms[0].id, checkIn: day(50), checkOut: day(52) }),
      reserve({ unitId, checkIn: day(51), checkOut: day(53) }),
      reserve({ unitId, roomId: rooms[1].id, checkIn: day(51), checkOut: day(53) }),
    ]);
    const won = results.filter((r) => r.status === 201).map((r) => r.body.room);
    expect(won.length).toBeGreaterThanOrEqual(1);
    if (won.some((room) => room === null)) expect(won).toHaveLength(1);
  });

  it('rejects a room from a different unit', async () => {
    const other = await h.prisma.apartmentUnit.create({
      data: { propertyId: (await h.prisma.apartmentUnit.findUnique({ where: { id: unitId } })).propertyId, code: 'V2', name: 'Other', bedrooms: 1, bathrooms: 1, maxGuests: 2, nightlyRateMinor: 100_000n, status: 'ACTIVE', verification: 'VERIFIED' },
    });
    await reserve({ unitId: other.id, roomId: rooms[0].id, checkIn: day(60), checkOut: day(61) }).expect(404);
  });
});

describe('readiness', () => {
  it('stops a room being booked while it is under maintenance', async () => {
    await h.http.patch(`${API}/admin/apartments/rooms/${rooms[0].id}`).set(admin).send({ readiness: 'MAINTENANCE', readinessNote: 'AC repair' }).expect(200);
    await reserve({ unitId, roomId: rooms[0].id, checkIn: day(70), checkOut: day(71) }).expect(404);
    await reserve({ unitId, roomId: rooms[1].id, checkIn: day(70), checkOut: day(71) }).expect(201);
    await h.http.patch(`${API}/admin/apartments/rooms/${rooms[0].id}`).set(admin).send({ readiness: 'READY', readinessNote: null }).expect(200);
  });

  it.each(['FINISHING', 'NOT_READY', 'SERVICING', 'MAINTENANCE'])('hides a unit marked %s from customers until it is ready', async (readiness) => {
    await h.http.patch(`${API}/admin/apartments/units/${unitId}`).set(admin).send({ readiness }).expect(200);
    await quote(day(80), day(81)).expect(404);
    await reserve({ unitId, checkIn: day(80), checkOut: day(81) }).expect(404);
    await reserve({ unitId, roomId: rooms[0].id, checkIn: day(80), checkOut: day(81) }).expect(404);
    const page = await h.http.get(`${API}/apartments/properties/${slug}`).expect(200);
    expect(page.body.units.map((u: { id: string }) => u.id)).not.toContain(unitId);
    await h.http.patch(`${API}/admin/apartments/units/${unitId}`).set(admin).send({ readiness: 'READY' }).expect(200);
    await quote(day(80), day(81)).expect(200);
  });

  it('shows staff the condition of every unit and room', async () => {
    const res = await h.http.get(`${API}/admin/apartments/properties`).set(admin).expect(200);
    const unit = res.body.flatMap((p: { units: unknown[] }) => p.units).find((u: { id: string }) => u.id === unitId);
    expect(unit.readiness).toBe('READY');
    expect(unit.rooms).toHaveLength(2);
  });
});
