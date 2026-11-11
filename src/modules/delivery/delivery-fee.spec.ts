import { DeliveryService } from './delivery.service';

/** The delivery fee rule, with zones served from memory instead of the database. */
const zone = (over: Record<string, unknown>) => ({
  id: 'z', name: 'Zone', state: 'FCT', cities: ['gwarinpa'], feeMinor: 700_000n, freeAboveMinor: null, estimatedHours: null,
  bulkFeeMinor: null, bulkFromQty: null, isActive: true, verification: 'VERIFIED', ...over,
});
const db = (zones: unknown[]) => ({ deliveryZone: { findMany: async () => zones } }) as never;
const svc = new DeliveryService({} as never, {} as never, {} as never);
const at = { state: 'FCT', city: 'Gwarinpa' };

describe('delivery fee', () => {
  it('charges the normal fee for smaller orders and the larger-order fee from the set quantity', async () => {
    const zones = [zone({ bulkFeeMinor: 1_000_000n, bulkFromQty: 10 })];
    expect((await svc.quote('d', at, 0n, 9, db(zones))).feeMinor).toBe(700_000n);
    expect((await svc.quote('d', at, 0n, 10, db(zones))).feeMinor).toBe(1_000_000n);
  });

  it('charges a zone without a larger-order fee the same for any quantity', async () => {
    expect((await svc.quote('d', at, 0n, 50, db([zone({})]))).feeMinor).toBe(700_000n);
  });

  it('still delivers free above a free-delivery amount', async () => {
    const zones = [zone({ bulkFeeMinor: 1_000_000n, bulkFromQty: 10, freeAboveMinor: 5_000_000n })];
    expect((await svc.quote('d', at, 6_000_000n, 20, db(zones))).feeMinor).toBe(0n);
  });
});
