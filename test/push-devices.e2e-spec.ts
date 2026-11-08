import { pushPath } from '../src/modules/notifications/push.service';
import { API, Harness } from './harness';

/** Phones register for notifications; without Firebase configured, notifications still work and nothing is sent. */
const h = new Harness();
beforeAll(() => h.start());
afterAll(() => h.stop());

const token = (n: string) => `test-fcm-token-${n}-${Date.now()}-${'x'.repeat(30)}`;

describe('phone notifications', () => {
  it('registers, moves and removes a phone', async () => {
    const a = await h.customer();
    const b = await h.customer();
    const t = token('a');
    await h.http.post(`${API}/notifications/devices`).set(a.auth).send({ token: t, platform: 'android' }).expect(200);
    await h.http.post(`${API}/notifications/devices`).set(a.auth).send({ token: t, platform: 'android' }).expect(200);
    expect(await h.prisma.pushDevice.count({ where: { token: t } })).toBe(1);
    // The same phone signed in to another account now belongs to that account.
    await h.http.post(`${API}/notifications/devices`).set(b.auth).send({ token: t, platform: 'android' }).expect(200);
    expect((await h.prisma.pushDevice.findUniqueOrThrow({ where: { token: t } })).userId).toBe(b.id);
    // Someone else cannot remove it; its owner can.
    await h.http.post(`${API}/notifications/devices/remove`).set(a.auth).send({ token: t }).expect(200);
    expect(await h.prisma.pushDevice.count({ where: { token: t } })).toBe(1);
    await h.http.post(`${API}/notifications/devices/remove`).set(b.auth).send({ token: t }).expect(200);
    expect(await h.prisma.pushDevice.count({ where: { token: t } })).toBe(0);
  });

  it('refuses bad input and needs a session', async () => {
    const c = await h.customer();
    await h.http.post(`${API}/notifications/devices`).set(c.auth).send({ token: token('c'), platform: 'windows' }).expect(400);
    await h.http.post(`${API}/notifications/devices`).set(c.auth).send({ token: 'short', platform: 'ios' }).expect(400);
    await h.http.post(`${API}/notifications/devices`).send({ token: token('d'), platform: 'ios' }).expect(401);
  });

  it('opens the right tab when a notification is tapped', () => {
    expect(pushPath({ orderId: 'x' })).toBe('/bookings?tab=orders');
    expect(pushPath({ reservationId: 'x' })).toBe('/bookings?tab=stays');
    expect(pushPath({ serviceBookingId: 'x' })).toBe('/bookings?tab=services');
    expect(pushPath({})).toBe('/bookings');
  });
});

describe('photos for the phone apps', () => {
  it('may be shown from another origin (the Android and iPhone apps)', async () => {
    const res = await h.http.get('/media/assets/royalty-spa-clean.webp').expect(200);
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
  });
});
