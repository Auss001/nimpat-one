/* eslint-disable @typescript-eslint/no-require-imports */
import { createHmac } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { MockPaystack } from './mock-paystack';
import { applyTestEnv, MOCK_PAYSTACK_PORT, TEST_PAYSTACK_SECRET } from './test-env';

applyTestEnv();
// Loaded after the env is set so ConfigModule validates the test configuration.
const { AppModule } = require('../src/app.module');
const { configureApp } = require('../src/bootstrap');
const { MailService } = require('../src/modules/notifications/mail.service');
const { PrismaService } = require('../src/prisma/prisma.service');

const mails: { to: string; subject: string; devOnlyDetail?: string }[] = [];
const paystack = new MockPaystack();
let app: INestApplication;
let prisma: any;
let http: any;
const API = '/api/v1';

function tokenFromMail(to: string, kind: 'verify-email' | 'reset-password'): string {
  const mail = [...mails].reverse().find((m) => m.to === to && m.devOnlyDetail?.includes(kind));
  const match = mail?.devOnlyDetail?.match(/token=([\w-]+)/);
  if (!match) throw new Error(`No ${kind} mail for ${to}`);
  return match[1];
}

let userSeq = 0;
async function newCustomer(verified = true) {
  const email = `customer${++userSeq}.${Date.now()}@example.test`;
  const password = 'correct-horse-battery-9';
  const res = await http.post(`${API}/auth/register`).send({ email, password, firstName: 'Test', lastName: `User${userSeq}` }).expect(201);
  if (verified) {
    await http.post(`${API}/auth/verify-email`).send({ token: tokenFromMail(email, 'verify-email') }).expect(200);
  }
  const login = await http.post(`${API}/auth/login`).send({ email, password }).expect(200);
  return { email, password, id: res.body.user.id, token: login.body.accessToken as string, refresh: login.body.refreshToken as string };
}

async function adminToken() {
  const res = await http.post(`${API}/auth/login`).send({ email: process.env.SEED_ADMIN_EMAIL, password: process.env.SEED_ADMIN_PASSWORD }).expect(200);
  return res.body.accessToken as string;
}

async function addAddress(token: string) {
  const res = await http
    .post(`${API}/me/addresses`)
    .set('Authorization', `Bearer ${token}`)
    .send({ recipientName: 'Test Recipient', phone: '+2348031234567', line1: '1 Test Close', city: 'Wuye', state: 'FCT' })
    .expect(201);
  return res.body.id as string;
}

async function variantBySku(sku: string) {
  return prisma.productVariant.findUniqueOrThrow({ where: { sku }, include: { stockLevels: true } });
}

/**
 * Test fixture (test database only): the seed marks its placeholder data as
 * DEV_SAMPLE, which the API refuses to sell. Tests treat it as confirmed.
 */
export async function markSamplesSellable(db: any) {
  const data = { verification: 'VERIFIED' };
  for (const m of ['product', 'apartmentUnit', 'vehicle', 'spaTreatment', 'serviceOffering', 'deliveryZone']) {
    await db[m].updateMany({ where: { verification: { not: 'VERIFIED' } }, data });
  }
}

function signedWebhook(payload: unknown) {
  const raw = JSON.stringify(payload);
  const sig = createHmac('sha512', TEST_PAYSTACK_SECRET).update(raw).digest('hex');
  return http.post(`${API}/payments/webhooks/paystack`).set('Content-Type', 'application/json').set('x-paystack-signature', sig).send(raw);
}

beforeAll(async () => {
  await paystack.start(MOCK_PAYSTACK_PORT);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MailService)
    .useValue({ send: async (m: any) => void mails.push(m) })
    .compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true, logger: ['error'] });
  configureApp(app as NestExpressApplication);
  await app.init();
  prisma = app.get(PrismaService);
  http = request(app.getHttpServer());
  await markSamplesSellable(prisma);
});

afterAll(async () => {
  await app?.close();
  await paystack.stop();
});

