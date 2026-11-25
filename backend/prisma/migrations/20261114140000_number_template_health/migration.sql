-- SP-14 number and template health. Hand-written, additive and idempotent.
-- Equal to `prisma migrate diff --from-schema-datamodel <HEAD schema>
-- --to-schema-datamodel prisma/schema.prisma --script`, plus IF NOT EXISTS.
-- Safe for the deployed main: three nullable columns its client never selects,
-- one index on Channel (tens of rows). Apply with `prisma migrate deploy` only,
-- after the user's explicit approval (ruling 17). No backfill.

-- AlterTable
ALTER TABLE "Template" ADD COLUMN IF NOT EXISTS "quality" TEXT;

-- AlterTable
ALTER TABLE "Channel" ADD COLUMN IF NOT EXISTS "healthAttemptedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "healthCheckedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Channel_kind_healthAttemptedAt_idx" ON "Channel"("kind", "healthAttemptedAt");
