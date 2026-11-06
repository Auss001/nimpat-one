import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import {
  FulfilmentType,
  OrderStatus,
  PayableState,
  Payment,
  PaymentOption,
  PaymentPurpose,
  PaymentStatus,
  Prisma,
  ProductStatus,
  RecordVerification,
} from '@prisma/client';
import { AppConfig } from '../../config/app-config.service';
import { pageArgs, paginate, PaginationQueryDto } from '../../common/dto/pagination.dto';
import { addMinutes } from '../../common/utils/dates';
import { formatNgn, multiplyMinor, sumMinor } from '../../common/utils/money';
import { businessNumber, randomTrackingCode, withUniqueRetry } from './order-numbers';
import { PrismaService, Tx } from '../../prisma/prisma.service';
import { AuthUser } from '../access/auth-user';
import { P } from '../access/permissions';
import { AuditService } from '../audit/audit.service';
import { DeliveryService } from '../delivery/delivery.service';
import { DivisionsService } from '../divisions/divisions.service';
import { InventoryService, InsufficientStockException, StockLine } from '../inventory/inventory.service';
import { NotificationsService, NotifyInput } from '../notifications/notifications.service';
import { PayableContext, PayableHandler, PayableRegistry } from '../payments/payable.registry';
import { PaymentSummary } from '../payments/payment-ledger.service';
import { PaymentPolicyService } from '../payments/payment-policy.service';
import { purchaseBlock } from '../catalog/purchase-rules';

export interface CheckoutInput {
  division: string;
  fulfilmentType: FulfilmentType;
  addressId?: string;
  customerNote?: string;
  /** How the customer will pay. Defaults to Paystack. */
  paymentOption?: PaymentOption;
  /** If sent, checkout fails with 409 when the server total differs (price changed). */
  expectedTotalMinor?: number;
}

const orderInclude = {
  items: true,
  delivery: { select: { id: true, status: true, trackingCode: true, scheduledFor: true, dispatchedAt: true, deliveredAt: true, feeMinor: true } },
  statusHistory: { orderBy: { createdAt: 'asc' }, select: { fromStatus: true, toStatus: true, note: true, createdAt: true } },
  payments: {
    orderBy: { createdAt: 'desc' },
    select: { id: true, reference: true, method: true, collectionPoint: true, status: true, reconciliationStatus: true, amountMinor: true, paidAt: true, refundStatus: true, receiptNumber: true },
  },
  division: { select: { id: true, code: true, name: true, slug: true } },
} satisfies Prisma.OrderInclude;

