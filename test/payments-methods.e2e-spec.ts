import { API, Harness } from './harness';

/**
 * Multiple payment methods (one gateway): Paystack, direct bank transfer,
 * pay on delivery, pay at a service location, deposits and part payments,
 * finance verification, separation of duties, disputes, reversals,
 * reconciliation and booking-confirmation policies.
 */
const h = new Harness();
let admin: { id: string; auth: object };
let finance: { id: string; auth: object };
let officer: { id: string; auth: object }; // WDW delivery officer (Department Staff)
let cashier: { id: string; auth: object }; // Spa cashier (Department Staff)
let wdwManager: { id: string; auth: object };
let spaLocationId: string;
const WDW = 'water-drinks-wines';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a9f70000000049454e44ae426082', 'hex');

async function placeOrder(c: { auth: object }, paymentOption: string, sku = 'DEV-WATER-JAR', quantity = 2, fulfilmentType = 'DELIVERY') {
  const v = await h.prisma.productVariant.findUniqueOrThrow({ where: { sku } });
  await h.http.post(`${API}/carts/items`).set(c.auth).send({ variantId: v.id, quantity }).expect(201);
  const addressId = fulfilmentType === 'DELIVERY' ? await h.address(c.auth) : undefined;
  return h.http.post(`${API}/orders`).set(c.auth).send({ division: WDW, fulfilmentType, addressId, paymentOption });
}

beforeAll(async () => {
  await h.start();
  await h.markSamplesSellable();
  await h.stock('DEV-WATER-JAR', 1000);
  admin = await h.admin();
  finance = await h.staff('FINANCE_OFFICER');
  officer = await h.staff('DEPARTMENT_STAFF', WDW);
  cashier = await h.staff('DEPARTMENT_STAFF', 'spa-wellness');
  wdwManager = await h.staff('DEPARTMENT_MANAGER', WDW);

  // Payment configuration (admin, audited)
  const accounts = await h.http.get(`${API}/admin/payment-settings/bank-accounts`).set(admin.auth).expect(200);
  if (!accounts.body.some((a: any) => a.isActive && !a.divisionId)) {
    await h.http.post(`${API}/admin/payment-settings/bank-accounts`).set(admin.auth)
      .send({ label: 'Test collections', bankName: 'Test Bank', accountName: 'Nimpat Test Account', accountNumber: '0123456789' }).expect(201);
  }
  await h.http.put(`${API}/admin/payment-settings/policies/${WDW}/ORDER`).set(admin.auth)
    .send({ allowPaystack: true, allowBankTransfer: true, allowPayOnDelivery: true, payOnDeliveryMaxOrderMinor: 10_000_000, bankTransferWindowHours: 24 }).expect(200);
  const zones = await h.http.get(`${API}/admin/delivery/zones?division=${WDW}`).set(admin.auth).expect(200);
  for (const z of zones.body) await h.http.patch(`${API}/admin/delivery/zones/${z.id}`).set(admin.auth).send({ payOnDeliveryEnabled: true }).expect(200);

  const code = `SPA-T${Date.now().toString(36).toUpperCase()}`;
  const loc = await h.http.post(`${API}/admin/payment-settings/service-locations`).set(admin.auth)
    .send({ division: 'spa-wellness', code, name: 'Test spa front desk', addressLine: 'Test address', city: 'Abuja', state: 'FCT', acceptsCash: true, acceptsBankTransfer: true, acceptsCardTerminal: true }).expect(201);
  spaLocationId = loc.body.id;
  await h.http.put(`${API}/admin/payment-settings/policies/spa-wellness/SPA_APPOINTMENT`).set(admin.auth)
    .send({ allowPaystack: true, allowPayAtLocation: true, confirmationRule: 'DEPOSIT_VERIFIED' }).expect(200);
});

afterAll(() => h.stop());

describe('Payment options for the frontend', () => {
  it('publishes customer-safe payment methods per division and transaction type', async () => {
    const res = await h.http.get(`${API}/payments/methods?division=${WDW}&purpose=ORDER`).expect(200);
    expect(res.body).toMatchObject({ paystack: true, bankTransfer: true, payOnDelivery: true });
    expect(JSON.stringify(res.body)).not.toContain('0123456789'); // no account numbers here
  });

  it('explains which options apply to the current cart', async () => {
    const c = await h.customer();
    const v = await h.prisma.productVariant.findUniqueOrThrow({ where: { sku: 'DEV-WATER-JAR' } });
    await h.http.post(`${API}/carts/items`).set(c.auth).send({ variantId: v.id, quantity: 1 }).expect(201);
    const addressId = await h.address(c.auth);
    const res = await h.http.get(`${API}/orders/checkout-options?division=${WDW}&fulfilmentType=DELIVERY&addressId=${addressId}`).set(c.auth).expect(200);
    const by = Object.fromEntries(res.body.options.map((o: any) => [o.option, o]));
    expect(by.PAYSTACK.available).toBe(true);
    expect(by.PAY_ON_DELIVERY.available).toBe(true);
    expect(by.PAY_AT_LOCATION.available).toBe(false);
    expect(by.PAY_AT_LOCATION.reason).toBeTruthy();
  });

  it('rejects a payment option the policy does not allow', async () => {
    const c = await h.customer();
    const res = await placeOrder(c, 'PAY_AT_LOCATION');
    expect(res.status).toBe(400);
  });
});

