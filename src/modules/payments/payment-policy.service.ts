import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfirmationRule, DepositType, PaymentOption, PaymentPolicy, PaymentPurpose } from '@prisma/client';
import { PrismaService, Tx } from '../../prisma/prisma.service';
import { PaymentSummary } from './payment-ledger.service';

/** Conservative defaults used until an administrator configures a policy. */
const DEFAULT_RULE: Record<PaymentPurpose, ConfirmationRule> = {
  ORDER: ConfirmationRule.FULL_PAYMENT,
  APARTMENT_RESERVATION: ConfirmationRule.FULL_PAYMENT,
  SERVICE_BOOKING: ConfirmationRule.DEPOSIT_VERIFIED,
  SPA_APPOINTMENT: ConfirmationRule.DEPOSIT_VERIFIED,
  VEHICLE_DEPOSIT: ConfirmationRule.FULL_PAYMENT,
  LOGISTICS_REQUEST: ConfirmationRule.FULL_PAYMENT,
  QUOTATION: ConfirmationRule.FULL_PAYMENT,
};

export type EffectivePolicy = Omit<PaymentPolicy, 'id' | 'createdAt' | 'updatedAt' | 'updatedById'> & { configured: boolean };

export interface PaymentOptionInfo {
  option: PaymentOption;
  available: boolean;
  reason?: string;
}

@Injectable()
export class PaymentPolicyService {
  constructor(private readonly prisma: PrismaService) {}

  async get(divisionId: string, purpose: PaymentPurpose, db: Tx | PrismaService = this.prisma): Promise<EffectivePolicy> {
    const p = await db.paymentPolicy.findUnique({ where: { divisionId_purpose: { divisionId, purpose } } });
    if (p) {
      const { id, createdAt, updatedAt, updatedById, ...rest } = p;
      return { ...rest, configured: true };
    }
    return {
      divisionId,
      purpose,
      allowPaystack: true,
      allowBankTransfer: false,
      allowPayOnDelivery: false,
      allowPayAtLocation: false,
      payOnDeliveryMinOrderMinor: null,
      payOnDeliveryMaxOrderMinor: null,
      depositType: DepositType.NONE,
      depositPercentBps: null,
      depositFixedMinor: null,
      confirmationRule: DEFAULT_RULE[purpose],
      bankTransferWindowHours: 24,
      configured: false,
    };
  }

  /**
   * Deposit for a given total. A record-level deposit (e.g. a spa treatment's
   * or a rental's own deposit) wins over the division policy.
   */
  depositFor(policy: EffectivePolicy, totalMinor: bigint, recordDepositMinor?: bigint | null): bigint {
    if (recordDepositMinor && recordDepositMinor > 0n) return recordDepositMinor > totalMinor ? totalMinor : recordDepositMinor;
    switch (policy.depositType) {
      case DepositType.PERCENT:
        // Integer maths: round the deposit UP to the next kobo.
        return policy.depositPercentBps ? (totalMinor * BigInt(policy.depositPercentBps) + 9_999n) / 10_000n : 0n;
      case DepositType.FIXED: {
        const fixed = policy.depositFixedMinor ?? 0n;
        return fixed > totalMinor ? totalMinor : fixed;
      }
      default:
        return 0n;
    }
  }

  /** True if the verified balance satisfies the department's confirmation rule. */
  confirmationMet(policy: EffectivePolicy, summary: PaymentSummary): boolean {
    switch (policy.confirmationRule) {
      case ConfirmationRule.FULL_PAYMENT:
        return summary.fullyPaid;
      case ConfirmationRule.DEPOSIT_VERIFIED:
        return summary.fullyPaid || (summary.depositRequiredMinor > 0n ? summary.paidMinor >= summary.depositRequiredMinor : summary.paidMinor > 0n);
      case ConfirmationRule.STAFF_APPROVAL:
        return false; // a staff member must confirm explicitly
    }
  }

