-- Groups apartment properties by location, for example Mabushi or Lagos.
ALTER TABLE "properties" ADD COLUMN "location" TEXT;

UPDATE "properties" SET "location" = 'Mabushi' WHERE "address_line" ILIKE '%mabushi%';
UPDATE "properties" SET "location" = 'Wuye' WHERE "address_line" ILIKE '%wuye%';
UPDATE "properties" SET "location" = 'Lagos' WHERE "city" ILIKE 'lagos';
UPDATE "properties" SET "location" = 'Port Harcourt' WHERE "city" ILIKE 'port harcourt';

CREATE INDEX "properties_location_idx" ON "properties"("location");
