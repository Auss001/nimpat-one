import { Injectable, NotFoundException } from '@nestjs/common';
import { Division, DivisionCode } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/** Divisions change rarely, so they are cached in memory for a minute. */
@Injectable()
export class DivisionsService {
  private cache?: { at: number; rows: Division[] };

  constructor(private readonly prisma: PrismaService) {}

  async all(): Promise<Division[]> {
    if (this.cache && Date.now() - this.cache.at < 60_000) return this.cache.rows;
    const rows = await this.prisma.division.findMany({ orderBy: { sortOrder: 'asc' } });
    this.cache = { at: Date.now(), rows };
    return rows;
  }

  async listPublic() {
    return (await this.all())
      .filter((d) => d.isActive)
      .map(({ id, code, name, slug, kind, description }) => ({ id, code, name, slug, kind, description }));
  }

  /** Resolves a division by id, slug or code. */
  async resolve(idOrSlug: string): Promise<Division> {
    const key = idOrSlug.trim();
    // Codes also match in slug form (real-estate-interior → REAL_ESTATE_INTERIOR).
    const code = key.toUpperCase().replace(/-/g, '_');
    const d = (await this.all()).find((x) => x.id === key || x.slug === key.toLowerCase() || x.code === code);
    if (!d) throw new NotFoundException(`Division "${idOrSlug}" not found`);
    return d;
  }

  async byCode(code: DivisionCode): Promise<Division> {
    const d = (await this.all()).find((x) => x.code === code);
    if (!d) throw new NotFoundException(`Division ${code} is not configured`);
    return d;
  }

  async byId(id: string): Promise<Division> {
    const d = (await this.all()).find((x) => x.id === id);
    if (!d) throw new NotFoundException('Division not found');
    return d;
  }
}
