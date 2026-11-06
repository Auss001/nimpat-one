import { PrescriptionStatus, ProductAvailability } from '@prisma/client';

interface RuleProduct {
  purchaseEnabled: boolean;
  listedAvailability: ProductAvailability | null;
  prescriptionStatus: PrescriptionStatus | null;
  pharmacistApprovedAt: Date | null;
}

/**
 * Why a product cannot be bought right now, or null when it can. Stock and
 * company confirmation are checked separately.
 *
 * Prescription-only and restricted medicines cannot be bought online at all
 * until a prescription check exists; customers book a pharmacist instead.
 */
export function purchaseBlock(product: RuleProduct, variant: { unitPriceMinor: bigint | null }): string | null {
  if (product.prescriptionStatus !== null) {
    if (product.prescriptionStatus === PrescriptionStatus.REQUIRED || product.prescriptionStatus === PrescriptionStatus.RESTRICTED) {
      return 'This medicine needs a pharmacist and prescription review. Please book a pharmacist.';
    }
    if (product.prescriptionStatus === PrescriptionStatus.NOT_REVIEWED || !product.pharmacistApprovedAt) {
      return 'This product is awaiting pharmacist approval';
    }
  }
  if (variant.unitPriceMinor === null) return 'The price has not been published. Please contact Nimpat for the price.';
  if (product.listedAvailability === ProductAvailability.OUT_OF_STOCK) return 'This item is out of stock';
  if (!product.purchaseEnabled) return 'Availability must be confirmed with Nimpat before this can be bought';
  return null;
}
