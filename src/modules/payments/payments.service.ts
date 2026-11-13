import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  CollectionPoint,
  Payment,
  PaymentMethod,
  PaymentPurpose,
  PaymentStatus,
  Prisma,
  ReconciliationStatus,
  RefundRecordStatus,
  RefundStatus,
} from '@prisma/client';
import { AppConfig } from '../../config/app-config.service';
import { pageArgs, paginate, PaginationQueryDto } from '../../common/dto/pagination.dto';
import { hmacSha512Hex, safeEqualHex, sha256 } from '../../common/utils/crypto';
import { paymentReference } from '../../common/utils/references';
import { PrismaService, Tx } from '../../prisma/prisma.service';
import { AuthUser } from '../access/auth-user';
import { P } from '../access/permissions';
import { AuditService } from '../audit/audit.service';
import { DivisionsService } from '../divisions/divisions.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { NotificationsService, NotifyInput } from '../notifications/notifications.service';
import { PayableContext, PAYABLE_COLUMN, payableIdOf, PayableRegistry } from './payable.registry';
import { PaymentLedgerService, PaymentSummary } from './payment-ledger.service';
import { PaymentPolicyService } from './payment-policy.service';
import { PaystackClient, PaystackError, PaystackRefund, PaystackTransaction } from './paystack.client';

const OPEN_STATUSES: PaymentStatus[] = [PaymentStatus.INITIALIZED, PaymentStatus.PENDING];
/** A pending checkout is considered abandoned after this long without success. */
const ABANDON_AFTER_MS = 2 * 60 * 60_000;

export type AmountOption = 'FULL' | 'DEPOSIT' | 'BALANCE';

export interface InitializeResult {
  paymentId: string;
  reference: string;
  status: PaymentStatus;
  amountMinor: bigint;
  currency: string;
  authorizationUrl: string | null;
  accessCode: string | null;
  publicKey: string | null;
  reused: boolean;
}

export interface SettleInput {
  /** Verified amount in kobo. */
  amountMinor: bigint;
  /** Statuses the payment must currently be in (conditional update). */
  from: PaymentStatus[];
  /** Staff member confirming the funds (null for Paystack's verify API). */
  actorId: string | null;
  /** Manual verification rejects amounts above the outstanding balance; Paystack money is already received, so it is flagged instead. */
  allowOverpayment: boolean;
  data?: Prisma.PaymentUpdateManyMutationInput;
  eventType: string;
  eventPayload?: Record<string, unknown>;
}