describe('Direct bank transfer', () => {
  it('waits for finance verification and never trusts the customer’s claim or upload', async () => {
    const c = await h.customer();
    const order = (await placeOrder(c, 'BANK_TRANSFER')).body;
    expect(order.status).toBe('PENDING');
    expect(order.paymentOption).toBe('BANK_TRANSFER');

    const ins = await h.http.post(`${API}/payments/bank-transfer`).set(c.auth).send({ purpose: 'ORDER', payableId: order.id }).expect(201);
    expect(ins.body.account).toEqual({ bankName: 'Test Bank', accountName: 'Nimpat Test Account', accountNumber: '0123456789' });
    expect(ins.body.amountMinor).toBe(order.totalMinor);
    expect(ins.body.narration).toBe(ins.body.reference);
    // Asking again re-uses the open instruction
    const again = await h.http.post(`${API}/payments/bank-transfer`).set(c.auth).send({ purpose: 'ORDER', payableId: order.id }).expect(201);
    expect(again.body.reference).toBe(ins.body.reference);

    await h.http.post(`${API}/payments/bank-transfer/${ins.body.reference}/notify`).set(c.auth)
      .send({ payerName: 'Pay Tester', amountMinor: order.totalMinor, customerReference: 'SESSION-123' }).expect(200);
    // Proof upload: real PNG accepted, fake content rejected
    await h.http.post(`${API}/payments/bank-transfer/${ins.body.reference}/proofs`).set(c.auth).attach('file', PNG, 'receipt.png').expect(201);
    await h.http.post(`${API}/payments/bank-transfer/${ins.body.reference}/proofs`).set(c.auth).attach('file', Buffer.from('<script>alert(1)</script>'), 'receipt.png').expect(400);

    const pending = await h.http.get(`${API}/orders/${order.id}`).set(c.auth).expect(200);
    expect(pending.body.status).toBe('PENDING');
    expect(pending.body.paymentStatus).toBe('AWAITING_VERIFICATION');
    expect(pending.body.amountPaidMinor).toBe(0);

    // Customers cannot approve their own payment
    await h.http.post(`${API}/admin/payments/${ins.body.paymentId}/confirm-funds`).set(c.auth).send({ receivedAmountMinor: order.totalMinor, verificationReference: 'X' }).expect(403);

    await h.http.post(`${API}/admin/payments/${ins.body.paymentId}/confirm-funds`).set(finance.auth)
      .send({ receivedAmountMinor: order.totalMinor, verificationReference: `STMT-${order.orderNumber}` }).expect(200);
    const paid = await h.http.get(`${API}/orders/${order.id}`).set(c.auth).expect(200);
    expect(paid.body.status).toBe('ACCEPTED');
    expect(paid.body.paymentStatus).toBe('PAID');

    // Second confirmation is rejected (no double counting)
    await h.http.post(`${API}/admin/payments/${ins.body.paymentId}/confirm-funds`).set(finance.auth)
      .send({ receivedAmountMinor: order.totalMinor, verificationReference: `STMT-${order.orderNumber}-2` }).expect(409);
    const events = await h.prisma.paymentEvent.findMany({ where: { paymentId: ins.body.paymentId }, orderBy: { createdAt: 'asc' } });
    expect(events.map((e: any) => e.eventType)).toEqual(
      expect.arrayContaining(['bank_transfer.instructions_issued', 'bank_transfer.customer_reported', 'bank_transfer.proof_uploaded', 'finance.funds_confirmed']),
    );
  });

  it('a bank statement line can confirm only one transfer', async () => {
    const [a, b] = [await h.customer(), await h.customer()];
    const ref = `STMT-DUP-${Date.now()}`;
    for (const [i, c] of [a, b].entries()) {
      const order = (await placeOrder(c, 'BANK_TRANSFER')).body;
      const ins = await h.http.post(`${API}/payments/bank-transfer`).set(c.auth).send({ purpose: 'ORDER', payableId: order.id }).expect(201);
      await h.http.post(`${API}/payments/bank-transfer/${ins.body.reference}/notify`).set(c.auth).send({ payerName: 'X Y' }).expect(200);
      await h.http.post(`${API}/admin/payments/${ins.body.paymentId}/confirm-funds`).set(finance.auth)
        .send({ receivedAmountMinor: order.totalMinor, verificationReference: ref }).expect(i === 0 ? 200 : 409);
    }
  });

  it('finance can reject a transfer that never arrived', async () => {
    const c = await h.customer();
    const order = (await placeOrder(c, 'BANK_TRANSFER')).body;
    const ins = await h.http.post(`${API}/payments/bank-transfer`).set(c.auth).send({ purpose: 'ORDER', payableId: order.id }).expect(201);
    await h.http.post(`${API}/payments/bank-transfer/${ins.body.reference}/notify`).set(c.auth).send({ payerName: 'X Y' }).expect(200);
    await h.http.post(`${API}/admin/payments/${ins.body.paymentId}/reject`).set(finance.auth).send({ reason: 'No matching credit on statement' }).expect(200);
    const o = await h.http.get(`${API}/orders/${order.id}`).set(c.auth).expect(200);
    expect(o.body.paymentStatus).toBe('FAILED');
    expect(o.body.status).toBe('PENDING');
  });

  it('refuses to confirm more than is owed (incorrect amount)', async () => {
    const c = await h.customer();
    const order = (await placeOrder(c, 'BANK_TRANSFER')).body;
    const ins = await h.http.post(`${API}/payments/bank-transfer`).set(c.auth).send({ purpose: 'ORDER', payableId: order.id }).expect(201);
    await h.http.post(`${API}/payments/bank-transfer/${ins.body.reference}/notify`).set(c.auth).send({ payerName: 'X Y' }).expect(200);
    await h.http.post(`${API}/admin/payments/${ins.body.paymentId}/confirm-funds`).set(finance.auth)
      .send({ receivedAmountMinor: order.totalMinor + 1, verificationReference: `STMT-OVER-${Date.now()}` }).expect(409);
  });
});

