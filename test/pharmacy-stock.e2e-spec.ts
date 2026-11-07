import { API, Harness } from './harness';

/** Unpublished prices, listed availability, the pharmacist gate and laboratory bookings. */
const h = new Harness();
const PHARMACY = 'pharmacy-laboratory';
let admin: object;
let customer: { auth: object };
let n = 0;

async function newProduct(division: string, price: number | null = null) {
  const stamp = `${Date.now()}${++n}`;
  const res = await h.http.post(`${API}/admin/catalog/products`).set(admin).send({
    division, name: `Stock Test ${stamp}`, slug: `stock-test-${stamp}`, status: 'ACTIVE', description: 'Draft text',
    variants: [{ sku: `STOCK-${stamp}`, name: 'As listed', unitPriceMinor: price }],
  }).expect(201);
  return res.body;
}
const confirm = (id: string, auth = admin) => h.http.post(`${API}/admin/records/verification`).set(auth).send({ type: 'PRODUCT', ids: [id], verification: 'VERIFIED' });
const addToCart = (variantId: string) => h.http.post(`${API}/carts/items`).set(customer.auth).send({ variantId, quantity: 1 });
const review = (id: string, body: object, auth = admin) => h.http.post(`${API}/admin/catalog/products/${id}/pharmacy-review`).set(auth).send(body);

beforeAll(async () => {
  await h.start();
  admin = (await h.admin()).auth;
  customer = await h.customer();
});
afterAll(() => h.stop());

describe('unpublished prices', () => {
  it('stores no price as null, never zero, and refuses a zero price', async () => {
    const p = await newProduct('water-drinks-wines');
    expect(p.variants[0].unitPriceMinor).toBeNull();
    await h.http.patch(`${API}/admin/catalog/variants/${p.variants[0].id}`).set(admin).send({ unitPriceMinor: 0 }).expect(400);
  });

  it('shows an unpriced product to customers, and cannot be bought', async () => {
    const p = await newProduct('water-drinks-wines');
    await h.http.patch(`${API}/admin/catalog/products/${p.id}`).set(admin).send({ listedAvailability: 'IN_STOCK', purchaseEnabled: false }).expect(200);
    await confirm(p.id).expect(200);
    const res = await h.http.get(`${API}/catalog/products/${p.slug}`).expect(200);
    expect(res.body.pricePublished).toBe(false);
    expect(res.body.priceFromMinor).toBeNull();
    expect(res.body.variants[0].unitPriceMinor).toBeNull();
    expect(res.body.inStock).toBe(true);
    expect(res.body.variants[0].purchasable).toBe(false);
    expect(res.body.imageStatus).toBe('IMAGE_PENDING');
    await addToCart(p.variants[0].id).expect(409);
  });

  it('stops checkout if a price is withdrawn after the item is in the cart', async () => {
    const p = await newProduct('water-drinks-wines', 100000);
    await confirm(p.id).expect(200);
    await h.stock(p.variants[0].sku, 10);
    await addToCart(p.variants[0].id).expect((r: { status: number }) => expect(r.status).toBeLessThan(300));
    await h.http.patch(`${API}/admin/catalog/variants/${p.variants[0].id}`).set(admin).send({ unitPriceMinor: null }).expect(200);
    const res = await h.http.post(`${API}/orders`).set(customer.auth).send({ division: 'water-drinks-wines', fulfilmentType: 'PICKUP' });
    expect(res.status).toBe(409);
    await h.http.delete(`${API}/carts/items/${p.variants[0].id}`).set(customer.auth);
  });
});