describe('Platform', () => {
  it('reports health and lists the ten divisions', async () => {
    await http.get('/health/ready').expect(200, { status: 'ok', database: 'up' });
    const res = await http.get(`${API}/divisions`).expect(200);
    expect(res.body).toHaveLength(10);
    expect(res.body.map((d: any) => d.code)).toContain('WATER_DRINKS_WINES');
  });

  it('rejects unknown fields and malformed input', async () => {
    await http.post(`${API}/auth/register`).send({ email: 'x@example.test', password: 'short', firstName: 'a', lastName: 'b', role: 'SUPER_ADMIN' }).expect(400);
  });
});

describe('Authentication', () => {
  it('registers, verifies email, logs in and returns profile', async () => {
    const c = await newCustomer();
    const me = await http.get(`${API}/auth/me`).set('Authorization', `Bearer ${c.token}`).expect(200);
    expect(me.body.email).toBe(c.email);
    expect(me.body.emailVerified).toBe(true);
    expect(me.body.roles.map((r: any) => r.code)).toEqual(['CUSTOMER']);
  });

  it('rejects wrong passwords without revealing whether the email exists', async () => {
    const c = await newCustomer();
    const a = await http.post(`${API}/auth/login`).send({ email: c.email, password: 'wrong-password-123' }).expect(401);
    const b = await http.post(`${API}/auth/login`).send({ email: 'nobody@example.test', password: 'wrong-password-123' }).expect(401);
    expect(a.body.message).toBe(b.body.message);
  });

  it('rotates refresh tokens and revokes everything on reuse', async () => {
    const c = await newCustomer();
    const r1 = await http.post(`${API}/auth/refresh`).send({ refreshToken: c.refresh }).expect(200);
    await http.post(`${API}/auth/refresh`).send({ refreshToken: c.refresh }).expect(401); // replay
    await http.post(`${API}/auth/refresh`).send({ refreshToken: r1.body.refreshToken }).expect(401); // family revoked
    await http.get(`${API}/auth/me`).set('Authorization', `Bearer ${r1.body.accessToken}`).expect(401);
  });

  it('logs out (access token stops working) and resets password', async () => {
    const c = await newCustomer();
    await http.post(`${API}/auth/logout`).set('Authorization', `Bearer ${c.token}`).expect(200);
    await http.get(`${API}/auth/me`).set('Authorization', `Bearer ${c.token}`).expect(401);

    await http.post(`${API}/auth/forgot-password`).send({ email: c.email }).expect(200);
    await http.post(`${API}/auth/reset-password`).send({ token: tokenFromMail(c.email, 'reset-password'), newPassword: 'a-new-passphrase-42' }).expect(200);
    await http.post(`${API}/auth/login`).send({ email: c.email, password: c.password }).expect(401);
    await http.post(`${API}/auth/login`).send({ email: c.email, password: 'a-new-passphrase-42' }).expect(200);
  });
});

describe('Authorization', () => {
  it('blocks customers from admin endpoints', async () => {
    const c = await newCustomer();
    await http.get(`${API}/admin/orders`).set('Authorization', `Bearer ${c.token}`).expect(403);
    await http.get(`${API}/admin/orders`).expect(401);
  });

  it('scopes department managers to their own division', async () => {
    const admin = await adminToken();
    const spa = await prisma.division.findUniqueOrThrow({ where: { code: 'SPA_WELLNESS' } });
    const email = `spa.manager.${Date.now()}@nimpat.test`;
    const created = await http
      .post(`${API}/admin/staff`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ email, firstName: 'Spa', lastName: 'Manager', employeeNumber: `E2E-${Date.now()}`, role: 'DEPARTMENT_MANAGER', divisionId: spa.id })
      .expect(201);
    expect(created.body.roles[0].role.code).toBe('DEPARTMENT_MANAGER');
    // Invited staff set their password through the emailed link.
    await http.post(`${API}/auth/reset-password`).send({ token: tokenFromMail(email, 'reset-password'), newPassword: 'spa-manager-pass-1' }).expect(200);
    const login = await http.post(`${API}/auth/login`).send({ email, password: 'spa-manager-pass-1' }).expect(200);
    const t = login.body.accessToken;

    await http.post(`${API}/admin/catalog/products`).set('Authorization', `Bearer ${t}`)
      .send({ division: 'water-drinks-wines', name: 'Should fail', slug: 'should-fail' }).expect(403);
    await http.post(`${API}/admin/spa/treatments`).set('Authorization', `Bearer ${t}`)
      .send({ name: 'E2E Facial', slug: `e2e-facial-${Date.now()}`, durationMinutes: 45, priceMinor: 1000000 }).expect(201);
    // A department manager cannot grant group-wide roles.
    await http.post(`${API}/admin/users/${created.body.id}/roles`).set('Authorization', `Bearer ${t}`).send({ role: 'SUPER_ADMIN' }).expect(403);
  });
});

