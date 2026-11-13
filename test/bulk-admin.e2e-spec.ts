import { API, Harness } from './harness';

/** The dashboard's bulk tools: export to a spreadsheet, delete many customers, delete many unpaid orders. */
const h = new Harness();
let admin: object;
const DRINKS = 'water-drinks-wines';

beforeAll(async () => {
  await h.start();
  admin = (await h.admin()).auth;
});
afterAll(() => h.stop());

async function unpaidOrder(c: { auth: object }) {
  const products = await h.http.get(`${API}/catalog/products`).query({ division: DRINKS, pageSize: 1 }).expect(200);
  const v = products.body.data[0].variants[0];
  await h.stock(v.sku, 500);
  await h.http.post(`${API}/carts/items`).set(c.auth).send({ variantId: v.id, quantity: 1 }).expect((r: { status: number }) => expect(r.status).toBeLessThan(300));
  return (await h.http.post(`${API}/orders`).set(c.auth).send({ division: DRINKS, fulfilmentType: 'PICKUP' }).expect(201)).body;
}

describe('customers', () => {
  it('exports the customers matching a search as a spreadsheet', async () => {
    const c = await h.customer();
    const res = await h.http.get(`${API}/admin/customers/export`).query({ q: c.email }).set(admin).expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('First name');
    expect(res.text).toContain(c.email);
  });

  it('deletes picked customers: they cannot sign in, and are gone from the list', async () => {
    const [a, b] = [await h.customer(), await h.customer()];
    const res = await h.http.post(`${API}/admin/customers/bulk-delete`).set(admin).send({ ids: [a.id, b.id] }).expect(200);
    expect(res.body.deleted).toBe(2);
    await h.http.get(`${API}/auth/me`).set(a.auth).expect(401);
    const list = await h.http.get(`${API}/admin/customers`).query({ q: b.email }).set(admin).expect(200);
    expect(list.body.data).toHaveLength(0);
  });

  it('is for administrators only', async () => {
    const manager = await h.staff('DEPARTMENT_MANAGER', DRINKS);
    const c = await h.customer();
    await h.http.post(`${API}/admin/customers/bulk-delete`).set(manager.auth).send({ ids: [c.id] }).expect(403);
  });
});

describe('orders', () => {
  it('exports orders as a spreadsheet', async () => {
    const c = await h.customer();
    const o = await unpaidOrder(c);
    const res = await h.http.get(`${API}/admin/orders/export`).query({ q: o.orderNumber }).set(admin).expect(200);
    expect(res.text).toContain(o.orderNumber);
  });

  it('deletes unpaid orders, and keeps paid ones as financial records', async () => {
    const c = await h.customer();
    const unpaid = await unpaidOrder(c);
    const paid = await unpaidOrder(c);
    await h.prisma.order.update({ where: { id: paid.id }, data: { status: 'PROCESSING', amountPaidMinor: 100n } });
    const res = await h.http.post(`${API}/admin/orders/bulk-delete`).set(admin).send({ ids: [unpaid.id, paid.id] }).expect(200);
    expect(res.body.deleted).toBe(1);
    expect(res.body.skipped).toEqual([expect.objectContaining({ orderNumber: paid.orderNumber })]);
    const gone = await h.prisma.order.findUnique({ where: { id: unpaid.id } });
    expect(gone === null || gone.archivedAt !== null).toBe(true);
    const list = await h.http.get(`${API}/admin/orders`).query({ q: unpaid.orderNumber }).set(admin).expect(200);
    expect(list.body.data).toHaveLength(0);
    expect(await h.prisma.order.findUnique({ where: { id: paid.id } })).not.toBeNull();
  });
});
