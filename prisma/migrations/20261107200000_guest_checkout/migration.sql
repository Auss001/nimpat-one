-- Guest checkout: a customer can buy without an account. A guest record keeps the real contact
-- details apart from the sign-in email, so it never clashes with a member's account.
ALTER TABLE "users" ADD COLUMN "is_guest" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "contact_email" TEXT;
ALTER TABLE "users" ADD COLUMN "contact_phone" TEXT;
