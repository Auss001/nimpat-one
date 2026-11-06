-- A product photo can belong to one size or pack.
ALTER TABLE "product_images" ADD COLUMN "variant_id" UUID;
CREATE INDEX "product_images_variant_id_idx" ON "product_images"("variant_id");
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Spa treatments and service listings each show one photo.
ALTER TABLE "spa_treatments" ADD COLUMN "image_url" TEXT;
ALTER TABLE "service_offerings" ADD COLUMN "image_url" TEXT;
