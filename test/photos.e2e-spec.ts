import { existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { API, Harness } from './harness';

/** Upload, replace, remove and main photo for everything that shows photos. */
const h = new Harness();
let admin: object;
let product: { id: string; variants: { id: string; sku: string }[] };
let n = 0;

const onDisk = (url: string) => existsSync(join(process.env.PHOTO_STORAGE_DIR as string, url.replace('/media/uploads/', '')));

/** A photo with a colour block on a wide white margin. */
const photo = (width = 1200, height = 900, colour = '#c0392b') =>
  sharp({ create: { width, height, channels: 3, background: '#ffffff' } })
    .composite([{ input: { create: { width: Math.round(width / 3), height: Math.round(height / 3), channels: 3, background: colour } }, gravity: 'center' }])
    .jpeg()
    .toBuffer();

const send = (path: string, file: Buffer, name = 'photo.jpg', fields: Record<string, string> = {}, auth = admin) => {
  let r = h.http.post(`${API}/admin/photos/${path}`).set(auth);
  for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
  return r.attach('file', file, name);
};

async function newProduct(division = 'water-drinks-wines', sizes = 1) {
  const stamp = `${Date.now()}${++n}`;
  const res = await h.http.post(`${API}/admin/catalog/products`).set(admin).send({
    division, name: `Photo Test ${stamp}`, slug: `photo-test-${stamp}`,
    variants: Array.from({ length: sizes }, (_, i) => ({ sku: `PHOTO-${stamp}-X${i}`, name: `Size ${i}`, unitPriceMinor: 100000 })),
  }).expect(201);
  return res.body;
}

beforeAll(async () => {
  await h.start();
  admin = (await h.admin()).auth;
  product = await newProduct();
});
afterAll(() => h.stop());

describe('processing', () => {
  it('turns any product photo into the same white square, and serves it', async () => {
    const res = await send(`product/${product.id}`, await photo(1200, 900)).expect(201);
    expect(res.body.url).toMatch(/^\/media\/uploads\/[0-9a-f-]{36}\.webp$/);
    const served = await h.http.get(res.body.url).expect(200);
    expect(served.headers['content-type']).toBe('image/webp');
    const meta = await sharp(served.body).metadata();
    expect([meta.width, meta.height, meta.format]).toEqual([1000, 1000, 'webp']);
    // The white margin is trimmed, so the product fills the frame.
    const { data, info } = await sharp(served.body).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let first = -1;
    for (let x = 0; x < info.width && first < 0; x++) if (data[(500 * info.width + x) * info.channels + 1] < 150) first = x;
    expect(first).toBeLessThan(120);
  });

  it('strips hidden data such as GPS location', async () => {
    const withExif = await sharp(await photo()).withExif({ IFD0: { Copyright: 'SECRET-MARKER' }, IFD3: { GPSLatitudeRef: 'N' } }).jpeg().toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeTruthy();
    const res = await send(`product/${product.id}`, withExif).expect(201);
    const served = await h.http.get(res.body.url).expect(200);
    expect((await sharp(served.body).metadata()).exif).toBeUndefined();
    expect(served.body.includes('SECRET-MARKER')).toBe(false);
  });

  it('judges a file by its content, not its name', async () => {
    await send(`product/${product.id}`, Buffer.from('<script>alert(1)</script>'), 'evil.jpg').expect(400);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900"><script>alert(1)</script></svg>');
    await send(`product/${product.id}`, svg, 'evil.png').expect(400);
    const gif = await sharp(await photo()).gif().toBuffer();
    await send(`product/${product.id}`, gif, 'moving.jpg').expect(400);
  });

  it('refuses very small photos, and warns about small ones', async () => {
    await send(`product/${product.id}`, await photo(100, 100)).expect(400);
    const res = await send(`product/${product.id}`, await photo(500, 500)).expect(201);
    expect(res.body.warning).toContain('small');
  });

  it('crops places and services to the same landscape frame', async () => {
    const division = await h.prisma.division.findUniqueOrThrow({ where: { slug: 'luxury-apartments' } });
    const property = await h.prisma.property.create({ data: { divisionId: division.id, name: 'Photo Villa', slug: `photo-villa-${Date.now()}`, addressLine: 'Wuye', city: 'Abuja', state: 'FCT', amenities: [], status: 'ACTIVE' } });
    const res = await send(`property/${property.id}`, await photo(800, 1400)).expect(201);
    const meta = await sharp((await h.http.get(res.body.url).expect(200)).body).metadata();
    expect([meta.width, meta.height]).toEqual([1600, 1067]);
  });
});

describe('managing photos', () => {
  it('adds, chooses the main photo, replaces and removes', async () => {
    const p = await newProduct();
    const first = (await send(`product/${p.id}`, await photo()).expect(201)).body;
    const second = (await send(`product/${p.id}`, await photo(1000, 1000, '#2a78d6')).expect(201)).body;

    const list = async () => (await h.http.get(`${API}/admin/photos/product/${p.id}`).set(admin).expect(200)).body.photos;
    expect((await list()).map((x: { id: string }) => x.id)).toEqual([first.id, second.id]);

    await h.http.patch(`${API}/admin/photos/product/${p.id}/${second.id}`).set(admin).send({ main: true }).expect(200);
    expect((await list()).map((x: { id: string }) => x.id)).toEqual([second.id, first.id]);
    const adminList = await h.http.get(`${API}/admin/catalog/products?division=water-drinks-wines&q=${encodeURIComponent(p.name)}&pageSize=100`).set(admin).expect(200);
    const row = adminList.body.data.find((x: { id: string }) => x.id === p.id);
    expect(row.images[0].id).toBe(second.id);

    // Replacing keeps the position and deletes the old file.
    expect(onDisk(second.url)).toBe(true);
    const third = (await send(`product/${p.id}`, await photo(), 'new.jpg', { replaceId: second.id }).expect(201)).body;
    expect((await list()).map((x: { id: string }) => x.id)).toEqual([third.id, first.id]);
    expect(onDisk(second.url)).toBe(false);

    await h.http.delete(`${API}/admin/photos/product/${p.id}/${third.id}`).set(admin).expect(200);
    expect((await list()).map((x: { id: string }) => x.id)).toEqual([first.id]);
    expect(onDisk(third.url)).toBe(false);
  });

  it('never deletes a bundled photo that a record used to point at', async () => {
    const p = await newProduct();
    const bundled = '/media/assets/car-stand-0.jpg';
    const image = await h.http.post(`${API}/admin/catalog/products/${p.id}/images`).set(admin).send({ url: bundled }).expect(201);
    await h.http.delete(`${API}/admin/photos/product/${p.id}/${image.body.id}`).set(admin).expect(200);
    await h.http.get(bundled).expect(200);
  });

  it('links a photo to one size or pack', async () => {
    const p = await newProduct('water-drinks-wines', 2);
    const res = await send(`product/${p.id}`, await photo(), 'pack.jpg', { variantId: p.variants[1].id }).expect(201);
    expect(res.body.variantId).toBe(p.variants[1].id);
    await h.http.patch(`${API}/admin/photos/product/${p.id}/${res.body.id}`).set(admin).send({ variantId: null }).expect(200);
    await send(`product/${p.id}`, await photo(), 'wrong.jpg', { variantId: product.variants[0].id }).expect(400);
  });

  it('gives a spa treatment one photo, and replaces it on a new upload', async () => {
    const division = await h.prisma.division.findUniqueOrThrow({ where: { slug: 'spa-wellness' } });
    const treatment = await h.prisma.spaTreatment.create({ data: { divisionId: division.id, name: 'Photo Facial', slug: `photo-facial-${Date.now()}`, durationMinutes: 30, priceMinor: 100000n, depositMinor: 0n } });
    const one = (await send(`spa/${treatment.id}`, await photo()).expect(201)).body;
    const two = (await send(`spa/${treatment.id}`, await photo()).expect(201)).body;
    const res = await h.http.get(`${API}/admin/photos/spa/${treatment.id}`).set(admin).expect(200);
    expect(res.body.single).toBe(true);
    expect(res.body.photos.map((x: { url: string }) => x.url)).toEqual([two.url]);
    expect(onDisk(one.url)).toBe(false);
    await h.http.delete(`${API}/admin/photos/spa/${treatment.id}/${treatment.id}`).set(admin).expect(200);
    expect((await h.prisma.spaTreatment.findUnique({ where: { id: treatment.id } })).imageUrl).toBeNull();
  });

  it('rejects an unknown kind of record', async () => {
    await h.http.get(`${API}/admin/photos/secret/${product.id}`).set(admin).expect(400);
  });

  it('records who changed a photo', async () => {
    const log = await h.prisma.auditLog.findFirst({ where: { action: { startsWith: 'photo.' }, entityId: product.id } });
    expect(log).toBeTruthy();
  });
});

describe('bulk upload by SKU', () => {
  it('replaces on the exact SKU, and adds on a numbered name', async () => {
    const p = await newProduct();
    await send(`product/${p.id}`, await photo()).expect(201);
    const sku = p.variants[0].sku;
    const replaced = await send('by-sku', await photo(), `${sku}.jpg`).expect(201);
    expect(replaced.body.action).toBe('replaced');
    const added = await send('by-sku', await photo(), `${sku.toLowerCase()}-2.jpg`).expect(201);
    expect(added.body.action).toBe('added');
    const res = await h.http.get(`${API}/admin/photos/product/${p.id}`).set(admin).expect(200);
    expect(res.body.photos.map((x: { url: string }) => x.url)).toEqual([replaced.body.url, added.body.url]);
  });

  it('keeps photos of other sizes when a product has several', async () => {
    const p = await newProduct('water-drinks-wines', 2);
    const small = (await send('by-sku', await photo(), `${p.variants[0].sku}.jpg`).expect(201)).body;
    await send('by-sku', await photo(), `${p.variants[1].sku}.jpg`).expect(201);
    await send('by-sku', await photo(), `${p.variants[1].sku}.jpg`).expect(201);
    const res = await h.http.get(`${API}/admin/photos/product/${p.id}`).set(admin).expect(200);
    expect(res.body.photos).toHaveLength(2);
    expect(res.body.photos[0].url).toBe(small.url);
  });

  it('reports a file name that matches no product, and saves nothing', async () => {
    await send('by-sku', await photo(), 'NOT-A-REAL-SKU.jpg').expect(404);
    await send('by-sku', await photo(), '../../NOT-REAL-EITHER.jpg').expect(404);
    await send('by-sku', await photo(), 'not a sku!.jpg').expect(400);
  });
});

describe('permissions', () => {
  it('keeps a manager to their own division', async () => {
    const manager = await h.staff('DEPARTMENT_MANAGER', 'water-drinks-wines');
    const own = await newProduct();
    const other = await newProduct('retail-general-supplies');
    await send(`product/${own.id}`, await photo(), 'ok.jpg', {}, manager.auth).expect(201);
    await send(`product/${other.id}`, await photo(), 'no.jpg', {}, manager.auth).expect(403);
    await send('by-sku', await photo(), `${other.variants[0].sku}.jpg`, {}, manager.auth).expect(403);
    await h.http.get(`${API}/admin/photos/product/${other.id}`).set(manager.auth).expect(403);
  });

  it('closes photos to customers and to anyone signed out', async () => {
    const customer = await h.customer();
    await send(`product/${product.id}`, await photo(), 'no.jpg', {}, customer.auth).expect(403);
    await h.http.post(`${API}/admin/photos/product/${product.id}`).expect(401);
  });

  it('does not serve private payment proofs through the photo address', async () => {
    await h.http.get('/media/uploads/payment-proofs/anything.png').expect(404);
    await h.http.get('/media/uploads/../payment-proofs/anything.png').expect(404);
  });
});
