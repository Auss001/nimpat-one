-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('PAYSTACK', 'BANK_TRANSFER', 'CASH', 'CARD_TERMINAL');

-- CreateEnum
CREATE TYPE "CollectionPoint" AS ENUM ('ONLINE', 'BANK', 'DELIVERY', 'SERVICE_LOCATION');

-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('NOT_COLLECTED', 'COLLECTION_REPORTED', 'COLLECTION_VERIFIED', 'RECONCILED', 'DISPUTED');

-- CreateEnum
CREATE TYPE "PayableState" AS ENUM ('UNPAID', 'AWAITING_VERIFICATION', 'PARTIALLY_PAID', 'PAID', 'REFUNDED', 'FAILED');

-- CreateEnum
CREATE TYPE "PaymentOption" AS ENUM ('PAYSTACK', 'BANK_TRANSFER', 'PAY_ON_DELIVERY', 'PAY_AT_LOCATION');

-- CreateEnum
CREATE TYPE "DepositType" AS ENUM ('NONE', 'PERCENT', 'FIXED');

-- CreateEnum
CREATE TYPE "ConfirmationRule" AS ENUM ('FULL_PAYMENT', 'DEPOSIT_VERIFIED', 'STAFF_APPROVAL');

-- CreateEnum
CREATE TYPE "RecordVerification" AS ENUM ('VERIFIED', 'AWAITING_CONFIRMATION', 'DEV_SAMPLE');

-- AlterEnum: BookingStatus PENDING_PAYMENT -> PENDING (payment is now tracked separately).
-- Renamed in place so the spa no-overlap exclusion constraint stays valid.
ALTER TYPE "BookingStatus" RENAME VALUE 'PENDING_PAYMENT' TO 'PENDING';

-- AlterEnum
BEGIN;
CREATE TYPE "OrderStatus_new" AS ENUM ('PENDING', 'ACCEPTED', 'PROCESSING', 'READY', 'OUT_FOR_DELIVERY', 'DELIVERED', 'COMPLETED', 'CANCELLED', 'EXPIRED');
ALTER TABLE "public"."orders" ALTER COLUMN "status" DROP DEFAULT;
-- Fulfilment status is separated from payment: PENDING_PAYMENT -> PENDING,
-- PAID -> ACCEPTED, REFUNDED -> CANCELLED (its payment state is backfilled below).
ALTER TABLE "orders" ALTER COLUMN "status" TYPE "OrderStatus_new" USING (
  CASE "status"::text WHEN 'PENDING_PAYMENT' THEN 'PENDING' WHEN 'PAID' THEN 'ACCEPTED' WHEN 'REFUNDED' THEN 'CANCELLED' ELSE "status"::text END
)::"OrderStatus_new";
ALTER TABLE "order_status_history" ALTER COLUMN "from_status" TYPE "OrderStatus_new" USING (
  CASE "from_status"::text WHEN 'PENDING_PAYMENT' THEN 'PENDING' WHEN 'PAID' THEN 'ACCEPTED' WHEN 'REFUNDED' THEN 'CANCELLED' ELSE "from_status"::text END
)::"OrderStatus_new";
ALTER TABLE "order_status_history" ALTER COLUMN "to_status" TYPE "OrderStatus_new" USING (
  CASE "to_status"::text WHEN 'PENDING_PAYMENT' THEN 'PENDING' WHEN 'PAID' THEN 'ACCEPTED' WHEN 'REFUNDED' THEN 'CANCELLED' ELSE "to_status"::text END
)::"OrderStatus_new";
ALTER TYPE "OrderStatus" RENAME TO "OrderStatus_old";
ALTER TYPE "OrderStatus_new" RENAME TO "OrderStatus";
DROP TYPE "public"."OrderStatus_old";
ALTER TABLE "orders" ALTER COLUMN "status" SET DEFAULT 'PENDING';
COMMIT;

-- AlterEnum
ALTER TYPE "PaymentStatus" ADD VALUE 'AWAITING_VERIFICATION';
ALTER TYPE "PaymentStatus" ADD VALUE 'REJECTED';

-- AlterEnum
ALTER TYPE "RoleCode" ADD VALUE 'FINANCE_OFFICER';

-- AlterTable
ALTER TABLE "apartment_units" ADD COLUMN     "verification" "RecordVerification" NOT NULL DEFAULT 'AWAITING_CONFIRMATION',
ADD COLUMN     "verified_at" TIMESTAMPTZ(3),
ADD COLUMN     "verified_by_id" UUID;

