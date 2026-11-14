import { API, Harness } from './harness';

/**
 * The dashboard's "In the app" must always match what customers can actually see (owner, 14 November 2026):
 * for each kind of listing, every item the dashboard calls live is in the customers' list, and every item it
 * calls hidden is not, with a reason.
 */
const h = new Harness();
let admin: { auth: object };
const rows = (r: { body: unknown }) => (Array.isArray(r.body) ? r.body : (r.body as { data: unknown[] }).data) as any[];

beforeAll(async () => {
  await h.start();
  await h.markSamplesSellable();
  admin = await h.admin();
});
afterAll(() => h.stop());

const agrees = (staff: any[], customerIds: Set<string>) => {
  expect(staff.length).toBeGreaterThan(0);
  for (const item of staff) {
    expect(item.inApp).toBeDefined();
    expect({ id: item.id, live: item.inApp.live }).toEqual({ id: item.id, live: customerIds.has(item.id) });
    if (!item.inApp.live) expect(item.inApp.why).toEqual(expect.any(String));
  }
};

describe('dashboard "In the app" agrees with the app', () => {
  it('spa treatments', async () => {
    const staff = rows(await h.http.get(`${API}/admin/spa/treatments`).set(admin.auth).expect(200));
    const customers = rows(await h.http.get(`${API}/spa/treatments`).query({ pageSize: 100 }).expect(200));
    agrees(staff, new Set(customers.map((t) => t.id)));
  });

  it('services', async () => {
    const staff = rows(await h.http.get(`${API}/admin/services`).set(admin.auth).expect(200));
    const customers = rows(await h.http.get(`${API}/services`).expect(200));
    agrees(staff, new Set(customers.map((s) => s.id)));
  });

  it('cars', async () => {
    const staff = rows(await h.http.get(`${API}/admin/vehicles`).query({ pageSize: 100 }).set(admin.auth).expect(200));
    const customers = rows(await h.http.get(`${API}/vehicles`).query({ pageSize: 100 }).expect(200));
    agrees(staff, new Set(customers.map((v) => v.id)));
  });

  it('flats, including one switched on but not confirmed', async () => {
    const unit = await h.prisma.apartmentUnit.findFirstOrThrow({ where: { status: 'ACTIVE' } });
    const before = unit.verification;
    await h.prisma.apartmentUnit.update({ where: { id: unit.id }, data: { verification: 'AWAITING_CONFIRMATION' } });
    try {
      const properties = rows(await h.http.get(`${API}/admin/apartments/properties`).set(admin.auth).expect(200));
      const staffUnits = properties.flatMap((p) => p.units);
      const listed = rows(await h.http.get(`${API}/apartments/properties`).query({ pageSize: 100 }).expect(200));
      const details = await Promise.all(listed.map((p) => h.http.get(`${API}/apartments/properties/${p.slug}`).expect(200).then((r: { body: unknown }) => r.body)));
      const customerUnits = new Set(details.flatMap((p: any) => p.units.map((u: any) => u.id)));
      agrees(staffUnits, customerUnits);
      expect(staffUnits.find((u) => u.id === unit.id).inApp).toEqual({ live: false, why: 'Not confirmed' });
    } finally {
      await h.prisma.apartmentUnit.update({ where: { id: unit.id }, data: { verification: before } });
    }
  });

  it('products say why they are hidden', async () => {
    const staff = rows(await h.http.get(`${API}/admin/catalog/products`).query({ pageSize: 50 }).set(admin.auth).expect(200));
    expect(staff.length).toBeGreaterThan(0);
    for (const p of staff) {
      expect(p.inApp).toBeDefined();
      if (!p.inApp.live) expect(p.inApp.why).toEqual(expect.any(String));
      // A product the dashboard calls live opens for customers.
      if (p.inApp.live) await h.http.get(`${API}/catalog/products/${p.slug}`).expect(200);
    }
  });
});
