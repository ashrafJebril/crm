-- SP-16 Smart audiences. Hand-written, additive and idempotent; apply with
-- `prisma migrate deploy` only, after explicit user approval (ruling 18).
-- Equals `prisma migrate diff --from-schema-datamodel <d152351 schema>
-- --to-schema-datamodel prisma/schema.prisma --script` apart from IF NOT EXISTS.
-- Safe for the deployed main: three nullable columns plus one NOT NULL DEFAULT 0
-- column (metadata-only on Postgres 11+), and one Contact index. No Message
-- index (ruling 10). No UPDATE, DELETE, DROP or type change; no backfill.

-- AlterTable
ALTER TABLE "Segment" ADD COLUMN IF NOT EXISTS "countedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "memberCount" INTEGER,
ADD COLUMN IF NOT EXISTS "rules" JSONB,
ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Contact_workspaceId_createdAt_idx" ON "Contact"("workspaceId", "createdAt");
