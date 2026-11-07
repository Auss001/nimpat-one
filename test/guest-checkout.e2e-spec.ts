import { API, Harness } from './harness';

/** Buying without an account: guests can order and pay, but only members earn Royalty points. */
const h = new Harness();
let finance: { auth: object };
let officer: { auth: object };
let n = 0;
const WDW = 'water-drinks-wines';

const guestDetails = () => ({ email: `guest${++n}.${Date.now()}@example.test`, firstName: 'Guest', lastName: `Buyer${n}`, phone: `+23480${String(Date.now()).slice(-7)}${n % 10}` });
async function startGuest(details = guestDetails()) {
  const res = await h.http.post(`${API}/auth/guest`).send(details).expect(201);
  return { ...details, id: res.body.user.id as string, body: res.body, auth: { Authorization: `Bearer ${res.body.accessToken}` } };
}

beforeAll(async () => {
  await h.start();
  await h.markSamplesSellable();
  await h.stock('DEV-WATER-JAR', 1000);
  finance = await h.staff('FINANCE_OFFICER');
  officer = await h.staff('DEPARTMENT_STAFF', WDW);
});
afterAll(() => h.stop());

describe('guest checkout', () => {
  it('starts without a password and shows the real contact details', async () => {
    const g = await startGuest();
    expect(g.body.user).toMatchObject({ isGuest: true, email: g.email, phone: g.phone });
    const me = await h.http.get(`${API}/auth/me`).set(g.auth).expect(200);
    expect(me.body).toMatchObject({ isGuest: true, email: g.email, loyalty: null });
    // The internal sign-in address is never usable for signing in.
    const row = await h.prisma.user.findUniqueOrThrow({ where: { id: g.id } });
    expect(row.email).toMatch(/@guest\.invalid$/);
    await h.http.post(`${API}/auth/login`).send({ email: g.email, password: 'anything-1234' }).expect(401);
  });

  it('sends a member to sign in rather than checking out as a guest', async () => {
    const member = await h.customer();
    await h.http.post(`${API}/auth/guest`).send({ ...guestDetails(), email: member.email }).expect(409);
  });

  it('lets a guest order and pay on delivery, and earns no Royalty points', async () => {
    const g = await startGuest();
    const v = await h.prisma.productVariant.findUniqueOrThrow({ where: { sku: 'DEV-WATER-JAR' } });
    await h.http.post(`${API}/carts/items`).set(g.auth).send({ variantId: v.id, quantity: 1 }).expect(201);
    const addressId = await h.address(g.auth);
    const order = (await h.http.post(`${API}/orders`).set(g.auth).send({ division: WDW, fulfilmentType: 'DELIVERY', addressId, paymentOption: 'PAY_ON_DELIVERY' }).expect(201)).body;

    // Staff see the guest's real email, not the internal one.
    const staffView = await h.http.get(`${API}/admin/orders/${order.id}`).set(finance.auth);
    if (staffView.status === 200) expect(staffView.body.user).toMatchObject({ isGuest: true, contactEmail: g.email });

    const col = await h.http.post(`${API}/admin/collections`).set(officer.auth)
      .send({ purpose: 'ORDER', payableId: order.id, method: 'CASH', point: 'DELIVERY', amountMinor: order.totalMinor }).expect(201);
    await h.http.post(`${API}/admin/payments/${col.body.id}/confirm-funds`).set(finance.auth)
      .send({ receivedAmountMinor: order.totalMinor, verificationReference: `GUEST-${order.orderNumber}` }).expect(200);
    expect((await h.http.get(`${API}/orders/${order.id}`).set(g.auth).expect(200)).body.paymentStatus).toBe('PAID');
    expect(await h.prisma.loyaltyTransaction.count({ where: { account: { userId: g.id } } })).toBe(0);
  });

  it('turns a guest into a member who keeps their orders and starts earning points', async () => {
    const g = await startGuest();
    const v = await h.prisma.productVariant.findUniqueOrThrow({ where: { sku: 'DEV-WATER-JAR' } });
    await h.http.post(`${API}/carts/items`).set(g.auth).send({ variantId: v.id, quantity: 1 }).expect(201);
    const addressId = await h.address(g.auth);
    const order = (await h.http.post(`${API}/orders`).set(g.auth).send({ division: WDW, fulfilmentType: 'DELIVERY', addressId, paymentOption: 'PAY_ON_DELIVERY' }).expect(201)).body;

    const password = 'new-member-pass-42';
    const up = await h.http.post(`${API}/auth/guest/upgrade`).set(g.auth).send({ password }).expect(200);
    expect(up.body).toMatchObject({ isGuest: false, email: g.email });
    // A verification email goes to the real address.
    expect(() => h.token(g.email, 'verify-email')).not.toThrow();
    const login = await h.http.post(`${API}/auth/login`).send({ email: g.email, password }).expect(200);
    const auth = { Authorization: `Bearer ${login.body.accessToken}` };
    expect((await h.http.get(`${API}/orders/${order.id}`).set(auth).expect(200)).body.id).toBe(order.id);
    expect((await h.http.get(`${API}/auth/me`).set(auth).expect(200)).body.loyalty).toMatchObject({ pointsBalance: 0 });
    // Only once.
    await h.http.post(`${API}/auth/guest/upgrade`).set(auth).send({ password }).expect(400);
  });

  it('will not upgrade a guest onto an email someone has since registered', async () => {
    const g = await startGuest();
    await h.http.post(`${API}/auth/register`).send({ email: g.email, password: 'someone-else-pass-7', firstName: 'Other', lastName: 'Person' }).expect(201);
    await h.http.post(`${API}/auth/guest/upgrade`).set(g.auth).send({ password: 'guest-own-pass-77' }).expect(409);
  });

  it('lets a guest delete their details without a password', async () => {
    const g = await startGuest();
    await h.http.delete(`${API}/me`).set(g.auth).send({}).expect(200);
    const row = await h.prisma.user.findUniqueOrThrow({ where: { id: g.id } });
    expect([row.status, row.contactEmail, row.contactPhone]).toEqual(['DEACTIVATED', null, null]);
  });

  it('still asks members for their password to delete', async () => {
    const c = await h.customer();
    await h.http.delete(`${API}/me`).set(c.auth).send({}).expect(400);
  });
});