/**
 * Payment service for every division.
 *
 * Golden rule: nothing is ever marked paid from client input, a raw webhook
 * body, a screenshot or a reported collection. A payment becomes SUCCESS only
 * after (a) Paystack's verify API confirms reference, amount and currency, or
 * (b) an authorised finance officer — never the person who reported it —
 * confirms the funds against trusted bank or cash records. Every SUCCESS
 * transition goes through settle(): the payable row is locked, the move is a
 * conditional update (exactly once), the ledger is recomputed and the owning
 * module applies its own confirmation policy.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly paystack: PaystackClient,
    private readonly registry: PayableRegistry,
    private readonly ledger: PaymentLedgerService,
    private readonly policies: PaymentPolicyService,
    private readonly config: AppConfig,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly loyalty: LoyaltyService,
    private readonly divisions: DivisionsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Amounts
  // ---------------------------------------------------------------------------

  /** Server-side amount for a payment request, never trusting the client. */
  amountFor(option: AmountOption, summary: PaymentSummary): bigint {
    const open = summary.outstandingMinor - summary.awaitingVerificationMinor;
    if (open <= 0n) {
      throw new ConflictException(
        summary.awaitingVerificationMinor > 0n
          ? 'A payment for this balance is awaiting verification. Please wait for it to be confirmed.'
          : 'Nothing is outstanding on this item',
      );
    }
    if (option === 'DEPOSIT') {
      const dep = summary.depositOutstandingMinor - summary.awaitingVerificationMinor;
      if (summary.depositRequiredMinor === 0n) throw new BadRequestException('No deposit is required; pay the balance instead');
      if (dep <= 0n) throw new ConflictException('The deposit has already been paid or is awaiting verification');
      return dep;
    }
    return open;
  }

  async summaryFor(purpose: PaymentPurpose, payableId: string, ctx: PayableContext, db: Tx | PrismaService = this.prisma) {
    return this.ledger.summarize(db, purpose, payableId, ctx);
  }

  // ---------------------------------------------------------------------------
  // Paystack initialisation
  // ---------------------------------------------------------------------------

  async initialize(user: AuthUser, purpose: PaymentPurpose, payableId: string, idempotencyKey?: string, amountOption: AmountOption = 'BALANCE', callbackUrl?: string): Promise<InitializeResult> {
    this.assertVerifiedEmail(user);
    if (idempotencyKey) {
      const prior = await this.prisma.payment.findUnique({ where: { userId_idempotencyKey: { userId: user.id, idempotencyKey } } });
      if (prior) {
        if (prior.purpose !== purpose || payableIdOf(prior) !== payableId || prior.method !== PaymentMethod.PAYSTACK) {
          throw new ConflictException('This Idempotency-Key was already used for a different payment');
        }
        return this.toInitResult(prior, true);
      }
    }

    const handler = this.registry.get(purpose);
    const ctx = await handler.resolve(payableId, user);
    this.assertOpen(ctx);
    const policy = await this.policies.get(ctx.divisionId, purpose);
    if (!policy.allowPaystack) throw new BadRequestException('Online payment is not available for this item');
    const summary = await this.summaryFor(purpose, payableId, ctx);
    const amount = this.amountFor(amountOption, summary);

    const column = PAYABLE_COLUMN[purpose];
    // Reuse a still-open checkout for the same payable and amount (prevents double charging on retries).
    const open = await this.prisma.payment.findFirst({
      where: {
        [column]: payableId,
        userId: user.id,
        method: PaymentMethod.PAYSTACK,
        status: { in: OPEN_STATUSES },
        amountMinor: amount,
        authorizationUrl: { not: null },
        createdAt: { gt: new Date(Date.now() - 30 * 60_000) },
      } as Prisma.PaymentWhereInput,
      orderBy: { createdAt: 'desc' },
    });
    if (open) return this.toInitResult(open, true);

    const division = await this.divisions.byId(ctx.divisionId);
    const payment = await this.prisma.payment.create({
      data: {
        reference: paymentReference(division.code),
        purpose,
        method: PaymentMethod.PAYSTACK,
        collectionPoint: CollectionPoint.ONLINE,
        divisionId: ctx.divisionId,
        userId: user.id,
        [column]: payableId,
        amountMinor: amount,
        currency: ctx.currency,
        idempotencyKey,
        metadata: { description: ctx.description, amountOption },
      } as Prisma.PaymentUncheckedCreateInput,
    });

    try {
      const init = await this.paystack.initialize({
        email: user.email,
        amount: Number(amount),
        reference: payment.reference,
        currency: ctx.currency,
        callback_url: callbackUrl ?? this.config.get('PAYSTACK_CALLBACK_URL'),
        metadata: {
          payment_id: payment.id,
          purpose,
          payable_id: payableId,
          division: division.code,
          custom_fields: [{ display_name: 'Item', variable_name: 'item', value: ctx.description }],
        },
      });
      const updated = await this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.PENDING, authorizationUrl: init.authorization_url, accessCode: init.access_code },
      });
      await this.audit.record({ actorId: user.id, action: 'payment.initialize', entityType: 'payment', entityId: payment.id, divisionId: ctx.divisionId, changes: { purpose, amountMinor: amount, amountOption } });
      return this.toInitResult(updated, false);
    } catch (e) {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.FAILED, failureReason: e instanceof PaystackError ? e.providerMessage : 'initialisation_error' },
      });
      throw e;
    }
  }

  // ---------------------------------------------------------------------------
  // Paystack verification (customer return, webhook, reconciliation all end here)
  // ---------------------------------------------------------------------------

  async verifyForCustomer(user: AuthUser, reference: string) {
    const payment = await this.prisma.payment.findUnique({ where: { reference } });
    if (!payment || payment.userId !== user.id) throw new NotFoundException('Payment not found');
    if (payment.method !== PaymentMethod.PAYSTACK) throw new BadRequestException('This payment is verified by Nimpat finance, not online');
    if (payment.status === PaymentStatus.SUCCESS) return this.customerView(payment.id);
    await this.verifyWithProvider(payment, 'verify');
    return this.customerView(payment.id);
  }

  async verifyWithProvider(payment: Payment, source: 'verify' | 'webhook' | 'reconcile'): Promise<Payment> {
    if (payment.method !== PaymentMethod.PAYSTACK) throw new BadRequestException('Only Paystack payments can be verified with Paystack');
    const tx = await this.paystack.verify(payment.reference);
    await this.recordEvent(`${source}:${payment.reference}:${tx.id}:${tx.status}`, `transaction.verify.${tx.status}`, source, payment, tx, true);
    return this.applyVerifiedTransaction(payment.id, tx);
  }

  private async applyVerifiedTransaction(paymentId: string, tx: PaystackTransaction): Promise<Payment> {
    const payment = await this.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    const base = {
      lastCheckedAt: new Date(),
      providerTransactionId: tx.id ? String(tx.id) : undefined,
      channel: tx.channel ?? undefined,
      gatewayResponse: tx.gateway_response?.slice(0, 300) ?? undefined,
    };

    if (tx.status === 'success') {
      const mismatch =
        tx.reference !== payment.reference ? 'reference' :
        BigInt(tx.amount) !== payment.amountMinor ? 'amount' :
        tx.currency?.toUpperCase() !== payment.currency ? 'currency' : null;
      if (mismatch) {
        this.logger.error(`Verification mismatch (${mismatch}) for ${payment.reference}`);
        await this.prisma.payment.updateMany({
          where: { id: payment.id, status: { not: PaymentStatus.SUCCESS } },
          data: { ...base, status: PaymentStatus.FAILED, failureReason: `verification_${mismatch}_mismatch` },
        });
        await this.audit.record({
          action: 'payment.verification_mismatch', entityType: 'payment', entityId: payment.id, divisionId: payment.divisionId,
          changes: { field: mismatch, expectedMinor: payment.amountMinor, providerAmount: tx.amount, providerCurrency: tx.currency },
        });
        return this.prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
      }
      await this.settle(payment.id, {
        amountMinor: payment.amountMinor,
        from: [PaymentStatus.INITIALIZED, PaymentStatus.PENDING, PaymentStatus.FAILED, PaymentStatus.ABANDONED],
        actorId: null,
        allowOverpayment: true, // money has reached Paystack; flag excess for refund
        data: {
          ...base,
          paidAt: tx.paid_at ? new Date(tx.paid_at) : new Date(),
          feesMinor: tx.fees != null ? BigInt(tx.fees) : undefined,
        },
        eventType: 'paystack.verified',
      });
      return this.prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    }

    let status: PaymentStatus = PaymentStatus.PENDING;
    if (tx.status === 'failed') status = PaymentStatus.FAILED;
    else if (tx.status === 'reversed') status = PaymentStatus.REVERSED;
    else if (tx.status === 'abandoned' && Date.now() - payment.createdAt.getTime() > ABANDON_AFTER_MS) status = PaymentStatus.ABANDONED;

    await this.prisma.$transaction(async (db) => {
      const res = await db.payment.updateMany({
        where: { id: payment.id, status: { in: OPEN_STATUSES } },
        data: { ...base, status, failureReason: status === PaymentStatus.FAILED ? tx.gateway_response?.slice(0, 300) : undefined },
      });
      if (res.count === 1 && (status === PaymentStatus.FAILED || status === PaymentStatus.ABANDONED)) {
        await this.registry.get(payment.purpose).onPaymentFailed?.(db, { ...payment, status });
        await this.refreshLedger(db, payment);
      }
    });
    if (tx.status === 'reversed' && payment.status === PaymentStatus.SUCCESS) {
      await this.reverseSettled(payment.id, null, 'Reversed by Paystack');
    }
    return this.prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
  }

  // ---------------------------------------------------------------------------
  // Settlement — the only path to SUCCESS
  // ---------------------------------------------------------------------------

  async settle(paymentId: string, input: SettleInput): Promise<{ payment: Payment; summary: PaymentSummary } | null> {
    let notes: NotifyInput[] = [];
    let result: { payment: Payment; summary: PaymentSummary } | null = null;
    await this.prisma.$transaction(
      async (db) => {
        const current = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
        const payableId = payableIdOf(current);
        await this.ledger.lock(db, current.purpose, payableId);
        const handler = this.registry.get(current.purpose);
        const ctx = await handler.load(db, payableId);
        const before = await this.ledger.summarize(db, current.purpose, payableId, ctx);

        let overpaid = 0n;
        if (input.amountMinor > before.outstandingMinor) {
          if (!input.allowOverpayment) {
            throw new ConflictException(`Amount exceeds the outstanding balance (${before.outstandingMinor} kobo). Record only what is owed and refund any excess.`);
          }
          overpaid = input.amountMinor - before.outstandingMinor;
        }

        // Exactly-once: only one caller can move this payment to SUCCESS.
        const res = await db.payment.updateMany({
          where: { id: paymentId, status: { in: input.from } },
          data: {
            ...input.data,
            amountMinor: input.amountMinor,
            status: PaymentStatus.SUCCESS,
            reconciliationStatus: ReconciliationStatus.COLLECTION_VERIFIED,
            verifiedAt: new Date(),
            verifiedById: input.actorId,
            failureReason: overpaid > 0n ? `Overpayment of ${overpaid} kobo — refund required` : null,
            refundStatus: overpaid > 0n ? RefundStatus.PENDING : undefined,
          },
        });
        if (res.count !== 1) return; // already settled (or no longer settleable) — idempotent no-op

        const fresh = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
        const summary = await this.ledger.recompute(db, current.purpose, payableId, ctx);
        notes = (await handler.onPaymentStateChanged(db, payableId, summary, fresh)) ?? [];
        if (fresh.refundStatus === RefundStatus.NONE) await this.loyalty.awardForPayment(db, fresh);
        await this.event(db, fresh, input.eventType, input.actorId, { amountMinor: input.amountMinor, overpaidMinor: overpaid, ...input.eventPayload });
        await this.audit.record(
          { actorId: input.actorId, action: 'payment.success', entityType: 'payment', entityId: paymentId, divisionId: current.divisionId, changes: { reference: current.reference, method: current.method, amountMinor: input.amountMinor, overpaidMinor: overpaid } },
          db,
        );
        result = { payment: fresh, summary };
      },
      { timeout: 20_000 },
    );
    for (const n of notes) await this.notifications.notify(n);
    return result;
  }

  /** Reverses a verified payment (bounced transfer, counterfeit cash, chargeback). */
  async reverseSettled(paymentId: string, actorId: string | null, reason: string) {
    let notes: NotifyInput[] = [];
    await this.prisma.$transaction(async (db) => {
      const current = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
      const payableId = payableIdOf(current);
      await this.ledger.lock(db, current.purpose, payableId);
      const res = await db.payment.updateMany({
        where: { id: paymentId, status: PaymentStatus.SUCCESS },
        data: { status: PaymentStatus.REVERSED, reconciliationStatus: ReconciliationStatus.DISPUTED, disputeReason: reason, disputedAt: new Date(), disputedById: actorId },
      });
      if (res.count !== 1) throw new ConflictException('Only a verified payment can be reversed');
      const fresh = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
      const handler = this.registry.get(current.purpose);
      const ctx = await handler.load(db, payableId);
      const summary = await this.ledger.recompute(db, current.purpose, payableId, ctx);
      await this.loyalty.reverseForRefund(db, current, current.amountMinor);
      notes = (await handler.onPaymentStateChanged(db, payableId, summary, fresh)) ?? [];
      await this.event(db, fresh, 'payment.reversed', actorId, { reason });
      await this.audit.record({ actorId, action: 'payment.reversed', entityType: 'payment', entityId: paymentId, divisionId: current.divisionId, changes: { reason, amountMinor: current.amountMinor } }, db);
    });
    for (const n of notes) await this.notifications.notify(n);
  }

  /** Recomputes the payable's payment state after a non-success change. */
  async refreshLedger(db: Tx, payment: Payment) {
    const payableId = payableIdOf(payment);
    const ctx = await this.registry.get(payment.purpose).load(db, payableId);
    return this.ledger.recompute(db, payment.purpose, payableId, ctx);
  }

  // ---------------------------------------------------------------------------
  // Webhooks
  // ---------------------------------------------------------------------------

  /**
   * Paystack webhook. The signature is an HMAC-SHA512 of the exact raw body
   * using the secret key. Events are stored once (unique key) and processed
   * once; a failed processing attempt is retried when Paystack re-sends.
   */
  async handleWebhook(rawBody: Buffer | undefined, signature: string | undefined, ip: string | undefined) {
    const allowlist = (this.config.get('PAYSTACK_WEBHOOK_IP_ALLOWLIST') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (allowlist.length && (!ip || !allowlist.includes(ip.replace(/^::ffff:/, '')))) {
      this.logger.warn(`Webhook from non-allowlisted IP ${ip}`);
      throw new ForbiddenException('Source not allowed');
    }
    if (!rawBody?.length || !signature) throw new UnauthorizedException('Missing signature');
    const expected = hmacSha512Hex(this.config.get('PAYSTACK_SECRET_KEY'), rawBody);
    if (!safeEqualHex(expected, signature.trim().toLowerCase())) {
      this.logger.warn('Rejected webhook with invalid signature');
      throw new UnauthorizedException('Invalid signature');
    }

    let event: { event: string; data: Record<string, any> };
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new BadRequestException('Malformed payload');
    }
    const data = event.data ?? {};
    // A refund event carries its own refund reference as well; the payment is the one in transaction_reference.
    const reference: string | undefined = event.event?.startsWith('refund.')
      ? (data.transaction_reference ?? data.transaction?.reference ?? data.reference)
      : (data.reference ?? data.transaction_reference ?? data.transaction?.reference);
    const eventKey = `webhook:${event.event}:${data.id ?? ''}:${reference ?? ''}:${data.status ?? ''}:${sha256(rawBody.toString('utf8')).slice(0, 16)}`;

    const payment = reference ? await this.prisma.payment.findUnique({ where: { reference } }) : null;
    const stored = await this.recordEvent(eventKey, event.event, 'webhook', payment, event, true);
    if (stored.processedAt) return { received: true, duplicate: true };

    try {
      if (!payment || payment.method !== PaymentMethod.PAYSTACK) {
        await this.markEvent(stored.id, payment ? 'not_a_paystack_payment' : 'unknown_reference');
        return { received: true };
      }
      if (event.event === 'charge.success') {
        // Never trust the webhook body for money: confirm with the verify API.
        await this.verifyWithProvider(payment, 'webhook');
      } else if (event.event.startsWith('refund.')) {
        await this.applyRefundUpdate(payment, {
          id: data.id ?? data.refund_reference,
          status: String(data.status ?? event.event.split('.')[1]),
          amount: Number(data.amount ?? 0),
          currency: data.currency,
        });
      }
      await this.markEvent(stored.id, null);
      return { received: true };
    } catch (e) {
      await this.markEvent(stored.id, (e as Error).message.slice(0, 500), false);
      throw e; // non-2xx makes Paystack retry later
    }
  }

  // ---------------------------------------------------------------------------
  // Refunds (Paystack payments)
  // ---------------------------------------------------------------------------

  async requestRefund(actor: AuthUser, paymentId: string, amountMinor: bigint | undefined, reason: string) {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId }, include: { refunds: true } });
    if (!payment) throw new NotFoundException('Payment not found');
    actor.assertCan(P.paymentsRefund, payment.divisionId);
    if (payment.status !== PaymentStatus.SUCCESS) throw new BadRequestException('Only successful payments can be refunded');
    if (payment.method !== PaymentMethod.PAYSTACK) {
      throw new BadRequestException('Bank transfer and cash refunds are paid out manually by finance; record them as a reversal or adjustment');
    }

    const committed = payment.refunds.filter((r) => r.status !== RefundRecordStatus.FAILED).reduce((s, r) => s + r.amountMinor, 0n);
    const refundable = payment.amountMinor - committed;
    const amount = amountMinor ?? refundable;
    if (amount <= 0n || amount > refundable) throw new BadRequestException(`Refund must be between 1 and ${refundable} kobo`);

    const refund = await this.prisma.refund.create({
      data: { paymentId, amountMinor: amount, reason, requestedById: actor.id, status: RefundRecordStatus.PENDING },
    });
    try {
      const res = await this.paystack.createRefund({ transaction: payment.reference, amount: Number(amount), merchant_note: reason.slice(0, 200) });
      await this.prisma.refund.update({ where: { id: refund.id }, data: { providerRefundId: String(res.id), status: mapRefundStatus(res.status) } });
      await this.prisma.payment.update({ where: { id: paymentId }, data: { refundStatus: RefundStatus.PROCESSING } });
      if (mapRefundStatus(res.status) === RefundRecordStatus.PROCESSED) await this.applyRefundUpdate(payment, res);
    } catch (e) {
      await this.prisma.refund.update({ where: { id: refund.id }, data: { status: RefundRecordStatus.FAILED } });
      await this.recomputeRefundStatus(paymentId);
      throw e;
    }
    await this.audit.record({ actorId: actor.id, action: 'payment.refund.request', entityType: 'payment', entityId: paymentId, divisionId: payment.divisionId, changes: { amountMinor: amount, reason } });
    return this.prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
  }

  private async applyRefundUpdate(payment: Payment, r: Pick<PaystackRefund, 'id' | 'status' | 'amount' | 'currency'>) {
    const status = mapRefundStatus(r.status);
    const providerRefundId = r.id ? String(r.id) : undefined;
    let refund = providerRefundId ? await this.prisma.refund.findUnique({ where: { providerRefundId } }) : null;
    if (!refund) {
      // Refund initiated outside the API (e.g. Paystack dashboard): record it.
      refund = await this.prisma.refund.findFirst({ where: { paymentId: payment.id, providerRefundId: null, status: { not: RefundRecordStatus.FAILED } }, orderBy: { createdAt: 'desc' } });
      if (refund) await this.prisma.refund.update({ where: { id: refund.id }, data: { providerRefundId } });
      else if (r.amount > 0) {
        refund = await this.prisma.refund.create({ data: { paymentId: payment.id, amountMinor: BigInt(r.amount), providerRefundId, status, reason: 'Recorded from provider event' } });
      }
    }
    if (refund && refund.status !== RefundRecordStatus.PROCESSED) {
      await this.prisma.refund.update({ where: { id: refund.id }, data: { status, processedAt: status === RefundRecordStatus.PROCESSED ? new Date() : undefined } });
    }
    await this.recomputeRefundStatus(payment.id);
  }

  private async recomputeRefundStatus(paymentId: string) {
    let notes: NotifyInput[] = [];
    await this.prisma.$transaction(async (db) => {
      const payment = await db.payment.findUniqueOrThrow({ where: { id: paymentId }, include: { refunds: true } });
      const processed = payment.refunds.filter((r) => r.status === RefundRecordStatus.PROCESSED).reduce((s, r) => s + r.amountMinor, 0n);
      const inFlight = payment.refunds.some((r) => r.status === RefundRecordStatus.PENDING || r.status === RefundRecordStatus.PROCESSING);
      const anyFailed = payment.refunds.some((r) => r.status === RefundRecordStatus.FAILED);
      const refundStatus: RefundStatus =
        processed >= payment.amountMinor ? RefundStatus.REFUNDED :
        inFlight ? RefundStatus.PROCESSING :
        processed > 0n ? RefundStatus.PARTIALLY_REFUNDED :
        anyFailed ? RefundStatus.FAILED :
        payment.refundStatus === RefundStatus.PENDING ? RefundStatus.PENDING : RefundStatus.NONE;
      const refundedMinor = processed > payment.amountMinor ? payment.amountMinor : processed;
      const changed = refundedMinor !== payment.refundedMinor;
      await db.payment.update({ where: { id: paymentId }, data: { refundStatus, refundedMinor } });
      if (changed) {
        const payableId = payableIdOf(payment);
        await this.ledger.lock(db, payment.purpose, payableId);
        const fresh = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
        const summary = await this.refreshLedger(db, fresh);
        notes = (await this.registry.get(payment.purpose).onPaymentStateChanged(db, payableId, summary, fresh)) ?? [];
        await this.event(db, fresh, 'refund.applied', null, { refundedMinor });
      }
      if (processed > 0n) await this.loyalty.reverseForRefund(db, payment, processed);
    });
    for (const n of notes) await this.notifications.notify(n);
  }

  // ---------------------------------------------------------------------------
  // Reconciliation (Paystack)
  // ---------------------------------------------------------------------------

  /** Re-verifies open Paystack payments (catches missed webhooks), marks stale ones abandoned and refreshes in-flight refunds. */
  async reconcile(limit = 100) {
    const now = Date.now();
    const open = await this.prisma.payment.findMany({
      where: { method: PaymentMethod.PAYSTACK, status: { in: OPEN_STATUSES }, createdAt: { lt: new Date(now - 2 * 60_000) } },
      orderBy: { lastCheckedAt: { sort: 'asc', nulls: 'first' } },
      take: limit,
    });
    const summary = { checked: 0, succeeded: 0, failed: 0, abandoned: 0, stillPending: 0, errors: 0, refundsChecked: 0 };
    for (const p of open) {
      summary.checked++;
      try {
        if (!p.authorizationUrl && now - p.createdAt.getTime() > ABANDON_AFTER_MS) {
          await this.prisma.payment.updateMany({ where: { id: p.id, status: { in: OPEN_STATUSES } }, data: { status: PaymentStatus.ABANDONED, lastCheckedAt: new Date() } });
          summary.abandoned++;
          continue;
        }
        const result = await this.verifyWithProvider(p, 'reconcile');
        if (result.status === PaymentStatus.SUCCESS) summary.succeeded++;
        else if (result.status === PaymentStatus.FAILED) summary.failed++;
        else if (result.status === PaymentStatus.ABANDONED) summary.abandoned++;
        else summary.stillPending++;
      } catch (e) {
        summary.errors++;
        if (e instanceof PaystackError && e.httpStatus === 400 && now - p.createdAt.getTime() > ABANDON_AFTER_MS) {
          await this.prisma.payment.updateMany({ where: { id: p.id, status: { in: OPEN_STATUSES } }, data: { status: PaymentStatus.ABANDONED, lastCheckedAt: new Date() } });
        } else {
          await this.prisma.payment.update({ where: { id: p.id }, data: { lastCheckedAt: new Date() } });
        }
      }
    }

    const refunds = await this.prisma.refund.findMany({
      where: { status: { in: [RefundRecordStatus.PENDING, RefundRecordStatus.PROCESSING] }, providerRefundId: { not: null } },
      include: { payment: true },
      take: limit,
    });
    for (const r of refunds) {
      summary.refundsChecked++;
      try {
        const res = await this.paystack.fetchRefund(r.providerRefundId!);
        await this.applyRefundUpdate(r.payment, res);
      } catch {
        summary.errors++;
      }
    }
    if (summary.checked || summary.refundsChecked) this.logger.log(`Reconciliation: ${JSON.stringify(summary)}`);
    return summary;
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  async listForCustomer(user: AuthUser, q: PaginationQueryDto) {
    const where = { userId: user.id };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.payment.findMany({ where, orderBy: { createdAt: 'desc' }, ...pageArgs(q), select: customerSelect }),
      this.prisma.payment.count({ where }),
    ]);
    return paginate(rows, total, q);
  }

  customerView(id: string) {
    return this.prisma.payment.findUniqueOrThrow({ where: { id }, select: customerSelect });
  }

  /** Customer view of what is owed on an order / booking and how it was paid. */
  async customerSummary(user: AuthUser, purpose: PaymentPurpose, payableId: string) {
    const ctx = await this.registry.get(purpose).resolve(payableId, user);
    const summary = await this.summaryFor(purpose, payableId, ctx);
    const payments = await this.prisma.payment.findMany({
      where: { [PAYABLE_COLUMN[purpose]]: payableId, userId: user.id } as Prisma.PaymentWhereInput,
      orderBy: { createdAt: 'asc' },
      select: customerSelect,
    });
    return { purpose, payableId, label: ctx.label, acceptsPayments: ctx.acceptsPayments, payBy: ctx.payBy ?? null, ...summary, payments };
  }

  async adminList(user: AuthUser, q: AdminPaymentFilter) {
    const allowed = user.divisionFilter(P.paymentsRead);
    const where: Prisma.PaymentWhereInput = {
      status: q.status,
      purpose: q.purpose,
      reference: q.reference,
      method: q.method,
      collectionPoint: q.collectionPoint,
      reconciliationStatus: q.reconciliationStatus,
      serviceLocationId: q.serviceLocationId,
      reportedById: q.reportedById,
      createdAt: q.from || q.to ? { gte: q.from ? new Date(q.from) : undefined, lt: q.to ? new Date(q.to) : undefined } : undefined,
    };
    if (q.division) {
      const d = await this.divisions.resolve(q.division);
      user.assertCan(P.paymentsRead, d.id);
      where.divisionId = d.id;
    } else if (allowed) where.divisionId = { in: allowed };
    const [rows, total, sums] = await this.prisma.$transaction([
      this.prisma.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...pageArgs(q),
        include: {
          user: { select: { id: true, email: true, isGuest: true, contactEmail: true, contactPhone: true } },
          refunds: true,
          serviceLocation: { select: { id: true, code: true, name: true } },
          reportedBy: { select: { id: true, email: true, staffProfile: { select: { firstName: true, lastName: true } } } },
          verifiedBy: { select: { id: true, email: true } },
          reconciledBy: { select: { id: true, email: true } },
          order: { select: { orderNumber: true, totalMinor: true, paymentStatus: true, amountPaidMinor: true } },
          reservation: { select: { reservationNumber: true, totalMinor: true, paymentStatus: true, amountPaidMinor: true } },
          serviceBooking: { select: { bookingNumber: true, priceMinor: true, paymentStatus: true, amountPaidMinor: true } },
          spaAppointment: { select: { appointmentNumber: true, priceMinor: true, paymentStatus: true, amountPaidMinor: true } },
          division: { select: { code: true, name: true } },
          _count: { select: { proofs: true } },
        },
      }),
      this.prisma.payment.count({ where }),
      this.prisma.payment.aggregate({ where, _sum: { amountMinor: true, claimedAmountMinor: true } }),
    ]);
    return { ...paginate(rows, total, q), totals: { amountMinor: sums._sum.amountMinor ?? 0n, claimedAmountMinor: sums._sum.claimedAmountMinor ?? 0n } };
  }

  async adminGet(user: AuthUser, id: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, email: true, isGuest: true, contactEmail: true, contactPhone: true, phone: true } },
        refunds: true,
        proofs: { select: { id: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true } },
        serviceLocation: true,
        beneficiaryAccount: { select: { id: true, label: true, bankName: true, accountName: true } },
        reportedBy: { select: { id: true, email: true, staffProfile: { select: { firstName: true, lastName: true, employeeNumber: true } } } },
        verifiedBy: { select: { id: true, email: true } },
        reconciledBy: { select: { id: true, email: true } },
        events: { orderBy: { createdAt: 'asc' }, select: { id: true, eventType: true, source: true, actorId: true, signatureValid: true, processedAt: true, processingError: true, createdAt: true } },
      },
    });
    if (!payment) throw new NotFoundException('Payment not found');
    user.assertCan(P.paymentsRead, payment.divisionId);
    return payment;
  }

  async adminVerify(user: AuthUser, id: string) {
    const payment = await this.prisma.payment.findUnique({ where: { id } });
    if (!payment) throw new NotFoundException('Payment not found');
    user.assertCan(P.paymentsRead, payment.divisionId);
    await this.verifyWithProvider(payment, 'reconcile');
    await this.audit.record({ actorId: user.id, action: 'payment.manual_verify', entityType: 'payment', entityId: id, divisionId: payment.divisionId });
    return this.adminGet(user, id);
  }

  // ---------------------------------------------------------------------------

  assertVerifiedEmail(user: AuthUser) {
    // Guests have no account to protect, so the email check is for members only.
    if (this.config.get('REQUIRE_VERIFIED_EMAIL_FOR_PAYMENT') && !user.emailVerified && !user.isGuest) {
      throw new ForbiddenException('Please verify your email address before making a payment');
    }
  }

  assertOpen(ctx: PayableContext) {
    if (!ctx.acceptsPayments) throw new ConflictException(ctx.closedReason ?? 'This item can no longer be paid');
  }

  async event(db: Tx | PrismaService, payment: Payment, eventType: string, actorId: string | null, payload: Record<string, unknown> = {}) {
    await db.paymentEvent.create({
      data: {
        eventKey: `manual:${payment.id}:${eventType}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`,
        eventType,
        source: actorId ? 'staff' : 'system',
        actorId,
        paymentId: payment.id,
        reference: payment.reference,
        signatureValid: true,
        payload: JSON.parse(JSON.stringify(payload, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))) as Prisma.InputJsonValue,
        processedAt: new Date(),
      },
    });
  }

  private async recordEvent(eventKey: string, eventType: string, source: string, payment: Payment | null, payload: unknown, signatureValid: boolean) {
    try {
      return await this.prisma.paymentEvent.create({
        data: {
          eventKey,
          eventType,
          source,
          paymentId: payment?.id,
          reference: payment?.reference,
          signatureValid,
          payload: JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonValue,
          processedAt: source === 'webhook' ? null : new Date(),
        },
      });
    } catch (e: any) {
      if (e?.code === 'P2002') return this.prisma.paymentEvent.findUniqueOrThrow({ where: { eventKey } });
      throw e;
    }
  }

  private async markEvent(id: string, error: string | null, processed = true) {
    await this.prisma.paymentEvent.update({ where: { id }, data: { processedAt: processed ? new Date() : null, processingError: error } });
  }

  private toInitResult(p: Payment, reused: boolean): InitializeResult {
    return {
      paymentId: p.id,
      reference: p.reference,
      status: p.status,
      amountMinor: p.amountMinor,
      currency: p.currency,
      authorizationUrl: p.authorizationUrl,
      accessCode: p.accessCode,
      publicKey: this.config.get('PAYSTACK_PUBLIC_KEY') ?? null,
      reused,
    };
  }
}

