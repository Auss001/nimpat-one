-- The code a store uses for an item in its own stock lists (barcode or stock code), so price lists match exactly.
ALTER TABLE "product_variants" ADD COLUMN "stock_code" TEXT;
CREATE INDEX "product_variants_stock_code_idx" ON "product_variants"("stock_code");