describe('pharmacy approval', () => {
  let product: { id: string; slug: string; variants: { id: string; sku: string }[] };
  let pharmacist: { auth: object };
  let manager: { auth: object };

  beforeAll(async () => {
    product = await newProduct(PHARMACY);
    pharmacist = await h.staff('PHARMACIST', PHARMACY);
    manager = await h.staff('DEPARTMENT_MANAGER', PHARMACY);
  });

  it('starts every new pharmacy product unapproved and hidden', async () => {
    expect(product).toEqual(expect.objectContaining({ prescriptionStatus: 'NOT_REVIEWED', purchaseEnabled: false, pharmacistApprovedAt: null }));
    await h.http.get(`${API}/catalog/products/${product.slug}`).expect(404);
  });

  it('cannot be confirmed before a pharmacist approves it', async () => {
    await confirm(product.id).expect(400);
    await confirm(product.id, manager.auth).expect(403);
  });

  it('lets only a pharmacist approve, and not while the prescription status is unset', async () => {
    await review(product.id, { prescriptionStatus: 'NOT_REQUIRED', approved: true }, manager.auth).expect(403);
    await review(product.id, { prescriptionStatus: 'NOT_REVIEWED', approved: true }, pharmacist.auth).expect(400);
    await h.http.patch(`${API}/admin/catalog/products/${product.id}`).set(manager.auth).send({ purchaseEnabled: true }).expect(403);
  });

  it('keeps old counts and staff notes private, and needs price and stock to buy', async () => {
    await h.prisma.productVariant.update({ where: { id: product.variants[0].id }, data: { recordedStockQty: 7, recordedStockAt: new Date('2026-10-29') } });
    await h.prisma.product.update({ where: { id: product.id }, data: { verificationNote: 'SECRET-NOTE' } });
    await review(product.id, { prescriptionStatus: 'NOT_REQUIRED', approved: true, purchaseEnabled: true }, pharmacist.auth).expect(200);
    await confirm(product.id, pharmacist.auth).expect(200);
    const res = await h.http.get(`${API}/catalog/products/${product.slug}`).expect(200);
    expect(JSON.stringify(res.body)).not.toContain('SECRET-NOTE');
    expect(res.body.variants[0].recordedStockQty).toBeUndefined();
    expect(res.body.variants[0].availableQuantity).toBe(0);
    expect(res.body.variants[0].purchasable).toBe(false);
    await addToCart(product.variants[0].id).expect(409);
    await h.http.patch(`${API}/admin/catalog/variants/${product.variants[0].id}`).set(pharmacist.auth).send({ unitPriceMinor: 150000 }).expect(200);
    await addToCart(product.variants[0].id).expect(409); // Recorded stock is not usable stock.
    await h.stock(product.variants[0].sku, 5);
    await addToCart(product.variants[0].id).expect((r: { status: number }) => expect(r.status).toBeLessThan(300));
    await h.http.delete(`${API}/carts/items/${product.variants[0].id}`).set(customer.auth);
  });

  it('removes approval when someone else changes the medicine text', async () => {
    const p = await newProduct(PHARMACY);
    await review(p.id, { prescriptionStatus: 'NOT_REQUIRED', approved: true }, pharmacist.auth).expect(200);
    await confirm(p.id, pharmacist.auth).expect(200);
    await h.http.patch(`${API}/admin/catalog/products/${p.id}`).set(manager.auth).send({ description: 'Changed by a manager' }).expect(200);
    const after = await h.prisma.product.findUnique({ where: { id: p.id } });
    expect(after.pharmacistApprovedAt).toBeNull();
    expect(after.verification).toBe('AWAITING_CONFIRMATION');
    await h.http.get(`${API}/catalog/products/${p.slug}`).expect(404);
  });

  it.each(['REQUIRED', 'RESTRICTED'])('never lets a %s medicine be bought online', async (status) => {
    const p = await newProduct(PHARMACY, 200000);
    await review(p.id, { prescriptionStatus: status, approved: true, purchaseEnabled: true }, pharmacist.auth).expect(200);
    await confirm(p.id, pharmacist.auth).expect(200);
    await h.stock(p.variants[0].sku, 5);
    const res = await h.http.get(`${API}/catalog/products/${p.slug}`).expect(200);
    expect(res.body.variants[0].purchasable).toBe(false);
    expect(res.body.variants[0].purchaseNote).toContain('pharmacist');
    await addToCart(p.variants[0].id).expect(409);
  });

  it('takes a product off the customer API when approval is withdrawn', async () => {
    const p = await newProduct(PHARMACY);
    await review(p.id, { prescriptionStatus: 'NOT_REQUIRED', approved: true }, pharmacist.auth).expect(200);
    await confirm(p.id, pharmacist.auth).expect(200);
    await h.http.get(`${API}/catalog/products/${p.slug}`).expect(200);
    await review(p.id, { prescriptionStatus: 'NOT_REQUIRED', approved: false }, pharmacist.auth).expect(200);
    await h.http.get(`${API}/catalog/products/${p.slug}`).expect(404);
  });

  it('keeps a pharmacist out of other divisions', async () => {
    const other = await newProduct('retail-general-supplies');
    await h.http.patch(`${API}/admin/catalog/products/${other.id}`).set(pharmacist.auth).send({ name: 'No' }).expect(403);
  });

  it('records the decision', async () => {
    const log = await h.prisma.auditLog.findFirst({ where: { action: 'pharmacy.approve', entityId: product.id } });
    expect(log).toBeTruthy();
  });
});

