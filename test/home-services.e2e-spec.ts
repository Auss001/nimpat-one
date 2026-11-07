import { API, Harness } from './harness';

/** Services grouped by category (lab tests, car hire, hire purchase …) and visits to the customer's home. */
const h = new Harness();
let admin: { auth: object };

const offering = async (body: Record<string, unknown>) => {
  const o = (await h.http.post(`${API}/admin/services`).set(admin.auth).send({ code: `TST-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1000)}`, ...body }).expect(201)).body;
  return o;
};
const slot = (dayOffset: number, hourLagos: number) => {
  const ymd = new Date(Date.now() + dayOffset * 86_400_000).toISOString().slice(0, 10);
  return new Date(`${ymd}T${String(hourLagos).padStart(2, '0')}:00:00+01:00`).toISOString();
};

beforeAll(async () => {
  await h.start();
  await h.markSamplesSellable();
  admin = await h.admin();
});
afterAll(() => h.stop());

describe('services by category and at home', () => {
  it('lists a lab test with its category and keeps the admin fields', async () => {
    const o = await offering({ division: 'pharmacy-laboratory', name: 'Test full blood count', pricingType: 'FIXED', basePriceMinor: 800000, category: 'Lab tests', serviceMode: 'EITHER', homeFeeMinor: 200000 });
    expect(o).toMatchObject({ category: 'Lab tests', serviceMode: 'EITHER', homeFeeMinor: 200000, verification: 'VERIFIED' });
    const list = (await h.http.get(`${API}/services`).query({ division: 'pharmacy-laboratory' }).expect(200)).body;
    expect(list.find((s: any) => s.id === o.id)).toMatchObject({ category: 'Lab tests', serviceMode: 'EITHER' });
  });

  it('adds the home fee and keeps a copy of the address for a home visit', async () => {
    const o = await offering({ division: 'pharmacy-laboratory', name: 'Test home sample collection', pricingType: 'FIXED', basePriceMinor: 500000, category: 'Lab tests', serviceMode: 'EITHER', homeFeeMinor: 150000 });
    const c = await h.customer();
    const addressId = await h.address(c.auth);
    const home = (await h.http.post(`${API}/services/bookings`).set(c.auth).send({ offeringId: o.id, atHome: true, addressId }).expect(201)).body;
    expect(home).toMatchObject({ atHome: true, homeFeeMinor: 150000, priceMinor: 650000 });
    expect(home.serviceAddress).toMatchObject({ city: 'Wuye' });
    const visit = (await h.http.post(`${API}/services/bookings`).set(c.auth).send({ offeringId: o.id }).expect(201)).body;
    expect(visit).toMatchObject({ atHome: false, homeFeeMinor: 0, priceMinor: 500000 });
  });

  it('needs an address of your own for a home visit, and refuses home visits for in-store services', async () => {
    const home = await offering({ division: 'automobiles', name: 'Test car hire with driver', pricingType: 'QUOTE_REQUIRED', category: 'Car hire', serviceMode: 'AT_HOME' });
    const shop = await offering({ division: 'transport-logistics', name: 'Test parcel drop-off', pricingType: 'QUOTE_REQUIRED', category: 'Parcels' });
    const c = await h.customer();
    const other = await h.customer();
    const othersAddress = await h.address(other.auth);
    const mine = await h.address(c.auth);
    await h.http.post(`${API}/services/bookings`).set(c.auth).send({ offeringId: home.id }).expect(400);
    await h.http.post(`${API}/services/bookings`).set(c.auth).send({ offeringId: home.id, addressId: othersAddress }).expect(400);
    const ok = (await h.http.post(`${API}/services/bookings`).set(c.auth).send({ offeringId: home.id, addressId: mine }).expect(201)).body;
    expect(ok).toMatchObject({ atHome: true, priceMinor: null });
    await h.http.post(`${API}/services/bookings`).set(c.auth).send({ offeringId: shop.id, atHome: true, addressId: mine }).expect(400);
  });

  it('accepts hire purchase as a car enquiry type', async () => {
    const v = await h.prisma.vehicle.findFirst({ where: { status: 'AVAILABLE' } });
    if (!v) return;
    const c = await h.customer();
    await h.http.post(`${API}/vehicles/${v.id}/inquiries`).set(c.auth)
      .send({ type: 'HIRE_PURCHASE', contactName: 'Hire Tester', contactEmail: 'hire@example.com', contactPhone: '+2348031234567' }).expect(201);
  });
});

describe('spa at home', () => {
  it('books a treatment at home only when the spa offers it, with the home fee added', async () => {
    const t = await h.prisma.spaTreatment.findFirstOrThrow({ where: { slug: 'dev-sample-massage' } });
    await h.http.post(`${API}/admin/spa/practitioners`).set(admin.auth).send({ displayName: `Home therapist ${Date.now()}`, treatmentIds: [t.id] }).expect(201);
    const c = await h.customer();
    const addressId = await h.address(c.auth);
    const startsAt = () => slot(300 + Math.floor(Math.random() * 200), 11);
    await h.http.patch(`${API}/admin/spa/treatments/${t.id}`).set(admin.auth).send({ homeService: false }).expect(200);
    await h.http.post(`${API}/spa/appointments`).set(c.auth).send({ treatmentId: t.id, startsAt: startsAt(), atHome: true, addressId }).expect(400);

    await h.http.patch(`${API}/admin/spa/treatments/${t.id}`).set(admin.auth).send({ homeService: true, homeFeeMinor: 300000 }).expect(200);
    const appt = (await h.http.post(`${API}/spa/appointments`).set(c.auth).send({ treatmentId: t.id, startsAt: startsAt(), atHome: true, addressId }).expect(201)).body;
    expect(appt).toMatchObject({ atHome: true, homeFeeMinor: 300000, priceMinor: Number(t.priceMinor) + 300000 });
    expect(appt.homeAddress).toMatchObject({ city: 'Wuye' });
    await h.http.patch(`${API}/admin/spa/treatments/${t.id}`).set(admin.auth).send({ homeService: false }).expect(200);
  });
});
