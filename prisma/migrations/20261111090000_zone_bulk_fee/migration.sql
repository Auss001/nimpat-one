-- Larger orders can pay a different delivery fee in a zone (owner, 11 November 2026).
ALTER TABLE "delivery_zones" ADD COLUMN "bulk_fee_minor" BIGINT;
ALTER TABLE "delivery_zones" ADD COLUMN "bulk_from_qty" INTEGER;
