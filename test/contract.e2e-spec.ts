import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { API, Harness } from './harness';

/**
 * Customer API contract. Walks every customer journey in
 * docs/FRONTEND_INTEGRATION.md, checks the documented fields exist, and saves
 * real responses to docs/api-samples.json so the document cannot drift from
 * what the API returns.
 */
const h = new Harness();
const samples: Record<string, { request?: unknown; status: number; response: unknown }> = {};
const WDW = 'water-drinks-wines';

/** Keeps arrays short so the samples stay readable. */
function trim(v: any): any {
  if (Array.isArray(v)) return v.slice(0, 2).map(trim);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /token/i.test(k) ? '<redacted>' : trim(x)]));
  return v;
}

async function call(name: string, method: 'get' | 'post' | 'patch' | 'delete', path: string, opts: { auth?: object; body?: unknown; status?: number } = {}) {
  let r = h.http[method](`${API}${path}`);
  if (opts.auth) r = r.set(opts.auth);
  const res = await (opts.body !== undefined ? r.send(opts.body) : r);
  if (opts.status) expect({ name, status: res.status }).toEqual({ name, status: opts.status });
  samples[name] = { request: opts.body && JSON.parse(JSON.stringify(opts.body).replace(/"password":"[^"]*"/, '"password":"<password>"')), status: res.status, response: trim(res.body) };
  return res.body;
}

beforeAll(async () => {
  await h.start();
  await h.markSamplesSellable();
  await h.stock('DEV-WATER-JAR', 500);
});
afterAll(async () => {
  writeFileSync(join(__dirname, '..', 'docs', 'api-samples.json'), JSON.stringify(samples, null, 2));
  await h.stop();
});

describe('Customer API contract', () => {
  let customer: Awaited<ReturnType<Harness['customer']>>;

  it('catalogue: divisions, categories, list, details, availability', async () => {
    const divisions = await call('divisions.list', 'get', '/divisions', { status: 200 });
    expect(divisions[0]).toEqual(expect.objectContaining({ id: expect.any(String), code: expect.any(String), name: expect.any(String), slug: expect.any(String), kind: expect.any(String) }));
    // The customer app's category slug for real estate also resolves.
    await call('divisions.alias', 'get', '/divisions/real-estate-interior', { status: 200 });
    await call('catalog.categories', 'get', `/catalog/categories?division=${WDW}`, { status: 200 });
    const list = await call('catalog.products', 'get', `/catalog/products?division=${WDW}&q=DEV-WATER-JAR`, { status: 200 });
    const p = list.data[0];
    expect(p).toEqual(expect.objectContaining({ id: expect.any(String), name: expect.any(String), slug: expect.any(String), priceFromMinor: expect.any(Number), inStock: expect.any(Boolean), images: expect.any(Array), variants: expect.any(Array) }));
    expect(p.variants[0]).toEqual(expect.objectContaining({ id: expect.any(String), sku: expect.any(String), name: expect.any(String), unitPriceMinor: expect.any(Number), availableQuantity: expect.any(Number) }));
    expect(list.meta).toEqual(expect.objectContaining({ page: 1, pageSize: expect.any(Number), total: expect.any(Number), totalPages: expect.any(Number) }));
    await call('catalog.product', 'get', `/catalog/products/${p.slug}`, { status: 200 });
    await call('catalog.availability', 'get', `/catalog/availability?variantIds=${p.variants[0].id}`, { status: 200 });
  });

  it('account: register, verify, login, refresh, me, profile, addresses, logout', async () => {
    const email = `contract.${Date.now()}@example.test`;
    const password = 'contract-pass-12345';
    const reg = await call('auth.register', 'post', '/auth/register', { body: { email, password, firstName: 'Ada', lastName: 'Okafor', phone: `+23480${String(Date.now()).slice(-8)}` }, status: 201 });
    expect(reg).toEqual(expect.objectContaining({ accessToken: expect.any(String), refreshToken: expect.any(String), accessTokenExpiresIn: expect.any(Number), user: expect.objectContaining({ id: expect.any(String), emailVerified: false }) }));
    await call('auth.verifyEmail', 'post', '/auth/verify-email', { body: { token: h.token(email, 'verify-email') }, status: 200 });
    const login = await call('auth.login', 'post', '/auth/login', { body: { email, password }, status: 200 });
    const refreshed = await call('auth.refresh', 'post', '/auth/refresh', { body: { refreshToken: login.refreshToken }, status: 200 });
    const auth = { Authorization: `Bearer ${refreshed.accessToken}` };
    customer = { email, id: reg.user.id, token: refreshed.accessToken, auth };
    const me = await call('auth.me', 'get', '/auth/me', { auth, status: 200 });
    expect(me).toEqual(expect.objectContaining({ email, emailVerified: true, customerProfile: expect.objectContaining({ firstName: 'Ada' }), loyalty: expect.objectContaining({ pointsBalance: 0 }) }));
    await call('account.profile', 'patch', '/me/profile', { auth, body: { firstName: 'Adaeze' }, status: 200 });
    await call('account.addAddress', 'post', '/me/addresses', { auth, body: { label: 'Home', recipientName: 'Ada Okafor', phone: '+2348031234567', line1: '1 Test Close', city: 'Wuye', state: 'FCT' }, status: 201 });
    await call('account.addresses', 'get', '/me/addresses', { auth, status: 200 });
    await call('notifications.list', 'get', '/notifications', { auth, status: 200 });
  });

  it('cart, checkout, payment options, Paystack, order history', async () => {
    const auth = customer.auth;
    const v = await h.prisma.productVariant.findUniqueOrThrow({ where: { sku: 'DEV-WATER-JAR' } });
    const cart = await call('cart.add', 'post', '/carts/items', { auth, body: { variantId: v.id, quantity: 2 }, status: 201 });
    expect(cart).toEqual(expect.objectContaining({ lines: expect.any(Array), subtotalMinor: expect.any(Number), itemCount: 2, canCheckout: true }));
    await call('cart.setQuantity', 'patch', `/carts/items/${v.id}`, { auth, body: { quantity: 3 }, status: 200 });
    await call('cart.view', 'get', `/carts/${WDW}`, { auth, status: 200 });
    const address = (await h.prisma.address.findFirstOrThrow({ where: { userId: customer.id } })).id;
    const quote = await call('cart.quote', 'get', `/carts/${WDW}/quote?fulfilmentType=DELIVERY&addressId=${address}`, { auth, status: 200 });
    expect(quote).toEqual(expect.objectContaining({ deliveryFeeMinor: expect.any(Number), totalMinor: expect.any(Number) }));
    const opts = await call('orders.checkoutOptions', 'get', `/orders/checkout-options?division=${WDW}&fulfilmentType=DELIVERY&addressId=${address}`, { auth, status: 200 });
    expect(opts.options.map((o: any) => o.option)).toEqual(expect.arrayContaining(['PAYSTACK', 'BANK_TRANSFER', 'PAY_ON_DELIVERY', 'PAY_AT_LOCATION']));
    await call('payments.methods', 'get', `/payments/methods?division=${WDW}&purpose=ORDER`, { status: 200 });
    const order = await call('orders.create', 'post', '/orders', { auth, body: { division: WDW, fulfilmentType: 'DELIVERY', addressId: address, paymentOption: 'PAYSTACK', expectedTotalMinor: quote.totalMinor }, status: 201 });
    expect(order).toEqual(expect.objectContaining({ id: expect.any(String), orderNumber: expect.any(String), status: 'PENDING', paymentStatus: 'UNPAID', paymentOption: 'PAYSTACK', totalMinor: quote.totalMinor, outstandingMinor: quote.totalMinor, items: expect.any(Array) }));
    await call('payments.options', 'get', `/payments/options?purpose=ORDER&payableId=${order.id}`, { auth, status: 200 });
    const init = await call('payments.initialize', 'post', '/payments/initialize', { auth, body: { purpose: 'ORDER', payableId: order.id }, status: 201 });
    expect(init).toEqual(expect.objectContaining({ reference: expect.any(String), authorizationUrl: expect.any(String), accessCode: expect.any(String), amountMinor: order.totalMinor, publicKey: expect.any(String) }));
    const verified = await call('payments.verify', 'post', `/payments/verify/${init.reference}`, { auth, status: 200 });
    expect(verified.status).toBe('SUCCESS');
    await call('payments.summary', 'get', `/payments/summary?purpose=ORDER&payableId=${order.id}`, { auth, status: 200 });
    await call('payments.mine', 'get', '/payments', { auth, status: 200 });
    await call('orders.detail', 'get', `/orders/${order.id}`, { auth, status: 200 });
    const history = await call('orders.history', 'get', '/orders', { auth, status: 200 });
    expect(history.data[0]).toEqual(expect.objectContaining({ status: 'ACCEPTED', paymentStatus: 'PAID', outstandingMinor: 0 }));
    const loyalty = await call('loyalty.me', 'get', '/loyalty/me', { auth, status: 200 });
    expect(loyalty.account).toEqual(expect.objectContaining({ pointsBalance: expect.any(Number), lifetimeEarned: expect.any(Number), tier: expect.any(String) }));
    expect(loyalty.history.data[0]).toEqual(expect.objectContaining({ type: 'EARN', points: expect.any(Number), balanceAfter: expect.any(Number) }));
    await call('loyalty.rules', 'get', '/loyalty/rules', { status: 200 });
  });

  it('apartments: listing, availability, quote, reservation', async () => {
    const auth = customer.auth;
    const tpl = await h.prisma.apartmentUnit.findFirstOrThrow({ where: { code: 'DEV-1' }, include: { property: true } });
    const { id, createdAt, updatedAt, code, property, ...rest } = tpl;
    const unit = await h.prisma.apartmentUnit.create({ data: { ...rest, code: `CT-${Date.now()}` } });
    await h.prisma.property.update({ where: { id: tpl.propertyId }, data: { status: 'ACTIVE', location: 'Mabushi' } });
    await h.prisma.apartmentUnit.update({ where: { id: unit.id }, data: { status: 'ACTIVE' } });
    const base = 30 + Math.floor(Math.random() * 400);
    const day = (o: number) => new Date(Date.now() + (base + o) * 86_400_000).toISOString().slice(0, 10);
    const list = await call('apartments.properties', 'get', `/apartments/properties?checkIn=${day(0)}&checkOut=${day(2)}&guests=2`, { status: 200 });
    expect(list.data[0]).toEqual(expect.objectContaining({ id: expect.any(String), slug: expect.any(String), city: expect.any(String), unitCount: expect.any(Number) }));
    const mabushi = await call('apartments.properties.location', 'get', '/apartments/properties?location=mabushi', { status: 200 });
    expect(mabushi.data.map((p: { id: string }) => p.id)).toContain(tpl.propertyId);
    expect(mabushi.data.find((p: { id: string }) => p.id === tpl.propertyId).location).toBe('Mabushi');
    const lagos = await call('apartments.properties.otherLocation', 'get', '/apartments/properties?location=lagos', { status: 200 });
    expect(lagos.data.map((p: { id: string }) => p.id)).not.toContain(tpl.propertyId);
    await call('apartments.property', 'get', `/apartments/properties/${property.slug}`, { status: 200 });
    await call('apartments.calendar', 'get', `/apartments/units/${unit.id}/calendar?from=${day(0)}&to=${day(30)}`, { status: 200 });
    const quote = await call('apartments.quote', 'get', `/apartments/units/${unit.id}/quote?checkIn=${day(0)}&checkOut=${day(2)}&guests=2`, { status: 200 });
    expect(quote).toEqual(expect.objectContaining({ nights: 2, totalMinor: expect.any(Number), available: true }));
    const res = await call('apartments.reserve', 'post', '/apartments/reservations', { auth, body: { unitId: unit.id, checkIn: day(0), checkOut: day(2), guests: 2 }, status: 201 });
    expect(res).toEqual(expect.objectContaining({ status: 'HOLD', paymentStatus: 'UNPAID', holdExpiresAt: expect.any(String), totalMinor: quote.totalMinor, depositRequiredMinor: expect.any(Number) }));
    await call('apartments.reservations', 'get', '/apartments/reservations', { auth, status: 200 });
    await call('apartments.cancel', 'post', `/apartments/reservations/${res.id}/cancel`, { auth, body: {}, status: 200 });
  });

  it('vehicles: listing, details, inquiry', async () => {
    const auth = customer.auth;
    const list = await call('vehicles.list', 'get', '/vehicles?pageSize=5', { status: 200 });
    const v = list.data[0];
    expect(v).toEqual(expect.objectContaining({ id: expect.any(String), slug: expect.any(String), make: expect.any(String), model: expect.any(String), priceMinor: expect.any(Number) }));
    expect(v.vin).toBeUndefined();
    await call('vehicles.detail', 'get', `/vehicles/${v.slug}`, { status: 200 });
    await call('vehicles.inquire', 'post', `/vehicles/${v.id}/inquiries`, { auth, body: { type: 'TEST_DRIVE', contactName: 'Ada Okafor', contactEmail: customer.email, contactPhone: '+2348031234567', message: 'Saturday morning?' }, status: 201 });
    await call('vehicles.inquiries', 'get', '/vehicles/inquiries/mine', { auth, status: 200 });
  });

  it('spa: treatments, slots, appointment', async () => {
    const auth = customer.auth;
    const admin = await h.admin();
    const t = await h.prisma.spaTreatment.findFirstOrThrow({ where: { slug: 'dev-sample-massage' } });
    await h.http.post(`${API}/admin/spa/practitioners`).set(admin.auth).send({ displayName: `Contract therapist ${Date.now()}`, treatmentIds: [t.id] }).expect(201);
    await call('spa.treatments', 'get', '/spa/treatments', { status: 200 });
    await call('spa.treatment', 'get', `/spa/treatments/${t.slug}`, { status: 200 });
    const date = new Date(Date.now() + (400 + Math.floor(Math.random() * 100)) * 86_400_000).toISOString().slice(0, 10);
    const slots = await call('spa.slots', 'get', `/spa/treatments/${t.id}/slots?date=${date}`, { status: 200 });
    expect(slots.slots[0]).toEqual(expect.objectContaining({ startsAt: expect.any(String), endsAt: expect.any(String), practitionerIds: expect.any(Array) }));
    const appt = await call('spa.book', 'post', '/spa/appointments', { auth, body: { treatmentId: t.id, startsAt: slots.slots[0].startsAt }, status: 201 });
    expect(appt).toEqual(expect.objectContaining({ appointmentNumber: expect.any(String), status: 'PENDING', depositRequiredMinor: Number(t.depositMinor) }));
    await call('spa.appointments', 'get', '/spa/appointments', { auth, status: 200 });
  });

  it('errors have one documented shape', async () => {
    const shape = expect.objectContaining({ statusCode: expect.any(Number), message: expect.anything(), requestId: expect.any(String) });
    expect(await call('error.401', 'get', '/auth/me', { status: 401 })).toEqual(shape);
    expect(await call('error.400', 'post', '/auth/register', { body: { email: 'bad' }, status: 400 })).toEqual(shape);
    expect(await call('error.403', 'get', '/admin/orders', { auth: customer.auth, status: 403 })).toEqual(shape);
    expect(await call('error.404', 'get', '/catalog/products/does-not-exist', { status: 404 })).toEqual(shape);
    const v = await h.prisma.productVariant.findUniqueOrThrow({ where: { sku: 'DEV-WATER-JAR' } });
    expect(await call('error.409', 'post', '/carts/items', { auth: customer.auth, body: { variantId: v.id, quantity: 1000 }, status: 409 })).toEqual(shape);
  });
});
