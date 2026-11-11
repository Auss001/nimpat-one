import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DivisionCode, PrescriptionStatus, Prisma, ProductAvailability, ProductStatus, RecordVerification } from '@prisma/client';
import { pageArgs, paginate } from '../../common/dto/pagination.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../access/auth-user';
import { P } from '../access/permissions';
import { AuditService } from '../audit/audit.service';
import { DivisionsService } from '../divisions/divisions.service';
import { InventoryService } from '../inventory/inventory.service';
import {
  AdminProductQueryDto,
  BulkProductsDto,
  CreateCategoryDto,
  CreateProductDto,
  ImageInputDto,
  PharmacyReviewDto,
  ProductQueryDto,
  UpdateCategoryDto,
  UpdateProductDto,
  UpdateVariantDto,
  VariantInputDto,
} from './catalog.dto';
import { purchaseBlock } from './purchase-rules';
import { SHOWN_PRODUCT } from './shown';

const productInclude = {
  category: { select: { id: true, name: true, slug: true } },
  division: { select: { id: true, code: true, name: true, slug: true } },
  images: { orderBy: { sortOrder: 'asc' } },
} satisfies Prisma.ProductInclude;

/** Pharmacy items show to customers only once they have a price; other shops are unaffected. */
const PRICED_IF_PHARMACY: Prisma.ProductWhereInput = {
  OR: [{ division: { code: { not: DivisionCode.PHARMACY } } }, { variants: { some: { isActive: true, unitPriceMinor: { not: null } } } }],
};

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
    const hidden = await this.hiddenOutOfStock();
    const where: Prisma.ProductWhereInput = {
      ...(await this.productWhere(q)),
      ...(hidden.length ? { id: { notIn: hidden } } : {}),
      AND: [PRICED_IF_PHARMACY, SHOWN_PRODUCT],
    };
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
    return paginate(data.map((p) => publicProduct(p)), total, q);
  }

  async getProduct(slugOrId: string) {
    const product = await this.prisma.product.findFirst({
      where: { AND: [PRICED_IF_PHARMACY, SHOWN_PRODUCT], ...(isUuid(slugOrId) ? { id: slugOrId } : { slug: slugOrId }) },
      include: { ...productInclude, variants: { where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { unitPriceMinor: 'asc' }] } },
    });
    if (!product) throw new NotFoundException('Product not found');
    const [withStock] = await this.withAvailability([product]);
    return publicProduct(withStock);
  }

  /** Live availability for a set of variants (used by product pages before add-to-cart). */
  async variantAvailability(variantIds: string[]) {
    const variants = await this.prisma.productVariant.findMany({
      where: { id: { in: variantIds }, isActive: true, product: SHOWN_PRODUCT },
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
    const { division, variants, images, ...fields } = dto;
    this.validateVariants(variants ?? []);
    // Anything new in the pharmacy starts unapproved and cannot be bought.
    const data = d.code === DivisionCode.PHARMACY ? { ...fields, prescriptionStatus: PrescriptionStatus.NOT_REVIEWED, purchaseEnabled: false } : fields;

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
    const isPharmacy = existing.prescriptionStatus !== null;
    const isPharmacist = user.can(P.pharmacyApprove, existing.divisionId);
    if (isPharmacy && dto.purchaseEnabled === true && !isPharmacist) {
      throw new ForbiddenException('Only a pharmacist can allow this product to be bought');
    }
    // Changed medicine text is no longer what the pharmacist approved.
    const textChanged = (dto.name !== undefined && dto.name !== existing.name) || (dto.description !== undefined && dto.description !== existing.description);
    const reset: Prisma.ProductUncheckedUpdateInput = isPharmacy && textChanged && !isPharmacist
      ? { pharmacistApprovedAt: null, pharmacistApprovedById: null, verification: RecordVerification.AWAITING_CONFIRMATION, verifiedAt: null, verifiedById: null }
      : {};
    await this.prisma.product.update({ where: { id }, data: { ...dto, ...reset } });
    await this.audit.record({ actorId: user.id, action: 'product.update', entityType: 'product', entityId: id, divisionId: existing.divisionId, changes: { ...dto } });
    return this.adminGetProduct(user, id);
  }

  /**
   * The pharmacist's decision on a medicine. Without approval it cannot appear
   * to customers, and withdrawing approval takes it off the customer API at once.
   */
  async pharmacyReview(user: AuthUser, id: string, dto: PharmacyReviewDto) {
    const existing = await this.prisma.product.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Product not found');
    user.assertCan(P.pharmacyApprove, existing.divisionId);
    if (existing.prescriptionStatus === null) throw new BadRequestException('Only pharmacy products have a pharmacist review');
    if (dto.approved && dto.prescriptionStatus === PrescriptionStatus.NOT_REVIEWED) {
      throw new BadRequestException('Choose the prescription status before approving');
    }
    await this.prisma.product.update({
      where: { id },
      data: {
        prescriptionStatus: dto.prescriptionStatus,
        description: dto.description,
        purchaseEnabled: dto.approved ? dto.purchaseEnabled : false,
        pharmacistApprovedAt: dto.approved ? new Date() : null,
        pharmacistApprovedById: dto.approved ? user.id : null,
        ...(dto.approved ? {} : { verification: RecordVerification.AWAITING_CONFIRMATION, verifiedAt: null, verifiedById: null }),
      },
    });
    await this.audit.record({ actorId: user.id, action: dto.approved ? 'pharmacy.approve' : 'pharmacy.withdraw', entityType: 'product', entityId: id, divisionId: existing.divisionId, changes: { ...dto } });
    return this.adminGetProduct(user, id);
  }

  /**
   * One action on many products. Each is checked on its own, so one that cannot
   * change is reported back and does not stop the others.
   */
  async bulk(user: AuthUser, dto: BulkProductsDto) {
    const ids = [...new Set(dto.ids)];
    const products = await this.prisma.product.findMany({ where: { id: { in: ids } }, include: { variants: { where: { isActive: true }, select: { id: true } } } });
    if (dto.action === 'PHARMACY_APPROVE' && (!dto.prescriptionStatus || dto.prescriptionStatus === PrescriptionStatus.NOT_REVIEWED)) {
      throw new BadRequestException('Choose the prescription status before approving');
    }
    let updated = 0;
    const skipped: { id: string; name: string; reason: string }[] = [];
    for (const p of products) {
      const skip = (reason: string) => skipped.push({ id: p.id, name: p.name, reason });
      if (!user.can(P.catalogManage, p.divisionId)) { skip('You do not manage this division'); continue; }
      const isPharmacy = p.prescriptionStatus !== null;
      const isPharmacist = user.can(P.pharmacyApprove, p.divisionId);
      let data: Prisma.ProductUncheckedUpdateInput;
      switch (dto.action) {
        case 'PUBLISH':
          if (!user.can(P.recordsVerify, p.divisionId)) { skip('You cannot confirm records in this division'); continue; }
          if (p.variants.length === 0) { skip('It has no active size'); continue; }
          if (isPharmacy && !p.pharmacistApprovedAt) { skip('It needs pharmacist approval first'); continue; }
          data = { status: ProductStatus.ACTIVE, verification: RecordVerification.VERIFIED, verifiedAt: new Date(), verifiedById: user.id };
          break;
        case 'UNPUBLISH':
          if (!user.can(P.recordsVerify, p.divisionId)) { skip('You cannot confirm records in this division'); continue; }
          data = { verification: RecordVerification.AWAITING_CONFIRMATION, verifiedAt: null, verifiedById: null };
          break;
        case 'ARCHIVE':
          data = { status: ProductStatus.ARCHIVED };
          break;
        case 'RESTORE':
          if (p.variants.length === 0) { skip('It has no active size'); continue; }
          data = { status: ProductStatus.ACTIVE };
          break;
        case 'ALLOW_PURCHASE':
          if (isPharmacy && !isPharmacist) { skip('Only a pharmacist can allow this to be bought'); continue; }
          if (isPharmacy && !p.pharmacistApprovedAt) { skip('It needs pharmacist approval first'); continue; }
          if (p.prescriptionStatus === PrescriptionStatus.REQUIRED || p.prescriptionStatus === PrescriptionStatus.RESTRICTED) { skip('Prescription medicines cannot be bought online'); continue; }
          data = { purchaseEnabled: true };
          break;
        case 'BLOCK_PURCHASE':
          data = { purchaseEnabled: false };
          break;
        case 'MARK_IN_STOCK':
          data = { listedAvailability: ProductAvailability.IN_STOCK };
          break;
        case 'MARK_OUT_OF_STOCK':
          data = { listedAvailability: ProductAvailability.OUT_OF_STOCK };
          break;
        case 'USE_LIVE_COUNT':
          data = { listedAvailability: null };
          break;
        case 'PHARMACY_APPROVE':
          if (!isPharmacy) { skip('It is not a pharmacy product'); continue; }
          if (!isPharmacist) { skip('Only a pharmacist can approve this'); continue; }
          data = { prescriptionStatus: dto.prescriptionStatus, pharmacistApprovedAt: new Date(), pharmacistApprovedById: user.id };
          break;
      }
      await this.prisma.product.update({ where: { id: p.id }, data });
      await this.audit.record({ actorId: user.id, action: `product.bulk.${dto.action.toLowerCase()}`, entityType: 'product', entityId: p.id, divisionId: p.divisionId, changes: { prescriptionStatus: dto.prescriptionStatus } });
      updated++;
    }
    return { updated, skipped, notFound: ids.length - products.length };
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
    this.validateVariants([{ ...merged, unitPriceMinor: merged.unitPriceMinor === null || merged.unitPriceMinor === undefined ? null : Number(merged.unitPriceMinor) }]);
    const data: Prisma.ProductVariantUpdateInput = {
      ...dto,
      unitPriceMinor: dto.unitPriceMinor === undefined ? undefined : dto.unitPriceMinor === null ? null : BigInt(dto.unitPriceMinor),
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

  /**
   * Products customers should not see in lists because their shop hides out-of-stock items. Matches the
   * "In stock" rule customers see: a listed status wins; otherwise live stock at the shop's main location.
   * A direct link to the product still opens it, marked out of stock.
   */
  private async hiddenOutOfStock(): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT p."id"::text AS id
        FROM "products" p
        JOIN "divisions" d ON d."id" = p."division_id"
       WHERE d."hide_out_of_stock" AND p."status" = 'ACTIVE'
         AND (p."listed_availability" = 'OUT_OF_STOCK'
              OR (p."listed_availability" IS NULL AND NOT EXISTS (
                    SELECT 1
                      FROM "product_variants" v
                      JOIN "stock_levels" s ON s."variant_id" = v."id"
                      JOIN "stock_locations" l ON l."id" = s."location_id"
                     WHERE v."product_id" = p."id" AND v."is_active"
                       AND l."division_id" = p."division_id" AND l."is_default" AND l."is_active"
                       AND s."quantity_on_hand" - s."quantity_reserved" > 0)))`;
    return rows.map((r) => r.id);
  }

  /** Switches hiding of out-of-stock items for one shop. */
  async setHideOutOfStock(user: AuthUser, division: string, hide: boolean) {
    const d = await this.divisions.resolve(division);
    user.assertCan(P.catalogManage, d.id);
    await this.prisma.division.update({ where: { id: d.id }, data: { hideOutOfStock: hide } });
    this.divisions.invalidate();
    await this.audit.record({ actorId: user.id, action: hide ? 'catalog.hide_out_of_stock.on' : 'catalog.hide_out_of_stock.off', entityType: 'division', entityId: d.id, divisionId: d.id });
    return { division: d.slug, hideOutOfStock: hide };
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
      if (v.compareAtPriceMinor !== undefined && v.compareAtPriceMinor !== null && v.unitPriceMinor !== null && v.unitPriceMinor !== undefined && v.compareAtPriceMinor < v.unitPriceMinor) {
        throw new BadRequestException(`Variant ${v.sku}: compareAtPriceMinor must be >= unitPriceMinor`);
      }
    }
  }

  private variantData(v: VariantInputDto) {
    return {
      ...v,
      unitPriceMinor: v.unitPriceMinor === null || v.unitPriceMinor === undefined ? null : BigInt(v.unitPriceMinor),
      compareAtPriceMinor: v.compareAtPriceMinor !== undefined ? BigInt(v.compareAtPriceMinor) : undefined,
    };
  }
}

type PublicInput = {
  listedAvailability: ProductAvailability | null;
  purchaseEnabled: boolean;
  prescriptionStatus: PrescriptionStatus | null;
  pharmacistApprovedAt: Date | null;
  pharmacistApprovedById: string | null;
  verifiedById: string | null;
  verificationNote: string | null;
  images: unknown[];
  variants: { unitPriceMinor: bigint | null; availableQuantity: number; recordedStockQty: number | null; recordedStockAt: Date | null }[];
};

/**
 * What customers see. Historical stock counts and staff notes stay private,
 * and availability comes from the listed status when there is no live count.
 */
function publicProduct<T extends PublicInput>(p: T) {
  const { verificationNote: _note, pharmacistApprovedById: _by, verifiedById: _verifier, ...rest } = p;
  const variants = p.variants.map(({ recordedStockQty: _qty, recordedStockAt: _at, ...v }) => ({
    ...v,
    purchasable: purchaseBlock(p, v) === null && (p.listedAvailability === ProductAvailability.IN_STOCK || v.availableQuantity > 0),
    purchaseNote: purchaseBlock(p, v),
  }));
  const prices = variants.map((v) => v.unitPriceMinor).filter((x): x is bigint => x !== null);
  return {
    ...rest,
    variants,
    priceFromMinor: prices.length ? prices.reduce((m, x) => (x < m ? x : m), prices[0]) : null,
    pricePublished: prices.length > 0,
    inStock: p.listedAvailability ? p.listedAvailability === ProductAvailability.IN_STOCK : variants.some((v) => v.availableQuantity > 0),
    imageStatus: p.images.length ? 'AVAILABLE' : 'IMAGE_PENDING',
  };
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
