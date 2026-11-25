-- SP-12 campaign recipients and reporting. Additive and idempotent: one new
-- table ("CampaignRecipient") and three defaulted "Campaign" columns. No
-- existing column, constraint or index is altered, and nothing is backfilled
-- (historical campaigns stay aggregate-only, recipientTracking = false).
-- Safe for the deployed main: its Prisma client never selects the new
-- columns, its campaign.create gets the defaults, a campaign delete cascades
-- into the new table and a contact or channel delete sets the FK to null.
-- "updatedAt" has no DB default (Prisma @updatedAt); raw-SQL writers set it.

CREATE TABLE IF NOT EXISTS "CampaignRecipient" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "contactId" TEXT,
  "channelId" TEXT,
  "phone" TEXT,
  "contactName" TEXT,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "messageId" TEXT,
  "sentAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "readAt" TIMESTAMP(3),
  "repliedAt" TIMESTAMP(3),
  "replyText" TEXT,
  "buttonPayload" TEXT,
  "replyMessageId" TEXT,
  "failureCode" TEXT,
  "failureReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CampaignRecipient_pkey" PRIMARY KEY ("id")
);

-- Launch is idempotent (createMany skipDuplicates) and the pull sweep matches
-- by phone. Postgres treats NULLs as distinct, so phoneless skipped rows never
-- collide.
CREATE UNIQUE INDEX IF NOT EXISTS "CampaignRecipient_campaignId_phone_key" ON "CampaignRecipient"("campaignId", "phone");
-- Keyset pages for one outcome and counts by status.
CREATE INDEX IF NOT EXISTS "CampaignRecipient_campaignId_status_id_idx" ON "CampaignRecipient"("campaignId", "status", "id");
-- Keyset pages for "all", and the FK cascade from Campaign.
CREATE INDEX IF NOT EXISTS "CampaignRecipient_campaignId_id_idx" ON "CampaignRecipient"("campaignId", "id");
-- Status webhook lookup, and the FK cascade from Workspace.
CREATE INDEX IF NOT EXISTS "CampaignRecipient_workspaceId_messageId_idx" ON "CampaignRecipient"("workspaceId", "messageId");
-- Reply attribution candidates, and the FK SET NULL from Channel.
CREATE INDEX IF NOT EXISTS "CampaignRecipient_channelId_phone_idx" ON "CampaignRecipient"("channelId", "phone");
-- Attribution by contact, and the FK SET NULL when a contact is deleted.
CREATE INDEX IF NOT EXISTS "CampaignRecipient_contactId_idx" ON "CampaignRecipient"("contactId");

DO $$ BEGIN
  ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_channelId_fkey"
    FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "Campaign"
  ADD COLUMN IF NOT EXISTS "recipientTracking" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "recipientsSyncedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "recipientSyncSkip" INTEGER NOT NULL DEFAULT 0;
