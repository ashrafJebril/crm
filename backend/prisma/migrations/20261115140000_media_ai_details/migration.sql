-- SP-17 media details for the AI agent. Hand-written, additive and idempotent.
-- Equal to `prisma migrate diff --from-schema-datamodel <HEAD schema>
-- --to-schema-datamodel prisma/schema.prisma --script`, plus IF NOT EXISTS.
-- Safe for the deployed main: three nullable columns and two columns with
-- constant defaults (metadata-only on Postgres 11+, no table rewrite); main's
-- client never selects them and its creates get the defaults. No index, no
-- backfill: every file starts undescribed and not approved for the agent.
-- Apply with `prisma migrate deploy` only, after the user's explicit approval.

-- AlterTable
ALTER TABLE "Media" ADD COLUMN IF NOT EXISTS "alt" TEXT,
ADD COLUMN IF NOT EXISTS "approvedForAgent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN IF NOT EXISTS "title" TEXT,
ADD COLUMN IF NOT EXISTS "useWhen" TEXT;