describe('Pay on delivery', () => {
  it('accepts the order without payment; delivery does not mark it paid; finance does', async () => {
    const c = await h.customer();
    const before = await h.prisma.stockLevel.findFirst({ where: { variant: { sku: 'DEV-WATER-JAR' }, location: { isDefault: true } } });
    const order = (await placeOrder(c, 'PAY_ON_DELIVERY')).body;
    expect(order.status).toBe('ACCEPTED');
    expect(order.paymentStatus).toBe('UNPAID');
    const after = await h.prisma.stockLevel.findFirst({ where: { variant: { sku: 'DEV-WATER-JAR' }, location: { isDefault: true } } });
    expect(after.quantityOnHand).toBe(before.quantityOnHand - 2); // goods allocated

    // Dispatch & deliver — still unpaid
    const delivery = await h.prisma.delivery.findUniqueOrThrow({ where: { orderId: order.id } });
    await h.http.patch(`${API}/admin/delivery/deliveries/${delivery.id}`).set(officer.auth).send({ status: 'DISPATCHED' }).expect(200);
    await h.http.patch(`${API}/admin/delivery/deliveries/${delivery.id}`).set(officer.auth).send({ status: 'DELIVERED' }).expect(200);
    let o = await h.http.get(`${API}/orders/${order.id}`).set(c.auth).expect(200);
    expect(o.body.status).toBe('DELIVERED');
    expect(o.body.paymentStatus).toBe('UNPAID');
    // Cannot complete an unpaid order
    await h.http.patch(`${API}/admin/orders/${order.id}/status`).set(wdwManager.auth).send({ status: 'COMPLETED' }).expect(400);

    // Officer records the cash (idempotent), cannot verify it
    const key = `col-${order.id}`;
    const col = await h.http.post(`${API}/admin/collections`).set(officer.auth).set('Idempotency-Key', key)
      .send({ purpose: 'ORDER', payableId: order.id, method: 'CASH', point: 'DELIVERY', amountMinor: order.totalMinor }).expect(201);
    expect(col.body.status).toBe('AWAITING_VERIFICATION');
    expect(col.body.receiptNumber).toMatch(/^RCT-/);
    const replay = await h.http.post(`${API}/admin/collections`).set(officer.auth).set('Idempotency-Key', key)
      .send({ purpose: 'ORDER', payableId: order.id, method: 'CASH', point: 'DELIVERY', amountMinor: order.totalMinor }).expect(201);
    expect(replay.body.id).toBe(col.body.id);
    // A second, different report of the same money is blocked (duplicate collection)
    await h.http.post(`${API}/admin/collections`).set(officer.auth)
      .send({ purpose: 'ORDER', payableId: order.id, method: 'CASH', point: 'DELIVERY', amountMinor: 100 }).expect(409);
    await h.http.post(`${API}/admin/payments/${col.body.id}/confirm-funds`).set(officer.auth).send({ receivedAmountMinor: order.totalMinor, verificationReference: 'CASHBOOK-1' }).expect(403);
    await h.http.post(`${API}/admin/payments/${col.body.id}/reconcile`).set(officer.auth).send({ settlementReference: 'X-1' }).expect(403);

    o = await h.http.get(`${API}/orders/${order.id}`).set(c.auth).expect(200);
    expect(o.body.paymentStatus).toBe('AWAITING_VERIFICATION');
    // Reported cash earns no loyalty points
    expect((await h.http.get(`${API}/loyalty/me`).set(c.auth)).body.account.pointsBalance).toBe(0);

    // Finance verifies, then reconciles (cash reconciliation)
    await h.http.post(`${API}/admin/payments/${col.body.id}/confirm-funds`).set(finance.auth).send({ receivedAmountMinor: order.totalMinor, verificationReference: `CASHBOOK-${order.orderNumber}` }).expect(200);
    o = await h.http.get(`${API}/orders/${order.id}`).set(c.auth).expect(200);
    expect(o.body.paymentStatus).toBe('PAID');
    expect((await h.http.get(`${API}/loyalty/me`).set(c.auth)).body.account.pointsBalance).toBeGreaterThan(0);
    const rec = await h.http.post(`${API}/admin/payments/${col.body.id}/reconcile`).set(finance.auth).send({ settlementReference: `BANKING-${order.orderNumber}` }).expect(200);
    expect(rec.body.reconciliationStatus).toBe('RECONCILED');
    await h.http.post(`${API}/admin/payments/${col.body.id}/reconcile`).set(finance.auth).send({ settlementReference: 'AGAIN' }).expect(409);
    await h.http.patch(`${API}/admin/orders/${order.id}/status`).set(wdwManager.auth).send({ status: 'COMPLETED' }).expect(200);

    const receipt = await h.http.get(`${API}/payments/receipts/${col.body.reference}`).set(c.auth).expect(200);
    expect(receipt.body.verified).toBe(true);
  });

  it('tracks partial collections and outstanding balances', async () => {
    const c = await h.customer();
    const order = (await placeOrder(c, 'PAY_ON_DELIVERY')).body;
    const half = Math.floor(order.totalMinor / 2);
    const col = await h.http.post(`${API}/admin/collections`).set(officer.auth)
      .send({ purpose: 'ORDER', payableId: order.id, method: 'BANK_TRANSFER', point: 'DELIVERY', amountMinor: half, collectionReference: 'TRF-1' }).expect(201);
    await h.http.post(`${API}/admin/payments/${col.body.id}/confirm-funds`).set(finance.auth).send({ receivedAmountMinor: half, verificationReference: `STMT-HALF-${order.orderNumber}` }).expect(200);
    const o = await h.http.get(`${API}/orders/${order.id}`).set(c.auth).expect(200);
    expect(o.body.paymentStatus).toBe('PARTIALLY_PAID');
    expect(o.body.outstandingMinor).toBe(order.totalMinor - half);
    const out = await h.http.get(`${API}/admin/finance/outstanding?division=${WDW}&purpose=ORDER`).set(finance.auth).expect(200);
    expect(out.body.find((r: any) => r.id === order.id).outstandingMinor).toBe(order.totalMinor - half);
    const summary = await h.http.get(`${API}/payments/summary?purpose=ORDER&payableId=${order.id}`).set(c.auth).expect(200);
    expect(summary.body.paidMinor).toBe(half);
  });

  it('enforces separation of duties even for a super administrator', async () => {
    const c = await h.customer();
    const order = (await placeOrder(c, 'PAY_ON_DELIVERY')).body;
    const col = await h.http.post(`${API}/admin/collections`).set(admin.auth)
      .send({ purpose: 'ORDER', payableId: order.id, method: 'CASH', point: 'DELIVERY', amountMinor: order.totalMinor }).expect(201);
    const res = await h.http.post(`${API}/admin/payments/${col.body.id}/confirm-funds`).set(admin.auth).send({ receivedAmountMinor: order.totalMinor, verificationReference: 'SELF' }).expect(403);
    expect(res.body.message).toMatch(/Separation of duties/);
  });

  it('disputes block reconciliation; reversals reduce the verified balance', async () => {
    const c = await h.customer();
    const order = (await placeOrder(c, 'PAY_ON_DELIVERY')).body;
    const col = await h.http.post(`${API}/admin/collections`).set(officer.auth)
      .send({ purpose: 'ORDER', payableId: order.id, method: 'CASH', point: 'DELIVERY', amountMinor: order.totalMinor }).expect(201);
    await h.http.post(`${API}/admin/payments/${col.body.id}/confirm-funds`).set(finance.auth).send({ receivedAmountMinor: order.totalMinor, verificationReference: `CB-${order.orderNumber}` }).expect(200);

    await h.http.post(`${API}/admin/payments/${col.body.id}/dispute`).set(finance.auth).send({ reason: 'Cash count short at banking' }).expect(200);
    await h.http.post(`${API}/admin/payments/${col.body.id}/reconcile`).set(finance.auth).send({ settlementReference: 'B-1' }).expect(409);
    const staffReport = await h.http.get(`${API}/admin/finance/collections-by-staff?division=${WDW}`).set(finance.auth).expect(200);
    expect(staffReport.body.find((r: any) => r.staff.id === officer.id).collections).toBeGreaterThan(0);

    // Investigation finds counterfeit notes → reverse
    await h.http.post(`${API}/admin/payments/${col.body.id}/reverse`).set(finance.auth).send({ reason: 'Counterfeit notes' }).expect(200);
    const o = await h.http.get(`${API}/orders/${order.id}`).set(c.auth).expect(200);
    expect(o.body.paymentStatus).toBe('UNPAID');
    expect(o.body.amountPaidMinor).toBe(0);
    expect((await h.prisma.payment.findUnique({ where: { id: col.body.id } })).status).toBe('REVERSED');
    // A reversed payment cannot be confirmed again
    await h.http.post(`${API}/admin/payments/${col.body.id}/confirm-funds`).set(finance.auth).send({ receivedAmountMinor: order.totalMinor, verificationReference: 'AGAIN-1' }).expect(409);
  });
});