describe('laboratory and pharmacist bookings', () => {
  it('books a quoted service, and staff price it', async () => {
    const stamp = `${Date.now()}${++n}`;
    const offering = await h.http.post(`${API}/admin/services`).set(admin).send({ division: PHARMACY, code: `LAB-${stamp}`, name: `Lab test ${stamp}`, pricingType: 'QUOTE_REQUIRED' }).expect(201);
    // Staff-added services show at once; a hidden one cannot be booked.
    await h.http.post(`${API}/admin/records/verification`).set(admin).send({ type: 'SERVICE_OFFERING', ids: [offering.body.id], verification: 'AWAITING_CONFIRMATION' }).expect(200);
    await h.http.post(`${API}/services/bookings`).set(customer.auth).send({ offeringId: offering.body.id }).expect(404);
    await h.http.post(`${API}/admin/records/verification`).set(admin).send({ type: 'SERVICE_OFFERING', ids: [offering.body.id], verification: 'VERIFIED' }).expect(200);
    const listed = await h.http.get(`${API}/services?division=${PHARMACY}`).expect(200);
    expect(listed.body.map((s: { id: string }) => s.id)).toContain(offering.body.id);
    const booking = await h.http.post(`${API}/services/bookings`).set(customer.auth).send({ offeringId: offering.body.id, details: { requestedTest: 'As written by the customer' } }).expect(201);
    expect(booking.body.bookingNumber).toMatch(/PHM/);
    expect(booking.body.priceMinor).toBeNull();
    const pharmacist = await h.staff('PHARMACIST', PHARMACY);
    const staffList = await h.http.get(`${API}/admin/services/bookings?division=${PHARMACY}`).set(pharmacist.auth).expect(200);
    expect(staffList.body.data.map((b: { id: string }) => b.id)).toContain(booking.body.id);
    await h.http.patch(`${API}/admin/services/bookings/${booking.body.id}`).set(pharmacist.auth).send({ priceMinor: 500000, status: 'PENDING' }).expect(200);
  });
});

describe('vehicles', () => {
  it('accepts a car with no price or stated condition, as supplied', async () => {
    const stamp = `${Date.now()}${++n}`;
    const res = await h.http.post(`${API}/admin/vehicles`).set(admin).send({ slug: `honda-pilot-${stamp}`, make: 'Honda', model: 'Pilot', year: 2021, status: 'AVAILABLE' }).expect(201);
    expect(res.body.priceMinor).toBeNull();
    expect(res.body.condition).toBeNull();
    await h.http.patch(`${API}/admin/vehicles/${res.body.id}`).set(admin).send({ priceMinor: 100000000 }).expect(200);
  });
});

describe('overview', () => {
  it('counts lists and old closing stock as not counted, not as out of stock', async () => {
    const res = await h.http.get(`${API}/admin/reports/overview`).set(admin).expect(200);
    const s = res.body.stock;
    expect(s.total).toBe(s.inStock + s.low + s.out + s.uncounted);
    expect(s.uncounted).toBeGreaterThan(0);
    expect(res.body.launch.prices.done).toBeLessThanOrEqual(res.body.launch.prices.total);
  });
});
