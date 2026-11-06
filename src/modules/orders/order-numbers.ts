import { randomCode } from '../../common/utils/crypto';

export { businessNumber, withUniqueRetry } from '../../common/utils/references';

/** Delivery tracking code shown to customers, e.g. TRK-8K2M4Q9X. */
export function randomTrackingCode(): string {
  return `TRK-${randomCode(8)}`;
}