describe('Pay at service location & deposits', () => {
  let therapistId: string;
  beforeAll(async () => {
    const t = await h.prisma.spaTreatment.findFirstOrThrow({ where: { slug: 'dev-sample-massage' } });
    const p = await h.http.post(`${API}/admin/spa/practitioners`).set(admin.auth).send({ displayName: `Test therapist ${Date.now()}`, treatmentIds: [t.id] }).expect(201);
    therapistId = p.body.id;
  });

  const slot = (dayOffset: number, hourLagos: number) => {
    const d = new Date(Date.now() + dayOffset * 86_400_000);
    const ymd = d.toISOString().slice(0, 10);
    return new Date(`${ymd}T${String(hourLagos).padStart(2, '0')}:00:00+01:00`).toISOString();
  };

  it('spa deposit collected at the front desk confirms the appointment only after verification', async () => {
    const c = await h.customer();
    const t = await h.prisma.spaTreatment.findFirstOrThrow({ where: { slug: 'dev-sample-massage' } });
    const appt = await h.http.post(`${API}/spa/appointments`).set(c.auth)
      .send({ treatmentId: t.id, practitionerId: therapistId, startsAt: slot(10 + Math.floor(Math.random() * 200), 10) }).expect(201);
    expect(appt.body.status).toBe('PENDING');
    expect(appt.body.depositRequiredMinor).toBe(Number(t.depositMinor));

    const col = await h.http.post(`${API}/admin/collections`).set(cashier.auth)
      .send({ purpose: 'SPA_APPOINTMENT', payableId: appt.body.id, method: 'CARD_TERMINAL', point: 'SERVICE_LOCATION', serviceLocationId: spaLocationId, amountMinor: Number(t.depositMinor), collectionReference: 'SLIP-77' }).expect(201);
    expect(col.body.note).toMatch(/no terminal integration/);
    expect((await h.prisma.spaAppointment.findUnique({ where: { id: appt.body.id } })).status).toBe('PENDING');

    await h.http.post(`${API}/admin/payments/${col.body.id}/confirm-funds`).set(finance.auth).send({ receivedAmountMinor: Number(t.depositMinor), verificationReference: `POS-SETTLE-${appt.body.id}` }).expect(200);
    const after = await h.prisma.spaAppointment.findUnique({ where: { id: appt.body.id } });
    expect(after.status).toBe('CONFIRMED');
    expect(after.paymentStatus).toBe('PARTIALLY_PAID');
    expect(Number(after.priceMinor) - Number(after.amountPaidMinor)).toBe(Number(t.priceMinor) - Number(t.depositMinor));
  });

  it('a location must belong to the division and accept the method', async () => {
    const c = await h.customer();
    const order = (await placeOrder(c, 'PAY_ON_DELIVERY')).body;
    await h.http.post(`${API}/admin/collections`).set(officer.auth)
      .send({ purpose: 'ORDER', payableId: order.id, method: 'CASH', point: 'SERVICE_LOCATION', serviceLocationId: spaLocationId, amountMinor: 100 }).expect(400);
  });

  it('spa appointment conflicts: one therapist cannot be double-booked', async () => {
    const t = await h.prisma.spaTreatment.findFirstOrThrow({ where: { slug: 'dev-sample-massage' } });
    const startsAt = slot(250 + Math.floor(Math.random() * 100), 14);
    const [a, b] = [await h.customer(), await h.customer()];
    const res = await Promise.all([a, b].map((c) => h.http.post(`${API}/spa/appointments`).set(c.auth).send({ treatmentId: t.id, practitionerId: therapistId, startsAt })));
    expect(res.map((r) => r.status).sort()).toEqual([201, 409]);
  });
});

