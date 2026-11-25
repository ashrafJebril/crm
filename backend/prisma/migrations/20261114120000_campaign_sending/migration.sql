-- SP-13 campaign sending: several sender numbers, variable mapping with
-- fallbacks, header media and the background launch job. Additive and
-- idempotent: one new table ("CampaignBroadcast") and nullable or defaulted
-- columns on "Campaign", "CampaignRecipient" and "Template". No existing
-- column, constraint or index is altered, and nothing is backfilled
-- (existing campaigns keep senderChannelId and variableMapping).
-- Safe for the deployed main: its Prisma client never selects the new
-- columns, its campaign.create/template.create get the defaults, a campaign
-- delete cascades into the new table, and a media or channel delete sets the
-- new references to null.
-- Applies after 20261113120000_campaign_recipients ("CampaignRecipient"),
-- in the same `migrate deploy` run when both are pending.
-- "updatedAt" has no DB default (Prisma @updatedAt); raw-SQL writers set it.

ALTER TABLE "Campaign"
  ADD COLUMN IF NOT EXISTS "senderChannelIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "varMap" JSONB,
  ADD COLUMN IF NOT EXISTS "headerMediaId" TEXT,
  ADD COLUMN IF NOT EXISTS "launchStage" TEXT,
  ADD COLUMN IF NOT EXISTS "launchHeartbeatAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "launchAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "launchedById" TEXT,
  ADD COLUMN IF NOT EXISTS "planCompletedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "cancelRequestedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "sendTransport" TEXT;

-- The resume scheduler's stale-launch query.
CREATE INDEX IF NOT EXISTS "Campaign_status_launchHeartbeatAt_idx" ON "Campaign"("status", "launchHeartbeatAt");

CREATE TABLE IF NOT EXISTS "CampaignBroadcast" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "channelId" TEXT,
  "accountId" TEXT NOT NULL,
  "partitionKey" TEXT NOT NULL,
  "variables" JSONB NOT NULL,
  "transport" TEXT NOT NULL,
  "stage" TEXT NOT NULL DEFAULT 'pending',
  "recipientCount" INTEGER NOT NULL DEFAULT 0,
  "importedThroughId" TEXT,
  "addedThroughId" TEXT,
  "createAttemptedAt" TIMESTAMP(3),
  "zernioBroadcastId" TEXT,
  "recipientSyncSkip" INTEGER NOT NULL DEFAULT 0,
  "recipientsSyncedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CampaignBroadcast_pkey" PRIMARY KEY ("id")
);

-- Idempotent partition upsert, and the FK cascade from Campaign.
CREATE UNIQUE INDEX IF NOT EXISTS "CampaignBroadcast_campaignId_partitionKey_key" ON "CampaignBroadcast"("campaignId", "partitionKey");
-- The FK cascade from Workspace.
CREATE INDEX IF NOT EXISTS "CampaignBroadcast_workspaceId_idx" ON "CampaignBroadcast"("workspaceId");
-- Sweep and webhook lookups by Zernio broadcast.
CREATE INDEX IF NOT EXISTS "CampaignBroadcast_zernioBroadcastId_idx" ON "CampaignBroadcast"("zernioBroadcastId");
-- The FK SET NULL from Channel.
CREATE INDEX IF NOT EXISTS "CampaignBroadcast_channelId_idx" ON "CampaignBroadcast"("channelId");

ALTER TABLE "CampaignRecipient"
  ADD COLUMN IF NOT EXISTS "broadcastId" TEXT,
  ADD COLUMN IF NOT EXISTS "templateParams" JSONB,
  ADD COLUMN IF NOT EXISTS "sendAttemptedAt" TIMESTAMP(3);

-- Keyset paging of one partition's queued rows, and the new FK.
CREATE INDEX IF NOT EXISTS "CampaignRecipient_broadcastId_status_id_idx" ON "CampaignRecipient"("broadcastId", "status", "id");
-- The per-number insights GROUP BY (index-only).
CREATE INDEX IF NOT EXISTS "CampaignRecipient_campaignId_channelId_status_idx" ON "CampaignRecipient"("campaignId", "channelId", "status");

ALTER TABLE "Template"
  ADD COLUMN IF NOT EXISTS "headerMediaId" TEXT;

DO $$ BEGIN
  ALTER TABLE "CampaignBroadcast" ADD CONSTRAINT "CampaignBroadcast_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CampaignBroadcast" ADD CONSTRAINT "CampaignBroadcast_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CampaignBroadcast" ADD CONSTRAINT "CampaignBroadcast_channelId_fkey"
    FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_broadcastId_fkey"
    FOREIGN KEY ("broadcastId") REFERENCES "CampaignBroadcast"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_headerMediaId_fkey"
    FOREIGN KEY ("headerMediaId") REFERENCES "Media"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "Template" ADD CONSTRAINT "Template_headerMediaId_fkey"
    FOREIGN KEY ("headerMediaId") REFERENCES "Media"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
