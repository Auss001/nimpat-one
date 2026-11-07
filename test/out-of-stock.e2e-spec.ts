import { API, Harness } from './harness';

/** A shop can hide its out-of-stock items from customers, and switch that back off. */
const h = new Harness();
let admin: { auth: object };
const WDW = 'water-drinks-wines';
let n = 0;

async function product(listed: 'IN_STOCK' | 'OUT_OF_STOCK' | null, stock = 0) {
  const stamp = `${Date.now()}${++n}`;
  const p = await h.prisma.product.create({
    data: {
      division: { connect: { slug: WDW } }, name: `Stock test ${stamp}`, slug: `stock-test-${stamp}`, status: 'ACTIVE', verification: 'VERIFIED', listedAvailability: listed,
      variants: { create: { sku: `STOCK-${stamp}`, name: 'Single', unitPriceMinor: 100000n } },
    },
    include: { variants: true },
  });
  const location = await h.prisma.stockLocation.findFirstOrThrow({ where: { division: { slug: WDW }, isDefault: true, isActive: true } });
  await h.prisma.stockLevel.create({ data: { variantId: p.variants[0].id, locationId: location.id, quantityOnHand: stock } });
  return p;
}
const listed = async (name: string) => {
  const res = await h.http.get(`${API}/catalog/products`).query({ division: WDW, q: name }).expect(200);
  return res.body.data.some((x: { name: string }) => x.name === name);
};
const setHide = (hideOutOfStock: boolean, auth: object = admin.auth) => h.http.patch(`${API}/admin/catalog/divisions/${WDW}/display`).set(auth).send({ hideOutOfStock });

beforeAll(async () => {
  await h.start();
  admin = await h.admin();
});
afterAll(async () => {
  await setHide(true);
  await h.stop();
});

describe('hiding out-of-stock items', () => {
  it('hides items with no stock and items marked out of stock, and shows the rest', async () => {
    const empty = await product(null, 0);
    const marked = await product('OUT_OF_STOCK', 50);
    const stocked = await product(null, 5);
    const listedIn = await product('IN_STOCK', 0);
    await setHide(true).expect(200);
    expect((await h.http.get(`${API}/divisions/${WDW}`).expect(200)).body.hideOutOfStock).toBe(true);
    expect(await listed(empty.name)).toBe(false);
    expect(await listed(marked.name)).toBe(false);
    expect(await listed(stocked.name)).toBe(true);
    expect(await listed(listedIn.name)).toBe(true);
    // A saved link still opens, marked out of stock.
    expect((await h.http.get(`${API}/catalog/products/${empty.slug}`).expect(200)).body.inStock).toBe(false);
  });

  it('shows everything again when switched off', async () => {
    const empty = await product(null, 0);
    await setHide(false).expect(200);
    expect(await listed(empty.name)).toBe(true);
    await setHide(true).expect(200);
    expect(await listed(empty.name)).toBe(false);
  });

  it('lets only managers of that shop change it', async () => {
    await setHide(false, (await h.customer()).auth).expect(403);
    await setHide(false, (await h.staff('DEPARTMENT_MANAGER', 'spa-wellness')).auth).expect(403);
    await setHide(true, (await h.staff('DEPARTMENT_MANAGER', WDW)).auth).expect(200);
  });
});
