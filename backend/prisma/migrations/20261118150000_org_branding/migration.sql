-- SP-29 organization branding. Hand-written, additive and idempotent.
-- Equal to `prisma migrate diff --from-schema-datamodel <cd7701c schema>
-- --to-schema-datamodel prisma/schema.prisma --script` (Prisma 5.22.0, no DB),
-- plus IF NOT EXISTS, the duplicate_object wrapper around the foreign key and
-- the lock_timeout below. Prisma emits no index for the plain FK, so none here.
-- Safe for the deployed main:
--   * Three nullable columns (Workspace.logoMediaId, Workspace.brandColor,
--     Media.purpose) that main never reads or writes; no default, no backfill,
--     so adding them is a catalog-only change.
--   * The FK is on an all-null column, so it validates at once; ON DELETE SET
--     NULL means a main media delete of a logo nulls the column (no 500).
--   * No UPDATE, DELETE, DROP or ALTER ... TYPE; no other table changes.
--   * lock_timeout: if a long transaction holds "Workspace" or "Media", a
--     statement gives up after 5 s instead of queueing every later request.
--     Prisma then records the migration as failed (P3009 on the next deploy):
--     `npx prisma migrate resolve --rolled-back 20261118150000_org_branding`,
--     then `npx prisma migrate deploy` again. The script is idempotent.
-- Applies after SP-28's 20261118140000_billing_portal (and SP-27's
-- 20261118130000_api_keys_webhooks), in timestamp order.
-- Apply with `prisma migrate deploy` only, after the user's explicit approval.

-- Give up instead of stalling the lock queue (SP-10 precedent).
SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "brandColor" TEXT,
ADD COLUMN IF NOT EXISTS "logoMediaId" TEXT;

-- AlterTable
ALTER TABLE "Media" ADD COLUMN IF NOT EXISTS "purpose" TEXT;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_logoMediaId_fkey" FOREIGN KEY ("logoMediaId") REFERENCES "Media"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
