import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  CollectionPoint,
  OrderStatus,
  PaymentMethod,
  PaymentOption,
  PaymentPurpose,
  PaymentStatus,
  Prisma,
  ReconciliationStatus,
} from '@prisma/client';
import { randomCode } from '../../common/utils/crypto';
import { addMinutes } from '../../common/utils/dates';
import { formatNgn } from '../../common/utils/money';
import { paymentReference } from '../../common/utils/references';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../access/auth-user';
import { P } from '../access/permissions';
import { AuditService } from '../audit/audit.service';
import { DivisionsService } from '../divisions/divisions.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PAYABLE_COLUMN, payableIdOf, PayableRegistry } from './payable.registry';
import { PaymentLedgerService } from './payment-ledger.service';
import { PaymentPolicyService } from './payment-policy.service';
import { AmountOption, customerSelect, PaymentsService } from './payments.service';
import { ProofStorageService } from './proof-storage.service';

const MANUAL_METHODS: PaymentMethod[] = [PaymentMethod.BANK_TRANSFER, PaymentMethod.CASH, PaymentMethod.CARD_TERMINAL];
const VERIFIABLE: PaymentStatus[] = [PaymentStatus.PENDING, PaymentStatus.AWAITING_VERIFICATION];

export interface RecordCollectionInput {
  purpose: PaymentPurpose;
  payableId: string;
  method: PaymentMethod;
  point: 'DELIVERY' | 'SERVICE_LOCATION';
  serviceLocationId?: string;
  amountMinor: bigint;
  collectedAt?: Date;
  collectionReference?: string;
  note?: string;
}

/**
 * Payments that happen outside Paystack: direct bank transfers, pay on
 * delivery and pay at a Nimpat location.
 *
 * Controls
 *  - Customers and collectors can only REPORT money (status
 *    AWAITING_VERIFICATION). Reports never change the paid balance.
 *  - Only staff with payments:verify can confirm funds, using a trusted
 *    reference (bank statement line / cash book), and never for a payment
 *    they reported themselves (separation of duties).
 *  - Reconciliation (payments:reconcile) is a separate step and also cannot
 *    be done by the person who collected the money.
 *  - Every action is a conditional update (no double confirmation), is
 *    written to the append-only payment event log and to the audit log.
 */
