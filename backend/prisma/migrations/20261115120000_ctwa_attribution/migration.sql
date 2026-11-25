-- SP-15 click-to-WhatsApp ad attribution and Meta Ads connect. Hand-written,
-- additive and idempotent. Equal to `prisma migrate diff --from-schema-datamodel
-- <9c8b5da schema> --to-schema-datamodel prisma/schema.prisma --script`, plus
-- IF NOT EXISTS and a duplicate_object guard around every foreign key.
-- Safe for the deployed main: five new tables it never reads, two nullable
-- Conversation columns its client never selects, one Conversation index.
-- Conversation_adSourceId_fkey validates an all-null column (short lock).
-- Apply with `prisma migrate deploy` only, after the user explicit approval
-- (ruling 15). No backfill (ruling 5).

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "adReferredAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "adSourceId" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "AdSource" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "headline" TEXT,
    "body" TEXT,
    "mediaType" TEXT,
    "mediaUrl" TEXT,
    "mediaId" TEXT,
    "sourceUrl" TEXT,
    "welcomeText" TEXT,
    "adAccountId" TEXT,
    "adName" TEXT,
    "adSetName" TEXT,
    "campaignName" TEXT,
    "namesFrom" TEXT,
    "firstReferredAt" TIMESTAMP(3),
    "lastReferredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "AdReferral" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "adSourceId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "channelId" TEXT,
    "messageId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "ctwaClid" TEXT,
    "firstTouch" BOOLEAN NOT NULL DEFAULT false,
    "referredAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdReferral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "AdSpendDaily" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "adSourceId" TEXT NOT NULL,
    "adAccountId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "spend" DECIMAL(14,4) NOT NULL,
    "currency" TEXT NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdSpendDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "MetaAdsConnection" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "statusReason" TEXT,
    "tokenEnc" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "pendingTokenEnc" TEXT,
    "pendingExpiresAt" TIMESTAMP(3),
    "scopes" TEXT,
    "adAccountId" TEXT,
    "adAccountName" TEXT,
    "currency" TEXT,
    "timezone" TEXT,
    "pageId" TEXT,
    "pageName" TEXT,
    "connectedById" TEXT,
    "connectedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "lastSyncError" TEXT,
    "syncAttemptedAt" TIMESTAMP(3),
    "spendBackfilledAt" TIMESTAMP(3),
    "checkAttemptedAt" TIMESTAMP(3),
    "leadCheckpoints" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetaAdsConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "MetaLead" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "leadgenId" TEXT NOT NULL,
    "formId" TEXT NOT NULL,
    "formName" TEXT,
    "pageId" TEXT NOT NULL,
    "adId" TEXT,
    "adSourceId" TEXT,
    "contactId" TEXT,
    "fieldData" JSONB NOT NULL,
    "createdTime" TIMESTAMP(3) NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MetaLead_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AdSource_workspaceId_lastReferredAt_idx" ON "AdSource"("workspaceId", "lastReferredAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AdSource_workspaceId_adAccountId_idx" ON "AdSource"("workspaceId", "adAccountId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "AdSource_workspaceId_sourceType_sourceId_key" ON "AdSource"("workspaceId", "sourceType", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "AdReferral_messageId_key" ON "AdReferral"("messageId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AdReferral_workspaceId_adSourceId_referredAt_idx" ON "AdReferral"("workspaceId", "adSourceId", "referredAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AdReferral_workspaceId_referredAt_idx" ON "AdReferral"("workspaceId", "referredAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AdReferral_conversationId_idx" ON "AdReferral"("conversationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AdSpendDaily_workspaceId_adAccountId_date_idx" ON "AdSpendDaily"("workspaceId", "adAccountId", "date");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "AdSpendDaily_adSourceId_date_key" ON "AdSpendDaily"("adSourceId", "date");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "MetaAdsConnection_workspaceId_key" ON "MetaAdsConnection"("workspaceId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MetaAdsConnection_status_syncAttemptedAt_idx" ON "MetaAdsConnection"("status", "syncAttemptedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MetaLead_workspaceId_contactId_idx" ON "MetaLead"("workspaceId", "contactId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "MetaLead_workspaceId_leadgenId_key" ON "MetaLead"("workspaceId", "leadgenId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Conversation_workspaceId_adSourceId_idx" ON "Conversation"("workspaceId", "adSourceId");

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_adSourceId_fkey" FOREIGN KEY ("adSourceId") REFERENCES "AdSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "AdSource" ADD CONSTRAINT "AdSource_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "AdSource" ADD CONSTRAINT "AdSource_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "Media"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "AdReferral" ADD CONSTRAINT "AdReferral_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "AdReferral" ADD CONSTRAINT "AdReferral_adSourceId_fkey" FOREIGN KEY ("adSourceId") REFERENCES "AdSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "AdReferral" ADD CONSTRAINT "AdReferral_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "AdReferral" ADD CONSTRAINT "AdReferral_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "AdSpendDaily" ADD CONSTRAINT "AdSpendDaily_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "AdSpendDaily" ADD CONSTRAINT "AdSpendDaily_adSourceId_fkey" FOREIGN KEY ("adSourceId") REFERENCES "AdSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "MetaAdsConnection" ADD CONSTRAINT "MetaAdsConnection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "MetaAdsConnection" ADD CONSTRAINT "MetaAdsConnection_connectedById_fkey" FOREIGN KEY ("connectedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "MetaLead" ADD CONSTRAINT "MetaLead_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "MetaLead" ADD CONSTRAINT "MetaLead_adSourceId_fkey" FOREIGN KEY ("adSourceId") REFERENCES "AdSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "MetaLead" ADD CONSTRAINT "MetaLead_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