describe('Water & Drinks commerce + Paystack', () => {
  it('prices on the server, reserves stock, and only marks paid after verification', async () => {
    const c = await newCustomer();
    const auth = { Authorization: `Bearer ${c.token}` };
    const addressId = await addAddress(c.token);
    const v = await variantBySku('DEV-WATER-PACK-12');
    const before = v.stockLevels[0];

    const list = await http.get(`${API}/catalog/products?division=water-drinks-wines`).expect(200);
    expect(list.body.data.length).toBeGreaterThan(0);

    const cart = await http.post(`${API}/carts/items`).set(auth).send({ variantId: v.id, quantity: 2 }).expect(201);
    expect(cart.body.subtotalMinor).toBe(500000); // 2 × ₦2,500.00 from the database

    const quote = await http.get(`${API}/carts/water-drinks-wines/quote?fulfilmentType=DELIVERY&addressId=${addressId}`).set(auth).expect(200);
    expect(quote.body.deliveryFeeMinor).toBe(150000);
    expect(quote.body.totalMinor).toBe(650000);

    // Stale client total → rejected
    await http.post(`${API}/orders`).set(auth).send({ division: 'water-drinks-wines', fulfilmentType: 'DELIVERY', addressId, expectedTotalMinor: 1 }).expect(409);

    const key = `order-${Date.now()}`;
    const order = await http.post(`${API}/orders`).set(auth).set('Idempotency-Key', key)
      .send({ division: 'water-drinks-wines', fulfilmentType: 'DELIVERY', addressId, expectedTotalMinor: 650000 }).expect(201);
    expect(order.body.status).toBe('PENDING');
    expect(order.body.paymentStatus).toBe('UNPAID');
    expect(order.body.totalMinor).toBe(650000);
    const again = await http.post(`${API}/orders`).set(auth).set('Idempotency-Key', key)
      .send({ division: 'water-drinks-wines', fulfilmentType: 'DELIVERY', addressId }).expect(201);
    expect(again.body.id).toBe(order.body.id);

    const reserved = await prisma.stockLevel.findUniqueOrThrow({ where: { id: before.id } });
    expect(reserved.quantityReserved).toBe(before.quantityReserved + 2);

    const init = await http.post(`${API}/payments/initialize`).set(auth).send({ purpose: 'ORDER', payableId: order.body.id }).expect(201);
    expect(init.body.amountMinor).toBe(650000);
    expect(paystack.transactions.get(init.body.reference)?.amount).toBe(650000);

    // Not paid until verified
    expect((await prisma.order.findUnique({ where: { id: order.body.id } })).status).toBe('PENDING');

    const verified = await http.post(`${API}/payments/verify/${init.body.reference}`).set(auth).expect(200);
    expect(verified.body.status).toBe('SUCCESS');
    const paid = await http.get(`${API}/orders/${order.body.id}`).set(auth).expect(200);
    expect(paid.body.status).toBe('ACCEPTED');
    expect(paid.body.paymentStatus).toBe('PAID');
    expect(paid.body.outstandingMinor).toBe(0);

    const after = await prisma.stockLevel.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.quantityOnHand).toBe(before.quantityOnHand - 2);
    expect(after.quantityReserved).toBe(before.quantityReserved);

    // Loyalty: ₦6,500 × 1 pt/₦100 = 65 points
    const loyalty = await http.get(`${API}/loyalty/me`).set(auth).expect(200);
    expect(loyalty.body.account.pointsBalance).toBe(65);

    // A replayed charge.success webhook does not double-fulfil
    const payload = { event: 'charge.success', data: { id: 1, reference: init.body.reference, status: 'success', amount: 650000 } };
    await signedWebhook(payload).expect(200);
    const dup = await signedWebhook(payload).expect(200);
    expect(dup.body.duplicate).toBe(true);
    const final = await prisma.stockLevel.findUniqueOrThrow({ where: { id: before.id } });
    expect(final.quantityOnHand).toBe(after.quantityOnHand);
    expect((await http.get(`${API}/loyalty/me`).set(auth)).body.account.pointsBalance).toBe(65);
  });

  it('never sells more than is in stock under concurrent checkouts', async () => {
    const seeded = await variantBySku('DEV-WATER-PACK-24');
    // Fixture: exactly 3 units available for this run.
    await prisma.stockLevel.update({ where: { id: seeded.stockLevels[0].id }, data: { quantityOnHand: seeded.stockLevels[0].quantityReserved + 3 } });
    const v = await variantBySku('DEV-WATER-PACK-24');
    const available = 3;
    const customers = await Promise.all(Array.from({ length: 6 }, () => newCustomer()));
    for (const c of customers) {
      await prisma.cart.upsert({
        where: { userId_divisionId: { userId: c.id, divisionId: (await prisma.division.findUniqueOrThrow({ where: { code: 'WATER_DRINKS_WINES' } })).id } },
        create: { userId: c.id, divisionId: (await prisma.division.findUniqueOrThrow({ where: { code: 'WATER_DRINKS_WINES' } })).id, items: { create: { variantId: v.id, quantity: 1 } } },
        update: {},
      });
    }
    const results = await Promise.all(
      customers.map((c) => http.post(`${API}/orders`).set('Authorization', `Bearer ${c.token}`).send({ division: 'water-drinks-wines', fulfilmentType: 'PICKUP' })),
    );
    const ok = results.filter((r) => r.status === 201).length;
    const conflicts = results.filter((r) => r.status === 409).length;
    expect(ok).toBe(available);
    expect(conflicts).toBe(customers.length - available);
    const level = await prisma.stockLevel.findFirstOrThrow({ where: { variantId: v.id } });
    expect(level.quantityReserved).toBeLessThanOrEqual(level.quantityOnHand);
  });

  it('refuses to mark paid when Paystack reports a different amount', async () => {
    const c = await newCustomer();
    const auth = { Authorization: `Bearer ${c.token}` };
    const v = await variantBySku('DEV-SODA-CRATE');
    await http.post(`${API}/carts/items`).set(auth).send({ variantId: v.id, quantity: 1 }).expect(201);
    const order = await http.post(`${API}/orders`).set(auth).send({ division: 'water-drinks-wines', fulfilmentType: 'PICKUP' }).expect(201);
    const init = await http.post(`${API}/payments/initialize`).set(auth).send({ purpose: 'ORDER', payableId: order.body.id }).expect(201);
    paystack.outcome.set(init.body.reference, { status: 'success', amount: 100 });
    const res = await http.post(`${API}/payments/verify/${init.body.reference}`).set(auth).expect(200);
    expect(res.body.status).toBe('FAILED');
    const o = await prisma.order.findUnique({ where: { id: order.body.id } });
    expect(o.status).toBe('PENDING');
    expect(o.paymentStatus).not.toBe('PAID');
  });

  it('rejects webhooks with an invalid signature', async () => {
    await http.post(`${API}/payments/webhooks/paystack`).set('x-paystack-signature', 'deadbeef').send({ event: 'charge.success', data: {} }).expect(401);
    await http.post(`${API}/payments/webhooks/paystack`).send({ event: 'charge.success', data: {} }).expect(401);
  });

  it('requires a verified email before payment', async () => {
    const c = await newCustomer(false);
    const auth = { Authorization: `Bearer ${c.token}` };
    const v = await variantBySku('DEV-WATER-JAR');
    await http.post(`${API}/carts/items`).set(auth).send({ variantId: v.id, quantity: 1 }).expect(201);
    const order = await http.post(`${API}/orders`).set(auth).send({ division: 'water-drinks-wines', fulfilmentType: 'PICKUP' }).expect(201);
    await http.post(`${API}/payments/initialize`).set(auth).send({ purpose: 'ORDER', payableId: order.body.id }).expect(403);
  });

  it('cancelling an unpaid order releases its reserved stock', async () => {
    const c = await newCustomer();
    const auth = { Authorization: `Bearer ${c.token}` };
    const v = await variantBySku('DEV-WATER-JAR');
    const start = (await prisma.stockLevel.findFirstOrThrow({ where: { variantId: v.id } })).quantityReserved;
    await http.post(`${API}/carts/items`).set(auth).send({ variantId: v.id, quantity: 4 }).expect(201);
    const order = await http.post(`${API}/orders`).set(auth).send({ division: 'water-drinks-wines', fulfilmentType: 'PICKUP' }).expect(201);
    expect((await prisma.stockLevel.findFirstOrThrow({ where: { variantId: v.id } })).quantityReserved).toBe(start + 4);
    await http.post(`${API}/orders/${order.body.id}/cancel`).set(auth).expect(200);
    expect((await prisma.stockLevel.findFirstOrThrow({ where: { variantId: v.id } })).quantityReserved).toBe(start);
  });

  it('processes refunds through to REFUNDED via webhook and reverses loyalty points', async () => {
    const c = await newCustomer();
    const auth = { Authorization: `Bearer ${c.token}` };
    const v = await variantBySku('DEV-WATER-JAR');
    await http.post(`${API}/carts/items`).set(auth).send({ variantId: v.id, quantity: 1 }).expect(201);
    const order = await http.post(`${API}/orders`).set(auth).send({ division: 'water-drinks-wines', fulfilmentType: 'PICKUP' }).expect(201);
    const init = await http.post(`${API}/payments/initialize`).set(auth).send({ purpose: 'ORDER', payableId: order.body.id }).expect(201);
    await http.post(`${API}/payments/verify/${init.body.reference}`).set(auth).expect(200);
    expect((await http.get(`${API}/loyalty/me`).set(auth)).body.account.pointsBalance).toBe(10);

    const admin = await adminToken();
    await http.patch(`${API}/admin/orders/${order.body.id}/status`).set('Authorization', `Bearer ${admin}`).send({ status: 'CANCELLED', note: 'Customer request' }).expect(200);
    const refund = await http.post(`${API}/admin/payments/${init.body.paymentId}/refunds`).set('Authorization', `Bearer ${admin}`).send({ reason: 'Order cancelled' }).expect(201);
    expect(refund.body.status).toBe('PENDING');

    await signedWebhook({ event: 'refund.processed', data: { id: Number(refund.body.providerRefundId), status: 'processed', transaction_reference: init.body.reference, amount: 100000, currency: 'NGN' } }).expect(200);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: init.body.paymentId } });
    expect(payment.refundStatus).toBe('REFUNDED');
    expect(Number(payment.refundedMinor)).toBe(100000);
    const refundedOrder = await prisma.order.findUnique({ where: { id: order.body.id } });
    expect(refundedOrder.status).toBe('CANCELLED');
    expect(refundedOrder.paymentStatus).toBe('REFUNDED');
    expect(Number(refundedOrder.amountPaidMinor)).toBe(0);
    expect((await http.get(`${API}/loyalty/me`).set(auth)).body.account.pointsBalance).toBe(0);
  });
});

