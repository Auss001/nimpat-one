import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, StockMovementType } from '@prisma/client';
import { PrismaService, Tx } from '../../prisma/prisma.service';

export interface StockLine {
  variantId: string;
  quantity: number;
}

export class InsufficientStockException extends ConflictException {
  constructor(readonly variantIds: string[]) {
    super({ statusCode: 409, error: 'Conflict', message: 'Some items are out of stock or have insufficient quantity', variantIds });
  }
}

/**
 * Inventory with concurrency safety.
 *
 * Every mutation is a single conditional UPDATE (e.g. "reserve q only if
 * on_hand - reserved >= q"). PostgreSQL row locks serialise competing
 * updates, and the predicate is re-checked after the lock is acquired, so two
 * customers can never both take the last unit. A CHECK constraint
 * (on_hand >= reserved >= 0) backs this up at the database level.
 *
 * Lifecycle: checkout → reserve; payment verified → commit (sale);
 * cancel/expire → release.
 */
@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  async defaultLocationId(divisionId: string, tx: Tx | PrismaService = this.prisma): Promise<string> {
    const loc = await tx.stockLocation.findFirst({ where: { divisionId, isDefault: true, isActive: true }, select: { id: true } });
    if (!loc) throw new ConflictException('No active fulfilment location is configured for this division');
    return loc.id;
  }

  /** Available (on hand minus reserved) per variant at a location. */
  async availability(variantIds: string[], locationId: string | null): Promise<Map<string, number>> {
    const result = new Map<string, number>(variantIds.map((id) => [id, 0]));
    if (!locationId || variantIds.length === 0) return result;
    const levels = await this.prisma.stockLevel.findMany({
      where: { variantId: { in: variantIds }, locationId },
      select: { variantId: true, quantityOnHand: true, quantityReserved: true },
    });
    for (const l of levels) result.set(l.variantId, Math.max(0, l.quantityOnHand - l.quantityReserved));
    return result;
  }

  async availabilityForDivision(divisionId: string, variantIds: string[]): Promise<Map<string, number>> {
    const loc = await this.prisma.stockLocation.findFirst({ where: { divisionId, isDefault: true, isActive: true }, select: { id: true } });
    return this.availability(variantIds, loc?.id ?? null);
  }

  /** Reserves all lines atomically or throws InsufficientStockException. Must run inside a transaction. */
  async reserve(tx: Tx, locationId: string, lines: StockLine[], orderId: string): Promise<void> {
    const failed: string[] = [];
    // Lock rows in a stable order to avoid deadlocks between concurrent checkouts.
    for (const line of [...lines].sort((a, b) => a.variantId.localeCompare(b.variantId))) {
      const updated = await tx.$executeRaw`
        UPDATE "stock_levels"
           SET "quantity_reserved" = "quantity_reserved" + ${line.quantity},
               "version" = "version" + 1, "updated_at" = now()
         WHERE "variant_id" = ${line.variantId}::uuid AND "location_id" = ${locationId}::uuid
           AND "quantity_on_hand" - "quantity_reserved" >= ${line.quantity}`;
      if (updated !== 1) failed.push(line.variantId);
    }
    if (failed.length) throw new InsufficientStockException(failed);
    await this.log(tx, locationId, lines, StockMovementType.RESERVATION, orderId, (q) => q);
  }

  /** Returns reserved units to available stock (order cancelled / expired). */
  async release(tx: Tx, locationId: string, lines: StockLine[], orderId: string): Promise<void> {
    for (const line of lines) {
      await tx.$executeRaw`
        UPDATE "stock_levels"
           SET "quantity_reserved" = GREATEST("quantity_reserved" - ${line.quantity}, 0),
               "version" = "version" + 1, "updated_at" = now()
         WHERE "variant_id" = ${line.variantId}::uuid AND "location_id" = ${locationId}::uuid`;
    }
    await this.log(tx, locationId, lines, StockMovementType.RELEASE, orderId, (q) => -q);
  }

  /** Converts a reservation into a sale (payment verified). */
  async commit(tx: Tx, locationId: string, lines: StockLine[], orderId: string): Promise<void> {
    for (const line of lines) {
      const updated = await tx.$executeRaw`
        UPDATE "stock_levels"
           SET "quantity_on_hand" = "quantity_on_hand" - ${line.quantity},
               "quantity_reserved" = "quantity_reserved" - ${line.quantity},
               "version" = "version" + 1, "updated_at" = now()
         WHERE "variant_id" = ${line.variantId}::uuid AND "location_id" = ${locationId}::uuid
           AND "quantity_reserved" >= ${line.quantity} AND "quantity_on_hand" >= ${line.quantity}`;
      if (updated !== 1) throw new ConflictException(`Stock reservation missing for variant ${line.variantId}`);
    }
    await this.log(tx, locationId, lines, StockMovementType.SALE, orderId, (q) => -q);
  }

  /** Puts sold units back on hand (a paid order was cancelled before dispatch). */
  async restock(tx: Tx, locationId: string, lines: StockLine[], orderId: string, actorId?: string): Promise<void> {
    for (const line of lines) {
      await tx.$executeRaw`
        UPDATE "stock_levels"
           SET "quantity_on_hand" = "quantity_on_hand" + ${line.quantity},
               "version" = "version" + 1, "updated_at" = now()
         WHERE "variant_id" = ${line.variantId}::uuid AND "location_id" = ${locationId}::uuid`;
    }
    await tx.stockMovement.createMany({
      data: lines.map((l) => ({ variantId: l.variantId, locationId, type: StockMovementType.RETURN, quantity: l.quantity, orderId, actorId, reason: 'Order cancelled after payment' })),
    });
  }

  /** Staff adjustment: receipts (+), write-offs/corrections (-). */
  async adjust(input: {
    variantId: string;
    locationId: string;
    delta: number;
    type: 'RECEIPT' | 'ADJUSTMENT' | 'RETURN';
    reason: string;
    actorId: string;
  }) {
    if (!Number.isInteger(input.delta) || input.delta === 0) throw new BadRequestException('delta must be a non-zero integer');
    if (input.type === 'RECEIPT' && input.delta < 0) throw new BadRequestException('Receipts must be positive');

    return this.prisma.$transaction(async (tx) => {
      const variant = await tx.productVariant.findUnique({ where: { id: input.variantId }, include: { product: true } });
      const location = await tx.stockLocation.findUnique({ where: { id: input.locationId } });
      if (!variant || !location) throw new NotFoundException('Variant or location not found');
      if (variant.product.divisionId !== location.divisionId) {
        throw new BadRequestException('Variant and stock location belong to different divisions');
      }
      // Ensure the row exists, then apply the delta atomically.
      await tx.stockLevel.upsert({
        where: { variantId_locationId: { variantId: input.variantId, locationId: input.locationId } },
        create: { variantId: input.variantId, locationId: input.locationId },
        update: {},
      });
      const updated = await tx.$executeRaw`
        UPDATE "stock_levels"
           SET "quantity_on_hand" = "quantity_on_hand" + ${input.delta},
               "version" = "version" + 1, "updated_at" = now()
         WHERE "variant_id" = ${input.variantId}::uuid AND "location_id" = ${input.locationId}::uuid
           AND "quantity_on_hand" + ${input.delta} >= "quantity_reserved"`;
      if (updated !== 1) {
        throw new ConflictException('Adjustment would reduce stock below the quantity already reserved for orders');
      }
      await tx.stockMovement.create({
        data: {
          variantId: input.variantId,
          locationId: input.locationId,
          type: input.type as StockMovementType,
          quantity: input.delta,
          reason: input.reason,
          actorId: input.actorId,
        },
      });
      const level = await tx.stockLevel.findUniqueOrThrow({
        where: { variantId_locationId: { variantId: input.variantId, locationId: input.locationId } },
      });
      return { ...level, divisionId: location.divisionId, available: level.quantityOnHand - level.quantityReserved };
    });
  }

  async listLevels(where: Prisma.StockLevelWhereInput, skip: number, take: number) {
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.stockLevel.findMany({
        where,
        skip,
        take,
        orderBy: [{ location: { code: 'asc' } }, { variant: { sku: 'asc' } }],
        include: {
          location: { select: { id: true, code: true, name: true } },
          variant: { select: { id: true, sku: true, name: true, product: { select: { id: true, name: true, divisionId: true } } } },
        },
      }),
      this.prisma.stockLevel.count({ where }),
    ]);
    return {
      rows: rows.map((r) => ({
        ...r,
        available: r.quantityOnHand - r.quantityReserved,
        lowStock: r.quantityOnHand - r.quantityReserved <= r.reorderLevel,
      })),
      total,
    };
  }

  private async log(tx: Tx, locationId: string, lines: StockLine[], type: StockMovementType, orderId: string, sign: (q: number) => number) {
    await tx.stockMovement.createMany({
      data: lines.map((l) => ({ variantId: l.variantId, locationId, type, quantity: sign(l.quantity), orderId })),
    });
  }
}
