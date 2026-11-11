import { BadRequestException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { DeliveryStatus, DeliveryZone, Prisma } from '@prisma/client';
import { pageArgs, paginate, PaginationQueryDto } from '../../common/dto/pagination.dto';
import { PrismaService, Tx } from '../../prisma/prisma.service';
import { AuthUser } from '../access/auth-user';
import { P } from '../access/permissions';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ABUJA_AREAS, ABUJA_FALLBACK_FEE, ABUJA_RINGS } from './abuja-areas';

export interface DeliveryQuote {
  zoneId: string;
  zoneName: string;
  feeMinor: bigint;
  standardFeeMinor: bigint;
  freeAboveMinor: bigint | null;
  estimatedHours: number | null;
  bulkFeeMinor: bigint | null;
  bulkFromQty: number | null;
}

const norm = (s: string) => s.trim().toLowerCase();

/** Allowed delivery state transitions. */
const DELIVERY_TRANSITIONS: Record<DeliveryStatus, DeliveryStatus[]> = {
  PENDING: ['SCHEDULED', 'DISPATCHED', 'CANCELLED'],
  SCHEDULED: ['DISPATCHED', 'CANCELLED'],
  DISPATCHED: ['DELIVERED', 'FAILED'],
  FAILED: ['SCHEDULED', 'DISPATCHED', 'RETURNED'],
  DELIVERED: [],
  RETURNED: [],
  CANCELLED: [],
};