describe('Luxury Apartments booking', () => {
  // A random window per run so re-runs against the same test DB never collide.
  // Kept well inside the 540-day advance-booking limit (largest offset used is +83).
  const base = 20 + Math.floor(Math.random() * 400);
  // Each test gets its own unit (cloned from the seeded sample) so re-runs never collide.
  const freshUnit = async () => {
    const tpl = await prisma.apartmentUnit.findFirstOrThrow({ where: { code: 'DEV-1' } });
    const { id, createdAt, updatedAt, code, ...rest } = tpl;
    return prisma.apartmentUnit.create({ data: { ...rest, code: 'E2E-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) } });
  };
  const day = (offset: number) => new Date(Date.now() + (base + offset) * 86_400_000).toISOString().slice(0, 10);

  it('quotes on the server, holds dates, prevents double booking and confirms on payment', async () => {
    const unit = await freshUnit();
    const [a, b] = [await newCustomer(), await newCustomer()];
    const checkIn = day(30);
    const checkOut = day(33);

    const quote = await http.get(`${API}/apartments/units/${unit.id}/quote?checkIn=${checkIn}&checkOut=${checkOut}&guests=2`).expect(200);
    expect(quote.body.nights).toBe(3);
    expect(quote.body.totalMinor).toBe(3 * 5_000_000 + 1_000_000 + 2_000_000);
    expect(quote.body.available).toBe(true);

    // Two guests race for the same dates: exactly one hold succeeds.
    const [r1, r2] = await Promise.all([
      http.post(`${API}/apartments/reservations`).set('Authorization', `Bearer ${a.token}`).send({ unitId: unit.id, checkIn, checkOut, guests: 2 }),
      http.post(`${API}/apartments/reservations`).set('Authorization', `Bearer ${b.token}`).send({ unitId: unit.id, checkIn, checkOut, guests: 2 }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    const winner = r1.status === 201 ? { res: r1, user: a } : { res: r2, user: b };

    // An overlapping (not identical) stay is also rejected.
    await http.post(`${API}/apartments/reservations`).set('Authorization', `Bearer ${(winner.user === a ? b : a).token}`)
      .send({ unitId: unit.id, checkIn: day(32), checkOut: day(35), guests: 1 }).expect(409);
    // Back-to-back stays are fine (checkout day = next check-in day).
    await http.post(`${API}/apartments/reservations`).set('Authorization', `Bearer ${(winner.user === a ? b : a).token}`)
      .send({ unitId: unit.id, checkIn: checkOut, checkOut: day(35), guests: 1 }).expect(201);

    const auth = { Authorization: `Bearer ${winner.user.token}` };
    const init = await http.post(`${API}/payments/initialize`).set(auth).send({ purpose: 'APARTMENT_RESERVATION', payableId: winner.res.body.id }).expect(201);
    expect(init.body.amountMinor).toBe(quote.body.totalMinor);
    await http.post(`${API}/payments/verify/${init.body.reference}`).set(auth).expect(200);
    const confirmed = await http.get(`${API}/apartments/reservations/${winner.res.body.id}`).set(auth).expect(200);
    expect(confirmed.body.status).toBe('CONFIRMED');

    const cal = await http.get(`${API}/apartments/units/${unit.id}/calendar?from=${day(29)}&to=${day(40)}`).expect(200);
    expect(cal.body.unavailable.length).toBe(2);
  });

  it('under an 8-way race for the same dates, exactly one booking wins and the rest get 409', async () => {
    const unit = await freshUnit();
    const guests = await Promise.all(Array.from({ length: 8 }, () => newCustomer()));
    const body = { unitId: unit.id, checkIn: day(80), checkOut: day(83), guests: 1 };
    const results = await Promise.all(guests.map((g) => http.post(`${API}/apartments/reservations`).set('Authorization', `Bearer ${g.token}`).send(body)));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(7);
    expect(await prisma.reservation.count({ where: { unitId: unit.id, status: 'HOLD' } })).toBe(1);
  });

  it('expired holds free the dates', async () => {
    const unit = await freshUnit();
    const [a, b] = [await newCustomer(), await newCustomer()];
    const body = { unitId: unit.id, checkIn: day(60), checkOut: day(62), guests: 2 };
    const held = await http.post(`${API}/apartments/reservations`).set('Authorization', `Bearer ${a.token}`).send(body).expect(201);
    await prisma.reservation.update({ where: { id: held.body.id }, data: { holdExpiresAt: new Date(Date.now() - 1000) } });
    await http.post(`${API}/apartments/reservations`).set('Authorization', `Bearer ${b.token}`).send(body).expect(201);
    expect((await prisma.reservation.findUnique({ where: { id: held.body.id } })).status).toBe('EXPIRED');
  });
});

describe('Jobs & audit', () => {
  it('protects internal job endpoints with a token', async () => {
    await http.post(`${API}/internal/jobs/expire`).expect(403);
    await http.post(`${API}/internal/jobs/expire`).set('x-job-token', process.env.JOBS_TOKEN!).expect(200);
  });

  it('writes an audit trail visible to administrators', async () => {
    const admin = await adminToken();
    const res = await http.get(`${API}/admin/audit-logs?action=payment.&pageSize=5`).set('Authorization', `Bearer ${admin}`).expect(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    const report = await http.get(`${API}/admin/reports/summary`).set('Authorization', `Bearer ${admin}`).expect(200);
    expect(report.body.grossRevenueMinor).toBeGreaterThan(0);
  });
});
