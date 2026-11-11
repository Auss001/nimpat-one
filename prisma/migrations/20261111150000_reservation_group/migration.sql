-- Several rooms booked together: one lead reservation carries the payment for the group.
ALTER TABLE "reservations" ADD COLUMN "group_lead_id" UUID;
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_group_lead_id_fkey" FOREIGN KEY ("group_lead_id") REFERENCES "reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "reservations_group_lead_id_idx" ON "reservations"("group_lead_id");
