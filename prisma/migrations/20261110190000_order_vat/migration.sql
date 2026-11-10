-- VAT charged on an order (Water, Drinks & Wines: 7.5% of the items), kept apart from the item prices.
ALTER TABLE "orders" ADD COLUMN "tax_minor" BIGINT NOT NULL DEFAULT 0;