  /** Which payment options apply to an order at checkout (and why not). */
  async orderOptions(
    divisionId: string,
    opts: { fulfilment: 'DELIVERY' | 'PICKUP'; zoneId: string | null; orderValueMinor: bigint },
    db: Tx | PrismaService = this.prisma,
  ): Promise<PaymentOptionInfo[]> {
    const policy = await this.get(divisionId, PaymentPurpose.ORDER, db);
    const out: PaymentOptionInfo[] = [];
    out.push(policy.allowPaystack ? { option: 'PAYSTACK', available: true } : { option: 'PAYSTACK', available: false, reason: 'Online payment is not enabled for this division' });

    const account = await this.beneficiaryAccount(divisionId, db);
    out.push(
      !policy.allowBankTransfer
        ? { option: 'BANK_TRANSFER', available: false, reason: 'Bank transfer is not enabled for this division' }
        : !account
          ? { option: 'BANK_TRANSFER', available: false, reason: 'No receiving bank account is configured' }
          : { option: 'BANK_TRANSFER', available: true },
    );

    let pod: PaymentOptionInfo = { option: 'PAY_ON_DELIVERY', available: true };
    if (!policy.allowPayOnDelivery) pod = { option: 'PAY_ON_DELIVERY', available: false, reason: 'Pay on delivery is not enabled for this division' };
    else if (opts.fulfilment !== 'DELIVERY') pod = { option: 'PAY_ON_DELIVERY', available: false, reason: 'Only for delivery orders' };
    else if (!opts.zoneId) pod = { option: 'PAY_ON_DELIVERY', available: false, reason: 'Choose a delivery address first' };
    else {
      const zone = await db.deliveryZone.findUnique({ where: { id: opts.zoneId }, select: { payOnDeliveryEnabled: true } });
      if (!zone?.payOnDeliveryEnabled) pod = { option: 'PAY_ON_DELIVERY', available: false, reason: 'Pay on delivery is not available in this area' };
      else if (policy.payOnDeliveryMinOrderMinor !== null && opts.orderValueMinor < policy.payOnDeliveryMinOrderMinor) pod = { option: 'PAY_ON_DELIVERY', available: false, reason: 'Order value is below the pay-on-delivery minimum' };
      else if (policy.payOnDeliveryMaxOrderMinor !== null && opts.orderValueMinor > policy.payOnDeliveryMaxOrderMinor) pod = { option: 'PAY_ON_DELIVERY', available: false, reason: 'Order value is above the pay-on-delivery limit' };
    }
    out.push(pod);

    let atLocation: PaymentOptionInfo = { option: 'PAY_AT_LOCATION', available: true };
    if (!policy.allowPayAtLocation) atLocation = { option: 'PAY_AT_LOCATION', available: false, reason: 'Pay at pickup is not enabled for this division' };
    else if (opts.fulfilment !== 'PICKUP') atLocation = { option: 'PAY_AT_LOCATION', available: false, reason: 'Only for pickup orders' };
    else if (!(await db.serviceLocation.count({ where: { divisionId, isActive: true } }))) atLocation = { option: 'PAY_AT_LOCATION', available: false, reason: 'No pickup location is configured' };
    out.push(atLocation);
    return out;
  }

  assertOrderOption(options: PaymentOptionInfo[], chosen: PaymentOption): void {
    const o = options.find((x) => x.option === chosen);
    if (!o?.available) throw new BadRequestException(`${chosen.replace(/_/g, ' ').toLowerCase()} is not available: ${o?.reason ?? 'unknown option'}`);
  }

  /** The active receiving account for a division, or the group-wide default. */
  async beneficiaryAccount(divisionId: string, db: Tx | PrismaService = this.prisma) {
    return (
      (await db.bankAccount.findFirst({ where: { divisionId, isActive: true }, orderBy: { createdAt: 'desc' } })) ??
      (await db.bankAccount.findFirst({ where: { divisionId: null, isActive: true }, orderBy: { createdAt: 'desc' } }))
    );
  }
}
