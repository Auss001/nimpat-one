import { vatOn, vatRateBps } from './vat';

describe('VAT', () => {
  it('adds 7.5% to Water, Drinks & Wines only', () => {
    expect(vatRateBps('WATER_DRINKS_WINES')).toBe(750);
    expect(vatOn('WATER_DRINKS_WINES', 240_000n)).toBe(18_000n); // ₦2,400 → ₦180
    expect(vatOn('PHARMACY_LABORATORY', 240_000n)).toBe(0n);
  });
  it('rounds to the nearest kobo, halves up', () => {
    expect(vatOn('WATER_DRINKS_WINES', 2n)).toBe(0n); // 0.15 kobo
    expect(vatOn('WATER_DRINKS_WINES', 20n)).toBe(2n); // 1.5 kobo
    expect(vatOn('WATER_DRINKS_WINES', 0n)).toBe(0n);
  });
});