describe('Booking confirmation policies (apartments)', () => {
  const base = 30 + Math.floor(Math.random() * 380);
  const day = (o: number) => new Date(Date.now() + (base + o) * 86_400_000).toISOString().slice(0, 10);
  const unit = async () => {
    const tpl = await h.prisma.apartmentUnit.findFirstOrThrow({ where: { code: 'DEV-1' } });
    const { id, createdAt, updatedAt, code, ...rest } = tpl;
    return h.prisma.apartmentUnit.create({ data: { ...rest, code: `PM-${Date.now()}-${Math.floor(Math.random() * 1e6)}` } });
  };
  const policy = (body: object) => h.http.put(`${API}/admin/payment-settings/policies/luxury-apartments/APARTMENT_RESERVATION`).set(admin.auth).send(body).expect(200);
  afterAll(() => policy({ depositType: 'NONE', confirmationRule: 'FULL_PAYMENT', allowBankTransfer: false }));

  it('DEPOSIT_VERIFIED: a verified 30% Paystack deposit confirms; balance stays outstanding', async () => {
    await policy({ depositType: 'PERCENT', depositPercentBps: 3000, confirmationRule: 'DEPOSIT_VERIFIED' });
    const u = await unit();
    const c = await h.customer();
    const r = await h.http.post(`${API}/apartments/reservations`).set(c.auth).send({ unitId: u.id, checkIn: day(1), checkOut: day(3), guests: 2 }).expect(201);
    const total = r.body.totalMinor;
    const deposit = Math.ceil((total * 3000) / 10000);
    expect(r.body.depositRequiredMinor).toBe(deposit);

    const init = await h.http.post(`${API}/payments/initialize`).set(c.auth).send({ purpose: 'APARTMENT_RESERVATION', payableId: r.body.id, amountOption: 'DEPOSIT' }).expect(201);
    expect(init.body.amountMinor).toBe(deposit);
    // Initiating a deposit does not confirm anything
    expect((await h.prisma.reservation.findUnique({ where: { id: r.body.id } })).status).toBe('HOLD');
    await h.http.post(`${API}/payments/verify/${init.body.reference}`).set(c.auth).expect(200);
    const after = await h.http.get(`${API}/apartments/reservations/${r.body.id}`).set(c.auth).expect(200);
    expect(after.body.status).toBe('CONFIRMED');
    expect(after.body.paymentStatus).toBe('PARTIALLY_PAID');

    const bal = await h.http.post(`${API}/payments/initialize`).set(c.auth).send({ purpose: 'APARTMENT_RESERVATION', payableId: r.body.id }).expect(201);
    expect(bal.body.amountMinor).toBe(total - deposit);
    await h.http.post(`${API}/payments/verify/${bal.body.reference}`).set(c.auth).expect(200);
    expect((await h.prisma.reservation.findUnique({ where: { id: r.body.id } })).paymentStatus).toBe('PAID');
  });

  it('FULL_PAYMENT: a deposit alone does not confirm, but keeps the hold from expiring', async () => {
    await policy({ depositType: 'PERCENT', depositPercentBps: 2000, confirmationRule: 'FULL_PAYMENT' });
    const u = await unit();
    const c = await h.customer();
    const r = await h.http.post(`${API}/apartments/reservations`).set(c.auth).send({ unitId: u.id, checkIn: day(10), checkOut: day(12), guests: 1 }).expect(201);
    const init = await h.http.post(`${API}/payments/initialize`).set(c.auth).send({ purpose: 'APARTMENT_RESERVATION', payableId: r.body.id, amountOption: 'DEPOSIT' }).expect(201);
    await h.http.post(`${API}/payments/verify/${init.body.reference}`).set(c.auth).expect(200);
    const after = await h.prisma.reservation.findUnique({ where: { id: r.body.id } });
    expect(after.status).toBe('HOLD');
    expect(after.paymentStatus).toBe('PARTIALLY_PAID');
    expect(after.holdExpiresAt).toBeNull();
  });

  it('STAFF_APPROVAL: even full payment waits for staff, who confirm in the dashboard', async () => {
    await policy({ depositType: 'NONE', confirmationRule: 'STAFF_APPROVAL' });
    const u = await unit();
    const c = await h.customer();
    const r = await h.http.post(`${API}/apartments/reservations`).set(c.auth).send({ unitId: u.id, checkIn: day(20), checkOut: day(21), guests: 1 }).expect(201);
    const init = await h.http.post(`${API}/payments/initialize`).set(c.auth).send({ purpose: 'APARTMENT_RESERVATION', payableId: r.body.id }).expect(201);
    await h.http.post(`${API}/payments/verify/${init.body.reference}`).set(c.auth).expect(200);
    expect((await h.prisma.reservation.findUnique({ where: { id: r.body.id } })).status).toBe('HOLD');
    await h.http.patch(`${API}/admin/apartments/reservations/${r.body.id}/status`).set(admin.auth).send({ status: 'CONFIRMED' }).expect(200);
    expect((await h.prisma.reservation.findUnique({ where: { id: r.body.id } })).status).toBe('CONFIRMED');
  });

  it('bank transfer extends the hold while finance verifies', async () => {
    await policy({ depositType: 'NONE', confirmationRule: 'FULL_PAYMENT', allowBankTransfer: true, bankTransferWindowHours: 12 });
    const u = await unit();
    const c = await h.customer();
    const r = await h.http.post(`${API}/apartments/reservations`).set(c.auth).send({ unitId: u.id, checkIn: day(30), checkOut: day(31), guests: 1 }).expect(201);
    await h.http.post(`${API}/payments/bank-transfer`).set(c.auth).send({ purpose: 'APARTMENT_RESERVATION', payableId: r.body.id }).expect(201);
    const held = await h.prisma.reservation.findUnique({ where: { id: r.body.id } });
    expect(held.holdExpiresAt.getTime()).toBeGreaterThan(Date.now() + 11 * 3600_000);
  });
});

