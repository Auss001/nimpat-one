import { DivisionCode } from '@prisma/client';
import { randomCode } from './crypto';

/** Short division prefixes used in human-facing reference numbers. */
export const DIVISION_PREFIX: Record<DivisionCode, string> = {
  WATER_DRINKS_WINES: 'WDW',
  LUXURY_APARTMENTS: 'APT',
  AUTOMOBILES: 'AUT',
  SPA_WELLNESS: 'SPA',
  TRANSPORT_LOGISTICS: 'LOG',
  RETAIL_GENERAL_SUPPLIES: 'RTL',
  MEDIA_EVENTS_RENTALS: 'MER',
  REAL_ESTATE_INTERIOR: 'RED',
  ENTERTAINMENT: 'ENT',
};

function yymmdd(d = new Date()): string {
  return d.toISOString().slice(2, 10).replace(/-/g, '');
}

/** e.g. WDW-261105-7KQ2M9 (order / booking / quote numbers). */
export function businessNumber(division: DivisionCode, kind = ''): string {
  return [DIVISION_PREFIX[division] + kind, yymmdd(), randomCode(6)].join('-');
}

/** Unique Paystack transaction reference, e.g. NP1-WDW-261105-9X3K7Q2M4T. */
export function paymentReference(division: DivisionCode): string {
  return ['NP1', DIVISION_PREFIX[division], yymmdd(), randomCode(10)].join('-');
}

/** Logistics consignment number, e.g. NMP-LOG-7KQ2M9-NG. */
export function trackingNumber(): string {
  return `NMP-LOG-${randomCode(8)}-NG`;
}

/** Retries a create that may collide on a random unique number. */
export async function withUniqueRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e: any) {
      if (e?.code === 'P2002' && i < attempts - 1) continue;
      throw e;
    }
  }
}
