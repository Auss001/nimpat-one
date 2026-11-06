import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfirmationRule, DepositType, PaymentPurpose, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../access/auth-user';
import { P } from '../access/permissions';
import { AuditService } from '../audit/audit.service';
import { DivisionsService } from '../divisions/divisions.service';
import { PaymentPolicyService } from './payment-policy.service';

export interface BankAccountInput {
  division?: string | null;
  label: string;
  bankName: string;
  accountName: string;
  accountNumber: string;
  isActive?: boolean;
}

export interface PolicyInput {
  allowPaystack?: boolean;
  allowBankTransfer?: boolean;
  allowPayOnDelivery?: boolean;
  allowPayAtLocation?: boolean;
  payOnDeliveryMinOrderMinor?: number | null;
  payOnDeliveryMaxOrderMinor?: number | null;
  depositType?: DepositType;
  depositPercentBps?: number | null;
  depositFixedMinor?: number | null;
  confirmationRule?: ConfirmationRule;
  bankTransferWindowHours?: number;
}

/** Masks all but the last 4 digits for listings. */
export function maskAccount(n: string): string {
  return `******${n.slice(-4)}`;
}

/**
 * Admin-managed payment configuration. Only payments:configure (Super
 * Administrator by default) can change receiving accounts and policies;
 * every change is audited with before/after values.
 */