-- AlterTable
ALTER TABLE "delivery_zones" ADD COLUMN     "pay_on_delivery_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "verification" "RecordVerification" NOT NULL DEFAULT 'AWAITING_CONFIRMATION',
ADD COLUMN     "verified_at" TIMESTAMPTZ(3),
ADD COLUMN     "verified_by_id" UUID;

-- AlterTable
ALTER TABLE "logistics_requests" ADD COLUMN     "amount_paid_minor" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "deposit_required_minor" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "payment_status" "PayableState" NOT NULL DEFAULT 'UNPAID';

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "amount_paid_minor" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "deposit_required_minor" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "payment_option" "PaymentOption" NOT NULL DEFAULT 'PAYSTACK',
ADD COLUMN     "payment_status" "PayableState" NOT NULL DEFAULT 'UNPAID',
ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- AlterTable
ALTER TABLE "payment_events" ADD COLUMN     "actor_id" UUID;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "beneficiary_account_id" UUID,
ADD COLUMN     "claimed_amount_minor" BIGINT,
ADD COLUMN     "collected_at" TIMESTAMPTZ(3),
ADD COLUMN     "collection_point" "CollectionPoint" NOT NULL DEFAULT 'ONLINE',
ADD COLUMN     "customer_reference" TEXT,
ADD COLUMN     "dispute_reason" TEXT,
ADD COLUMN     "disputed_at" TIMESTAMPTZ(3),
ADD COLUMN     "disputed_by_id" UUID,
ADD COLUMN     "method" "PaymentMethod" NOT NULL DEFAULT 'PAYSTACK',
ADD COLUMN     "note" TEXT,
ADD COLUMN     "payer_name" TEXT,
ADD COLUMN     "receipt_number" TEXT,
ADD COLUMN     "reconciled_at" TIMESTAMPTZ(3),
ADD COLUMN     "reconciled_by_id" UUID,
ADD COLUMN     "reconciliation_status" "ReconciliationStatus" NOT NULL DEFAULT 'NOT_COLLECTED',
ADD COLUMN     "rejection_reason" TEXT,
ADD COLUMN     "reported_at" TIMESTAMPTZ(3),
ADD COLUMN     "reported_by_id" UUID,
ADD COLUMN     "service_location_id" UUID,
ADD COLUMN     "settlement_reference" TEXT,
ADD COLUMN     "transferred_at" TIMESTAMPTZ(3),
ADD COLUMN     "verification_reference" TEXT,
ADD COLUMN     "verified_by_id" UUID;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "verification" "RecordVerification" NOT NULL DEFAULT 'AWAITING_CONFIRMATION',
ADD COLUMN     "verified_at" TIMESTAMPTZ(3),
ADD COLUMN     "verified_by_id" UUID;

-- AlterTable
ALTER TABLE "quotations" ADD COLUMN     "amount_paid_minor" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "deposit_required_minor" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "payment_status" "PayableState" NOT NULL DEFAULT 'UNPAID';

-- AlterTable
ALTER TABLE "reservations" ADD COLUMN     "amount_paid_minor" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "deposit_required_minor" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "payment_status" "PayableState" NOT NULL DEFAULT 'UNPAID';

-- AlterTable
ALTER TABLE "service_bookings" ADD COLUMN     "amount_paid_minor" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "deposit_required_minor" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "payment_status" "PayableState" NOT NULL DEFAULT 'UNPAID';

-- AlterTable
ALTER TABLE "service_offerings" ADD COLUMN     "verification" "RecordVerification" NOT NULL DEFAULT 'AWAITING_CONFIRMATION',
ADD COLUMN     "verified_at" TIMESTAMPTZ(3),
ADD COLUMN     "verified_by_id" UUID;

-- AlterTable
ALTER TABLE "spa_appointments" ADD COLUMN     "amount_paid_minor" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "deposit_required_minor" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "payment_status" "PayableState" NOT NULL DEFAULT 'UNPAID';

-- AlterTable
ALTER TABLE "spa_treatments" ADD COLUMN     "verification" "RecordVerification" NOT NULL DEFAULT 'AWAITING_CONFIRMATION',
ADD COLUMN     "verified_at" TIMESTAMPTZ(3),
ADD COLUMN     "verified_by_id" UUID;

-- AlterTable
ALTER TABLE "vehicle_inquiries" ADD COLUMN     "amount_paid_minor" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "deposit_required_minor" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "payment_status" "PayableState" NOT NULL DEFAULT 'UNPAID';

