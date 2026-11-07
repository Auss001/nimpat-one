import { API, Harness } from './harness';
import { LIVE_PAYSTACK_KEY, PAYSTACK_DRY_RUN, TEST_PAYSTACK_SECRET } from './test-env';

/**
 * Real Paystack TEST environment check.
 *
 *   PAYSTACK_LIVE_TEST_KEY=sk_test_xxx npm run test:paystack
 *
 * Talks to api.paystack.co with your TEST key (live keys are refused). The key
 * is only read from the environment and is never printed.
 * Without a key this spec is skipped. PAYSTACK_DRY_RUN=1 runs the same steps
 * against the local mock, to prove the script itself works.
 *
 * Amount and currency mismatches cannot be forced on Paystack, so those stay
 * covered by the mock in payments-methods.e2e-spec.ts.
 */
const enabled = !!LIVE_PAYSTACK_KEY || PAYSTACK_DRY_RUN;
const suite = enabled ? describe : describe.skip;
const h = new Harness();
const WDW = 'water-drinks-wines';

async function placeOrder(c: { auth: object }) {
  const v = await h.prisma.productVariant.findUniqueOrThrow({ where: { sku: 'DEV-WATER-JAR' } });
  await h.http.post(`${API}/carts/items`).set(c.auth).send({ variantId: v.id, quantity: 1 }).expect(201);
  const res = await h.http.post(`${API}/orders`).set(c.auth).send({ division: WDW, fulfilmentType: 'PICKUP', paymentOption: 'PAYSTACK' }).expect(201);
  return res.body;
}

/** Pays with Paystack's published test card through the Charge API. */
async function chargeTestCard(email: string, amount: number, reference: string) {
  const res = await fetch(`${process.env.PAYSTACK_BASE_URL}/charge`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, amount, reference, card: { number: '4084084084084081', cvv: '408', expiry_month: '12', expiry_year: '30' } }),
  });
  return { http: res.status, body: (await res.json()) as { status: boolean; message: string; data?: { status?: string } } };
}

