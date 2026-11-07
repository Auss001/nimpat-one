import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { LoyaltyTxType, Payment } from '@prisma/client';
import { pageArgs, paginate, PaginationQueryDto } from '../../common/dto/pagination.dto';
import { PrismaService, Tx } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

/**
 * Green Wallet — loyalty POINTS only. It is not a stored-value wallet and
 * points have no cash value in this API.
 *
 * Earning: rule.pointsPer100NgnX100 hundredths of a point per ₦100
 * (10,000 kobo) paid, rounded down. Earning and reversals are keyed by
 * source so retries never double-award.
 */
@Injectable()
export class LoyaltyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  static pointsFor(amountMinor: bigint, ratePer100NgnX100: number): number {
    // amount/10_000 kobo per ₦100 × rate/100  → amount × rate / 1_000_000
    return Number((amountMinor * BigInt(ratePer100NgnX100)) / 1_000_000n);
  }

  async awardForPayment(tx: Tx, payment: Payment): Promise<void> {
    const rule = await tx.loyaltyRule.findUnique({ where: { divisionId: payment.divisionId } });
    if (!rule?.isActive) return;
    // Royalty points are for members only; a guest earns none.
    const payer = await tx.user.findUnique({ where: { id: payment.userId }, select: { isGuest: true } });
    if (!payer || payer.isGuest) return;
    const points = LoyaltyService.pointsFor(payment.amountMinor, rule.pointsPer100NgnX100);
    if (points <= 0) return;
    const existing = await tx.loyaltyTransaction.findFirst({ where: { type: LoyaltyTxType.EARN, sourceType: 'payment', sourceId: payment.id } });
    if (existing) return;
    const account = await tx.loyaltyAccount.upsert({ where: { userId: payment.userId }, create: { userId: payment.userId }, update: {} });
    const updated = await tx.loyaltyAccount.update({
      where: { id: account.id },
      data: { pointsBalance: { increment: points }, lifetimeEarned: { increment: points } },
    });
    await tx.loyaltyTransaction.create({
      data: {
        accountId: account.id,
        type: LoyaltyTxType.EARN,
        points,
        balanceAfter: updated.pointsBalance,
        divisionId: payment.divisionId,
        sourceType: 'payment',
        sourceId: payment.id,
        description: `Earned on payment ${payment.reference}`,
      },
    });
  }

  /** Claws back points proportionally to the refunded amount (never below zero). */
  async reverseForRefund(tx: Tx, payment: Payment, refundedMinor: bigint): Promise<void> {
    const earned = await tx.loyaltyTransaction.findFirst({ where: { type: LoyaltyTxType.EARN, sourceType: 'payment', sourceId: payment.id } });
    if (!earned) return;
    const target = Number((BigInt(earned.points) * refundedMinor) / payment.amountMinor);
    const prior = await tx.loyaltyTransaction.aggregate({
      where: { type: LoyaltyTxType.REVERSAL, sourceType: 'payment_refund', sourceId: { startsWith: `${payment.id}:` } },
      _sum: { points: true },
    });
    const alreadyReversed = -(prior._sum.points ?? 0);
    const account = await tx.loyaltyAccount.findUniqueOrThrow({ where: { id: earned.accountId } });
    const delta = Math.min(target - alreadyReversed, account.pointsBalance);
    if (delta <= 0) return;
    const updated = await tx.loyaltyAccount.update({ where: { id: account.id }, data: { pointsBalance: { decrement: delta } } });
    await tx.loyaltyTransaction.create({
      data: {
        accountId: account.id,
        type: LoyaltyTxType.REVERSAL,
        points: -delta,
        balanceAfter: updated.pointsBalance,
        divisionId: payment.divisionId,
        sourceType: 'payment_refund',
        sourceId: `${payment.id}:${refundedMinor}`,
        description: `Reversed after refund on ${payment.reference}`,
      },
    });
  }

  async summary(userId: string, q: PaginationQueryDto) {
    const account = await this.prisma.loyaltyAccount.upsert({ where: { userId }, create: { userId }, update: {} });
    const where = { accountId: account.id };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.loyaltyTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...pageArgs(q),
        include: { division: { select: { name: true, code: true } } },
      }),
      this.prisma.loyaltyTransaction.count({ where }),
    ]);
    return { account: { pointsBalance: account.pointsBalance, lifetimeEarned: account.lifetimeEarned, tier: account.tier }, history: paginate(rows, total, q) };
  }

  async rules() {
    return this.prisma.loyaltyRule.findMany({
      where: { isActive: true },
      include: { division: { select: { code: true, name: true, slug: true } } },
    });
  }

  /** Manual staff adjustment (goodwill credit / correction), always audited. */
  async adjust(actorId: string, userId: string, points: number, reason: string) {
    if (!Number.isInteger(points) || points === 0) throw new BadRequestException('points must be a non-zero integer');
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw new NotFoundException('User not found');
      const account = await tx.loyaltyAccount.upsert({ where: { userId }, create: { userId }, update: {} });
      if (account.pointsBalance + points < 0) throw new BadRequestException('Adjustment would make the balance negative');
      const updated = await tx.loyaltyAccount.update({
        where: { id: account.id },
        data: { pointsBalance: { increment: points }, lifetimeEarned: points > 0 ? { increment: points } : undefined },
      });
      const entry = await tx.loyaltyTransaction.create({
        data: { accountId: account.id, type: LoyaltyTxType.ADJUST, points, balanceAfter: updated.pointsBalance, description: reason },
      });
      await this.audit.record({ actorId, action: 'loyalty.adjust', entityType: 'loyalty_account', entityId: account.id, changes: { userId, points, reason } }, tx);
      return entry;
    });
  }
}
