import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { currentRequest } from '../../common/request-context';
import { PaginationQueryDto, pageArgs, paginate } from '../../common/dto/pagination.dto';
import { PrismaService, Tx } from '../../prisma/prisma.service';

export interface AuditEntry {
  actorId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  divisionId?: string | null;
  changes?: Record<string, unknown>;
}

const SENSITIVE_KEYS = /password|token|secret|authorization|otp|cvv|pin/i;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SENSITIVE_KEYS.test(k) ? '[REDACTED]' : redact(v)]),
    );
  }
  return typeof value === 'bigint' ? value.toString() : value;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records an audit entry. Pass `tx` to make the log part of the same
   * transaction as the change it describes.
   */
  async record(entry: AuditEntry, tx?: Tx): Promise<void> {
    const ctx = currentRequest();
    const data: Prisma.AuditLogUncheckedCreateInput = {
      actorId: entry.actorId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      divisionId: entry.divisionId ?? null,
      changes: entry.changes ? (redact(entry.changes) as Prisma.InputJsonValue) : undefined,
      ipAddress: ctx?.ip,
      userAgent: ctx?.userAgent,
      requestId: ctx?.requestId,
    };
    if (tx) {
      await tx.auditLog.create({ data });
      return;
    }
    try {
      await this.prisma.auditLog.create({ data });
    } catch (e) {
      // Never fail the user's request because an out-of-band audit write failed.
      this.logger.error(`Audit write failed for ${entry.action}: ${(e as Error).message}`);
    }
  }

  async search(
    q: PaginationQueryDto & { actorId?: string; action?: string; entityType?: string; entityId?: string },
    divisionIds: string[] | undefined,
  ) {
    const where: Prisma.AuditLogWhereInput = {
      actorId: q.actorId,
      action: q.action ? { startsWith: q.action } : undefined,
      entityType: q.entityType,
      entityId: q.entityId,
      divisionId: divisionIds ? { in: divisionIds } : undefined,
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...pageArgs(q),
        include: { actor: { select: { id: true, email: true } } },
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return paginate(rows, total, q);
  }
}
