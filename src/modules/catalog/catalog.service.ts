import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ProductStatus, RecordVerification } from '@prisma/client';
import { pageArgs, paginate } from '../../common/dto/pagination.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../access/auth-user';
import { P } from '../access/permissions';
import { AuditService } from '../audit/audit.service';
import { DivisionsService } from '../divisions/divisions.service';
import { InventoryService } from '../inventory/inventory.service';
import {
  AdminProductQueryDto,
  CreateCategoryDto,
  CreateProductDto,
  ImageInputDto,
  ProductQueryDto,
  UpdateCategoryDto,
  UpdateProductDto,
  UpdateVariantDto,
  VariantInputDto,
} from './catalog.dto';

const productInclude = {
  category: { select: { id: true, name: true, slug: true } },
  division: { select: { id: true, code: true, name: true, slug: true } },
  images: { orderBy: { sortOrder: 'asc' } },
} satisfies Prisma.ProductInclude;

@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly divisions: DivisionsService,
    private readonly inventory: InventoryService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // Public storefront
  // ---------------------------------------------------------------------------

  async listCategories(division: string) {
    const d = await this.divisions.resolve(division);
    return this.prisma.productCategory.findMany({
      where: { divisionId: d.id, isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, slug: true, description: true, parentId: true, sortOrder: true },
    });
  }

  async listProducts(q: ProductQueryDto) {
    const where = { ...(await this.productWhere(q, ProductStatus.ACTIVE)), verification: RecordVerification.VERIFIED };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        orderBy: this.sort(q.sort),
        ...pageArgs(q),
        include: {
          ...productInclude,
          images: { orderBy: { sortOrder: 'asc' }, take: 1 },
          variants: { where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { unitPriceMinor: 'asc' }] },
        },
      }),
      this.prisma.product.count({ where }),
    ]);
    const data = await this.withAvailability(rows);
    return paginate(
      data.map((p) => ({
        ...p,
        priceFromMinor: p.variants.length ? p.variants.reduce((m, v) => (v.unitPriceMinor < m ? v.unitPriceMinor : m), p.variants[0].unitPriceMinor) : null,
        inStock: p.variants.some((v) => v.availableQuantity > 0),
      })),
      total,
      q,
    );
  }

  async getProduct(slugOrId: string) {
    const product = await this.prisma.product.findFirst({
      where: { status: ProductStatus.ACTIVE, verification: RecordVerification.VERIFIED, ...(isUuid(slugOrId) ? { id: slugOrId } : { slug: slugOrId }) },
      include: { ...productInclude, variants: { where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { unitPriceMinor: 'asc' }] } },
    });
    if (!product) throw new NotFoundException('Product not found');
    const [withStock] = await this.withAvailability([product]);
    return withStock;
  }

  /** Live availability for a set of variants (used by product pages before add-to-cart). */
  async variantAvailability(variantIds: string[]) {
    const variants = await this.prisma.productVariant.findMany({
      where: { id: { in: variantIds }, isActive: true, product: { status: ProductStatus.ACTIVE, verification: RecordVerification.VERIFIED } },
      select: { id: true, sku: true, product: { select: { divisionId: true } } },
    });
    const out: { variantId: string; sku: string; availableQuantity: number }[] = [];
    const byDivision = groupBy(variants, (v) => v.product.divisionId);
    for (const [divisionId, list] of byDivision) {
      const avail = await this.inventory.availabilityForDivision(divisionId, list.map((v) => v.id));
      for (const v of list) out.push({ variantId: v.id, sku: v.sku, availableQuantity: avail.get(v.id) ?? 0 });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Admin
  // ---------------------------------------------------------------------------

  async adminListProducts(user: AuthUser, q: AdminProductQueryDto) {
    const where = await this.productWhere(q, q.status);
    const allowed = user.divisionFilter(P.catalogManage);
    if (allowed) where.divisionId = q.division ? where.divisionId : { in: allowed };
    if (q.division) user.assertCan(P.catalogManage, where.divisionId as string);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        orderBy: this.sort(q.sort ?? 'newest'),
        ...pageArgs(q),
        include: { ...productInclude, variants: { orderBy: { sortOrder: 'asc' } } },
      }),
      this.prisma.product.count({ where }),
    ]);
    return paginate(await this.withAvailability(rows), total, q);
  }

  async adminGetProduct(user: AuthUser, id: string) {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: { ...productInclude, variants: { orderBy: { sortOrder: 'asc' } } },
    });
    if (!product) throw new NotFoundException('Product not found');
    user.assertCan(P.catalogManage, product.divisionId);
    const [withStock] = await this.withAvailability([product]);
    return withStock;
  }

  async createCategory(user: AuthUser, dto: CreateCategoryDto) {
    const d = await this.divisions.resolve(dto.division);
    user.assertCan(P.catalogManage, d.id);
    if (dto.parentId) await this.assertCategoryInDivision(dto.parentId, d.id);
    const { division, ...data } = dto;
    const category = await this.prisma.productCategory.create({ data: { ...data, divisionId: d.id } });
    await this.audit.record({ actorId: user.id, action: 'category.create', entityType: 'product_category', entityId: category.id, divisionId: d.id, changes: data });
    return category;
  }

  async updateCategory(user: AuthUser, id: string, dto: UpdateCategoryDto) {
    const existing = await this.prisma.productCategory.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Category not found');
    user.assertCan(P.catalogManage, existing.divisionId);
    if (dto.division) throw new BadRequestException('A category cannot be moved to another division');
    if (dto.parentId) {
      if (dto.parentId === id) throw new BadRequestException('A category cannot be its own parent');
      await this.assertCategoryInDivision(dto.parentId, existing.divisionId);
    }
    const { division, ...data } = dto;
    const updated = await this.prisma.productCategory.update({ where: { id }, data });
    await this.audit.record({ actorId: user.id, action: 'category.update', entityType: 'product_category', entityId: id, divisionId: existing.divisionId, changes: data });
    return updated;
  }

  async createProduct(user: AuthUser, dto: CreateProductDto) {
    const d = await this.divisions.resolve(dto.division);
    user.assertCan(P.catalogManage, d.id);
    if (dto.categoryId) await this.assertCategoryInDivision(dto.categoryId, d.id);
    const { division, variants, images, ...data } = dto;
    this.validateVariants(variants ?? []);

    const product = await this.prisma.$transaction(async (tx) => {
      const created = await tx.product.create({
        data: {
          ...data,
          divisionId: d.id,
          variants: variants?.length ? { create: variants.map((v) => this.variantData(v)) } : undefined,
          images: images?.length ? { create: images } : undefined,
        },
      });
      await this.audit.record(
        { actorId: user.id, action: 'product.create', entityType: 'product', entityId: created.id, divisionId: d.id, changes: { ...data, variants: variants?.map((v) => v.sku) } },
        tx,
      );
      await this.ensureStockRows(tx, d.id, created.id);
      return created;
    });
    return this.adminGetProduct(user, product.id);
  }

  async updateProduct(user: AuthUser, id: string, dto: UpdateProductDto) {
    const existing = await this.prisma.product.findUnique({ where: { id }, include: { variants: { where: { isActive: true } } } });
    if (!existing) throw new NotFoundException('Product not found');
    user.assertCan(P.catalogManage, existing.divisionId);
    if (dto.categoryId) await this.assertCategoryInDivision(dto.categoryId, existing.divisionId);
    if (dto.status === ProductStatus.ACTIVE && existing.variants.length === 0) {
      throw new BadRequestException('Add at least one active variant before publishing a product');
    }
    await this.prisma.product.update({ where: { id }, data: dto });
    await this.audit.record({ actorId: user.id, action: 'product.update', entityType: 'product', entityId: id, divisionId: existing.divisionId, changes: { ...dto } });
    return this.adminGetProduct(user, id);
  }

  async addVariant(user: AuthUser, productId: string, dto: VariantInputDto) {
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product) throw new NotFoundException('Product not found');
    user.assertCan(P.catalogManage, product.divisionId);
    this.validateVariants([dto]);
    const variant = await this.prisma.productVariant.create({ data: { ...this.variantData(dto), productId } });
    await this.ensureStockRows(this.prisma, product.divisionId, productId);
    await this.audit.record({ actorId: user.id, action: 'variant.create', entityType: 'product_variant', entityId: variant.id, divisionId: product.divisionId, changes: { ...dto } });
    return variant;
  }

  async updateVariant(user: AuthUser, variantId: string, dto: UpdateVariantDto) {
    const variant = await this.prisma.productVariant.findUnique({ where: { id: variantId }, include: { product: true } });
    if (!variant) throw new NotFoundException('Variant not found');
    user.assertCan(P.catalogManage, variant.product.divisionId);
    const merged = { ...variant, ...dto } as unknown as VariantInputDto;
    this.validateVariants([{ ...merged, unitPriceMinor: Number(merged.unitPriceMinor) }]);
    const data: Prisma.ProductVariantUpdateInput = {
      ...dto,
      unitPriceMinor: dto.unitPriceMinor !== undefined ? BigInt(dto.unitPriceMinor) : undefined,
      compareAtPriceMinor: dto.compareAtPriceMinor !== undefined ? BigInt(dto.compareAtPriceMinor) : undefined,
    };
    const updated = await this.prisma.productVariant.update({ where: { id: variantId }, data });
    // Price changes are always audited with before/after values.
    await this.audit.record({
      actorId: user.id,
      action: 'variant.update',
      entityType: 'product_variant',
      entityId: variantId,
      divisionId: variant.product.divisionId,
      changes: { before: { unitPriceMinor: variant.unitPriceMinor, isActive: variant.isActive }, after: { ...dto } },
    });
    return updated;
  }

  async addImage(user: AuthUser, productId: string, dto: ImageInputDto) {
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product) throw new NotFoundException('Product not found');
    user.assertCan(P.catalogManage, product.divisionId);
    return this.prisma.productImage.create({ data: { ...dto, productId } });
  }

  async removeImage(user: AuthUser, imageId: string) {
    const image = await this.prisma.productImage.findUnique({ where: { id: imageId }, include: { product: true } });
    if (!image) throw new NotFoundException('Image not found');
    user.assertCan(P.catalogManage, image.product.divisionId);
    await this.prisma.productImage.delete({ where: { id: imageId } });
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async productWhere(q: ProductQueryDto, status?: ProductStatus): Promise<Prisma.ProductWhereInput> {
    const where: Prisma.ProductWhereInput = { status };
    if (q.division) where.divisionId = (await this.divisions.resolve(q.division)).id;
    if (q.category) where.category = { slug: q.category };
    if (q.q) {
      where.OR = [
        { name: { contains: q.q, mode: 'insensitive' } },
        { brand: { contains: q.q, mode: 'insensitive' } },
        { description: { contains: q.q, mode: 'insensitive' } },
        { variants: { some: { sku: { equals: q.q.toUpperCase() } } } },
      ];
    }
    return where;
  }

  private sort(sort?: string): Prisma.ProductOrderByWithRelationInput[] {
    switch (sort) {
      case 'newest':
        return [{ createdAt: 'desc' }];
      // Price sorting by "from" price needs an aggregate; name is the stable fallback.
      default:
        return [{ name: 'asc' }];
    }
  }

  private async withAvailability<T extends { divisionId: string; variants: { id: string }[] }>(
    products: T[],
  ): Promise<(Omit<T, 'variants'> & { variants: (T['variants'][number] & { availableQuantity: number })[] })[]> {
    const byDivision = groupBy(products, (p) => p.divisionId);
    const avail = new Map<string, number>();
    for (const [divisionId, list] of byDivision) {
      const m = await this.inventory.availabilityForDivision(divisionId, list.flatMap((p) => p.variants.map((v) => v.id)));
      m.forEach((v, k) => avail.set(k, v));
    }
    return products.map((p) => ({
      ...p,
      variants: p.variants.map((v) => ({ ...v, availableQuantity: avail.get(v.id) ?? 0 })),
    }));
  }

  /** New variants get a zero-stock row at the division's default location, so they show up in Stock. */
  private async ensureStockRows(db: Prisma.TransactionClient | PrismaService, divisionId: string, productId: string) {
    const location = await db.stockLocation.findFirst({ where: { divisionId, isDefault: true, isActive: true }, select: { id: true } });
    if (!location) return;
    const variants = await db.productVariant.findMany({ where: { productId }, select: { id: true } });
    await db.stockLevel.createMany({ data: variants.map((v) => ({ variantId: v.id, locationId: location.id })), skipDuplicates: true });
  }

  private async assertCategoryInDivision(categoryId: string, divisionId: string) {
    const c = await this.prisma.productCategory.findUnique({ where: { id: categoryId }, select: { divisionId: true } });
    if (!c || c.divisionId !== divisionId) throw new BadRequestException('Category does not belong to this division');
  }

  private validateVariants(variants: VariantInputDto[]) {
    for (const v of variants) {
      if (v.maxOrderQty && v.minOrderQty && v.maxOrderQty < v.minOrderQty) {
        throw new BadRequestException(`Variant ${v.sku}: maxOrderQty must be >= minOrderQty`);
      }
      if (v.compareAtPriceMinor !== undefined && v.compareAtPriceMinor !== null && v.compareAtPriceMinor < v.unitPriceMinor) {
        throw new BadRequestException(`Variant ${v.sku}: compareAtPriceMinor must be >= unitPriceMinor`);
      }
    }
  }

  private variantData(v: VariantInputDto) {
    return {
      ...v,
      unitPriceMinor: BigInt(v.unitPriceMinor),
      compareAtPriceMinor: v.compareAtPriceMinor !== undefined ? BigInt(v.compareAtPriceMinor) : undefined,
    };
  }
}

function groupBy<T, K>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const i of items) {
    const k = key(i);
    m.set(k, [...(m.get(k) ?? []), i]);
  }
  return m;
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