/** Staff-driven fulfilment transitions. Payment status never changes here. */
const ADMIN_TRANSITIONS: Partial<Record<OrderStatus, OrderStatus[]>> = {
  PENDING: ['CANCELLED'],
  ACCEPTED: ['PROCESSING', 'READY', 'CANCELLED'],
  PROCESSING: ['READY', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED'],
  READY: ['OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED'],
  OUT_FOR_DELIVERY: ['DELIVERED'],
  DELIVERED: ['COMPLETED'],
};

/** Options that accept the order straight away (money collected later, then verified). */
const COLLECT_LATER: PaymentOption[] = [PaymentOption.PAY_ON_DELIVERY, PaymentOption.PAY_AT_LOCATION];

@Injectable()
export class OrdersService implements OnModuleInit, PayableHandler {
  readonly purpose = PaymentPurpose.ORDER;
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly divisions: DivisionsService,
    private readonly inventory: InventoryService,
    private readonly delivery: DeliveryService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly payables: PayableRegistry,
    private readonly policies: PaymentPolicyService,
  ) {}

  onModuleInit(): void {
    this.payables.register(this);
  }

  // ---------------------------------------------------------------------------
  // Customer
  // ---------------------------------------------------------------------------

  /** Payment options for the current cart, before placing the order. */
  async checkoutOptions(user: AuthUser, division: string, fulfilmentType: FulfilmentType, addressId?: string) {
    const d = await this.divisions.resolve(division);
    const cart = await this.prisma.cart.findUnique({
      where: { userId_divisionId: { userId: user.id, divisionId: d.id } },
      include: { items: { include: { variant: true } } },
    });
    const subtotal = sumMinor((cart?.items ?? []).map((i) => multiplyMinor(i.variant.unitPriceMinor ?? 0n, i.quantity)));
    let zoneId: string | null = null;
    let fee = 0n;
    if (fulfilmentType === FulfilmentType.DELIVERY && addressId) {
      const address = await this.prisma.address.findFirst({ where: { id: addressId, userId: user.id, deletedAt: null } });
      if (!address) throw new NotFoundException('Delivery address not found');
      const q = await this.delivery.quote(d.id, address, subtotal);
      zoneId = q.zoneId;
      fee = q.feeMinor;
    }
    const options = await this.policies.orderOptions(d.id, { fulfilment: fulfilmentType, zoneId, orderValueMinor: subtotal + fee });
    return { division: d.slug, fulfilmentType, orderValueMinor: subtotal + fee, options };
  }

  /**
   * Converts the customer's cart into an order. Prices come only from the
   * database; stock is reserved atomically in the same transaction.
   */
  async checkout(user: AuthUser, input: CheckoutInput, idempotencyKey?: string) {
    if (idempotencyKey) {
      const existing = await this.prisma.order.findUnique({ where: { userId_idempotencyKey: { userId: user.id, idempotencyKey } } });
      if (existing) return this.getForCustomer(user, existing.id);
    }
    const paymentOption = input.paymentOption ?? PaymentOption.PAYSTACK;

    const division = await this.divisions.resolve(input.division);
    const cart = await this.prisma.cart.findUnique({
      where: { userId_divisionId: { userId: user.id, divisionId: division.id } },
      include: { items: { include: { variant: { include: { product: true } } } } },
    });
    if (!cart || cart.items.length === 0) throw new BadRequestException('Your cart is empty');

    for (const item of cart.items) {
      const v = item.variant;
      if (!v.isActive || v.product.status !== ProductStatus.ACTIVE || v.product.divisionId !== division.id) {
        throw new ConflictException(`${v.product.name} (${v.name}) is no longer available`);
      }
      if (v.product.verification !== RecordVerification.VERIFIED) {
        throw new ConflictException(`${v.product.name} is awaiting confirmation by Nimpat and cannot be sold yet`);
      }
      const blocked = purchaseBlock(v.product, v);
      if (blocked) throw new ConflictException(`${v.product.name}: ${blocked}`);
      if (item.quantity < v.minOrderQty || (v.maxOrderQty && item.quantity > v.maxOrderQty)) {
        throw new BadRequestException(`Invalid quantity for ${v.product.name} (${v.name})`);
      }
      if (input.fulfilmentType === FulfilmentType.DELIVERY && !v.product.isDeliverable) {
        throw new BadRequestException(`${v.product.name} is available for pickup only`);
      }
    }

    const lines = cart.items.map((i) => ({
      variantId: i.variantId,
      productName: i.variant.product.name,
      variantName: i.variant.name,
      sku: i.variant.sku,
      unitPriceMinor: i.variant.unitPriceMinor as bigint,
      quantity: i.quantity,
      lineTotalMinor: multiplyMinor(i.variant.unitPriceMinor as bigint, i.quantity),
    }));
    const subtotalMinor = sumMinor(lines.map((l) => l.lineTotalMinor));

    let address: Awaited<ReturnType<PrismaService['address']['findFirst']>> = null;
    let deliveryFeeMinor = 0n;
    let zoneId: string | null = null;
    if (input.fulfilmentType === FulfilmentType.DELIVERY) {
      if (!input.addressId) throw new BadRequestException('addressId is required for delivery');
      address = await this.prisma.address.findFirst({ where: { id: input.addressId, userId: user.id, deletedAt: null } });
      if (!address) throw new NotFoundException('Delivery address not found');
      const q = await this.delivery.quote(division.id, address, subtotalMinor);
      deliveryFeeMinor = q.feeMinor;
      zoneId = q.zoneId;
    }
    const totalMinor = subtotalMinor + deliveryFeeMinor;
    if (input.expectedTotalMinor !== undefined && BigInt(input.expectedTotalMinor) !== totalMinor) {
      throw new ConflictException({ statusCode: 409, error: 'Conflict', message: 'Prices or delivery charges have changed. Please review your cart.', totalMinor });
    }

    // Payment option must be allowed for this division, area and order value.
    const options = await this.policies.orderOptions(division.id, { fulfilment: input.fulfilmentType, zoneId, orderValueMinor: totalMinor });
    this.policies.assertOrderOption(options, paymentOption);
    const policy = await this.policies.get(division.id, PaymentPurpose.ORDER);

    const collectLater = COLLECT_LATER.includes(paymentOption);
    const ttlMinutes = paymentOption === PaymentOption.BANK_TRANSFER ? policy.bankTransferWindowHours * 60 : this.config.get('ORDER_PAYMENT_TTL_MINUTES');
    const locationId = await this.inventory.defaultLocationId(division.id);
    const initialStatus = collectLater ? OrderStatus.ACCEPTED : OrderStatus.PENDING;

    const order = await withUniqueRetry(() =>
      this.prisma.$transaction(async (tx) => {
        const created = await tx.order.create({
          data: {
            orderNumber: businessNumber(division.code),
            userId: user.id,
            divisionId: division.id,
            status: initialStatus,
            paymentOption,
            paymentStatus: PayableState.UNPAID,
            fulfilmentType: input.fulfilmentType,
            subtotalMinor,
            deliveryFeeMinor,
            totalMinor,
            addressId: address?.id,
            deliveryAddress: address ? snapshotAddress(address) : undefined,
            stockLocationId: locationId,
            customerNote: input.customerNote,
            idempotencyKey,
            // Pay-later orders are accepted and do not expire; others must be paid in time.
            expiresAt: collectLater ? null : addMinutes(new Date(), ttlMinutes),
            items: { create: lines },
            statusHistory: {
              create: [
                { toStatus: OrderStatus.PENDING, actorId: user.id, note: `Order placed (${paymentOption.replace(/_/g, ' ').toLowerCase()})` },
                ...(collectLater ? [{ fromStatus: OrderStatus.PENDING, toStatus: OrderStatus.ACCEPTED, note: 'Accepted for payment on collection' }] : []),
              ],
            },
            delivery:
              input.fulfilmentType === FulfilmentType.DELIVERY
                ? { create: { zoneId, feeMinor: deliveryFeeMinor, trackingCode: randomTrackingCode() } }
                : undefined,
          },
        });
        await this.inventory.reserve(tx, locationId, lines, created.id);
        // Accepted orders hold their goods: convert the reservation into a sale now.
        if (collectLater) await this.inventory.commit(tx, locationId, lines, created.id);
        await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
        await tx.cart.update({ where: { id: cart.id }, data: { status: 'CONVERTED' } });
        return created;
      }),
    ).catch((e) => {
      if (e instanceof InsufficientStockException) throw e;
      if (e?.code === 'P2002' && idempotencyKey) throw new ConflictException('A checkout with this Idempotency-Key is already in progress');
      throw e;
    });

    await this.audit.record({ actorId: user.id, action: 'order.create', entityType: 'order', entityId: order.id, divisionId: division.id, changes: { totalMinor, paymentOption } });
    return this.getForCustomer(user, order.id);
  }

  async listForCustomer(user: AuthUser, q: PaginationQueryDto & { status?: OrderStatus; division?: string }) {
    const where: Prisma.OrderWhereInput = { userId: user.id, status: q.status };
    if (q.division) where.divisionId = (await this.divisions.resolve(q.division)).id;
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...pageArgs(q),
        include: { items: true, division: orderInclude.division, delivery: { select: { status: true, trackingCode: true } } },
      }),
      this.prisma.order.count({ where }),
    ]);
    return paginate(rows.map(withOutstanding), total, q);
  }

  async getForCustomer(user: AuthUser, id: string) {
    const order = await this.prisma.order.findFirst({ where: { id, userId: user.id }, include: orderInclude });
    if (!order) throw new NotFoundException('Order not found');
    return withOutstanding(order);
  }

  async cancelByCustomer(user: AuthUser, id: string) {
    const order = await this.prisma.order.findFirst({ where: { id, userId: user.id } });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status !== OrderStatus.PENDING || order.amountPaidMinor > 0n) {
      throw new BadRequestException('Only unpaid pending orders can be cancelled here. Contact support for other orders.');
    }
    const awaiting = await this.prisma.payment.count({ where: { orderId: id, status: PaymentStatus.AWAITING_VERIFICATION } });
    if (awaiting) throw new BadRequestException('A payment for this order is awaiting verification. Please contact support.');
    await this.releaseUnpaid(order.id, OrderStatus.CANCELLED, user.id, 'Cancelled by customer');
    return this.getForCustomer(user, id);
  }

  // ---------------------------------------------------------------------------
  // Admin
  // ---------------------------------------------------------------------------

  async adminList(user: AuthUser, q: PaginationQueryDto & { status?: OrderStatus; division?: string; q?: string; paymentStatus?: PayableState; paymentOption?: PaymentOption }) {
    const where: Prisma.OrderWhereInput = { status: q.status, paymentStatus: q.paymentStatus, paymentOption: q.paymentOption };
    const allowed = user.divisionFilter(P.ordersRead);
    if (q.division) {
      const d = await this.divisions.resolve(q.division);
      user.assertCan(P.ordersRead, d.id);
      where.divisionId = d.id;
    } else if (allowed) {
      where.divisionId = { in: allowed };
    }
    if (q.q) where.OR = [{ orderNumber: { contains: q.q.toUpperCase() } }, { user: { email: { contains: q.q.toLowerCase() } } }];
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...pageArgs(q),
        include: { user: { select: { id: true, email: true, phone: true } }, delivery: { select: { status: true } }, _count: { select: { items: true } } },
      }),
      this.prisma.order.count({ where }),
    ]);
    return paginate(rows.map(withOutstanding), total, q);
  }

  async adminGet(user: AuthUser, id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        ...orderInclude,
        statusHistory: { orderBy: { createdAt: 'asc' } },
        user: { select: { id: true, email: true, phone: true, customerProfile: { select: { firstName: true, lastName: true } } } },
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    user.assertCan(P.ordersRead, order.divisionId);
    return withOutstanding(order);
  }

  async adminUpdateStatus(user: AuthUser, id: string, to: OrderStatus, note?: string) {
    const order = await this.prisma.order.findUnique({ where: { id }, include: { items: true } });
    if (!order) throw new NotFoundException('Order not found');
    user.assertCan(P.ordersManage, order.divisionId);
    if (!ADMIN_TRANSITIONS[order.status]?.includes(to)) {
      throw new BadRequestException(`Cannot change an order from ${order.status} to ${to}`);
    }
    if (to === OrderStatus.COMPLETED && order.paymentStatus !== PayableState.PAID) {
      throw new BadRequestException('An order can only be completed once its payment is verified as paid in full');
    }

    if (order.status === OrderStatus.PENDING && to === OrderStatus.CANCELLED) {
      if (!(await this.releaseUnpaid(order.id, OrderStatus.CANCELLED, user.id, note ?? 'Cancelled by staff'))) {
        throw new ConflictException('Order was updated by someone else; reload and retry');
      }
    } else {
      await this.prisma.$transaction(async (tx) => {
        const res = await tx.order.updateMany({
          where: { id, status: order.status },
          data: { status: to, cancelledAt: to === OrderStatus.CANCELLED ? new Date() : undefined },
        });
        if (res.count !== 1) throw new ConflictException('Order was updated by someone else; reload and retry');
        if (to === OrderStatus.CANCELLED && order.stockLocationId) {
          // Accepted but not delivered: return the goods to stock. Any refund is a separate, explicit finance action.
          await this.inventory.restock(tx, order.stockLocationId, order.items, order.id, user.id);
          await tx.delivery.updateMany({ where: { orderId: id }, data: { status: 'CANCELLED' } });
        }
        await tx.orderStatusHistory.create({ data: { orderId: id, fromStatus: order.status, toStatus: to, actorId: user.id, note } });
        await this.audit.record({ actorId: user.id, action: 'order.status', entityType: 'order', entityId: id, divisionId: order.divisionId, changes: { from: order.status, to, note } }, tx);
      });
    }

    await this.notifications.notify({
      userId: order.userId,
      type: `order.${to.toLowerCase()}`,
      title: `Order ${order.orderNumber}: ${to.replace(/_/g, ' ').toLowerCase()}`,
      body:
        to === OrderStatus.CANCELLED && order.amountPaidMinor > 0n
          ? `Your order ${order.orderNumber} was cancelled. The amount you paid will be refunded to you.`
          : `Your order ${order.orderNumber} is now ${to.replace(/_/g, ' ').toLowerCase()}.`,
      data: { orderId: id },
      email: true,
    });
    return this.adminGet(user, id);
  }

  // ---------------------------------------------------------------------------
  // Jobs
  // ---------------------------------------------------------------------------

  /** Expires unpaid PENDING orders past their payment window and frees their stock. */
  async expireStale(limit = 200): Promise<number> {
    const stale = await this.prisma.order.findMany({
      where: { status: OrderStatus.PENDING, expiresAt: { lt: new Date() }, amountPaidMinor: 0n },
      select: { id: true },
      take: limit,
    });
    let expired = 0;
    for (const o of stale) {
      // Never expire an order whose payment is being confirmed.
      const busy = await this.prisma.payment.count({ where: { orderId: o.id, status: { in: [PaymentStatus.SUCCESS, PaymentStatus.AWAITING_VERIFICATION] } } });
      if (busy) continue;
      if (await this.releaseUnpaid(o.id, OrderStatus.EXPIRED, null, 'Payment window elapsed')) expired++;
    }
    return expired;
  }

  // ---------------------------------------------------------------------------
  // PayableHandler
  // ---------------------------------------------------------------------------

  async resolve(orderId: string, user: AuthUser): Promise<PayableContext> {
    const order = await this.prisma.order.findFirst({ where: { id: orderId, userId: user.id } });
    if (!order) throw new NotFoundException('Order not found');
    return this.context(order);
  }

  async load(db: Tx | PrismaService, orderId: string): Promise<PayableContext> {
    const order = await db.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');
    return this.context(order);
  }

  private context(order: Prisma.OrderGetPayload<object>): PayableContext {
    let acceptsPayments = true;
    let closedReason: string | undefined;
    if (order.status === OrderStatus.CANCELLED || order.status === OrderStatus.EXPIRED) {
      acceptsPayments = false;
      closedReason = `Order is ${order.status.toLowerCase()}`;
    } else if (order.status === OrderStatus.PENDING && order.expiresAt && order.expiresAt < new Date()) {
      acceptsPayments = false;
      closedReason = 'The payment window for this order has closed';
    }
    return {
      totalDueMinor: order.totalMinor,
      depositRequiredMinor: 0n,
      currency: order.currency,
      divisionId: order.divisionId,
      userId: order.userId,
      label: order.orderNumber,
      description: `Order ${order.orderNumber}`,
      payBy: order.status === OrderStatus.PENDING ? order.expiresAt : null,
      acceptsPayments,
      closedReason,
      delivery: { fulfilment: order.fulfilmentType, zoneId: null, orderValueMinor: order.totalMinor },
    };
  }

  async onBankTransferStarted(tx: Tx, orderId: string, payBy: Date): Promise<void> {
    // Keep the stock reserved while the transfer is pending verification.
    await tx.order.updateMany({ where: { id: orderId, status: OrderStatus.PENDING, OR: [{ expiresAt: null }, { expiresAt: { lt: payBy } }] }, data: { expiresAt: payBy } });
  }

  /** Orders are accepted (and stock committed) only once fully paid and verified. */
  async onPaymentStateChanged(tx: Tx, orderId: string, summary: PaymentSummary, trigger: Payment): Promise<NotifyInput[]> {
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
    const lines: StockLine[] = order.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity }));
    const notes: NotifyInput[] = [];
    if (trigger.status !== PaymentStatus.SUCCESS) {
      if (trigger.status === PaymentStatus.REVERSED) {
        notes.push({ userId: order.userId, type: 'order.payment_reversed', title: `Payment reversed on ${order.orderNumber}`, body: `${formatNgn(summary.outstandingMinor)} is now outstanding on order ${order.orderNumber}.`, data: { orderId } });
      }
      return notes;
    }
    if (!summary.fullyPaid) {
      notes.push({ userId: order.userId, type: 'order.part_payment', title: `Payment received for ${order.orderNumber}`, body: `We confirmed ${formatNgn(trigger.amountMinor)}. ${formatNgn(summary.outstandingMinor)} is still outstanding.`, data: { orderId } });
      return notes;
    }

    if (order.status === OrderStatus.PENDING) {
      const res = await tx.order.updateMany({ where: { id: order.id, status: OrderStatus.PENDING }, data: { status: OrderStatus.ACCEPTED, paidAt: new Date() } });
      if (res.count === 1) {
        await this.inventory.commit(tx, order.stockLocationId!, lines, order.id);
        await tx.orderStatusHistory.create({ data: { orderId: order.id, fromStatus: OrderStatus.PENDING, toStatus: OrderStatus.ACCEPTED, note: `Payment ${trigger.reference} verified` } });
      }
    } else if (order.status === OrderStatus.EXPIRED || order.status === OrderStatus.CANCELLED) {
      // Customer paid after the window closed. Try to re-reserve; otherwise flag for refund.
      try {
        await tx.$executeRaw`SAVEPOINT late_payment`;
        await this.inventory.reserve(tx, order.stockLocationId!, lines, order.id);
        await this.inventory.commit(tx, order.stockLocationId!, lines, order.id);
        await tx.order.update({ where: { id: order.id }, data: { status: OrderStatus.ACCEPTED, paidAt: new Date(), cancelledAt: null } });
        await tx.orderStatusHistory.create({ data: { orderId: order.id, fromStatus: order.status, toStatus: OrderStatus.ACCEPTED, note: `Late payment ${trigger.reference} accepted; stock re-reserved` } });
        await tx.$executeRaw`RELEASE SAVEPOINT late_payment`;
      } catch {
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT late_payment`;
        this.logger.warn(`Late payment ${trigger.reference} for ${order.orderNumber}: stock unavailable, refund required`);
        await tx.payment.update({ where: { id: trigger.id }, data: { refundStatus: 'PENDING', failureReason: 'Paid after order expiry; stock unavailable — refund required' } });
        await this.audit.record({ action: 'order.late_payment.refund_required', entityType: 'order', entityId: order.id, divisionId: order.divisionId, changes: { reference: trigger.reference } }, tx);
        return [{
          userId: order.userId,
          type: 'order.payment_after_expiry',
          title: `We received your payment for ${order.orderNumber}`,
          body: `Your order had expired and some items are no longer available. A refund of ${formatNgn(trigger.amountMinor)} will be processed.`,
          data: { orderId: order.id },
          email: true,
        }];
      }
    } else {
      // Already accepted (e.g. pay on delivery) — record when it became fully paid.
      if (!order.paidAt) await tx.order.update({ where: { id: order.id }, data: { paidAt: new Date() } });
    }

    notes.push({
      userId: order.userId,
      type: 'order.paid',
      title: `Payment received for ${order.orderNumber}`,
      body: `Thank you! Order ${order.orderNumber} is paid in full (${formatNgn(summary.paidMinor)}).`,
      data: { orderId: order.id },
      email: true,
    });
    return notes;
  }

  // ---------------------------------------------------------------------------

  /** Moves an unpaid PENDING order to CANCELLED/EXPIRED and releases its reservation, exactly once. */
  private async releaseUnpaid(orderId: string, to: OrderStatus, actorId: string | null, note: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
      const res = await tx.order.updateMany({
        where: { id: orderId, status: OrderStatus.PENDING, amountPaidMinor: 0n },
        data: { status: to, cancelledAt: new Date() },
      });
      if (res.count !== 1) return false;
      if (order.stockLocationId) {
        await this.inventory.release(tx, order.stockLocationId, order.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })), orderId);
      }
      await tx.delivery.updateMany({ where: { orderId }, data: { status: 'CANCELLED' } });
      await tx.orderStatusHistory.create({ data: { orderId, fromStatus: OrderStatus.PENDING, toStatus: to, actorId, note } });
      await tx.payment.updateMany({ where: { orderId, status: { in: ['INITIALIZED', 'PENDING'] } }, data: { status: 'ABANDONED' } });
      return true;
    });
  }
}

/** Adds the computed outstanding balance to an order for API responses. */
function withOutstanding<T extends { totalMinor: bigint; amountPaidMinor: bigint }>(o: T): T & { outstandingMinor: bigint } {
  return { ...o, outstandingMinor: o.totalMinor - o.amountPaidMinor };
}

function snapshotAddress(a: NonNullable<Awaited<ReturnType<PrismaService['address']['findFirst']>>>): Prisma.InputJsonValue {
  return {
    recipientName: a.recipientName,
    phone: a.phone,
    line1: a.line1,
    line2: a.line2,
    landmark: a.landmark,
    city: a.city,
    lga: a.lga,
    state: a.state,
    country: a.country,
    latitude: a.latitude,
    longitude: a.longitude,
  };
}