@Injectable()
export class PaymentSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly divisions: DivisionsService,
    private readonly policies: PaymentPolicyService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------- bank accounts

  async listAccounts(actor: AuthUser) {
    const full = actor.hasAny(P.paymentsConfigure);
    const rows = await this.prisma.bankAccount.findMany({ orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }], include: { division: { select: { code: true, name: true } } } });
    // Account numbers are shown in full only to people who manage them.
    return rows.map((r) => ({ ...r, accountNumber: full ? r.accountNumber : maskAccount(r.accountNumber) }));
  }

  async createAccount(actor: AuthUser, dto: BankAccountInput) {
    const divisionId = dto.division ? (await this.divisions.resolve(dto.division)).id : null;
    const acc = await this.prisma.bankAccount.create({
      data: { divisionId, label: dto.label, bankName: dto.bankName, accountName: dto.accountName, accountNumber: dto.accountNumber, isActive: dto.isActive ?? true, createdById: actor.id },
    });
    await this.audit.record({ actorId: actor.id, action: 'payment_settings.bank_account.create', entityType: 'bank_account', entityId: acc.id, divisionId, changes: { label: dto.label, bankName: dto.bankName, accountName: dto.accountName, accountNumber: maskAccount(dto.accountNumber) } });
    return acc;
  }

  async updateAccount(actor: AuthUser, id: string, dto: Partial<BankAccountInput>) {
    const before = await this.prisma.bankAccount.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Bank account not found');
    const { division, ...rest } = dto;
    const acc = await this.prisma.bankAccount.update({
      where: { id },
      data: { ...rest, divisionId: division === undefined ? undefined : division ? (await this.divisions.resolve(division)).id : null },
    });
    await this.audit.record({
      actorId: actor.id, action: 'payment_settings.bank_account.update', entityType: 'bank_account', entityId: id, divisionId: acc.divisionId,
      changes: { before: { ...before, accountNumber: maskAccount(before.accountNumber) }, after: { ...rest, accountNumber: rest.accountNumber ? maskAccount(rest.accountNumber) : undefined } },
    });
    return acc;
  }

  // ---------------------------------------------------------------- service locations

  listLocations(divisionSlug?: string) {
    return this.prisma.serviceLocation.findMany({
      where: divisionSlug ? { division: { slug: divisionSlug } } : {},
      orderBy: [{ divisionId: 'asc' }, { name: 'asc' }],
      include: { division: { select: { code: true, name: true, slug: true } } },
    });
  }

  async createLocation(actor: AuthUser, dto: Prisma.ServiceLocationUncheckedCreateInput & { division: string }) {
    const { division, ...data } = dto;
    const d = await this.divisions.resolve(division);
    const loc = await this.prisma.serviceLocation.create({ data: { ...data, divisionId: d.id } });
    await this.audit.record({ actorId: actor.id, action: 'payment_settings.location.create', entityType: 'service_location', entityId: loc.id, divisionId: d.id, changes: { ...data } });
    return loc;
  }

  async updateLocation(actor: AuthUser, id: string, dto: Prisma.ServiceLocationUpdateInput) {
    const loc = await this.prisma.serviceLocation.update({ where: { id }, data: dto });
    await this.audit.record({ actorId: actor.id, action: 'payment_settings.location.update', entityType: 'service_location', entityId: id, divisionId: loc.divisionId, changes: { ...dto } });
    return loc;
  }

  // ---------------------------------------------------------------- policies

  /** Effective policy for every division × transaction type (defaults included). */
  async listPolicies() {
    const divisions = await this.divisions.all();
    const out = [];
    for (const d of divisions) {
      for (const purpose of Object.values(PaymentPurpose)) {
        out.push({ division: { id: d.id, code: d.code, name: d.name, slug: d.slug }, ...(await this.policies.get(d.id, purpose)) });
      }
    }
    return out;
  }

  async upsertPolicy(actor: AuthUser, division: string, purpose: PaymentPurpose, dto: PolicyInput) {
    const d = await this.divisions.resolve(division);
    if (dto.depositType === DepositType.PERCENT && !dto.depositPercentBps) throw new BadRequestException('depositPercentBps is required for a percentage deposit');
    if (dto.depositType === DepositType.FIXED && !dto.depositFixedMinor) throw new BadRequestException('depositFixedMinor is required for a fixed deposit');
    if (dto.allowPayOnDelivery && purpose !== PaymentPurpose.ORDER) throw new BadRequestException('Pay on delivery applies to product orders only');
    const before = await this.policies.get(d.id, purpose);
    const data = {
      ...dto,
      payOnDeliveryMinOrderMinor: dto.payOnDeliveryMinOrderMinor === undefined ? undefined : dto.payOnDeliveryMinOrderMinor === null ? null : BigInt(dto.payOnDeliveryMinOrderMinor),
      payOnDeliveryMaxOrderMinor: dto.payOnDeliveryMaxOrderMinor === undefined ? undefined : dto.payOnDeliveryMaxOrderMinor === null ? null : BigInt(dto.payOnDeliveryMaxOrderMinor),
      depositFixedMinor: dto.depositFixedMinor === undefined ? undefined : dto.depositFixedMinor === null ? null : BigInt(dto.depositFixedMinor),
      updatedById: actor.id,
    };
    const saved = await this.prisma.paymentPolicy.upsert({
      where: { divisionId_purpose: { divisionId: d.id, purpose } },
      create: { divisionId: d.id, purpose, ...data },
      update: data,
    });
    await this.audit.record({ actorId: actor.id, action: 'payment_settings.policy.update', entityType: 'payment_policy', entityId: saved.id, divisionId: d.id, changes: { purpose, before, after: dto as Record<string, unknown> } });
    return saved;
  }

  /** Public, customer-safe view of how a division accepts payment (no account details). */
  async publicMethods(division: string, purpose: PaymentPurpose) {
    const d = await this.divisions.resolve(division);
    const policy = await this.policies.get(d.id, purpose);
    const hasAccount = !!(await this.policies.beneficiaryAccount(d.id));
    const locations = await this.prisma.serviceLocation.findMany({
      where: { divisionId: d.id, isActive: true },
      select: { id: true, name: true, addressLine: true, city: true, state: true, acceptsCash: true, acceptsBankTransfer: true, acceptsCardTerminal: true },
    });
    return {
      division: { code: d.code, name: d.name, slug: d.slug },
      purpose,
      paystack: policy.allowPaystack,
      bankTransfer: policy.allowBankTransfer && hasAccount,
      payOnDelivery: purpose === PaymentPurpose.ORDER && policy.allowPayOnDelivery,
      payOnDeliveryLimits: { minOrderMinor: policy.payOnDeliveryMinOrderMinor, maxOrderMinor: policy.payOnDeliveryMaxOrderMinor },
      payAtLocation: policy.allowPayAtLocation && locations.length > 0,
      locations,
      deposit: { type: policy.depositType, percentBps: policy.depositPercentBps, fixedMinor: policy.depositFixedMinor },
      confirmationRule: policy.confirmationRule,
      bankTransferWindowHours: policy.bankTransferWindowHours,
    };
  }
}
