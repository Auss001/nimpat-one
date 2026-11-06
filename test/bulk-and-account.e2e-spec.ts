import { API, Harness } from './harness';

/** One action on many products, and account deletion for the mobile apps. */
const h = new Harness();
const PHARMACY = 'pharmacy-laboratory';
const DRINKS = 'water-drinks-wines';
let admin: object;
let n = 0;

async function product(division = DRINKS, price: number | null = 100000) {
  const stamp = `${Date.now()}${++n}`;
  const res = await h.http.post(`${API}/admin/catalog/products`).set(admin).send({
    division, name: `Bulk ${stamp}`, slug: `bulk-${stamp}`, status: 'DRAFT', variants: [{ sku: `BULK-${stamp}`, name: 'Single', unitPriceMinor: price }],
  }).expect(201);
  return res.body;
}
const bulk = (ids: string[], action: string, auth = admin, extra: object = {}) => h.http.post(`${API}/admin/catalog/products/bulk`).set(auth).send({ ids, action, ...extra });

beforeAll(async () => {
  await h.start();
  admin = (await h.admin()).auth;
});
afterAll(() => h.stop());

describe('bulk product actions', () => {
  it('shows many products to customers with one action', async () => {
    const [a, b] = [await product(), await product()];
    const res = await bulk([a.id, b.id], 'PUBLISH').expect(200);
    expect(res.body).toEqual({ updated: 2, skipped: [], notFound: 0 });
    await h.http.get(`${API}/catalog/products/${a.slug}`).expect(200);
    await h.http.get(`${API}/catalog/products/${b.slug}`).expect(200);
    await bulk([a.id, b.id], 'UNPUBLISH').expect(200);
    await h.http.get(`${API}/catalog/products/${a.slug}`).expect(404);
  });

  it('removes, restores and sets availability together', async () => {
    const a = await product();
    await bulk([a.id], 'ARCHIVE').expect(200);
    expect((await h.prisma.product.findUnique({ where: { id: a.id } })).status).toBe('ARCHIVED');
    await bulk([a.id], 'RESTORE').expect(200);
    await bulk([a.id], 'MARK_OUT_OF_STOCK').expect(200);
    expect((await h.prisma.product.findUnique({ where: { id: a.id } })).listedAvailability).toBe('OUT_OF_STOCK');
    await bulk([a.id], 'USE_LIVE_COUNT').expect(200);
    await bulk([a.id], 'BLOCK_PURCHASE').expect(200);
    expect((await h.prisma.product.findUnique({ where: { id: a.id } })).purchaseEnabled).toBe(false);
  });

  it('never publishes a medicine without pharmacist approval, and still does the others', async () => {
    const [med, drink] = [await product(PHARMACY), await product()];
    const res = await bulk([med.id, drink.id], 'PUBLISH').expect(200);
    expect(res.body.updated).toBe(1);
    expect(res.body.skipped).toEqual([expect.objectContaining({ id: med.id, reason: expect.stringContaining('pharmacist') })]);
    await h.http.get(`${API}/catalog/products/${med.slug}`).expect(404);
    await h.http.get(`${API}/catalog/products/${drink.slug}`).expect(200);
  });

  it('lets a pharmacist approve many, but only with a prescription status', async () => {
    const pharmacist = await h.staff('PHARMACIST', PHARMACY);
    const [a, b] = [await product(PHARMACY), await product(PHARMACY)];
    await bulk([a.id, b.id], 'PHARMACY_APPROVE', pharmacist.auth).expect(400);
    await bulk([a.id, b.id], 'PHARMACY_APPROVE', pharmacist.auth, { prescriptionStatus: 'NOT_REVIEWED' }).expect(400);
    const res = await bulk([a.id, b.id], 'PHARMACY_APPROVE', pharmacist.auth, { prescriptionStatus: 'NOT_REQUIRED' }).expect(200);
    expect(res.body.updated).toBe(2);
    await bulk([a.id, b.id], 'PUBLISH', pharmacist.auth).expect(200);
    await h.http.get(`${API}/catalog/products/${a.slug}`).expect(200);
  });

  it('refuses bulk approval by a manager, and cannot allow prescription medicines to be bought', async () => {
    const manager = await h.staff('DEPARTMENT_MANAGER', PHARMACY);
    const pharmacist = await h.staff('PHARMACIST', PHARMACY);
    const med = await product(PHARMACY);
    const asManager = await bulk([med.id], 'PHARMACY_APPROVE', manager.auth, { prescriptionStatus: 'NOT_REQUIRED' }).expect(200);
    expect(asManager.body.updated).toBe(0);
    expect((await bulk([med.id], 'ALLOW_PURCHASE', manager.auth).expect(200)).body.updated).toBe(0);
    await bulk([med.id], 'PHARMACY_APPROVE', pharmacist.auth, { prescriptionStatus: 'REQUIRED' }).expect(200);
    const res = await bulk([med.id], 'ALLOW_PURCHASE', pharmacist.auth).expect(200);
    expect(res.body.updated).toBe(0);
    expect(res.body.skipped[0].reason).toContain('Prescription');
  });

  it('keeps a manager to their own division', async () => {
    const manager = await h.staff('DEPARTMENT_MANAGER', DRINKS);
    const other = await product('retail-general-supplies');
    const res = await bulk([other.id], 'ARCHIVE', manager.auth).expect(200);
    expect(res.body.updated).toBe(0);
    expect((await h.prisma.product.findUnique({ where: { id: other.id } })).status).toBe('DRAFT');
  });

  it('closes bulk actions to customers, and records each change', async () => {
    const customer = await h.customer();
    const a = await product();
    await bulk([a.id], 'ARCHIVE', customer.auth).expect(403);
    await bulk([a.id], 'RESTORE').expect(200);
    expect(await h.prisma.auditLog.findFirst({ where: { action: 'product.bulk.restore', entityId: a.id } })).toBeTruthy();
  });
});

