import { API, Harness } from './harness';

/** The dashboard's customer list: staff with permission only, and searchable. */
const h = new Harness();
let admin: object;

beforeAll(async () => {
  await h.start();
  admin = (await h.admin()).auth;
});
afterAll(() => h.stop());

describe('stock history', () => {
  it('accepts a product size and page size together', async () => {
    const products = await h.http.get(`${API}/admin/catalog/products`).query({ pageSize: 1 }).set(admin).expect(200);
    const variantId = products.body.data[0].variants[0].id;
    await h.http.get(`${API}/admin/inventory/movements`).query({ variantId, pageSize: 100 }).set(admin).expect(200);
  });
});

describe('customer list', () => {
  it('finds a customer by email and never returns a password', async () => {
    const c = await h.customer();
    const res = await h.http.get(`${API}/admin/customers`).query({ q: c.email }).set(admin).expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].email).toBe(c.email);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash/);
  });

  it('refuses customers', async () => {
    const c = await h.customer();
    await h.http.get(`${API}/admin/customers`).set(c.auth).expect(403);
  });
});

describe('favourites', () => {
  it('saves, lists and removes, and saving twice is harmless', async () => {
    const c = await h.customer();
    await h.http.post(`${API}/me/favorites`).set(c.auth).send({ kind: 'PRODUCT', slug: 'some-product' }).expect(201);
    await h.http.post(`${API}/me/favorites`).set(c.auth).send({ kind: 'PRODUCT', slug: 'some-product' }).expect(201);
    const list = await h.http.get(`${API}/me/favorites`).set(c.auth).expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ kind: 'PRODUCT', itemSlug: 'some-product' });
    await h.http.delete(`${API}/me/favorites/PRODUCT/some-product`).set(c.auth).expect(200);
    expect((await h.http.get(`${API}/me/favorites`).set(c.auth).expect(200)).body).toHaveLength(0);
  });

  it('keeps each customer to their own list, and needs sign-in', async () => {
    const [a, b] = [await h.customer(), await h.customer()];
    await h.http.post(`${API}/me/favorites`).set(a.auth).send({ kind: 'VEHICLE', slug: 'a-car' }).expect(201);
    expect((await h.http.get(`${API}/me/favorites`).set(b.auth).expect(200)).body).toHaveLength(0);
    await h.http.get(`${API}/me/favorites`).expect(401);
  });
});
