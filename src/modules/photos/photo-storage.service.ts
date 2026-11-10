import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import sharp from 'sharp';

export const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
export const PHOTO_URL_PREFIX = '/media/uploads/';
const MAX_INPUT_PIXELS = 60_000_000;
const MIN_LONG_SIDE = 200;
const SMALL_LONG_SIDE = 800;

/** Square on white for products; a 3:2 frame for places, vehicles and services. */
export type PhotoPreset = 'product' | 'scene' | 'banner';

export const photoRoot = () => resolve(process.env.PHOTO_STORAGE_DIR ?? join(process.cwd(), 'uploads', 'public-photos'));

/**
 * Turns any accepted upload into one standard file: checked by content rather
 * than file name, turned the right way up, stripped of hidden data such as GPS
 * location, and resized to a fixed frame.
 *
 * Files go to local disk. PHOTO_STORAGE_DIR can point at a mounted bucket;
 * Cloud Run's own disk is wiped on restart, so production must set it.
 */
@Injectable()
export class PhotoStorageService {
  private async process(input: Buffer, preset: PhotoPreset): Promise<{ output: Buffer; warning?: string }> {
    if (!input.length) throw new BadRequestException('The file is empty');
    if (input.length > MAX_PHOTO_BYTES) throw new BadRequestException('Photos must be 15 MB or smaller');
    const options = { limitInputPixels: MAX_INPUT_PIXELS };
    const meta = await sharp(input, options).metadata().catch(() => {
      throw new BadRequestException('This file is not a readable image. Please use JPG, PNG or WebP.');
    });
    if (!meta.format || !['jpeg', 'png', 'webp'].includes(meta.format)) {
      throw new BadRequestException('Please use a JPG, PNG or WebP photo. iPhone HEIC photos need saving as JPG first.');
    }
    const longSide = Math.max(meta.width ?? 0, meta.height ?? 0);
    if (longSide < MIN_LONG_SIDE) throw new BadRequestException(`This photo is too small (${longSide} pixels). Please use one at least ${SMALL_LONG_SIDE} pixels wide.`);
    const warning = longSide < SMALL_LONG_SIDE ? `This photo is small (${longSide} pixels), so it may look soft on large screens.` : undefined;

    try {
      const output = preset === 'product' ? await this.productFrame(input, options) : preset === 'banner' ? await this.bannerFrame(input, options) : await this.sceneFrame(input, options);
      return { output, warning };
    } catch {
      throw new BadRequestException('This image could not be processed. It may be damaged, or too large in pixels.');
    }
  }

  private async productFrame(input: Buffer, options: { limitInputPixels: number }): Promise<Buffer> {
    const SIZE = 1200;
    const INNER = 1032;
    const upright = await sharp(input, options).rotate().flatten({ background: '#ffffff' }).png().toBuffer();
    const { width = 0, height = 0 } = await sharp(upright).metadata();
    // A photo that already comes as a white square keeps its framing, so a 50cl bottle can stay
    // smaller than its 75cl sister. Other photos lose their plain margins and are centred.
    const framed = width === height && (await this.whiteBorder(upright));
    let fitted: Buffer;
    if (framed) fitted = await sharp(upright).resize(SIZE, SIZE, { kernel: 'lanczos3' }).png().toBuffer();
    else {
      const trimmed = await sharp(upright).trim({ background: '#ffffff', threshold: 12 }).png().toBuffer().catch(() => upright);
      fitted = await sharp(trimmed).resize(INNER, INNER, { fit: 'inside', kernel: 'lanczos3' }).png().toBuffer();
    }
    const crisp = await sharp(fitted).sharpen({ sigma: 0.6, m1: 0.5, m2: 1.5 }).png().toBuffer();
    return sharp({ create: { width: SIZE, height: SIZE, channels: 3, background: '#ffffff' } })
      .composite([{ input: crisp, gravity: 'center' }])
      .webp({ quality: 92, smartSubsample: true, effort: 5 })
      .toBuffer();
  }

  /** True when the outer edge of a picture is (almost) plain white. */
  private async whiteBorder(png: Buffer): Promise<boolean> {
    const { data, info } = await sharp(png).resize(64, 64, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let edge = 0, white = 0;
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        if (x > 1 && y > 1 && x < info.width - 2 && y < info.height - 2) continue;
        const i = (y * info.width + x) * info.channels;
        edge++;
        if (data[i] > 240 && data[i + 1] > 240 && data[i + 2] > 240) white++;
      }
    }
    return white / edge > 0.97;
  }

  /** A promo flyer or banner: never cropped or enlarged, because its words must stay whole. */
  private bannerFrame(input: Buffer, options: { limitInputPixels: number }): Promise<Buffer> {
    return sharp(input, options).rotate().flatten({ background: '#ffffff' }).resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).sharpen({ sigma: 0.5 }).webp({ quality: 90, smartSubsample: true }).toBuffer();
  }

  private sceneFrame(input: Buffer, options: { limitInputPixels: number }): Promise<Buffer> {
    return sharp(input, options).rotate().flatten({ background: '#ffffff' }).resize(1600, 1067, { fit: 'cover', position: 'attention', kernel: 'lanczos3' }).sharpen({ sigma: 0.6, m1: 0.5, m2: 1.5 }).webp({ quality: 88, smartSubsample: true }).toBuffer();
  }

  async save(input: Buffer, preset: PhotoPreset): Promise<{ url: string; warning?: string }> {
    const { output, warning } = await this.process(input, preset);
    const name = `${randomUUID()}.webp`;
    const root = photoRoot();
    await mkdir(root, { recursive: true });
    await writeFile(join(root, name), output, { flag: 'wx' });
    return { url: `${PHOTO_URL_PREFIX}${name}`, warning };
  }

  /** Deletes an uploaded file. Bundled photos and outside links are left alone. */
  async remove(url: string): Promise<void> {
    const name = url.startsWith(PHOTO_URL_PREFIX) ? url.slice(PHOTO_URL_PREFIX.length) : '';
    if (!/^[0-9a-f-]{36}\.webp$/.test(name)) return;
    await unlink(join(photoRoot(), name)).catch(() => undefined);
  }
}