describe('Paystack edge cases', () => {
  it('failed and interrupted (abandoned) payments never mark the order paid', async () => {
    const c = await h.customer();
    const order = (await placeOrder(c, 'PAYSTACK')).body;
    const init = await h.http.post(`${API}/payments/initialize`).set(c.auth).send({ purpose: 'ORDER', payableId: order.id }).expect(201);
    h.paystack.outcome.set(init.body.reference, { status: 'abandoned' });
    let v = await h.http.post(`${API}/payments/verify/${init.body.reference}`).set(c.auth).expect(200);
    expect(v.body.status).toBe('PENDING'); // customer may still complete checkout
    h.paystack.outcome.set(init.body.reference, { status: 'failed' });
    v = await h.http.post(`${API}/payments/verify/${init.body.reference}`).set(c.auth).expect(200);
    expect(v.body.status).toBe('FAILED');
    const o = await h.http.get(`${API}/orders/${order.id}`).set(c.auth).expect(200);
    expect(o.body.status).toBe('PENDING');
    expect(o.body.paymentStatus).toBe('FAILED');
  });

  it('a currency mismatch is rejected', async () => {
    const c = await h.customer();
    const order = (await placeOrder(c, 'PAYSTACK')).body;
    const init = await h.http.post(`${API}/payments/initialize`).set(c.auth).send({ purpose: 'ORDER', payableId: order.id }).expect(201);
    h.paystack.outcome.set(init.body.reference, { status: 'success', currency: 'USD' });
    const v = await h.http.post(`${API}/payments/verify/${init.body.reference}`).set(c.auth).expect(200);
    expect(v.body.status).toBe('FAILED');
    expect((await h.prisma.order.findUnique({ where: { id: order.id } })).paymentStatus).not.toBe('PAID');
  });

  it('replaying verify and the webhook never double-counts', async () => {
    const c = await h.customer();
    const order = (await placeOrder(c, 'PAYSTACK')).body;
    const init = await h.http.post(`${API}/payments/initialize`).set(c.auth).send({ purpose: 'ORDER', payableId: order.id }).expect(201);
    await Promise.all([
      h.http.post(`${API}/payments/verify/${init.body.reference}`).set(c.auth),
      h.http.post(`${API}/payments/verify/${init.body.reference}`).set(c.auth),
      h.webhook({ event: 'charge.success', data: { id: 9, reference: init.body.reference, status: 'success' } }),
    ]);
    const o = await h.prisma.order.findUnique({ where: { id: order.id } });
    expect(Number(o.amountPaidMinor)).toBe(order.totalMinor);
    const movements = await h.prisma.stockMovement.count({ where: { orderId: order.id, type: 'SALE' } });
    expect(movements).toBe(1);
  });
});

