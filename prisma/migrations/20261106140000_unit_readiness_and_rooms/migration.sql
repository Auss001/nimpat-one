-- Whether an apartment or room can actually be sold right now.
CREATE TYPE "UnitReadiness" AS ENUM ('READY', 'FINISHING', 'NOT_READY', 'SERVICING', 'MAINTENANCE');

ALTER TABLE "apartment_units"
  ADD COLUMN "readiness" "UnitReadiness" NOT NULL DEFAULT 'READY',
  ADD COLUMN "readiness_note" TEXT;

-- Rooms that can be booked individually inside a unit.
CREATE TABLE "apartment_rooms" (
    "id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "slot" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "max_guests" INTEGER NOT NULL DEFAULT 2,
    "nightly_rate_minor" BIGINT NOT NULL,
    "cleaning_fee_minor" BIGINT NOT NULL DEFAULT 0,
    "caution_deposit_minor" BIGINT NOT NULL DEFAULT 0,
    "status" "ListingStatus" NOT NULL DEFAULT 'ACTIVE',
    "readiness" "UnitReadiness" NOT NULL DEFAULT 'READY',
    "readiness_note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "apartment_rooms_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "apartment_rooms_unit_id_slot_key" ON "apartment_rooms"("unit_id", "slot");

ALTER TABLE "apartment_rooms" ADD CONSTRAINT "apartment_rooms_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "apartment_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "apartment_rooms" ADD CONSTRAINT "apartment_rooms_slot_chk" CHECK ("slot" BETWEEN 1 AND 9999);
ALTER TABLE "apartment_rooms" ADD CONSTRAINT "apartment_rooms_rate_chk" CHECK ("nightly_rate_minor" > 0 AND "cleaning_fee_minor" >= 0 AND "caution_deposit_minor" >= 0);

ALTER TABLE "reservations"
  ADD COLUMN "room_id" UUID,
  ADD COLUMN "room_slot" INTEGER;

CREATE INDEX "reservations_room_id_idx" ON "reservations"("room_id");

ALTER TABLE "reservations" ADD CONSTRAINT "reservations_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "apartment_rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_room_pair_chk" CHECK (("room_id" IS NULL) = ("room_slot" IS NULL));

-- Double-booking rule, enforced by the database:
--   a whole-unit stay occupies every slot (0 to 9999), and a room stay occupies only its own slot.
-- So a whole unit conflicts with any room, and two different rooms never conflict.
ALTER TABLE "reservations" DROP CONSTRAINT "reservations_no_overlap";
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_no_overlap"
  EXCLUDE USING gist (
    "unit_id" WITH =,
    daterange("check_in", "check_out", '[)') WITH &&,
    (CASE WHEN "room_slot" IS NULL THEN int4range(0, 10000) ELSE int4range("room_slot", "room_slot" + 1) END) WITH &&
  ) WHERE ("status" IN ('HOLD', 'CONFIRMED', 'CHECKED_IN'));