-- AlterTable
ALTER TABLE "vehicles" ADD COLUMN     "verification" "RecordVerification" NOT NULL DEFAULT 'AWAITING_CONFIRMATION',
ADD COLUMN     "verified_at" TIMESTAMPTZ(3),
ADD COLUMN     "verified_by_id" UUID;

-- CreateTable
CREATE TABLE "payment_proofs" (
    "id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "uploaded_by_id" UUID NOT NULL,
    "storage_key" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_proofs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_accounts" (
    "id" UUID NOT NULL,
    "division_id" UUID,
    "label" TEXT NOT NULL,
    "bank_name" TEXT NOT NULL,
    "account_name" TEXT NOT NULL,
    "account_number" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bank_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_locations" (
    "id" UUID NOT NULL,
    "division_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address_line" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "accepts_cash" BOOLEAN NOT NULL DEFAULT true,
    "accepts_bank_transfer" BOOLEAN NOT NULL DEFAULT true,
    "accepts_card_terminal" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "service_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_policies" (
    "id" UUID NOT NULL,
    "division_id" UUID NOT NULL,
    "purpose" "PaymentPurpose" NOT NULL,
    "allow_paystack" BOOLEAN NOT NULL DEFAULT true,
    "allow_bank_transfer" BOOLEAN NOT NULL DEFAULT false,
    "allow_pay_on_delivery" BOOLEAN NOT NULL DEFAULT false,
    "allow_pay_at_location" BOOLEAN NOT NULL DEFAULT false,
    "pay_on_delivery_min_order_minor" BIGINT,
    "pay_on_delivery_max_order_minor" BIGINT,
    "deposit_type" "DepositType" NOT NULL DEFAULT 'NONE',
    "deposit_percent_bps" INTEGER,
    "deposit_fixed_minor" BIGINT,
    "confirmation_rule" "ConfirmationRule" NOT NULL DEFAULT 'FULL_PAYMENT',
    "bank_transfer_window_hours" INTEGER NOT NULL DEFAULT 24,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_proofs_storage_key_key" ON "payment_proofs"("storage_key");

-- CreateIndex
CREATE INDEX "payment_proofs_payment_id_idx" ON "payment_proofs"("payment_id");

-- CreateIndex
CREATE INDEX "bank_accounts_division_id_is_active_idx" ON "bank_accounts"("division_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "service_locations_code_key" ON "service_locations"("code");

-- CreateIndex
CREATE INDEX "service_locations_division_id_is_active_idx" ON "service_locations"("division_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "payment_policies_division_id_purpose_key" ON "payment_policies"("division_id", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "payments_receipt_number_key" ON "payments"("receipt_number");

-- CreateIndex
CREATE INDEX "payments_method_status_created_at_idx" ON "payments"("method", "status", "created_at");

-- CreateIndex
CREATE INDEX "payments_reconciliation_status_created_at_idx" ON "payments"("reconciliation_status", "created_at");

-- CreateIndex
CREATE INDEX "payments_reported_by_id_created_at_idx" ON "payments"("reported_by_id", "created_at");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_beneficiary_account_id_fkey" FOREIGN KEY ("beneficiary_account_id") REFERENCES "bank_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_service_location_id_fkey" FOREIGN KEY ("service_location_id") REFERENCES "service_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_reported_by_id_fkey" FOREIGN KEY ("reported_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_verified_by_id_fkey" FOREIGN KEY ("verified_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_reconciled_by_id_fkey" FOREIGN KEY ("reconciled_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_proofs" ADD CONSTRAINT "payment_proofs_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_division_id_fkey" FOREIGN KEY ("division_id") REFERENCES "divisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_locations" ADD CONSTRAINT "service_locations_division_id_fkey" FOREIGN KEY ("division_id") REFERENCES "divisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_policies" ADD CONSTRAINT "payment_policies_division_id_fkey" FOREIGN KEY ("division_id") REFERENCES "divisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- =============================================================================
-- Backfill payment state from existing payment records (hand-written)
-- =============================================================================

-- Paystack payments that already succeeded were verified by the provider.
UPDATE "payments" SET "reconciliation_status" = 'COLLECTION_VERIFIED' WHERE "status" = 'SUCCESS';

-- Helper: verified (successful, net of refunds) and refunded totals per payable.
CREATE TEMP TABLE payable_totals AS
SELECT
  COALESCE("order_id", "reservation_id", "service_booking_id", "spa_appointment_id",
           "vehicle_inquiry_id", "logistics_request_id", "quotation_id") AS payable_id,
  SUM("amount_minor" - "refunded_minor") AS net_minor,
  SUM("refunded_minor") AS refunded_minor
FROM "payments" WHERE "status" = 'SUCCESS'
GROUP BY 1;

UPDATE "orders" o SET
  "amount_paid_minor" = LEAST(t.net_minor, o."total_minor"),
  "payment_status" = (CASE WHEN t.net_minor >= o."total_minor" AND o."total_minor" > 0 THEN 'PAID'
                           WHEN t.net_minor > 0 THEN 'PARTIALLY_PAID'
                           WHEN t.refunded_minor > 0 THEN 'REFUNDED' ELSE 'UNPAID' END)::"PayableState"
FROM payable_totals t WHERE t.payable_id = o."id";

UPDATE "reservations" r SET
  "amount_paid_minor" = LEAST(t.net_minor, r."total_minor"),
  "payment_status" = (CASE WHEN t.net_minor >= r."total_minor" AND r."total_minor" > 0 THEN 'PAID'
                           WHEN t.net_minor > 0 THEN 'PARTIALLY_PAID'
                           WHEN t.refunded_minor > 0 THEN 'REFUNDED' ELSE 'UNPAID' END)::"PayableState"
FROM payable_totals t WHERE t.payable_id = r."id";

UPDATE "spa_appointments" a SET
  "deposit_required_minor" = a."deposit_minor",
  "amount_paid_minor" = LEAST(t.net_minor, a."price_minor"),
  "payment_status" = (CASE WHEN t.net_minor >= a."price_minor" AND a."price_minor" > 0 THEN 'PAID'
                           WHEN t.net_minor > 0 THEN 'PARTIALLY_PAID'
                           WHEN t.refunded_minor > 0 THEN 'REFUNDED' ELSE 'UNPAID' END)::"PayableState"
FROM payable_totals t WHERE t.payable_id = a."id";
UPDATE "spa_appointments" SET "deposit_required_minor" = "deposit_minor" WHERE "deposit_required_minor" = 0;

UPDATE "service_bookings" b SET
  "amount_paid_minor" = LEAST(t.net_minor, COALESCE(b."price_minor", t.net_minor)),
  "payment_status" = (CASE WHEN b."price_minor" IS NOT NULL AND t.net_minor >= b."price_minor" THEN 'PAID'
                           WHEN t.net_minor > 0 THEN 'PARTIALLY_PAID'
                           WHEN t.refunded_minor > 0 THEN 'REFUNDED' ELSE 'UNPAID' END)::"PayableState"
FROM payable_totals t WHERE t.payable_id = b."id";

UPDATE "logistics_requests" l SET
  "amount_paid_minor" = t.net_minor,
  "payment_status" = (CASE WHEN l."quoted_price_minor" IS NOT NULL AND t.net_minor >= l."quoted_price_minor" THEN 'PAID'
                           WHEN t.net_minor > 0 THEN 'PARTIALLY_PAID' ELSE 'UNPAID' END)::"PayableState"
FROM payable_totals t WHERE t.payable_id = l."id";

UPDATE "quotations" q SET
  "amount_paid_minor" = t.net_minor,
  "payment_status" = (CASE WHEN q."total_minor" IS NOT NULL AND t.net_minor >= q."total_minor" THEN 'PAID'
                           WHEN t.net_minor > 0 THEN 'PARTIALLY_PAID' ELSE 'UNPAID' END)::"PayableState"
FROM payable_totals t WHERE t.payable_id = q."id";

UPDATE "vehicle_inquiries" v SET
  "amount_paid_minor" = t.net_minor,
  "payment_status" = (CASE WHEN t.net_minor > 0 THEN 'PAID' ELSE 'UNPAID' END)::"PayableState"
FROM payable_totals t WHERE t.payable_id = v."id";

DROP TABLE payable_totals;

-- =============================================================================
-- Catalogue verification backfill: seed placeholders are DEV_SAMPLE;
-- everything else waits for company confirmation.
-- =============================================================================
UPDATE "products" SET "verification" = 'DEV_SAMPLE' WHERE "name" LIKE '[DEV SAMPLE]%';
UPDATE "apartment_units" u SET "verification" = 'DEV_SAMPLE'
  FROM "properties" p WHERE p."id" = u."property_id" AND (u."name" LIKE '[DEV SAMPLE]%' OR p."name" LIKE '[DEV SAMPLE]%');
UPDATE "vehicles" SET "verification" = 'DEV_SAMPLE' WHERE "make" = 'DevSample';
UPDATE "spa_treatments" SET "verification" = 'DEV_SAMPLE' WHERE "name" LIKE '[DEV SAMPLE]%';
UPDATE "service_offerings" SET "verification" = 'DEV_SAMPLE' WHERE "name" LIKE '[DEV SAMPLE]%';
UPDATE "delivery_zones" SET "verification" = 'DEV_SAMPLE' WHERE "name" LIKE '[DEV SAMPLE]%';

-- =============================================================================
-- Integrity rules (hand-written)
-- =============================================================================

-- A bank statement line can settle only one transfer.
CREATE UNIQUE INDEX "payments_verified_bank_reference_uq"
  ON "payments" ("verification_reference")
  WHERE "status" = 'SUCCESS' AND "method" = 'BANK_TRANSFER' AND "verification_reference" IS NOT NULL;

-- Payment-state amounts are never negative.
ALTER TABLE "orders" ADD CONSTRAINT "orders_payment_amounts_chk" CHECK ("amount_paid_minor" >= 0 AND "deposit_required_minor" >= 0);
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_payment_amounts_chk" CHECK ("amount_paid_minor" >= 0 AND "deposit_required_minor" >= 0);
ALTER TABLE "service_bookings" ADD CONSTRAINT "service_bookings_payment_amounts_chk" CHECK ("amount_paid_minor" >= 0 AND "deposit_required_minor" >= 0);
ALTER TABLE "spa_appointments" ADD CONSTRAINT "spa_appointments_payment_amounts_chk" CHECK ("amount_paid_minor" >= 0 AND "deposit_required_minor" >= 0);
ALTER TABLE "payment_policies" ADD CONSTRAINT "payment_policies_values_chk" CHECK (
  ("deposit_percent_bps" IS NULL OR ("deposit_percent_bps" > 0 AND "deposit_percent_bps" <= 10000))
  AND ("deposit_fixed_minor" IS NULL OR "deposit_fixed_minor" > 0)
  AND "bank_transfer_window_hours" BETWEEN 1 AND 336
);
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_nuban_chk" CHECK ("account_number" ~ '^[0-9]{10}$');

-- Append-only financial history: payment events, audit log, stock ledger and
-- loyalty ledger cannot be deleted or rewritten. Payments themselves can
-- change status but can never be deleted.
CREATE OR REPLACE FUNCTION nimpat_forbid_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: this table is append-only', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payments_no_delete BEFORE DELETE ON "payments" FOR EACH ROW EXECUTE FUNCTION nimpat_forbid_change();
CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON "audit_logs" FOR EACH ROW EXECUTE FUNCTION nimpat_forbid_change();
CREATE TRIGGER stock_movements_append_only BEFORE UPDATE OR DELETE ON "stock_movements" FOR EACH ROW EXECUTE FUNCTION nimpat_forbid_change();
CREATE TRIGGER loyalty_transactions_append_only BEFORE UPDATE OR DELETE ON "loyalty_transactions" FOR EACH ROW EXECUTE FUNCTION nimpat_forbid_change();
CREATE TRIGGER payment_events_no_delete BEFORE DELETE ON "payment_events" FOR EACH ROW EXECUTE FUNCTION nimpat_forbid_change();

-- Audit rows: only the actor/division links may be cleared (when a user or
-- division row is removed); the recorded action itself never changes.
CREATE OR REPLACE FUNCTION nimpat_audit_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.action IS DISTINCT FROM OLD.action OR NEW.entity_type IS DISTINCT FROM OLD.entity_type
     OR NEW.entity_id IS DISTINCT FROM OLD.entity_id OR NEW.changes::text IS DISTINCT FROM OLD.changes::text
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.ip_address IS DISTINCT FROM OLD.ip_address
     OR (NEW.actor_id IS DISTINCT FROM OLD.actor_id AND NEW.actor_id IS NOT NULL) THEN
    RAISE EXCEPTION 'audit_logs rows are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_logs_immutable BEFORE UPDATE ON "audit_logs" FOR EACH ROW EXECUTE FUNCTION nimpat_audit_immutable();

-- Payment events: only processing bookkeeping may be updated.
CREATE OR REPLACE FUNCTION nimpat_payment_event_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.event_key IS DISTINCT FROM OLD.event_key OR NEW.event_type IS DISTINCT FROM OLD.event_type
     OR NEW.payload::text IS DISTINCT FROM OLD.payload::text OR NEW.signature_valid IS DISTINCT FROM OLD.signature_valid
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.actor_id IS DISTINCT FROM OLD.actor_id THEN
    RAISE EXCEPTION 'payment_events rows are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER payment_events_immutable BEFORE UPDATE ON "payment_events" FOR EACH ROW EXECUTE FUNCTION nimpat_payment_event_immutable();
