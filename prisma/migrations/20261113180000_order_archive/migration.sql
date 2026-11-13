-- Orders an administrator deleted that could not be removed outright (they reserved stock, whose history is
-- append-only). They are cancelled and archived: gone from every list, history kept.
ALTER TABLE "orders" ADD COLUMN "archived_at" TIMESTAMPTZ(3);
