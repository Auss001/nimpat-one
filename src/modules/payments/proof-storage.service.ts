import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const MAX_PROOF_BYTES = 5 * 1024 * 1024;

const SIGNATURES: { mime: string; ext: string; magic: number[] }[] = [
  { mime: 'image/png', ext: 'png', magic: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/jpeg', ext: 'jpg', magic: [0xff, 0xd8, 0xff] },
  { mime: 'application/pdf', ext: 'pdf', magic: [0x25, 0x50, 0x44, 0x46] },
];

/**
 * Private storage for proof-of-payment files. Files live outside the public
 * /media folder and are only served through an authorised endpoint.
 * Local disk for development; swap for a private Cloud Storage bucket in
 * production (same interface).
 */
@Injectable()
export class ProofStorageService {
  private readonly root = resolve(process.env.PROOF_STORAGE_DIR ?? join(process.cwd(), 'uploads', 'payment-proofs'));

  /** Validates content by magic bytes (not by the client-declared type). */
  inspect(buffer: Buffer): { mime: string; ext: string } {
    if (!buffer.length) throw new BadRequestException('The file is empty');
    if (buffer.length > MAX_PROOF_BYTES) throw new BadRequestException('Files must be 5 MB or smaller');
    const sig = SIGNATURES.find((s) => s.magic.every((b, i) => buffer[i] === b));
    if (!sig) throw new BadRequestException('Only PNG, JPEG or PDF files are accepted');
    return sig;
  }

  async save(buffer: Buffer): Promise<{ key: string; mime: string; sha256: string; size: number }> {
    const { mime, ext } = this.inspect(buffer);
    const key = `${randomUUID()}.${ext}`;
    await mkdir(this.root, { recursive: true });
    await writeFile(join(this.root, key), buffer, { flag: 'wx' });
    return { key, mime, sha256: createHash('sha256').update(buffer).digest('hex'), size: buffer.length };
  }

  async read(key: string): Promise<Buffer> {
    if (!/^[0-9a-f-]{36}\.(png|jpg|pdf)$/.test(key)) throw new NotFoundException();
    try {
      return await readFile(join(this.root, key));
    } catch {
      throw new NotFoundException('File not found');
    }
  }
}
