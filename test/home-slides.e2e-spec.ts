import sharp from 'sharp';
import { API, Harness } from './harness';

/** Home page promos: managed from the dashboard, shown to customers only when they should be. */
const h = new Harness();
let admin: object;
const created: string[] = [];

beforeAll(async () => {
  await h.start();
  admin = (await h.admin()).auth;
});
afterAll(async () => {
  await h.prisma.homeSlide.deleteMany({ where: { id: { in: created } } });
  await h.stop();
});

const make = async (body: object) => {
  const res = await h.http.post(`${API}/admin/home-slides`).set(admin).send(body).expect(201);
  created.push(res.body.id);
  return res.body;
};
const shown = async () => (await h.http.get(`${API}/home-slides`).expect(200)).body as { id: string; product?: { name: string } }[];
const picture = '/media/images/promos/drinks-on-promo.webp';

describe('home page promos', () => {
  it('shows a saved promo to everyone, without signing in', async () => {
    const slide = await make({ kind: 'PICTURE', imageUrl: picture, title: 'Weekend offer', linkTo: '/spa' });
    expect((await shown()).some((s) => s.id === slide.id)).toBe(true);
  });

  it('hides a slide that is switched off, not started or finished', async () => {
    const off = await make({ kind: 'PICTURE', imageUrl: picture, isActive: false });
    const later = await make({ kind: 'PICTURE', imageUrl: picture, startsAt: new Date(Date.now() + 86400000).toISOString() });
    const over = await make({ kind: 'PICTURE', imageUrl: picture, endsAt: new Date(Date.now() - 86400000).toISOString() });
    const ids = (await shown()).map((s) => s.id);
    for (const s of [off, later, over]) expect(ids).not.toContain(s.id);
    await h.http.patch(`${API}/admin/home-slides/${off.id}`).set(admin).send({ isActive: true }).expect(200);
    expect((await shown()).map((s) => s.id)).toContain(off.id);
  });

  it('drops a product slide when the product stops being on sale', async () => {
    const stamp = Date.now();
    const product = await h.prisma.product.create({
      data: {
        division: { connect: { slug: 'water-drinks-wines' } }, name: `Slide ${stamp}`, slug: `slide-${stamp}`, status: 'ACTIVE', verification: 'VERIFIED',
        images: { create: { url: picture } }, variants: { create: { sku: `SLIDE-${stamp}`, name: 'Single', unitPriceMinor: 100000n } },
      },
    });
    const slide = await make({ kind: 'PRODUCT', productId: product.id, tone: 'gold' });
    expect((await shown()).find((s) => s.id === slide.id)?.product?.name).toBe(product.name);
    await h.prisma.product.update({ where: { id: product.id }, data: { status: 'ARCHIVED' } });
    expect((await shown()).map((s) => s.id)).not.toContain(slide.id);
  });

  it('refuses an incomplete slide or an unsafe link', async () => {
    const post = (body: object) => h.http.post(`${API}/admin/home-slides`).set(admin).send(body);
    await post({ kind: 'PICTURE' }).expect(400);
    await post({ kind: 'PRODUCT' }).expect(400);
    await post({ kind: 'PICTURE', imageUrl: picture, linkTo: 'javascript:alert(1)' }).expect(400);
    await post({ kind: 'PICTURE', imageUrl: picture, linkTo: '//evil.example' }).expect(400);
    await post({ kind: 'PICTURE', imageUrl: 'https://evil.example/a.png' }).expect(400);
    await post({ kind: 'PICTURE', imageUrl: picture, startsAt: '2030-01-02', endsAt: '2030-01-01' }).expect(400);
  });

  it('keeps the whole picture when it is uploaded', async () => {
    const file = await sharp({ create: { width: 1000, height: 1000, channels: 3, background: '#208080' } }).png().toBuffer();
    const res = await h.http.post(`${API}/admin/home-slides/upload`).set(admin).attach('file', file, 'flyer.png').expect(201);
    const served = await h.http.get(res.body.url).expect(200);
    const meta = await sharp(served.body).metadata();
    expect([meta.width, meta.height, meta.format]).toEqual([1000, 1000, 'webp']);
  });

  it('saves a new order', async () => {
    const a = await make({ kind: 'PICTURE', imageUrl: picture });
    const b = await make({ kind: 'PICTURE', imageUrl: picture });
    await h.http.put(`${API}/admin/home-slides/order`).set(admin).send({ ids: [b.id, a.id] }).expect(200);
    const rows = await h.prisma.homeSlide.findMany({ where: { id: { in: [a.id, b.id] } } });
    expect(rows.find((r: { id: string }) => r.id === b.id)!.sortOrder).toBeLessThan(rows.find((r: { id: string }) => r.id === a.id)!.sortOrder);
  });

  it('is closed to customers and to managers of one business', async () => {
    await h.http.get(`${API}/admin/home-slides`).expect(401);
    const customer = await h.customer();
    await h.http.get(`${API}/admin/home-slides`).set(customer.auth).expect(403);
    const manager = await h.staff('DEPARTMENT_MANAGER', 'water-drinks-wines');
    await h.http.post(`${API}/admin/home-slides`).set(manager.auth).send({ kind: 'APARTMENTS' }).expect(403);
  });
});
