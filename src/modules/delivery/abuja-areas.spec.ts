import { ABUJA_AREAS, ABUJA_RINGS } from './abuja-areas';

describe('Abuja delivery rings', () => {
  it('lists each area once', () => {
    const names = ABUJA_AREAS.map((a) => a.area.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });
  it("matches the owner's list of 11 November 2026", () => {
    const fee = (area: string) => ABUJA_RINGS.find((r) => r.areas.includes(area));
    expect(fee('Wuye')!.feeMinor).toBe(0n);
    expect(fee('Utako')!.feeMinor).toBe(0n);
    for (const a of ['Jabi', 'Jahi', 'Garki', 'Wuse', 'Central Area']) expect(fee(a)!.feeMinor).toBe(500_000n);
    for (const a of ['Gudu', 'Apo']) expect(fee(a)!.feeMinor).toBe(700_000n);
    for (const a of ['Gwarinpa', 'Asokoro', 'Guzape']) expect(fee(a)).toEqual(expect.objectContaining({ feeMinor: 700_000n, bulk: { feeMinor: 1_000_000n, fromQty: 10 } }));
    for (const a of ['Lugbe', 'Games Village', 'Galadimawa']) expect(fee(a)!.feeMinor).toBe(1_000_000n);
    expect(fee('Airport')!.feeMinor).toBe(1_500_000n);
  });
});