describe('Catalogue verification gate', () => {
  it('unconfirmed products cannot be sold until verified; samples can never be verified', async () => {
    const admin2 = await h.admin();
    const created = await h.http.post(`${API}/admin/catalog/products`).set(admin2.auth).send({
      division: WDW, name: `Unverified water ${Date.now()}`, slug: `unverified-${Date.now()}`, status: 'ACTIVE',
      variants: [{ sku: `UNV-${Date.now().toString(36).toUpperCase()}`, name: 'Single', unitPriceMinor: 10000 }],
    }).expect(201);
    expect(created.body.verification).toBe('AWAITING_CONFIRMATION');
    const sku = created.body.variants[0].sku;
    await h.stock(sku, 10);
    const c = await h.customer();
    await h.http.post(`${API}/carts/items`).set(c.auth).send({ variantId: created.body.variants[0].id, quantity: 1 }).expect(409);
    const list = await h.http.get(`${API}/catalog/products?division=${WDW}&q=${encodeURIComponent(created.body.name)}`).expect(200);
    expect(list.body.data.map((p: any) => p.id)).not.toContain(created.body.id);

    // Department staff cannot verify; a manager can
    await h.http.post(`${API}/admin/records/verification`).set(officer.auth).send({ type: 'PRODUCT', ids: [created.body.id], verification: 'VERIFIED' }).expect(403);
    await h.http.post(`${API}/admin/records/verification`).set(wdwManager.auth).send({ type: 'PRODUCT', ids: [created.body.id], verification: 'VERIFIED' }).expect(200);
    await h.http.post(`${API}/carts/items`).set(c.auth).send({ variantId: created.body.variants[0].id, quantity: 1 }).expect(201);

    const sample = await h.prisma.product.create({ data: { divisionId: created.body.divisionId, name: '[DEV SAMPLE] gate test', slug: `dev-gate-${Date.now()}`, verification: 'DEV_SAMPLE' } });
    await h.http.post(`${API}/admin/records/verification`).set(admin2.auth).send({ type: 'PRODUCT', ids: [sample.id], verification: 'VERIFIED' }).expect(400);

    const audit = await h.http.get(`${API}/admin/records/audit`).set(admin2.auth).expect(200);
    expect(audit.body.verificationCounts.products).toHaveProperty('VERIFIED');
  });
});

