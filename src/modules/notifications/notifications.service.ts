import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { NotificationChannel, NotificationStatus, Prisma } from '@prisma/client';
import { PaginationQueryDto, pageArgs, paginate } from '../../common/dto/pagination.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from './mail.service';
import { PushService } from './push.service';

export interface NotifyInput {
  userId: string;
  type: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  email?: boolean;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly push: PushService,
  ) {}

  /**
   * Creates an in-app notification, sends it to the customer's phones, and optionally emails them.
   * Delivery failures are recorded, never thrown to the caller.
   */
  async notify(input: NotifyInput): Promise<void> {
    try {
      await this.prisma.notification.create({
        data: {
          userId: input.userId,
          channel: NotificationChannel.IN_APP,
          type: input.type,
          title: input.title,
          body: input.body,
          data: (input.data ?? undefined) as Prisma.InputJsonValue | undefined,
          status: NotificationStatus.SENT,
          sentAt: new Date(),
        },
      });
      await this.push.sendToUser(input.userId, input.title, input.body, input.data);
      if (input.email) {
        const user = await this.prisma.user.findUnique({ where: { id: input.userId }, select: { email: true, isGuest: true, contactEmail: true } });
        const to = user?.isGuest ? user.contactEmail : user?.email;
        if (to) await this.sendEmailRecorded(input, to);
      }
    } catch (e) {
      this.logger.error(`notify(${input.type}) failed: ${(e as Error).message}`);
    }
  }

  private async sendEmailRecorded(input: NotifyInput, to: string): Promise<void> {
    const record = await this.prisma.notification.create({
      data: { userId: input.userId, channel: NotificationChannel.EMAIL, type: input.type, title: input.title, body: input.body },
    });
    try {
      await this.mail.send({ to, subject: input.title, text: input.body });
      await this.prisma.notification.update({ where: { id: record.id }, data: { status: 'SENT', sentAt: new Date() } });
    } catch (e) {
      await this.prisma.notification.update({ where: { id: record.id }, data: { status: 'FAILED' } });
      this.logger.warn(`Email for ${input.type} failed: ${(e as Error).message}`);
    }
  }

  async listForUser(userId: string, q: PaginationQueryDto & { unreadOnly?: boolean }) {
    const where: Prisma.NotificationWhereInput = {
      userId,
      channel: NotificationChannel.IN_APP,
      readAt: q.unreadOnly ? null : undefined,
    };
    const [rows, total, unread] = await this.prisma.$transaction([
      this.prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, ...pageArgs(q) }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { userId, channel: NotificationChannel.IN_APP, readAt: null } }),
    ]);
    return { ...paginate(rows, total, q), unreadCount: unread };
  }

  async markRead(userId: string, id: string) {
    const res = await this.prisma.notification.updateMany({ where: { id, userId, readAt: null }, data: { readAt: new Date() } });
    if (res.count === 0) {
      const exists = await this.prisma.notification.count({ where: { id, userId } });
      if (!exists) throw new NotFoundException('Notification not found');
    }
    return { ok: true };
  }

  async markAllRead(userId: string) {
    const res = await this.prisma.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
    return { updated: res.count };
  }
}
