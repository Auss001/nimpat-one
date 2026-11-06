import { BadRequestException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { DeliveryStatus, DeliveryZone, Prisma } from '@prisma/client';
import { pageArgs, paginate, PaginationQueryDto } from '../../common/dto/pagination.dto';
import { PrismaService, Tx } from '../../prisma/prisma.service';
import { AuthUser } from '../access/auth-user';
import { P } from '../access/permissions';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';

export interface DeliveryQuote {
  zoneId: string;
  zoneName: string;
  feeMinor: bigint;
  standardFeeMinor: bigint;
  freeAboveMinor: bigint | null;
  estimatedHours: number | null;
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
   * zones; orders above a zone's threshold ship free.
   */
  async quote(divisionId: string, address: { state: string; city: string }, subtotalMinor: bigint, db: Tx | PrismaService = this.prisma): Promise<DeliveryQuote> {
    // Only company-confirmed fees are ever charged.
    const zones = await db.deliveryZone.findMany({ where: { divisionId, isActive: true, verification: 'VERIFIED' } });
    const state = norm(address.state);
    const city = norm(address.city);
    const inState = zones.filter((z) => norm(z.state) === state);
    const zone: DeliveryZone | undefined =
      inState.find((z) => z.cities.map(norm).includes(city)) ?? inState.find((z) => z.cities.length === 0);
    if (!zone) throw new UnprocessableEntityException(`Delivery is not yet available to ${address.city}, ${address.state}`);
    const free = zone.freeAboveMinor !== null && subtotalMinor >= zone.freeAboveMinor;
    return {
      zoneId: zone.id,
      zoneName: zone.name,
      feeMinor: free ? 0n : zone.feeMinor,
      standardFeeMinor: zone.feeMinor,
      freeAboveMinor: zone.freeAboveMinor,
      estimatedHours: zone.estimatedHours,
    };
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