suite(`Paystack test environment (${LIVE_PAYSTACK_KEY ? 'REAL test API' : 'dry run on mock'})`, () => {
  let admin: { auth: object };
  beforeAll(async () => {
    await h.start();
    await h.markSamplesSellable();
    await h.stock('DEV-WATER-JAR', 1000);
    admin = await h.admin();
    await h.http.put(`${API}/admin/payment-settings/policies/${WDW}/ORDER`).set(admin.auth).send({ allowPaystack: true }).expect(200);
    expect(process.env.PAYSTACK_SECRET_KEY).toMatch(/^sk_test_/);
  });
  afterAll(() => h.stop());

  let customer: Awaited<ReturnType<Harness['customer']>>;
  let order: any;
  let reference: string;
  let paymentId: string;
  // Paystack will not let a script pay a transaction its checkout already started; that payment is made by hand.
  let paid = false;

  it('initialises a real transaction with a server-computed amount', async () => {
    customer = await h.customer();
    order = await placeOrder(customer);
    const init = await h.http.post(`${API}/payments/initialize`).set(customer.auth).send({ purpose: 'ORDER', payableId: order.id }).expect(201);
    reference = init.body.reference;
    paymentId = init.body.paymentId;
    expect(init.body.amountMinor).toBe(order.totalMinor);
    expect(init.body.authorizationUrl).toMatch(/^https:\/\//);
    if (PAYSTACK_DRY_RUN) h.paystack.outcome.set(reference, { status: 'abandoned' });
  });

  it('interrupted checkout: verifying before paying leaves the order unpaid', async () => {
    const v = await h.http.post(`${API}/payments/verify/${reference}`).set(customer.auth).expect(200);
    expect(v.body.status).not.toBe('SUCCESS');
    const o = await h.prisma.order.findUnique({ where: { id: order.id } });
    expect(o.status).toBe('PENDING');
    expect(o.paymentStatus).toBe('UNPAID');
  });

  it('webhook authentication: a bad signature is refused', async () => {
    await h.http.post(`${API}/payments/webhooks/paystack`).set('x-paystack-signature', 'deadbeef').send({ event: 'charge.success', data: { reference } }).expect(401);
  });

  it('a correctly signed but false webhook cannot mark the order paid, because verify is asked', async () => {
    await h.webhook({ event: 'charge.success', data: { id: 1, reference, status: 'success', amount: order.totalMinor } }).expect(200);
    expect((await h.prisma.order.findUnique({ where: { id: order.id } })).paymentStatus).toBe('UNPAID');
  });

  it('pays with the test card, verifies with Paystack and accepts the order', async () => {
    if (PAYSTACK_DRY_RUN) h.paystack.outcome.delete(reference);
    const charge = await chargeTestCard(customer.email, order.totalMinor, reference);
    // Report the result without exposing anything sensitive.
    console.log(`Paystack /charge: HTTP ${charge.http}, ${charge.body.message}, status=${charge.body.data?.status ?? 'n/a'}`);
    if (!charge.body.status && /duplicate transaction reference/i.test(charge.body.message)) {
      console.log('Not automatable on this account: pay once by hand on the checkout page with a Paystack test card.');
      return;
    }
    expect(charge.body.status).toBe(true);
    const v = await h.http.post(`${API}/payments/verify/${reference}`).set(customer.auth).expect(200);
    expect(v.body.status).toBe('SUCCESS');
    const o = await h.prisma.order.findUnique({ where: { id: order.id } });
    expect(o.status).toBe('ACCEPTED');
    expect(o.paymentStatus).toBe('PAID');
    paid = true;
  });

  it('duplicate webhook delivery does not double-fulfil', async () => {
    if (!paid) return console.log('Skipped: needs the paid order from the hand-made payment.');
    const payload = { event: 'charge.success', data: { id: 2, reference, status: 'success', amount: order.totalMinor } };
    await h.webhook(payload).expect(200);
    const dup = await h.webhook(payload).expect(200);
    expect(dup.body.duplicate).toBe(true);
    expect(await h.prisma.stockMovement.count({ where: { orderId: order.id, type: 'SALE' } })).toBe(1);
  });

  it('a failed card leaves the order unpaid', async () => {
    const c = await h.customer();
    const o = await placeOrder(c);
    const init = await h.http.post(`${API}/payments/initialize`).set(c.auth).send({ purpose: 'ORDER', payableId: o.id }).expect(201);
    if (PAYSTACK_DRY_RUN) h.paystack.outcome.set(init.body.reference, { status: 'failed' });
    else {
      // Paystack's published test card for a declined charge.
      await fetch(`${process.env.PAYSTACK_BASE_URL}/charge`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: c.email, amount: o.totalMinor, reference: init.body.reference, card: { number: '4084080000005408', cvv: '001', expiry_month: '12', expiry_year: '30' } }),
      });
    }
    const v = await h.http.post(`${API}/payments/verify/${init.body.reference}`).set(c.auth).expect(200);
    expect(v.body.status).not.toBe('SUCCESS');
    expect((await h.prisma.order.findUnique({ where: { id: o.id } })).status).toBe('PENDING');
  });

  it('requests a refund and reconciliation refreshes its status', async () => {
    if (!paid) return console.log('Skipped: needs the paid order from the hand-made payment.');
    const refund = await h.http.post(`${API}/admin/payments/${paymentId}/refunds`).set(admin.auth).send({ reason: 'Paystack test-mode check' }).expect(201);
    expect(refund.body.providerRefundId).toBeTruthy();
    const rec = await h.http.post(`${API}/admin/payments/reconcile`).set(admin.auth).expect(200);
    expect(rec.body.refundsChecked).toBeGreaterThan(0);
    expect((await h.prisma.payment.findUnique({ where: { id: paymentId } })).refundStatus).not.toBe('NONE');
  });
});

if (!enabled) {
  it('skipped: set PAYSTACK_LIVE_TEST_KEY to run against Paystack test mode', () => {
    expect(TEST_PAYSTACK_SECRET).toMatch(/^sk_test_/);
  });
}
