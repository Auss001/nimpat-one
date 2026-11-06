import { Injectable } from '@nestjs/common';
import { PayableState, PaymentPurpose, PaymentStatus } from '@prisma/client';
import { PrismaService, Tx } from '../../prisma/prisma.service';
import { PAYABLE_COLUMN, PAYABLE_MODEL, PAYABLE_TABLE } from './payable.registry';

export interface PaymentSummary {
  currency: string;
  totalDueMinor: bigint;
  depositRequiredMinor: bigint;
  /** Verified money net of refunds, capped at the total (what the payable has been paid). */
  paidMinor: bigint;
  /** Verified money above the total — flagged for refund, never counted twice. */
  overpaidMinor: bigint;
  refundedMinor: bigint;
  /** Reported/claimed but not yet verified by finance. */
  awaitingVerificationMinor: bigint;
  outstandingMinor: bigint;
  /** Deposit still needed before the deposit requirement is met. */
  depositOutstandingMinor: bigint;
  depositSatisfied: boolean;
  fullyPaid: boolean;
  paymentStatus: PayableState;
}

/**
 * The ledger is the single source of truth for "how much has been paid".
 * Only payments in status SUCCESS (verified by Paystack's verify API or by
 * finance against trusted records) count. Reported collections and claimed
 * transfers are shown separately as "awaiting verification" and never
 * increase the paid balance.
 */
@Injectable()
export class PaymentLedgerService {
  constructor(private readonly prisma: PrismaService) {}

  /** Row-locks the payable so concurrent verifications are serialised. */
  async lock(tx: Tx, purpose: PaymentPurpose, payableId: string): Promise<void> {
    // Table name comes from a constant map, never from input.
    await tx.$queryRawUnsafe(`SELECT 1 FROM "${PAYABLE_TABLE[purpose]}" WHERE "id" = $1::uuid FOR UPDATE`, payableId);
  }

  async summarize(
    db: Tx | PrismaService,
    purpose: PaymentPurpose,
    payableId: string,
    due: { totalDueMinor: bigint; depositRequiredMinor: bigint; currency: string },
  ): Promise<PaymentSummary> {
    const payments = await db.payment.findMany({
      where: { [PAYABLE_COLUMN[purpose]]: payableId },
      select: { status: true, amountMinor: true, refundedMinor: true, claimedAmountMinor: true },
    });
    let verified = 0n;
    let refunded = 0n;
    let awaiting = 0n;
    let failed = 0;
    for (const p of payments) {
      if (p.status === PaymentStatus.SUCCESS) {
        verified += p.amountMinor - p.refundedMinor;
        refunded += p.refundedMinor;
      } else if (p.status === PaymentStatus.AWAITING_VERIFICATION) {
        awaiting += p.claimedAmountMinor ?? p.amountMinor;
      } else if (p.status === PaymentStatus.FAILED || p.status === PaymentStatus.REJECTED) {
        failed++;
      }
    }
    const total = due.totalDueMinor;
    const paid = verified > total ? total : verified;
    const overpaid = verified > total ? verified - total : 0n;
    const outstanding = total - paid;
    const depositOutstanding = due.depositRequiredMinor > paid ? due.depositRequiredMinor - paid : 0n;
    const fullyPaid = total > 0n && paid >= total;

    let paymentStatus: PayableState;
    if (fullyPaid) paymentStatus = PayableState.PAID;
    else if (paid > 0n) paymentStatus = PayableState.PARTIALLY_PAID;
    else if (awaiting > 0n) paymentStatus = PayableState.AWAITING_VERIFICATION;
    else if (refunded > 0n) paymentStatus = PayableState.REFUNDED;
    else if (failed > 0 && payments.every((p) => p.status !== PaymentStatus.PENDING && p.status !== PaymentStatus.INITIALIZED)) paymentStatus = PayableState.FAILED;
    else paymentStatus = PayableState.UNPAID;

    return {
      currency: due.currency,
      totalDueMinor: total,
      depositRequiredMinor: due.depositRequiredMinor,
      paidMinor: paid,
      overpaidMinor: overpaid,
      refundedMinor: refunded,
      awaitingVerificationMinor: awaiting,
      outstandingMinor: outstanding,
      depositOutstandingMinor: depositOutstanding,
      depositSatisfied: due.depositRequiredMinor === 0n ? paid > 0n || total === 0n : paid >= due.depositRequiredMinor,
      fullyPaid,
      paymentStatus,
    };
  }

  /** Recomputes and stores paymentStatus / amountPaid / depositRequired on the payable. */
  async recompute(
    tx: Tx,
    purpose: PaymentPurpose,
    payableId: string,
    due: { totalDueMinor: bigint; depositRequiredMinor: bigint; currency: string },
  ): Promise<PaymentSummary> {
    const summary = await this.summarize(tx, purpose, payableId, due);
    await (tx[PAYABLE_MODEL[purpose]] as any).update({
      where: { id: payableId },
      data: { paymentStatus: summary.paymentStatus, amountPaidMinor: summary.paidMinor, depositRequiredMinor: due.depositRequiredMinor },
    });
    return summary;
  }
}
