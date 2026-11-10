/**
 * Nigerian VAT on goods, added on top of the listed item prices.
 * Only Water, Drinks & Wines charges it for now (owner's decision, 10 November 2026).
 * Rates are in basis points: 750 = 7.5%.
 */
const VAT_BPS: Record<string, number> = { WATER_DRINKS_WINES: 750 };

export function vatRateBps(divisionCode: string): number {
  return VAT_BPS[divisionCode] ?? 0;
}

/** VAT on the items, rounded to the nearest kobo (halves round up). Delivery is not taxed here. */
export function vatOn(divisionCode: string, subtotalMinor: bigint): bigint {
  const bps = BigInt(vatRateBps(divisionCode));
  if (bps === 0n || subtotalMinor <= 0n) return 0n;
  return (subtotalMinor * bps + 5_000n) / 10_000n;
}
