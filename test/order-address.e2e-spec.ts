import { API, Harness } from './harness';

/** A wrong delivery address can be fixed before paying, and paying in store is only offered for pickup. */
const h = new Harness();
const WDW = 'water-drinks-wines';
let admin: { auth: object };

const addressIn = async (auth: object, city: string, state: string) =>
  (await h.http.post(`${API}/me/addresses`).set(auth).send({ recipientName: 'Address Tester', phone: '+2348031234567', line1: '2 Test Street', city, state }).expect(201)).body.id as string;

async function order(c: { auth: object }, fulfilmentType: 'DELIVERY' | 'PICKUP', addressId?: string, paymentOption = 'PAYSTACK') {
  const v = await h.prisma.productVariant.findUniqueOrThrow({ where: { sku: 'DEV-WATER-JAR' } });
  await h.http.post(`${API}/carts/items`).set(c.auth).send({ variantId: v.id, quantity: 1 }).expect(201);
  return (await h.http.post(`${API}/orders`).set(c.auth).send({ division: WDW, fulfilmentType, addressId, paymentOption }).expect(201)).body;
}
const options = async (c: { auth: object }, id: string) => (await h.http.get(`${API}/payments/options`).query({ purpose: 'ORDER', payableId: id }).set(c.auth).expect(200)).body;

beforeAll(async () => {
  await h.start();
  await h.markSamplesSellable();
  await h.stock('DEV-WATER-JAR', 1000);
  admin = await h.admin();
  await h.http.put(`${API}/admin/payment-settings/policies/${WDW}/ORDER`).set(admin.auth).send({ allowPaystack: true, allowPayAtLocation: true }).expect(200);
});
afterAll(() => h.stop());

describe('delivery address and pay in store', () => {
  it('offers paying in store for pickup only', async () => {
    const c = await h.customer();
    const delivery = await order(c, 'DELIVERY', await h.address(c.auth));
    const d = await options(c, delivery.id);
    expect(d.methods.payAtLocation.available).toBe(false);
    expect(d.delivery).toMatchObject({ canChangeAddress: true });

    const pickup = await order(c, 'PICKUP');
    const p = await options(c, pickup.id);
    expect(p.delivery).toBeNull();
    expect(p.methods.payAtLocation.available).toBe(p.methods.payAtLocation.locations.length > 0);
  });

  it('moves an unpaid order to another address and works the fee out again', async () => {
    const c = await h.customer();
    const first = await order(c, 'DELIVERY', await h.address(c.auth));
    const outskirts = await addressIn(c.auth, 'Kubwa', 'FCT');
    const moved = await h.http.patch(`${API}/orders/${first.id}/address`).set(c.auth).send({ addressId: outskirts }).expect(200);
    expect(moved.body.deliveryAddress.city).toBe('Kubwa');
    expect(Number(moved.body.totalMinor)).toBe(Number(moved.body.subtotalMinor) + Number(moved.body.deliveryFeeMinor));
    const delivery = await h.prisma.delivery.findUniqueOrThrow({ where: { orderId: first.id } });
    expect(Number(delivery.feeMinor)).toBe(Number(moved.body.deliveryFeeMinor));
    expect((await options(c, first.id)).totalDueMinor).toBe(Number(moved.body.totalMinor));
  });

  it('refuses an address where there is no delivery, and keeps the old one', async () => {
    const c = await h.customer();
    const o = await order(c, 'DELIVERY', await h.address(c.auth));
    const lagos = await addressIn(c.auth, 'Ikeja', 'Lagos');
    await h.http.patch(`${API}/orders/${o.id}/address`).set(c.auth).send({ addressId: lagos }).expect(422);
    expect(((await h.prisma.order.findUniqueOrThrow({ where: { id: o.id } })).deliveryAddress as { city: string }).city).toBe('Wuye');
  });

  it('will not move an order that is paid, someone else’s, or for pickup', async () => {
    const c = await h.customer();
    const o = await order(c, 'DELIVERY', await h.address(c.auth));
    const other = await h.customer();
    const othersAddress = await h.address(other.auth);
    await h.http.patch(`${API}/orders/${o.id}/address`).set(other.auth).send({ addressId: othersAddress }).expect(404);
    const mine = await h.address(c.auth);
    const pickup = await order(c, 'PICKUP');
    await h.http.patch(`${API}/orders/${pickup.id}/address`).set(c.auth).send({ addressId: mine }).expect(400);
    await h.prisma.order.update({ where: { id: o.id }, data: { amountPaidMinor: 100n } });
    await h.http.patch(`${API}/orders/${o.id}/address`).set(c.auth).send({ addressId: mine }).expect(400);
  });
});