export interface AdminPaymentFilter extends PaginationQueryDto {
  status?: PaymentStatus;
  purpose?: PaymentPurpose;
  division?: string;
  reference?: string;
  method?: PaymentMethod;
  collectionPoint?: CollectionPoint;
  reconciliationStatus?: ReconciliationStatus;
  serviceLocationId?: string;
  reportedById?: string;
  from?: string;
  to?: string;
}

export const customerSelect = {
  id: true,
  reference: true,
  purpose: true,
  method: true,
  collectionPoint: true,
  status: true,
  reconciliationStatus: true,
  refundStatus: true,
  amountMinor: true,
  claimedAmountMinor: true,
  refundedMinor: true,
  currency: true,
  channel: true,
  receiptNumber: true,
  paidAt: true,
  collectedAt: true,
  rejectionReason: true,
  createdAt: true,
  orderId: true,
  reservationId: true,
  serviceBookingId: true,
  spaAppointmentId: true,
  vehicleInquiryId: true,
  logisticsRequestId: true,
  quotationId: true,
} satisfies Prisma.PaymentSelect;

function mapRefundStatus(s: string): RefundRecordStatus {
  switch (s) {
    case 'processed':
      return RefundRecordStatus.PROCESSED;
    case 'failed':
      return RefundRecordStatus.FAILED;
    case 'processing':
    case 'needs-attention':
      return RefundRecordStatus.PROCESSING;
    default:
      return RefundRecordStatus.PENDING;
  }
}
