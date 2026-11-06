import { ConfirmationRule, DepositType, PaymentPurpose } from '@prisma/client';
import { PaymentSummary } from './payment-ledger.service';
import { EffectivePolicy, PaymentPolicyService } from './payment-policy.service';

const svc = new PaymentPolicyService(null as never);
const policy = (p: Partial<EffectivePolicy>): EffectivePolicy => ({
  divisionId: 'd', purpose: PaymentPurpose.APARTMENT_RESERVATION, allowPaystack: true, allowBankTransfer: false, allowPayOnDelivery: false,
  allowPayAtLocation: false, payOnDeliveryMinOrderMinor: null, payOnDeliveryMaxOrderMinor: null, depositType: DepositType.NONE,
  depositPercentBps: null, depositFixedMinor: null, confirmationRule: ConfirmationRule.FULL_PAYMENT, bankTransferWindowHours: 24, configured: true, ...p,
});
const summary = (paid: bigint, total: bigint, deposit: bigint): PaymentSummary => ({
  currency: 'NGN', totalDueMinor: total, depositRequiredMinor: deposit, paidMinor: paid, overpaidMinor: 0n, refundedMinor: 0n,
  awaitingVerificationMinor: 0n, outstandingMinor: total - paid, depositOutstandingMinor: deposit > paid ? deposit - paid : 0n,
  depositSatisfied: paid >= deposit, fullyPaid: paid >= total, paymentStatus: paid >= total ? 'PAID' : paid > 0n ? 'PARTIALLY_PAID' : 'UNPAID',
});

describe('deposits (exact kobo)', () => {
  it('percentage deposits round up to the next kobo', () => {
    expect(svc.depositFor(policy({ depositType: DepositType.PERCENT, depositPercentBps: 3000 }), 1_000_001n)).toBe(300_001n);
    expect(svc.depositFor(policy({ depositType: DepositType.PERCENT, depositPercentBps: 3000 }), 1_000_000n)).toBe(300_000n);
  });
  it('fixed deposits never exceed the total; record-level deposits win', () => {
    expect(svc.depositFor(policy({ depositType: DepositType.FIXED, depositFixedMinor: 500n }), 300n)).toBe(300n);
    expect(svc.depositFor(policy({ depositType: DepositType.PERCENT, depositPercentBps: 5000 }), 10_000n, 1_234n)).toBe(1_234n);
    expect(svc.depositFor(policy({}), 10_000n)).toBe(0n);
  });
});

describe('confirmation rules', () => {
  it('FULL_PAYMENT needs the whole amount', () => {
    const p = policy({ confirmationRule: ConfirmationRule.FULL_PAYMENT });
    expect(svc.confirmationMet(p, summary(999n, 1000n, 300n))).toBe(false);
    expect(svc.confirmationMet(p, summary(1000n, 1000n, 300n))).toBe(true);
  });
  it('DEPOSIT_VERIFIED needs the verified deposit', () => {
    const p = policy({ confirmationRule: ConfirmationRule.DEPOSIT_VERIFIED });
    expect(svc.confirmationMet(p, summary(299n, 1000n, 300n))).toBe(false);
    expect(svc.confirmationMet(p, summary(300n, 1000n, 300n))).toBe(true);
    expect(svc.confirmationMet(p, summary(0n, 1000n, 0n))).toBe(false);
  });
  it('STAFF_APPROVAL never confirms automatically', () => {
    expect(svc.confirmationMet(policy({ confirmationRule: ConfirmationRule.STAFF_APPROVAL }), summary(1000n, 1000n, 0n))).toBe(false);
  });
});