@Injectable()
export class DeliveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Server-side delivery charge. City-specific zones win over state-wide
   * zones; orders above a zone's threshold ship free; a zone can charge a
   * different fee from a number of items (larger orders).
   */
  async quote(divisionId: string, address: { state: string; city: string }, subtotalMinor: bigint, quantity = 0, db: Tx | PrismaService = this.prisma): Promise<DeliveryQuote> {
    // Only company-confirmed fees are ever charged.
    const zones = await db.deliveryZone.findMany({ where: { divisionId, isActive: true, verification: 'VERIFIED' } });
    const state = norm(address.state);
    const city = norm(address.city);
    const inState = zones.filter((z) => norm(z.state) === state);
    const zone: DeliveryZone | undefined =
      inState.find((z) => z.cities.map(norm).includes(city)) ?? inState.find((z) => z.cities.length === 0);
    if (!zone) throw new UnprocessableEntityException(`Delivery is not yet available to ${address.city}, ${address.state}`);
    const free = zone.freeAboveMinor !== null && subtotalMinor >= zone.freeAboveMinor;
    const bulk = zone.bulkFeeMinor !== null && zone.bulkFromQty !== null && quantity >= zone.bulkFromQty;
    const fee = bulk ? zone.bulkFeeMinor! : zone.feeMinor;
    return {
      zoneId: zone.id,
      zoneName: zone.name,
      feeMinor: free ? 0n : fee,
      standardFeeMinor: zone.feeMinor,
      freeAboveMinor: zone.freeAboveMinor,
      estimatedHours: zone.estimatedHours,
      bulkFeeMinor: zone.bulkFeeMinor,
      bulkFromQty: zone.bulkFromQty,
    };
  }

  /** Abuja areas for the address form, each with this shop's fee (null when not yet set). */
  async abujaAreas(divisionId: string) {
    const zones = (await this.prisma.deliveryZone.findMany({ where: { divisionId, isActive: true, verification: 'VERIFIED' } })).filter((z) => norm(z.state) === 'fct');
    const fallback = zones.find((z) => z.cities.length === 0);
    return ABUJA_AREAS.map(({ area, ring }) => {
      const zone = zones.find((z) => z.cities.map(norm).includes(norm(area))) ?? fallback;
      return { area, ring, feeMinor: zone ? zone.feeMinor : null, bulkFeeMinor: zone?.bulkFeeMinor ?? null, bulkFromQty: zone?.bulkFromQty ?? null };
    });
  }

  /**
   * Sets this shop's Abuja fees in rings around Wuye: one zone per ring, confirmed by the
   * person who presses the button. Abuja addresses outside the list pay the outer-ring fee.
   * Running it again puts the standard rings back.
   */
  async setupAbujaRings(user: AuthUser, divisionId: string) {
    user.assertCan(P.deliveriesManage, divisionId);
    const now = new Date();
    const existing = await this.prisma.deliveryZone.findMany({ where: { divisionId } });
    const wide = existing.filter((z) => norm(z.state) === 'fct' && z.cities.length === 0);
    const payOnDelivery = wide.some((z) => z.payOnDeliveryEnabled);
    const confirmed = { verification: 'VERIFIED' as const, verifiedAt: now, verifiedById: user.id, isActive: true };
    await this.prisma.$transaction(async (tx) => {
      for (const ring of ABUJA_RINGS) {
        const data = { state: 'FCT', cities: ring.areas.map(norm), feeMinor: ring.feeMinor, bulkFeeMinor: ring.bulk?.feeMinor ?? null, bulkFromQty: ring.bulk?.fromQty ?? null, freeAboveMinor: null, payOnDeliveryEnabled: payOnDelivery, ...confirmed };
        await tx.deliveryZone.upsert({ where: { divisionId_name: { divisionId, name: ring.name } }, create: { divisionId, name: ring.name, ...data }, update: data });
      }
      const current = new Set(ABUJA_RINGS.map((r) => r.name));
      const retired = existing.filter((z) => z.name.startsWith('Abuja: ') && z.cities.length > 0 && !current.has(z.name)).map((z) => z.id);
      if (retired.length) await tx.deliveryZone.updateMany({ where: { id: { in: retired } }, data: { isActive: false } });
      if (wide.length) await tx.deliveryZone.updateMany({ where: { id: { in: wide.map((z) => z.id) } }, data: { feeMinor: ABUJA_FALLBACK_FEE, freeAboveMinor: null, ...confirmed } });
      else await tx.deliveryZone.create({ data: { divisionId, name: 'Abuja: other areas', state: 'FCT', cities: [], feeMinor: ABUJA_FALLBACK_FEE, payOnDeliveryEnabled: payOnDelivery, ...confirmed } });
      await this.audit.record(
        { actorId: user.id, action: 'delivery_zone.abuja_rings', entityType: 'division', entityId: divisionId, divisionId, changes: { rings: ABUJA_RINGS.map((r) => ({ name: r.name, feeMinor: String(r.feeMinor), bulk: r.bulk ? { feeMinor: String(r.bulk.feeMinor), fromQty: r.bulk.fromQty } : null, areas: r.areas.length })), retired: retired.length, otherAreasFeeMinor: String(ABUJA_FALLBACK_FEE) } },
        tx,
      );
    });
    return this.listZones(divisionId, true);
  }

  listZones(divisionId: string, includeInactive = false) {
    return this.prisma.deliveryZone.findMany({
      where: { divisionId, isActive: includeInactive ? undefined : true, verification: includeInactive ? undefined : 'VERIFIED' },
      orderBy: [{ state: 'asc' }, { name: 'asc' }],
    });
  }

  async createZone(user: AuthUser, divisionId: string, data: Omit<Prisma.DeliveryZoneUncheckedCreateInput, 'divisionId'>) {
    user.assertCan(P.deliveriesManage, divisionId);
    const zone = await this.prisma.deliveryZone.create({
      data: { ...data, divisionId, cities: (data.cities as string[] | undefined)?.map(norm) ?? [] },
    });
    await this.audit.record({ actorId: user.id, action: 'delivery_zone.create', entityType: 'delivery_zone', entityId: zone.id, divisionId, changes: { ...data } });
    return zone;
  }

  async updateZone(user: AuthUser, id: string, data: Prisma.DeliveryZoneUpdateInput & { cities?: string[] }) {
    const zone = await this.prisma.deliveryZone.findUnique({ where: { id } });
    if (!zone) throw new NotFoundException('Delivery zone not found');
    user.assertCan(P.deliveriesManage, zone.divisionId);
    const updated = await this.prisma.deliveryZone.update({
      where: { id },
      data: { ...data, cities: data.cities ? data.cities.map(norm) : undefined },
    });
    await this.audit.record({
      actorId: user.id, action: 'delivery_zone.update', entityType: 'delivery_zone', entityId: id, divisionId: zone.divisionId,
      changes: { before: { feeMinor: zone.feeMinor, freeAboveMinor: zone.freeAboveMinor }, after: { ...data } },
    });
    return updated;
  }

  async listDeliveries(user: AuthUser, q: PaginationQueryDto & { status?: DeliveryStatus; divisionId?: string }) {
    const allowed = user.divisionFilter(P.deliveriesManage);
    if (q.divisionId) user.assertCan(P.deliveriesManage, q.divisionId);
    const where: Prisma.DeliveryWhereInput = {
      status: q.status,
      order: { divisionId: q.divisionId ?? (allowed ? { in: allowed } : undefined) },
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.delivery.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...pageArgs(q),
        include: {
          order: { select: { id: true, orderNumber: true, status: true, deliveryAddress: true, totalMinor: true, divisionId: true } },
          assignedTo: { select: { id: true, email: true, staffProfile: { select: { firstName: true, lastName: true } } } },
          zone: { select: { name: true } },
        },
      }),
      this.prisma.delivery.count({ where }),
    ]);
    return paginate(rows, total, q);
  }

  /** Updates a delivery and keeps the order status in step with it. */
  async updateDelivery(
    user: AuthUser,
    id: string,
    dto: { status?: DeliveryStatus; assignedToId?: string; scheduledFor?: string; failureReason?: string },
  ) {
    const delivery = await this.prisma.delivery.findUnique({ where: { id }, include: { order: true } });
    if (!delivery) throw new NotFoundException('Delivery not found');
    user.assertCan(P.deliveriesManage, delivery.order.divisionId);
    if (!['ACCEPTED', 'PROCESSING', 'READY', 'OUT_FOR_DELIVERY', 'DELIVERED'].includes(delivery.order.status)) {
      throw new BadRequestException(`Order ${delivery.order.orderNumber} is ${delivery.order.status}; it cannot be dispatched`);
    }
    if (dto.status && dto.status !== delivery.status && !DELIVERY_TRANSITIONS[delivery.status].includes(dto.status)) {
      throw new BadRequestException(`Cannot move delivery from ${delivery.status} to ${dto.status}`);
    }
    if (dto.assignedToId) {
      const staff = await this.prisma.user.findFirst({ where: { id: dto.assignedToId, type: 'STAFF', status: 'ACTIVE' } });
      if (!staff) throw new BadRequestException('Assignee must be an active staff member');
    }

    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.delivery.update({
        where: { id },
        data: {
          status: dto.status,
          assignedToId: dto.assignedToId,
          scheduledFor: dto.scheduledFor ? new Date(dto.scheduledFor) : undefined,
          failureReason: dto.failureReason,
          dispatchedAt: dto.status === 'DISPATCHED' ? now : undefined,
          deliveredAt: dto.status === 'DELIVERED' ? now : undefined,
        },
      });
      const orderStatus =
        dto.status === 'DISPATCHED' ? 'OUT_FOR_DELIVERY' : dto.status === 'DELIVERED' ? 'DELIVERED' : dto.status === 'SCHEDULED' && delivery.order.status === 'ACCEPTED' ? 'PROCESSING' : undefined;
      if (orderStatus && orderStatus !== delivery.order.status) {
        await tx.order.update({ where: { id: delivery.orderId }, data: { status: orderStatus } });
        await tx.orderStatusHistory.create({
          data: { orderId: delivery.orderId, fromStatus: delivery.order.status, toStatus: orderStatus, actorId: user.id, note: `Delivery ${dto.status}` },
        });
      }
      await this.audit.record(
        { actorId: user.id, action: 'delivery.update', entityType: 'delivery', entityId: id, divisionId: delivery.order.divisionId, changes: { ...dto } },
        tx,
      );
      return updated;
    });

    if (dto.status === 'DISPATCHED' || dto.status === 'DELIVERED') {
      await this.notifications.notify({
        userId: delivery.order.userId,
        type: `order.${dto.status.toLowerCase()}`,
        title: dto.status === 'DISPATCHED' ? 'Your order is on the way' : 'Your order has been delivered',
        body: `Order ${delivery.order.orderNumber} — tracking code ${delivery.trackingCode}.`,
        data: { orderId: delivery.orderId },
        email: true,
      });
    }
    return result;
  }
}
