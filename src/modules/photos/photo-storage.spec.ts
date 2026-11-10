import sharp from 'sharp';
import { PhotoStorageService } from './photo-storage.service';

/** Height of the non-white content in a processed photo. */
async function contentHeight(img: Buffer) {
  const { info } = await sharp(img).trim({ background: '#ffffff', threshold: 12 }).toBuffer({ resolveWithObject: true });
  return info.height;
}
const bottle = (h: number) =>
  sharp({ create: { width: 1200, height: 1200, channels: 3, background: '#ffffff' } })
    .composite([{ input: { create: { width: 200, height: h, channels: 3, background: '#2a6fd6' } }, left: 500, top: 1200 - h - 60 }])
    .png()
    .toBuffer();

describe('product photos', () => {
  const svc = new PhotoStorageService() as unknown as { process: (b: Buffer, p: string) => Promise<{ output: Buffer }> };

  it('keeps the size of a bottle on a prepared white square, so 50cl stays smaller than 75cl', async () => {
    const big = (await svc.process(await bottle(1000), 'product')).output;
    const small = (await svc.process(await bottle(800), 'product')).output;
    expect(await contentHeight(small)).toBeLessThan((await contentHeight(big)) * 0.9);
  });

  it('still centres and fills an ordinary photo with a plain margin', async () => {
    const photo = await sharp({ create: { width: 900, height: 1300, channels: 3, background: '#ffffff' } })
      .composite([{ input: { create: { width: 300, height: 600, channels: 3, background: '#2a6fd6' } }, left: 300, top: 350 }])
      .png()
      .toBuffer();
    const out = (await svc.process(photo, 'product')).output;
    expect((await sharp(out).metadata()).width).toBe(1200);
    expect(await contentHeight(out)).toBeGreaterThan(1000);
  });
});