describe('Security & validation', () => {
  it('customers cannot reach finance or settings endpoints, and cannot manipulate loyalty points', async () => {
    const c = await h.customer();
    for (const [m, p] of [
      ['get', '/admin/finance/outstanding'],
      ['get', '/admin/payment-settings/bank-accounts'],
      ['post', '/admin/collections'],
      ['post', `/loyalty/admin/users/${c.id}/adjustments`],
    ] as const) {
      await h.http[m](`${API}${p}`).set(c.auth).send({}).expect(403);
    }
    await h.http.post(`${API}/loyalty/admin/users/${c.id}/adjustments`).set(admin.auth).send({ points: -1000000, reason: 'Abuse test' }).expect(400);
  });

  it('department staff of one division cannot record collections for another', async () => {
    const c = await h.customer();
    const order = (await placeOrder(c, 'PAY_ON_DELIVERY')).body;
    await h.http.post(`${API}/admin/collections`).set(cashier.auth)
      .send({ purpose: 'ORDER', payableId: order.id, method: 'CASH', point: 'DELIVERY', amountMinor: 100 }).expect(403);
  });

  it('bank account numbers are masked for people who cannot configure them', async () => {
    const res = await h.http.get(`${API}/admin/payment-settings/bank-accounts`).set(finance.auth).expect(200);
    for (const a of res.body) expect(a.accountNumber).toMatch(/^\*{6}\d{4}$/);
  });

  it('rejects malformed payment input', async () => {
    const c = await h.customer();
    await h.http.post(`${API}/payments/initialize`).set(c.auth).send({ purpose: 'ORDER', payableId: 'not-a-uuid' }).expect(400);
    await h.http.post(`${API}/payments/initialize`).set(c.auth).send({ purpose: 'TIPS', payableId: '00000000-0000-0000-0000-000000000000' }).expect(400);
    await h.http.post(`${API}/admin/collections`).set(officer.auth).send({ purpose: 'ORDER', payableId: '00000000-0000-0000-0000-000000000000', method: 'CASH', point: 'DELIVERY', amountMinor: -5 }).expect(400);
    await h.http.post(`${API}/admin/payments/00000000-0000-0000-0000-000000000000/confirm-funds`).set(finance.auth).send({ receivedAmountMinor: 1.5, verificationReference: 'X' }).expect(400);
    await h.http.post(`${API}/admin/payment-settings/bank-accounts`).set(admin.auth).send({ label: 'x', bankName: 'Bank', accountName: 'Name', accountNumber: '12AB' }).expect(400);
  });

  it('payment history is append-only at the database level', async () => {
    const p = await h.prisma.payment.findFirst();
    await expect(h.prisma.payment.delete({ where: { id: p.id } })).rejects.toThrow(/append-only/);
    const e = await h.prisma.paymentEvent.findFirst();
    await expect(h.prisma.paymentEvent.update({ where: { id: e.id }, data: { eventType: 'tampered' } })).rejects.toThrow(/immutable/);
    const a = await h.prisma.auditLog.findFirst();
    await expect(h.prisma.auditLog.delete({ where: { id: a.id } })).rejects.toThrow(/append-only/);
  });
});
