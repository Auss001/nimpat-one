import { ABUJA_AREAS, ABUJA_RINGS } from './abuja-areas';

describe('Abuja delivery rings', () => {
  it('lists each area once', () => {
    const names = ABUJA_AREAS.map((a) => a.area.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });
  it('is free at Wuye and Utako and rises outwards to ₦10,000', () => {
    expect(ABUJA_RINGS[0].areas).toEqual(['Wuye', 'Utako']);
    expect(ABUJA_RINGS[0].feeMinor).toBe(0n);
    const fees = ABUJA_RINGS.map((r) => r.feeMinor);
    expect([...fees].sort((a, b) => (a < b ? -1 : 1))).toEqual(fees);
    expect(fees.at(-1)).toBe(1_000_000n);
    expect(ABUJA_RINGS.at(-1)!.areas).toEqual(expect.arrayContaining(['Kubwa', 'Gwarinpa']));
  });
});
