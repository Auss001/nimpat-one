-- Promos and featured items on the customer home page, managed from the dashboard.
CREATE TYPE "HomeSlideKind" AS ENUM ('PICTURE', 'PRODUCT', 'APARTMENTS');

CREATE TABLE "home_slides" (
    "id" UUID NOT NULL,
    "kind" "HomeSlideKind" NOT NULL,
    "title" TEXT,
    "subtitle" TEXT,
    "button_text" TEXT,
    "image_url" TEXT,
    "link_to" TEXT,
    "product_id" UUID,
    "tone" TEXT NOT NULL DEFAULT 'sky',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "starts_at" TIMESTAMPTZ(3),
    "ends_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "home_slides_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "home_slides_is_active_sort_order_idx" ON "home_slides"("is_active", "sort_order");
CREATE INDEX "home_slides_product_id_idx" ON "home_slides"("product_id");

ALTER TABLE "home_slides" ADD CONSTRAINT "home_slides_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Starts with the slides already showing on the home page.
INSERT INTO "home_slides" ("id", "kind", "button_text", "image_url", "link_to", "sort_order", "updated_at")
VALUES (gen_random_uuid(), 'PICTURE', 'See prices', '/media/images/promos/drinks-on-promo.webp', '/shop/water-drinks-wines?category=water', 0, CURRENT_TIMESTAMP);

INSERT INTO "home_slides" ("id", "kind", "sort_order", "updated_at")
VALUES (gen_random_uuid(), 'APARTMENTS', 1, CURRENT_TIMESTAMP);

INSERT INTO "home_slides" ("id", "kind", "subtitle", "product_id", "tone", "sort_order", "updated_at")
SELECT gen_random_uuid(), 'PRODUCT', 'Featured', "id", 'rose', 2, CURRENT_TIMESTAMP FROM "products" WHERE "slug" = 'chamdor-red-grape-sparkling';

INSERT INTO "home_slides" ("id", "kind", "subtitle", "product_id", "tone", "sort_order", "updated_at")
SELECT gen_random_uuid(), 'PRODUCT', 'Bottled water', "id", 'sky', 3, CURRENT_TIMESTAMP FROM "products" WHERE "slug" = 'swan-natural-spring-water-75cl';

INSERT INTO "home_slides" ("id", "kind", "subtitle", "product_id", "tone", "sort_order", "updated_at")
SELECT gen_random_uuid(), 'PRODUCT', 'Top shelf', "id", 'gold', 4, CURRENT_TIMESTAMP FROM "products" WHERE "slug" = 'hennessy-x-o-extra-old-cognac';
