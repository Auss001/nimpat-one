-- Things customers have saved.
CREATE TYPE "FavoriteKind" AS ENUM ('PRODUCT', 'PROPERTY', 'VEHICLE', 'TREATMENT');

CREATE TABLE "favorites" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "FavoriteKind" NOT NULL,
    "item_slug" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "favorites_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "favorites_user_id_kind_item_slug_key" ON "favorites"("user_id", "kind", "item_slug");
CREATE INDEX "favorites_user_id_created_at_idx" ON "favorites"("user_id", "created_at");

ALTER TABLE "favorites" ADD CONSTRAINT "favorites_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
