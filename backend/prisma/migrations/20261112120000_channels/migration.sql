-- SP-19 channels hub and multiple numbers. Additive and idempotent: a new
-- "Channel" table, two nullable columns ("Conversation"."channelId",
-- "Campaign"."senderChannelId") and a rerunnable backfill. "Integration" and
-- its unique constraint are not altered: the deployed code keeps reading and
-- writing it, and ChannelsService.ensureLegacyChannels mirrors any row that
-- code adds after this migration (same mapping as the INSERT below; the spec
-- src/channels/legacy-mirror.spec.ts pins the two together).

CREATE TABLE IF NOT EXISTS "Channel" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "externalId" TEXT,
  "displayName" TEXT NOT NULL,
  "phoneNumber" TEXT,
  "status" TEXT NOT NULL DEFAULT 'active',
  "statusReason" TEXT,
  "health" JSONB,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "config" JSONB,
  "secretsEnc" TEXT,
  "webhookSecretHash" TEXT,
  "integrationId" TEXT,
  "lastInboundAt" TIMESTAMP(3),
  "disconnectedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Channel_integrationId_key" ON "Channel"("integrationId");
CREATE UNIQUE INDEX IF NOT EXISTS "Channel_workspaceId_provider_externalId_key" ON "Channel"("workspaceId", "provider", "externalId");
CREATE INDEX IF NOT EXISTS "Channel_workspaceId_kind_idx" ON "Channel"("workspaceId", "kind");
CREATE INDEX IF NOT EXISTS "Channel_provider_externalId_idx" ON "Channel"("provider", "externalId");
-- At most one default channel per workspace and kind. SQL only: Prisma cannot
-- express a partial index, so it is deliberately absent from schema.prisma.
CREATE UNIQUE INDEX IF NOT EXISTS "Channel_one_default_per_kind" ON "Channel"("workspaceId", "kind") WHERE "isDefault";

DO $$ BEGIN
  ALTER TABLE "Channel" ADD CONSTRAINT "Channel_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "Channel" ADD CONSTRAINT "Channel_integrationId_fkey"
    FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Inbound routing (ChannelResolver.forInbound) looks the legacy Integration up
-- by its account id. An index only: the table and its constraints are not
-- altered, so the deployed code is unaffected.
CREATE INDEX IF NOT EXISTS "Integration_pageId_idx" ON "Integration"("pageId");

ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "channelId" TEXT;
CREATE INDEX IF NOT EXISTS "Conversation_workspaceId_channelId_idx" ON "Conversation"("workspaceId", "channelId");

DO $$ BEGIN
  ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_channelId_fkey"
    FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "senderChannelId" TEXT;

DO $$ BEGIN
  ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_senderChannelId_fkey"
    FOREIGN KEY ("senderChannelId") REFERENCES "Channel"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Backfill 1: exactly one Channel per Integration, with a deterministic id.
-- Integration."raw" is never parsed (a malformed row would abort the
-- migration); the code fills phoneNumber on the next sync. The first channel
-- of a kind in a workspace becomes its default. Rerunning inserts nothing:
-- the NOT EXISTS guard skips mirrored rows and ON CONFLICT covers the rest.
INSERT INTO "Channel" ("id", "workspaceId", "kind", "provider", "externalId", "displayName", "status", "isDefault", "integrationId", "createdAt", "updatedAt")
SELECT
  'chi_' || i."id",
  i."workspaceId",
  lower(i."platform"),
  i."provider",
  i."pageId",
  COALESCE(NULLIF(i."pageName", ''), initcap(i."platform")),
  'active',
  NOT EXISTS (SELECT 1 FROM "Channel" d WHERE d."workspaceId" = i."workspaceId" AND d."kind" = lower(i."platform") AND d."isDefault"),
  i."id",
  i."createdAt",
  CURRENT_TIMESTAMP
FROM "Integration" i
WHERE NOT EXISTS (SELECT 1 FROM "Channel" c WHERE c."integrationId" = i."id")
ON CONFLICT DO NOTHING;

-- Backfill 2: stamp conversations whose channel is derivable (one Integration
-- per platform, so conversation.channel -> that integration's channel).
-- webchat and l conversations stay null. Limited by "channelId" IS NULL, so a
-- rerun is a no-op.
UPDATE "Conversation" cv
SET "channelId" = ch."id"
FROM "Channel" ch
JOIN "Integration" i ON i."id" = ch."integrationId"
WHERE cv."channelId" IS NULL
  AND cv."workspaceId" = i."workspaceId"
  AND lower(cv."channel") = lower(i."platform");
