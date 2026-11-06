/**
 * Money helpers. All amounts are integer MINOR units (kobo for NGN) held as
 * BigInt. Never use floating point for money.
 */
export const KOBO_PER_NAIRA = 100n;

export function sumMinor(values: bigint[]): bigint {
  return values.reduce((acc, v) => acc + v, 0n);
}

export function multiplyMinor(unit: bigint, quantity: number): bigint {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new Error(`Invalid quantity ${quantity}`);
  }
  return unit * BigInt(quantity);
}

/** Converts a BigInt minor amount to a JS number for JSON (safe below 2^53). */
export function minorToNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error('Amount exceeds safe integer range');
  }
  return Number(value);
}

/** Human formatting for notifications only (never for calculation). */
export function formatNgn(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const naira = abs / KOBO_PER_NAIRA;
  const kobo = abs % KOBO_PER_NAIRA;
  const nairaStr = naira.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}₦${nairaStr}.${kobo.toString().padStart(2, '0')}`;
}
