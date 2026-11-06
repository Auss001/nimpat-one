import { Injectable } from '@nestjs/common';
import { Payment, PaymentPurpose, Prisma } from '@prisma/client';
import { PrismaService, Tx } from '../../prisma/prisma.service';
import { AuthUser } from '../access/auth-user';
import { NotifyInput } from '../notifications/notifications.service';
import { PaymentSummary } from './payment-ledger.service';

/** What a payable (order, reservation, booking...) tells the payment module. */
export interface PayableContext {
  /** Full amount owed, computed on the server (kobo). */
  totalDueMinor: bigint;
  /** Minimum verified payment the department requires (0 = none). */
  depositRequiredMinor: bigint;
  currency: string;
  divisionId: string;
  userId: string;
  /** Human reference, e.g. order number. */
  label: string;
  description: string;
  /** Payment must be completed before this time, if any. */
  payBy?: Date | null;
  /** False when the payable can no longer receive payments (cancelled, expired...). */
  acceptsPayments: boolean;
  /** Why payments are not accepted, for error messages. */
  closedReason?: string;
  /** Delivery details for pay-on-delivery eligibility (orders only). */
  delivery?: { fulfilment: 'DELIVERY' | 'PICKUP'; zoneId: string | null; orderValueMinor: bigint };
}

/**
 * Each business module registers a handler for its payment purpose. The
 * payment module stays generic: it never computes prices itself. It asks the
 * owning module what is owed, keeps the ledger of verified payments, and
 * tells the module when the verified balance changes. The module then
 * applies its own confirmation policy.
 */
export interface PayableHandler {
  purpose: PaymentPurpose;
  /** Customer-facing load: checks ownership. */
  resolve(payableId: string, user: AuthUser): Promise<PayableContext>;
  /** Staff / ledger load: no ownership check. Runs inside the payment transaction. */
  load(db: Tx | PrismaService, payableId: string): Promise<PayableContext>;
  /**
   * Called inside the transaction that changed the verified balance (a
   * payment was verified, reversed or refunded). The module decides — using
   * its department policy — whether to accept/confirm. Never called merely
   * because a payment was initiated or reported. Return notifications.
   */
  onPaymentStateChanged(tx: Tx, payableId: string, summary: PaymentSummary, trigger: Payment): Promise<NotifyInput[] | void>;
  /** Optional: a bank transfer was started — extend holds/expiry until this time. */
  onBankTransferStarted?(tx: Tx, payableId: string, payBy: Date): Promise<void>;
  /** Optional: a payment definitively failed or was abandoned. */
  onPaymentFailed?(tx: Tx, payment: Payment): Promise<void>;
}

/** Maps a purpose to the payments table column holding the payable id. */
export const PAYABLE_COLUMN: Record<PaymentPurpose, keyof Prisma.PaymentUncheckedCreateInput & string> = {
  ORDER: 'orderId',
  APARTMENT_RESERVATION: 'reservationId',
  SERVICE_BOOKING: 'serviceBookingId',
  SPA_APPOINTMENT: 'spaAppointmentId',
  VEHICLE_DEPOSIT: 'vehicleInquiryId',
  LOGISTICS_REQUEST: 'logisticsRequestId',
  QUOTATION: 'quotationId',
};

/** Database table of each payable (constant map — never user input). */
export const PAYABLE_TABLE: Record<PaymentPurpose, string> = {
  ORDER: 'orders',
  APARTMENT_RESERVATION: 'reservations',
  SERVICE_BOOKING: 'service_bookings',
  SPA_APPOINTMENT: 'spa_appointments',
  VEHICLE_DEPOSIT: 'vehicle_inquiries',
  LOGISTICS_REQUEST: 'logistics_requests',
  QUOTATION: 'quotations',
};

/** Prisma delegate name of each payable. */
export const PAYABLE_MODEL: Record<PaymentPurpose, 'order' | 'reservation' | 'serviceBooking' | 'spaAppointment' | 'vehicleInquiry' | 'logisticsRequest' | 'quotation'> = {
  ORDER: 'order',
  APARTMENT_RESERVATION: 'reservation',
  SERVICE_BOOKING: 'serviceBooking',
  SPA_APPOINTMENT: 'spaAppointment',
  VEHICLE_DEPOSIT: 'vehicleInquiry',
  LOGISTICS_REQUEST: 'logisticsRequest',
  QUOTATION: 'quotation',
};

export function payableIdOf(payment: Payment): string {
  return (payment as unknown as Record<string, string>)[PAYABLE_COLUMN[payment.purpose]];
}

@Injectable()
export class PayableRegistry {
  private readonly handlers = new Map<PaymentPurpose, PayableHandler>();

  register(handler: PayableHandler): void {
    if (this.handlers.has(handler.purpose)) throw new Error(`Duplicate payable handler for ${handler.purpose}`);
    this.handlers.set(handler.purpose, handler);
  }

  get(purpose: PaymentPurpose): PayableHandler {
    const h = this.handlers.get(purpose);
    if (!h) throw new Error(`No payable handler registered for ${purpose}`);
    return h;
  }

  has(purpose: PaymentPurpose): boolean {
    return this.handlers.has(purpose);
  }
}
