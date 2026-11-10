import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { FulfilmentType, ProductStatus, RecordVerification } from '@prisma/client';
import { multiplyMinor, sumMinor } from '../../common/utils/money';
import { vatOn, vatRateBps } from '../../common/utils/vat';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../access/auth-user';
import { DeliveryService } from '../delivery/delivery.service';
import { DivisionsService } from '../divisions/divisions.service';
import { InventoryService } from '../inventory/inventory.service';
import { purchaseBlock } from '../catalog/purchase-rules';

const MAX_LINES = 50;

@Injectable()
export class CartService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly divisions: DivisionsService,
    private readonly inventory: InventoryService,
    private readonly delivery: DeliveryService,
  ) {}

  /** Cart with live server prices, availability and per-line issues. */
  async view(user: AuthUser, division: string) {
    const d = await this.divisions.resolve(division);
    const cart = await this.prisma.cart.findUnique({
      where: { userId_divisionId: { userId: user.id, divisionId: d.id } },
      include: {
        items: {
          orderBy: { createdAt: 'asc' },
          include: {
            variant: {
              include: { product: { select: { id: true, name: true, slug: true, status: true, verification: true, isAgeRestricted: true, purchaseEnabled: true, listedAvailability: true, prescriptionStatus: true, pharmacistApprovedAt: true, images: { take: 1, orderBy: { sortOrder: 'asc' } } } } },
            },
          },
        },
      },
    });
    const items = cart?.items ?? [];
    const availability = await this.inventory.availabilityForDivision(d.id, items.map((i) => i.variantId));

    const lines = items.map((i) => {
      const v = i.variant;
      const available = availability.get(v.id) ?? 0;
      const issues: string[] = [];
      if (!v.isActive || v.product.status !== ProductStatus.ACTIVE || v.product.verification !== RecordVerification.VERIFIED) issues.push('UNAVAILABLE');
      else if (purchaseBlock(v.product, v)) issues.push('NOT_PURCHASABLE');
      else if (available < i.quantity) issues.push(available === 0 ? 'OUT_OF_STOCK' : 'INSUFFICIENT_STOCK');
      if (i.quantity < v.minOrderQty) issues.push('BELOW_MIN_QTY');
      if (v.maxOrderQty && i.quantity > v.maxOrderQty) issues.push('ABOVE_MAX_QTY');
      return {
        itemId: i.id,
        variantId: v.id,
        sku: v.sku,
        productId: v.product.id,
        productName: v.product.name,
        productSlug: v.product.slug,
        variantName: v.name,
        image: v.product.images[0]?.url ?? null,
        isAgeRestricted: v.product.isAgeRestricted,
        unitPriceMinor: v.unitPriceMinor,
        quantity: i.quantity,
        lineTotalMinor: multiplyMinor(v.unitPriceMinor ?? 0n, i.quantity),
        availableQuantity: available,
        issues,
      };
    });

    return {
      cartId: cart?.id ?? null,
      division: { id: d.id, code: d.code, name: d.name, slug: d.slug },
      currency: 'NGN',
      lines,
      itemCount: lines.reduce((n, l) => n + l.quantity, 0),
      subtotalMinor: sumMinor(lines.map((l) => l.lineTotalMinor)),
      canCheckout: lines.length > 0 && lines.every((l) => l.issues.length === 0),
    };
  }

  async addItem(user: AuthUser, variantId: string, quantity: number) {
    const variant = await this.loadPurchasableVariant(variantId);
    const divisionId = variant.product.divisionId;
    const cart = await this.prisma.cart.upsert({
      where: { userId_divisionId: { userId: user.id, divisionId } },
      create: { userId: user.id, divisionId },
      update: { status: 'ACTIVE' },
    });
    const existing = await this.prisma.cartItem.findUnique({ where: { cartId_variantId: { cartId: cart.id, variantId } } });
    if (!existing) {
      const lines = await this.prisma.cartItem.count({ where: { cartId: cart.id } });
      if (lines >= MAX_LINES) throw new BadRequestException(`A cart can hold at most ${MAX_LINES} different items`);
    }
    const newQty = (existing?.quantity ?? 0) + quantity;
    await this.assertQuantity(variant, newQty, divisionId);
    await this.prisma.cartItem.upsert({
      where: { cartId_variantId: { cartId: cart.id, variantId } },
      create: { cartId: cart.id, variantId, quantity: newQty },
      update: { quantity: newQty },
    });
    return this.view(user, divisionId);
  }

  async setQuantity(user: AuthUser, variantId: string, quantity: number) {
    const item = await this.findItem(user, variantId);
    if (quantity === 0) {
      await this.prisma.cartItem.delete({ where: { id: item.id } });
    } else {
      const variant = await this.loadPurchasableVariant(variantId);
      await this.assertQuantity(variant, quantity, item.cart.divisionId);
      await this.prisma.cartItem.update({ where: { id: item.id }, data: { quantity } });
    }
    return this.view(user, item.cart.divisionId);
  }

  async removeItem(user: AuthUser, variantId: string) {
    const item = await this.findItem(user, variantId);
    await this.prisma.cartItem.delete({ where: { id: item.id } });
    return this.view(user, item.cart.divisionId);
  }

  async clear(user: AuthUser, division: string) {
    const d = await this.divisions.resolve(division);
    await this.prisma.cartItem.deleteMany({ where: { cart: { userId: user.id, divisionId: d.id } } });
    return this.view(user, d.id);
  }

  /** Full price breakdown (items + delivery) exactly as checkout will charge it. */
  async quote(user: AuthUser, division: string, fulfilmentType: FulfilmentType, addressId?: string) {
    const cart = await this.view(user, division);
    let delivery = null;
    if (fulfilmentType === FulfilmentType.DELIVERY) {
      if (!addressId) throw new BadRequestException('addressId is required for delivery');
      const address = await this.prisma.address.findFirst({ where: { id: addressId, userId: user.id, deletedAt: null } });
      if (!address) throw new NotFoundException('Address not found');
      delivery = await this.delivery.quote(cart.division.id, address, cart.subtotalMinor);
    }
    const deliveryFeeMinor = delivery?.feeMinor ?? 0n;
    const taxMinor = vatOn(cart.division.code, cart.subtotalMinor);
    return { ...cart, fulfilmentType, delivery, deliveryFeeMinor, discountMinor: 0n, taxMinor, vatRateBps: vatRateBps(cart.division.code), totalMinor: cart.subtotalMinor + taxMinor + deliveryFeeMinor };
  }

  private async findItem(user: AuthUser, variantId: string) {
    const item = await this.prisma.cartItem.findFirst({ where: { variantId, cart: { userId: user.id } }, include: { cart: true } });
    if (!item) throw new NotFoundException('Item is not in your cart');
    return item;
  }

  private async loadPurchasableVariant(variantId: string) {
    const variant = await this.prisma.productVariant.findUnique({ where: { id: variantId }, include: { product: true } });
    if (!variant || !variant.isActive || variant.product.status !== ProductStatus.ACTIVE) {
      throw new NotFoundException('This product is not available');
    }
    if (variant.product.verification !== RecordVerification.VERIFIED) {
      throw new ConflictException('This product is awaiting confirmation by Nimpat and cannot be sold yet');
    }
    const blocked = purchaseBlock(variant.product, variant);
    if (blocked) throw new ConflictException(blocked);
    return variant;
  }

  private async assertQuantity(variant: { id: string; minOrderQty: number; maxOrderQty: number | null }, qty: number, divisionId: string) {
    if (qty < variant.minOrderQty) throw new BadRequestException(`Minimum order quantity is ${variant.minOrderQty}`);
    if (variant.maxOrderQty && qty > variant.maxOrderQty) throw new BadRequestException(`Maximum order quantity is ${variant.maxOrderQty}`);
    const available = (await this.inventory.availabilityForDivision(divisionId, [variant.id])).get(variant.id) ?? 0;
    if (qty > available) {
      throw new ConflictException(available === 0 ? 'This item is out of stock' : `Only ${available} available`);
    }
  }
}