@Injectable()
export class ManualPaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    private readonly registry: PayableRegistry,
    private readonly ledger: PaymentLedgerService,
    private readonly policies: PaymentPolicyService,
    private readonly proofs: ProofStorageService,
    private readonly divisions: DivisionsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Customer: payment options
  // ---------------------------------------------------------------------------

  /** Which ways the customer can pay for a specific order / booking right now. */
  async optionsForPayable(user: AuthUser, purpose: PaymentPurpose, payableId: string) {
    const ctx = await this.registry.get(purpose).resolve(payableId, user);
    const policy = await this.policies.get(ctx.divisionId, purpose);
    const summary = await this.payments.summaryFor(purpose, payableId, ctx);
    const account = await this.policies.beneficiaryAccount(ctx.divisionId);
    const locations = await this.prisma.serviceLocation.findMany({
      where: { divisionId: ctx.divisionId, isActive: true },
      select: { id: true, code: true, name: true, addressLine: true, city: true, state: true, acceptsCash: true, acceptsBankTransfer: true, acceptsCardTerminal: true },
    });
    const open = ctx.acceptsPayments && summary.outstandingMinor - summary.awaitingVerificationMinor > 0n;
    // Paying in store means coming to collect, so a delivery order never offers it.
    const order = purpose === PaymentPurpose.ORDER
      ? await this.prisma.order.findUnique({ where: { id: payableId }, select: { fulfilmentType: true, status: true, amountPaidMinor: true, deliveryAddress: true, deliveryFeeMinor: true, delivery: { select: { status: true } } } })
      : null;
    const isDelivery = order?.fulfilmentType === 'DELIVERY';
    const canChangeAddress = !!order && isDelivery && (order.status === 'PENDING' || order.status === 'ACCEPTED') && order.amountPaidMinor === 0n
      && summary.awaitingVerificationMinor === 0n && (!order.delivery || order.delivery.status === 'PENDING');
    return {
      purpose,
      payableId,
      label: ctx.label,
      currency: ctx.currency,
      totalDueMinor: summary.totalDueMinor,
      depositRequiredMinor: summary.depositRequiredMinor,
      paidMinor: summary.paidMinor,
      awaitingVerificationMinor: summary.awaitingVerificationMinor,
      outstandingMinor: summary.outstandingMinor,
      depositOutstandingMinor: summary.depositOutstandingMinor,
      paymentStatus: summary.paymentStatus,
      confirmationRule: policy.confirmationRule,
      payBy: ctx.payBy ?? null,
      methods: {
        paystack: { available: open && policy.allowPaystack, channels: ['card', 'bank_transfer', 'ussd'], note: process.env.PAYSTACK_MODE === 'live' ? 'Card, bank transfer or USSD through Paystack' : 'Paystack checkout (test mode)' },
        bankTransfer: { available: open && policy.allowBankTransfer && !!account, windowHours: policy.bankTransferWindowHours, note: account ? 'Account details are shown after you choose this option' : 'No receiving account configured' },
        payOnDelivery: { available: purpose === PaymentPurpose.ORDER && policy.allowPayOnDelivery, note: 'Chosen at checkout; staff collect on delivery' },
        payAtLocation: { available: policy.allowPayAtLocation && locations.length > 0 && !isDelivery, locations },
      },
      delivery: isDelivery ? { address: order!.deliveryAddress, feeMinor: order!.deliveryFeeMinor, canChangeAddress } : null,
      closedReason: ctx.acceptsPayments ? undefined : ctx.closedReason,
    };
  }

  // ---------------------------------------------------------------------------
  // Customer: direct bank transfer
  // ---------------------------------------------------------------------------

  /** Issues transfer instructions with a unique reference for the narration. */
  async startBankTransfer(user: AuthUser, purpose: PaymentPurpose, payableId: string, amountOption: AmountOption = 'BALANCE', idempotencyKey?: string) {
    this.payments.assertVerifiedEmail(user);
    if (idempotencyKey) {
      const prior = await this.prisma.payment.findUnique({ where: { userId_idempotencyKey: { userId: user.id, idempotencyKey } } });
      if (prior) {
        if (prior.method !== PaymentMethod.BANK_TRANSFER || payableIdOf(prior) !== payableId) throw new ConflictException('This Idempotency-Key was already used for a different payment');
        return this.instructions(prior.id);
      }
    }
    const handler = this.registry.get(purpose);
    const ctx = await handler.resolve(payableId, user);
    this.payments.assertOpen(ctx);
    const policy = await this.policies.get(ctx.divisionId, purpose);
    if (!policy.allowBankTransfer) throw new BadRequestException('Direct bank transfer is not available for this item');
    const account = await this.policies.beneficiaryAccount(ctx.divisionId);
    if (!account) throw new BadRequestException('Direct bank transfer is not available yet (no receiving account configured)');

    const column = PAYABLE_COLUMN[purpose];
    const summary = await this.payments.summaryFor(purpose, payableId, ctx);
    // Re-use an open instruction instead of creating duplicates.
    const existing = await this.prisma.payment.findFirst({
      where: { [column]: payableId, userId: user.id, method: PaymentMethod.BANK_TRANSFER, status: PaymentStatus.PENDING } as Prisma.PaymentWhereInput,
      orderBy: { createdAt: 'desc' },
    });
    if (existing) return this.instructions(existing.id);

    const amount = this.payments.amountFor(amountOption, summary);
    const division = await this.divisions.byId(ctx.divisionId);
    const payBy = addMinutes(new Date(), policy.bankTransferWindowHours * 60);
    const payment = await this.prisma.$transaction(async (tx) => {
      const p = await tx.payment.create({
        data: {
          reference: paymentReference(division.code),
          purpose,
          method: PaymentMethod.BANK_TRANSFER,
          collectionPoint: CollectionPoint.BANK,
          status: PaymentStatus.PENDING,
          divisionId: ctx.divisionId,
          userId: user.id,
          [column]: payableId,
          amountMinor: amount,
          currency: ctx.currency,
          beneficiaryAccountId: account.id,
          idempotencyKey,
          metadata: { description: ctx.description, amountOption, payBy: payBy.toISOString() },
        } as Prisma.PaymentUncheckedCreateInput,
      });
      await handler.onBankTransferStarted?.(tx, payableId, payBy);
      await this.payments.event(tx, p, 'bank_transfer.instructions_issued', null, { amountMinor: amount });
      return p;
    });
    await this.audit.record({ actorId: user.id, action: 'payment.bank_transfer.start', entityType: 'payment', entityId: payment.id, divisionId: ctx.divisionId, changes: { amountMinor: amount } });
    return this.instructions(payment.id);
  }

  async instructionsForCustomer(user: AuthUser, reference: string) {
    const p = await this.ownedPayment(user, reference, PaymentMethod.BANK_TRANSFER);
    return this.instructions(p.id);
  }

  /** Only the fields a customer needs to make the transfer. */
  async instructions(paymentId: string) {
    const p = await this.prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: { beneficiaryAccount: { select: { bankName: true, accountName: true, accountNumber: true } } },
    });
    return {
      paymentId: p.id,
      reference: p.reference,
      status: p.status,
      amountMinor: p.amountMinor,
      currency: p.currency,
      payBy: (p.metadata as { payBy?: string } | null)?.payBy ?? null,
      account: p.beneficiaryAccount,
      narration: p.reference,
      steps: [
        `Transfer exactly ${formatNgn(p.amountMinor)} to the account shown.`,
        `Use ${p.reference} as the transfer narration / reference.`,
        'Tap "I have paid" and optionally upload your transfer receipt.',
        'Your order or booking is confirmed only after Nimpat finance confirms the money has arrived.',
      ],
    };
  }

  /** Customer says they have paid. Moves to AWAITING_VERIFICATION — not paid. */
  async notifyTransfer(user: AuthUser, reference: string, dto: { payerName: string; transferredAt?: string; amountMinor?: bigint; customerReference?: string }) {
    const p = await this.ownedPayment(user, reference, PaymentMethod.BANK_TRANSFER);
    if (p.status !== PaymentStatus.PENDING && p.status !== PaymentStatus.AWAITING_VERIFICATION) {
      throw new ConflictException(`This transfer is already ${p.status.toLowerCase().replace('_', ' ')}`);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.payment.updateMany({
        where: { id: p.id, status: { in: VERIFIABLE } },
        data: {
          status: PaymentStatus.AWAITING_VERIFICATION,
          reconciliationStatus: ReconciliationStatus.COLLECTION_REPORTED,
          payerName: dto.payerName,
          customerReference: dto.customerReference,
          claimedAmountMinor: dto.amountMinor ?? p.amountMinor,
          transferredAt: dto.transferredAt ? new Date(dto.transferredAt) : new Date(),
          reportedById: user.id,
          reportedAt: new Date(),
        },
      });
      const fresh = await tx.payment.findUniqueOrThrow({ where: { id: p.id } });
      await this.payments.refreshLedger(tx, fresh);
      await this.payments.event(tx, fresh, 'bank_transfer.customer_reported', user.id, { payerName: dto.payerName, claimedAmountMinor: dto.amountMinor ?? p.amountMinor });
    });
    await this.audit.record({ actorId: user.id, action: 'payment.bank_transfer.reported', entityType: 'payment', entityId: p.id, divisionId: p.divisionId });
    return this.prisma.payment.findUniqueOrThrow({ where: { id: p.id }, select: customerSelect });
  }

  async uploadProof(user: AuthUser, reference: string, file: { buffer: Buffer; originalname: string } | undefined) {
    if (!file) throw new BadRequestException('Attach a file in the "file" field');
    const p = await this.ownedPayment(user, reference, PaymentMethod.BANK_TRANSFER);
    if (!VERIFIABLE.includes(p.status)) throw new ConflictException('Proof can only be added while the transfer is awaiting verification');
    const count = await this.prisma.paymentProof.count({ where: { paymentId: p.id } });
    if (count >= 3) throw new BadRequestException('At most 3 files can be attached');
    const saved = await this.proofs.save(file.buffer);
    const proof = await this.prisma.paymentProof.create({
      data: { paymentId: p.id, uploadedById: user.id, storageKey: saved.key, fileName: file.originalname.slice(0, 120), mimeType: saved.mime, sizeBytes: saved.size, sha256: saved.sha256 },
      select: { id: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true },
    });
    await this.payments.event(this.prisma, p, 'bank_transfer.proof_uploaded', user.id, { proofId: proof.id, sha256: saved.sha256 });
    return { ...proof, note: 'Uploads are kept as supporting evidence only. Finance confirms payment from bank records.' };
  }

  /** Proof file — visible to the customer who uploaded it and to payments staff. */
  async readProof(user: AuthUser, proofId: string) {
    const proof = await this.prisma.paymentProof.findUnique({ where: { id: proofId }, include: { payment: true } });
    if (!proof) throw new NotFoundException('File not found');
    const isOwner = proof.payment.userId === user.id;
    if (!isOwner && !user.can(P.paymentsRead, proof.payment.divisionId)) throw new NotFoundException('File not found');
    return { buffer: await this.proofs.read(proof.storageKey), mimeType: proof.mimeType, fileName: proof.fileName };
  }

  // ---------------------------------------------------------------------------
  // Staff: record a collection (pay on delivery / at location)
  // ---------------------------------------------------------------------------

  async recordCollection(actor: AuthUser, input: RecordCollectionInput, idempotencyKey?: string) {
    if (!MANUAL_METHODS.includes(input.method)) throw new BadRequestException('Collections are cash, bank transfer or card terminal');
    if (input.amountMinor <= 0n) throw new BadRequestException('Amount must be positive');
    const handler = this.registry.get(input.purpose);
    const ctx = await handler.load(this.prisma, input.payableId);
    actor.assertCan(P.collectionsRecord, ctx.divisionId);
    if (idempotencyKey) {
      const prior = await this.prisma.payment.findUnique({ where: { userId_idempotencyKey: { userId: ctx.userId, idempotencyKey: `col:${actor.id}:${idempotencyKey}` } } });
      if (prior) return this.collectionRecord(prior.id);
    }
    if (!ctx.acceptsPayments) throw new ConflictException(ctx.closedReason ?? 'This item can no longer take payments');
    const policy = await this.policies.get(ctx.divisionId, input.purpose);

    let locationId: string | null = null;
    if (input.point === 'DELIVERY') {
      if (input.purpose !== PaymentPurpose.ORDER || ctx.delivery?.fulfilment !== 'DELIVERY') throw new BadRequestException('Delivery collections are only for delivery orders');
      if (input.method === PaymentMethod.CARD_TERMINAL) throw new BadRequestException('Card terminals are not used on delivery');
      const order = await this.prisma.order.findUniqueOrThrow({ where: { id: input.payableId } });
      if (order.paymentOption !== PaymentOption.PAY_ON_DELIVERY) throw new BadRequestException('This order was not placed as pay on delivery');
    } else {
      if (!policy.allowPayAtLocation) throw new BadRequestException('Payment at a service location is not enabled for this transaction type');
      if (!input.serviceLocationId) throw new BadRequestException('serviceLocationId is required');
      const loc = await this.prisma.serviceLocation.findUnique({ where: { id: input.serviceLocationId } });
      if (!loc || !loc.isActive || loc.divisionId !== ctx.divisionId) throw new BadRequestException('Unknown service location for this division');
      const ok = { CASH: loc.acceptsCash, BANK_TRANSFER: loc.acceptsBankTransfer, CARD_TERMINAL: loc.acceptsCardTerminal, PAYSTACK: false }[input.method];
      if (!ok) throw new BadRequestException(`${loc.name} does not accept ${input.method.replace('_', ' ').toLowerCase()}`);
      locationId = loc.id;
    }

    const division = await this.divisions.byId(ctx.divisionId);
    const created = await this.prisma.$transaction(async (tx) => {
      await this.ledger.lock(tx, input.purpose, input.payableId);
      const summary = await this.ledger.summarize(tx, input.purpose, input.payableId, ctx);
      // Verified + already-reported money can never exceed what is owed: blocks duplicate reports.
      const room = summary.outstandingMinor - summary.awaitingVerificationMinor;
      if (input.amountMinor > room) {
        throw new ConflictException(
          room <= 0n
            ? 'Nothing left to collect: the balance is already paid or a collection is awaiting verification'
            : `Amount exceeds the uncollected balance of ${formatNgn(room)}`,
        );
      }
      const p = await tx.payment.create({
        data: {
          reference: paymentReference(division.code),
          purpose: input.purpose,
          method: input.method,
          collectionPoint: input.point === 'DELIVERY' ? CollectionPoint.DELIVERY : CollectionPoint.SERVICE_LOCATION,
          status: PaymentStatus.AWAITING_VERIFICATION,
          reconciliationStatus: ReconciliationStatus.COLLECTION_REPORTED,
          divisionId: ctx.divisionId,
          userId: ctx.userId,
          [PAYABLE_COLUMN[input.purpose]]: input.payableId,
          amountMinor: input.amountMinor,
          claimedAmountMinor: input.amountMinor,
          currency: ctx.currency,
          serviceLocationId: locationId,
          customerReference: input.collectionReference,
          receiptNumber: `RCT-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${randomCode(8)}`,
          collectedAt: input.collectedAt ?? new Date(),
          reportedById: actor.id,
          reportedAt: new Date(),
          note: input.method === PaymentMethod.CARD_TERMINAL ? `${input.note ?? ''} [card terminal — recorded manually; no terminal integration]`.trim() : input.note,
          idempotencyKey: idempotencyKey ? `col:${actor.id}:${idempotencyKey}` : undefined,
        } as Prisma.PaymentUncheckedCreateInput,
      });
      await this.payments.refreshLedger(tx, p);
      await this.payments.event(tx, p, 'collection.reported', actor.id, { method: input.method, point: input.point, amountMinor: input.amountMinor, serviceLocationId: locationId });
      await this.audit.record({ actorId: actor.id, action: 'payment.collection.reported', entityType: 'payment', entityId: p.id, divisionId: ctx.divisionId, changes: { purpose: input.purpose, payableId: input.payableId, method: input.method, amountMinor: input.amountMinor } }, tx);
      return p;
    });
    await this.notifications.notify({
      userId: ctx.userId,
      type: 'payment.collection_recorded',
      title: `Payment recorded for ${ctx.label}`,
      body: `We recorded ${formatNgn(input.amountMinor)} (${input.method.replace('_', ' ').toLowerCase()}). Receipt ${created.receiptNumber}. It will show as paid once our finance team confirms it.`,
      data: { paymentId: created.id, receiptNumber: created.receiptNumber },
    });
    return this.collectionRecord(created.id);
  }

  async collectionRecord(paymentId: string) {
    return this.prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
      select: {
        ...customerSelect,
        serviceLocation: { select: { code: true, name: true } },
        reportedBy: { select: { id: true, email: true, staffProfile: { select: { firstName: true, lastName: true, employeeNumber: true } } } },
        customerReference: true,
        note: true,
      },
    });
  }

  /** Customer receipt for a recorded collection or verified transfer. */
  async receipt(user: AuthUser, reference: string) {
    const p = await this.prisma.payment.findUnique({
      where: { reference },
      include: { serviceLocation: { select: { name: true, addressLine: true, city: true } }, reportedBy: { select: { staffProfile: { select: { firstName: true, lastName: true } } } }, division: { select: { name: true } } },
    });
    if (!p || p.userId !== user.id) throw new NotFoundException('Payment not found');
    return {
      receiptNumber: p.receiptNumber,
      reference: p.reference,
      division: p.division.name,
      method: p.method,
      collectionPoint: p.collectionPoint,
      amountMinor: p.amountMinor,
      currency: p.currency,
      status: p.status,
      verified: p.status === PaymentStatus.SUCCESS,
      collectedAt: p.collectedAt ?? p.paidAt,
      collectedBy: p.reportedBy?.staffProfile ? `${p.reportedBy.staffProfile.firstName} ${p.reportedBy.staffProfile.lastName.charAt(0)}.` : null,
      location: p.serviceLocation,
      note: p.status === PaymentStatus.SUCCESS ? 'Payment confirmed by Nimpat finance.' : 'Recorded — awaiting confirmation by Nimpat finance.',
    };
  }

  // ---------------------------------------------------------------------------
  // Finance: verify, reject, dispute, reverse, reconcile
  // ---------------------------------------------------------------------------

  /** Confirms that the money actually arrived, from a trusted record. */
  async confirmFunds(actor: AuthUser, paymentId: string, dto: { receivedAmountMinor: bigint; verificationReference: string; receivedAt?: string; note?: string }) {
    const p = await this.staffPayment(actor, paymentId, P.paymentsVerify);
    if (!MANUAL_METHODS.includes(p.method)) throw new BadRequestException('Paystack payments are verified automatically with Paystack');
    this.assertNotReporter(actor, p.reportedById, 'verify');
    if (!VERIFIABLE.includes(p.status)) throw new ConflictException(`Payment is ${p.status.toLowerCase()}; it cannot be confirmed`);
    if (dto.receivedAmountMinor <= 0n) throw new BadRequestException('Received amount must be positive');
    try {
      const res = await this.payments.settle(p.id, {
        amountMinor: dto.receivedAmountMinor,
        from: VERIFIABLE,
        actorId: actor.id,
        allowOverpayment: false,
        data: {
          verificationReference: dto.verificationReference,
          paidAt: dto.receivedAt ? new Date(dto.receivedAt) : p.collectedAt ?? p.transferredAt ?? new Date(),
          note: dto.note ? [p.note, `Finance: ${dto.note}`].filter(Boolean).join(' | ') : undefined,
          disputeReason: null,
        },
        eventType: 'finance.funds_confirmed',
        eventPayload: { verificationReference: dto.verificationReference, claimedAmountMinor: p.claimedAmountMinor, receivedAmountMinor: dto.receivedAmountMinor },
      });
      if (!res) throw new ConflictException('This payment was already confirmed or changed by someone else');
    } catch (e: any) {
      if (e?.code === 'P2002') throw new ConflictException('This bank statement reference has already been used to confirm another payment');
      throw e;
    }
    await this.notifications.notify({
      userId: p.userId,
      type: 'payment.confirmed',
      title: 'Payment confirmed',
      body: `Nimpat finance confirmed ${formatNgn(dto.receivedAmountMinor)} for reference ${p.reference}.`,
      data: { paymentId: p.id },
      email: true,
    });
    return this.payments.adminGet(actor, p.id);
  }

  async reject(actor: AuthUser, paymentId: string, reason: string) {
    const p = await this.staffPayment(actor, paymentId, P.paymentsVerify);
    if (!MANUAL_METHODS.includes(p.method)) throw new BadRequestException('Paystack payments cannot be rejected manually');
    this.assertNotReporter(actor, p.reportedById, 'reject');
    await this.prisma.$transaction(async (tx) => {
      const res = await tx.payment.updateMany({
        where: { id: p.id, status: { in: VERIFIABLE } },
        data: { status: PaymentStatus.REJECTED, rejectionReason: reason, reconciliationStatus: ReconciliationStatus.NOT_COLLECTED, verifiedById: actor.id, verifiedAt: new Date() },
      });
      if (res.count !== 1) throw new ConflictException('Only a payment awaiting verification can be rejected');
      const fresh = await tx.payment.findUniqueOrThrow({ where: { id: p.id } });
      await this.payments.refreshLedger(tx, fresh);
      await this.payments.event(tx, fresh, 'finance.rejected', actor.id, { reason });
      await this.audit.record({ actorId: actor.id, action: 'payment.rejected', entityType: 'payment', entityId: p.id, divisionId: p.divisionId, changes: { reason } }, tx);
    });
    await this.notifications.notify({
      userId: p.userId,
      type: 'payment.rejected',
      title: 'We could not confirm your payment',
      body: `We could not find the funds for reference ${p.reference}. Reason: ${reason}. Please contact Nimpat support if you believe this is a mistake.`,
      data: { paymentId: p.id },
      email: true,
    });
    return this.payments.adminGet(actor, p.id);
  }

  /** Flags a payment for investigation (any manual payment, before or after verification). */
  async dispute(actor: AuthUser, paymentId: string, reason: string) {
    const p = await this.staffPayment(actor, paymentId, P.paymentsVerify);
    if (!MANUAL_METHODS.includes(p.method)) throw new BadRequestException('Raise Paystack disputes in the Paystack dashboard');
    const res = await this.prisma.payment.updateMany({
      where: { id: p.id, reconciliationStatus: { not: ReconciliationStatus.RECONCILED }, status: { in: [...VERIFIABLE, PaymentStatus.SUCCESS] } },
      data: { reconciliationStatus: ReconciliationStatus.DISPUTED, disputeReason: reason, disputedAt: new Date(), disputedById: actor.id },
    });
    if (res.count !== 1) throw new ConflictException('This payment cannot be disputed (already reconciled or closed)');
    const fresh = await this.prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
    await this.payments.event(this.prisma, fresh, 'finance.disputed', actor.id, { reason });
    await this.audit.record({ actorId: actor.id, action: 'payment.disputed', entityType: 'payment', entityId: p.id, divisionId: p.divisionId, changes: { reason } });
    return this.payments.adminGet(actor, p.id);
  }

  /** Closes a dispute on a verified payment after investigation (funds are confirmed). */
  async resolveDispute(actor: AuthUser, paymentId: string, note: string) {
    const p = await this.staffPayment(actor, paymentId, P.paymentsVerify);
    this.assertNotReporter(actor, p.reportedById, 'resolve');
    if (p.status !== PaymentStatus.SUCCESS) throw new BadRequestException('Confirm or reject the payment instead');
    const res = await this.prisma.payment.updateMany({
      where: { id: p.id, status: PaymentStatus.SUCCESS, reconciliationStatus: ReconciliationStatus.DISPUTED },
      data: { reconciliationStatus: ReconciliationStatus.COLLECTION_VERIFIED, note: [p.note, `Dispute resolved: ${note}`].filter(Boolean).join(' | ') },
    });
    if (res.count !== 1) throw new ConflictException('This payment is not under dispute');
    const fresh = await this.prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
    await this.payments.event(this.prisma, fresh, 'finance.dispute_resolved', actor.id, { note });
    await this.audit.record({ actorId: actor.id, action: 'payment.dispute_resolved', entityType: 'payment', entityId: p.id, divisionId: p.divisionId, changes: { note } });
    return this.payments.adminGet(actor, p.id);
  }

  async reverse(actor: AuthUser, paymentId: string, reason: string) {
    const p = await this.staffPayment(actor, paymentId, P.paymentsVerify);
    if (!MANUAL_METHODS.includes(p.method)) throw new BadRequestException('Paystack payments are reversed by refund or by Paystack');
    this.assertNotReporter(actor, p.reportedById, 'reverse');
    if (p.reconciliationStatus === ReconciliationStatus.RECONCILED) throw new ConflictException('A reconciled payment cannot be reversed here; post a finance adjustment instead');
    await this.payments.reverseSettled(p.id, actor.id, reason);
    await this.notifications.notify({
      userId: p.userId,
      type: 'payment.reversed',
      title: 'A payment was reversed',
      body: `Payment ${p.reference} (${formatNgn(p.amountMinor)}) was reversed: ${reason}. Your balance has been updated.`,
      data: { paymentId: p.id },
      email: true,
    });
    return this.payments.adminGet(actor, p.id);
  }

  /** Marks verified money as matched to the bank settlement / cash banking record. */
  async reconcile(actor: AuthUser, paymentId: string, dto: { settlementReference: string; note?: string }) {
    const p = await this.staffPayment(actor, paymentId, P.paymentsReconcile);
    this.assertNotReporter(actor, p.reportedById, 'reconcile');
    const res = await this.prisma.payment.updateMany({
      where: { id: p.id, status: PaymentStatus.SUCCESS, reconciliationStatus: ReconciliationStatus.COLLECTION_VERIFIED },
      data: { reconciliationStatus: ReconciliationStatus.RECONCILED, reconciledById: actor.id, reconciledAt: new Date(), settlementReference: dto.settlementReference },
    });
    if (res.count !== 1) throw new ConflictException('Only verified, undisputed payments can be reconciled');
    const fresh = await this.prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
    await this.payments.event(this.prisma, fresh, 'finance.reconciled', actor.id, { settlementReference: dto.settlementReference, note: dto.note });
    await this.audit.record({ actorId: actor.id, action: 'payment.reconciled', entityType: 'payment', entityId: p.id, divisionId: p.divisionId, changes: { settlementReference: dto.settlementReference } });
    return this.payments.adminGet(actor, p.id);
  }

  /** Per-staff accountability: collections reported, verified, outstanding. */
  async collectionsByStaff(actor: AuthUser, q: { from?: string; to?: string; division?: string }) {
    const allowed = actor.divisionFilter(P.paymentsRead);
    let divisionIds = allowed;
    if (q.division) {
      const d = await this.divisions.resolve(q.division);
      actor.assertCan(P.paymentsRead, d.id);
      divisionIds = [d.id];
    }
    const rows = await this.prisma.payment.groupBy({
      by: ['reportedById', 'status', 'method'],
      where: {
        reportedById: { not: null },
        collectionPoint: { in: [CollectionPoint.DELIVERY, CollectionPoint.SERVICE_LOCATION] },
        divisionId: divisionIds ? { in: divisionIds } : undefined,
        createdAt: q.from || q.to ? { gte: q.from ? new Date(q.from) : undefined, lt: q.to ? new Date(q.to) : undefined } : undefined,
      },
      _sum: { claimedAmountMinor: true, amountMinor: true },
      _count: true,
    });
    const staff = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.reportedById!))] } },
      select: { id: true, email: true, staffProfile: { select: { firstName: true, lastName: true, employeeNumber: true } } },
    });
    return staff.map((s) => {
      const mine = rows.filter((r) => r.reportedById === s.id);
      const sum = (pred: (r: (typeof rows)[number]) => boolean, f: 'claimedAmountMinor' | 'amountMinor') =>
        mine.filter(pred).reduce((acc, r) => acc + (r._sum[f] ?? 0n), 0n);
      return {
        staff: s,
        collections: mine.reduce((n, r) => n + r._count, 0),
        reportedMinor: sum(() => true, 'claimedAmountMinor'),
        awaitingVerificationMinor: sum((r) => r.status === PaymentStatus.AWAITING_VERIFICATION, 'claimedAmountMinor'),
        verifiedMinor: sum((r) => r.status === PaymentStatus.SUCCESS, 'amountMinor'),
        rejectedMinor: sum((r) => r.status === PaymentStatus.REJECTED, 'claimedAmountMinor'),
        shortfallMinor:
          sum((r) => r.status === PaymentStatus.SUCCESS, 'claimedAmountMinor') - sum((r) => r.status === PaymentStatus.SUCCESS, 'amountMinor'),
      };
    });
  }

  /** Orders, reservations and bookings with money still owed. */
  async outstandingBalances(actor: AuthUser, q: { division?: string; purpose?: PaymentPurpose }) {
    const allowed = actor.divisionFilter(P.paymentsRead);
    let divisionIds = allowed;
    if (q.division) {
      const d = await this.divisions.resolve(q.division);
      actor.assertCan(P.paymentsRead, d.id);
      divisionIds = [d.id];
    }
    const inDiv = divisionIds ? { in: divisionIds } : undefined;
    const states = { in: ['UNPAID', 'AWAITING_VERIFICATION', 'PARTIALLY_PAID'] as const } as any;
    const take = 200;
    const [orders, reservations, bookings, spa] = await Promise.all([
      !q.purpose || q.purpose === 'ORDER'
        ? this.prisma.order.findMany({
            where: { divisionId: inDiv, paymentStatus: states, status: { notIn: [OrderStatus.CANCELLED, OrderStatus.EXPIRED] } },
            select: { id: true, orderNumber: true, status: true, paymentOption: true, paymentStatus: true, totalMinor: true, amountPaidMinor: true, depositRequiredMinor: true, createdAt: true, user: { select: { email: true, isGuest: true, contactEmail: true, contactPhone: true } } },
            orderBy: { createdAt: 'desc' },
            take,
          })
        : [],
      !q.purpose || q.purpose === 'APARTMENT_RESERVATION'
        ? this.prisma.reservation.findMany({
            where: { paymentStatus: states, status: { in: ['HOLD', 'CONFIRMED', 'CHECKED_IN'] }, unit: { property: { divisionId: inDiv } } },
            select: { id: true, reservationNumber: true, status: true, paymentStatus: true, totalMinor: true, amountPaidMinor: true, depositRequiredMinor: true, checkIn: true, user: { select: { email: true, isGuest: true, contactEmail: true, contactPhone: true } } },
            orderBy: { checkIn: 'asc' },
            take,
          })
        : [],
      !q.purpose || q.purpose === 'SERVICE_BOOKING'
        ? this.prisma.serviceBooking.findMany({
            where: { divisionId: inDiv, paymentStatus: states, priceMinor: { not: null }, status: { notIn: ['CANCELLED', 'NO_SHOW'] } },
            select: { id: true, bookingNumber: true, status: true, paymentStatus: true, priceMinor: true, amountPaidMinor: true, depositRequiredMinor: true, scheduledStart: true, user: { select: { email: true, isGuest: true, contactEmail: true, contactPhone: true } } },
            take,
          })
        : [],
      !q.purpose || q.purpose === 'SPA_APPOINTMENT'
        ? this.prisma.spaAppointment.findMany({
            where: { paymentStatus: states, status: { notIn: ['CANCELLED', 'NO_SHOW'] }, treatment: { divisionId: inDiv } },
            select: { id: true, appointmentNumber: true, status: true, paymentStatus: true, priceMinor: true, amountPaidMinor: true, depositRequiredMinor: true, startsAt: true, user: { select: { email: true, isGuest: true, contactEmail: true, contactPhone: true } } },
            orderBy: { startsAt: 'asc' },
            take,
          })
        : [],
    ]);
    const row = (purpose: PaymentPurpose, id: string, label: string, status: string, paymentStatus: string, total: bigint, paid: bigint, deposit: bigint, when: Date | null, email: string, extra: Record<string, unknown> = {}) => ({
      purpose, id, label, status, paymentStatus, totalDueMinor: total, paidMinor: paid, outstandingMinor: total - paid, depositRequiredMinor: deposit, date: when, customer: email, ...extra,
    });
    return [
      ...orders.map((o) => row('ORDER', o.id, o.orderNumber, o.status, o.paymentStatus, o.totalMinor, o.amountPaidMinor, o.depositRequiredMinor, o.createdAt, o.user.email, { paymentOption: o.paymentOption })),
      ...reservations.map((r) => row('APARTMENT_RESERVATION', r.id, r.reservationNumber, r.status, r.paymentStatus, r.totalMinor, r.amountPaidMinor, r.depositRequiredMinor, r.checkIn, r.user.email)),
      ...bookings.map((b) => row('SERVICE_BOOKING', b.id, b.bookingNumber, b.status, b.paymentStatus, b.priceMinor ?? 0n, b.amountPaidMinor, b.depositRequiredMinor, b.scheduledStart, b.user.email)),
      ...spa.map((a) => row('SPA_APPOINTMENT', a.id, a.appointmentNumber, a.status, a.paymentStatus, a.priceMinor, a.amountPaidMinor, a.depositRequiredMinor, a.startsAt, a.user.email)),
    ];
  }

  // ---------------------------------------------------------------------------

  private assertNotReporter(actor: AuthUser, reportedById: string | null, action: string) {
    if (reportedById && reportedById === actor.id) {
      throw new ForbiddenException(`Separation of duties: you reported this payment, so another authorised person must ${action} it`);
    }
  }

  private async staffPayment(actor: AuthUser, id: string, permission: (typeof P)[keyof typeof P]) {
    const p = await this.prisma.payment.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Payment not found');
    actor.assertCan(permission, p.divisionId);
    return p;
  }

  private async ownedPayment(user: AuthUser, reference: string, method: PaymentMethod) {
    const p = await this.prisma.payment.findUnique({ where: { reference } });
    if (!p || p.userId !== user.id || p.method !== method) throw new NotFoundException('Payment not found');
    return p;
  }
}
