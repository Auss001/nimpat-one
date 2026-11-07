-- Each shop can hide its out-of-stock items from customers, switched from the dashboard.
ALTER TABLE "divisions" ADD COLUMN "hide_out_of_stock" BOOLEAN NOT NULL DEFAULT false;

-- The owner asked for out-of-stock items to be removed from the shops (7 November 2026). Pharmacy stays
-- visible for now: none of its items has a live stock count yet, so hiding them would empty the shop.
UPDATE "divisions" SET "hide_out_of_stock" = true
WHERE "slug" IN ('water-drinks-wines', 'retail-general-supplies');
