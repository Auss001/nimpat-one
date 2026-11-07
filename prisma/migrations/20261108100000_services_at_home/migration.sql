-- Services can be grouped (lab tests, car hire, hire purchase, logistics …) and can happen at the customer's home.
CREATE TYPE "ServiceMode" AS ENUM ('AT_VENUE', 'AT_HOME', 'EITHER');
ALTER TYPE "InquiryType" ADD VALUE 'HIRE_PURCHASE';

ALTER TABLE "service_offerings"
  ADD COLUMN "category" TEXT,
  ADD COLUMN "service_mode" "ServiceMode" NOT NULL DEFAULT 'AT_VENUE',
  ADD COLUMN "home_fee_minor" BIGINT,
  ADD COLUMN "sort_order" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "service_bookings"
  ADD COLUMN "at_home" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "service_address" JSONB,
  ADD COLUMN "home_fee_minor" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "spa_treatments"
  ADD COLUMN "home_service" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "home_fee_minor" BIGINT;

ALTER TABLE "spa_appointments"
  ADD COLUMN "at_home" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "home_address" JSONB,
  ADD COLUMN "home_fee_minor" BIGINT NOT NULL DEFAULT 0;
