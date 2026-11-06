-- Bathrooms can be fractional (e.g. 3.5 = three full + one guest toilet).
ALTER TABLE "apartment_units" ALTER COLUMN "bathrooms" SET DATA TYPE DOUBLE PRECISION;

-- Role grants stay unique per (user, role, division) with NULL = group-wide.
-- Two partial indexes replace the NULLS NOT DISTINCT index from the init
-- migration, because Prisma leaves partial indexes alone in future diffs.
DROP INDEX "user_roles_user_role_division_key";
CREATE UNIQUE INDEX "user_roles_group_grant_uq" ON "user_roles" ("user_id", "role_id") WHERE "division_id" IS NULL;
CREATE UNIQUE INDEX "user_roles_division_grant_uq" ON "user_roles" ("user_id", "role_id", "division_id") WHERE "division_id" IS NOT NULL;
