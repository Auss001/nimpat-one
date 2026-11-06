-- Pharmacy & Laboratory division and the pharmacist role.
ALTER TYPE "DivisionCode" ADD VALUE IF NOT EXISTS 'PHARMACY';
ALTER TYPE "RoleCode" ADD VALUE IF NOT EXISTS 'PHARMACIST';

CREATE TYPE "ProductAvailability" AS ENUM ('IN_STOCK', 'OUT_OF_STOCK');
CREATE TYPE "PrescriptionStatus" AS ENUM ('NOT_REVIEWED', 'NOT_REQUIRED', 'REQUIRED', 'RESTRICTED');

-- A price can be unpublished: null, never zero.
ALTER TABLE "product_variants"
  ALTER COLUMN "unit_price_minor" DROP NOT NULL,
  ADD COLUMN "recorded_stock_qty" INTEGER,
  ADD COLUMN "recorded_stock_at" DATE;

ALTER TABLE "products"
  ADD COLUMN "listed_availability" "ProductAvailability",
  ADD COLUMN "purchase_enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "prescription_status" "PrescriptionStatus",
  ADD COLUMN "pharmacist_approved_at" TIMESTAMPTZ(3),
  ADD COLUMN "pharmacist_approved_by_id" UUID,
  ADD COLUMN "verification_note" TEXT;

-- Car lists can arrive without a price or a stated condition.
ALTER TABLE "vehicles"
  ALTER COLUMN "price_minor" DROP NOT NULL,
  ALTER COLUMN "condition" DROP NOT NULL;