describe('account deletion', () => {
  const PASSWORD = 'correct-horse-battery-9';

  it('erases personal details and stops sign-in', async () => {
    const c = await h.customer();
    await h.address(c.auth);
    await h.http.delete(`${API}/me`).set(c.auth).send({ password: 'wrong-password-1' }).expect(400);
    await h.http.delete(`${API}/me`).set(c.auth).send({ password: PASSWORD }).expect(200);
    const row = await h.prisma.user.findUnique({ where: { id: c.id }, include: { customerProfile: true, addresses: true } });
    expect(row.email).not.toContain('@example.test');
    expect(row.status).toBe('DEACTIVATED');
    expect(row.customerProfile.firstName).toBe('Deleted');
    expect(row.addresses.every((a: { line1: string; deletedAt: Date | null }) => a.line1 === 'Deleted' && a.deletedAt)).toBe(true);
    await h.http.post(`${API}/auth/login`).send({ email: c.email, password: PASSWORD }).expect(401);
    await h.http.get(`${API}/auth/me`).set(c.auth).expect(401);
  });

  it('lets the same email register again afterwards', async () => {
    const c = await h.customer();
    await h.http.delete(`${API}/me`).set(c.auth).send({ password: PASSWORD }).expect(200);
    await h.http.post(`${API}/auth/register`).send({ email: c.email, password: PASSWORD, firstName: 'New', lastName: 'Person' }).expect(201);
  });

  it('waits for open orders to finish, and is not for staff', async () => {
    const c = await h.customer();
    const p = await product();
    await bulk([p.id], 'PUBLISH').expect(200);
    await h.stock(p.variants[0].sku, 5);
    await h.http.post(`${API}/carts/items`).set(c.auth).send({ variantId: p.variants[0].id, quantity: 1 }).expect((r: { status: number }) => expect(r.status).toBeLessThan(300));
    await h.http.post(`${API}/orders`).set(c.auth).send({ division: DRINKS, fulfilmentType: 'PICKUP' }).expect(201);
    await h.http.delete(`${API}/me`).set(c.auth).send({ password: PASSWORD }).expect(409);
    const staff = await h.staff('DEPARTMENT_STAFF', DRINKS);
    await h.http.delete(`${API}/me`).set(staff.auth).send({ password: 'staff-pass-12345' }).expect(400);
  });
});
