-- Ads Assistant data model (ported from hjz-v2): chat sessions/messages for
-- the "Salma" ad-analysis agent, an approval-gated pending-action queue with
-- an append-only audit trail, and a per-workspace JOD wallet with its ledger.
-- All statements are idempotent/additive per repo convention (hand-authored
-- migrations only — see 20260819150000_tag_catalog for house style).

-- AdsChatSession ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "AdsChatSession" (
    "id" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "title" TEXT,
    "deletedAt" TIMESTAMP(3),
    "workspaceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AdsChatSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AdsChatSession_workspaceId_updatedAt_idx" ON "AdsChatSession"("workspaceId", "updatedAt");

-- AdsChatMessage -------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "AdsChatMessage" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "toolCallsJson" JSONB,
    "usageJson" JSONB,
    "workspaceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdsChatMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AdsChatMessage_workspaceId_sessionId_createdAt_idx" ON "AdsChatMessage"("workspaceId", "sessionId", "createdAt");
CREATE INDEX IF NOT EXISTS "AdsChatMessage_sessionId_idx" ON "AdsChatMessage"("sessionId");

-- AdsPendingAction ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "AdsPendingAction" (
    "id" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "sessionId" TEXT,
    "tool" TEXT NOT NULL,
    "argsJson" JSONB NOT NULL,
    "argsHash" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "summaryIsPlaceholder" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "resultJson" JSONB,
    "errorText" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdsPendingAction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AdsPendingAction_workspaceId_status_createdAt_idx" ON "AdsPendingAction"("workspaceId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "AdsPendingAction_sessionId_idx" ON "AdsPendingAction"("sessionId");

-- AdsActionAudit --------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "AdsActionAudit" (
    "id" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "actorId" TEXT,
    "tool" TEXT NOT NULL,
    "sessionId" TEXT,
    "argsRedactedJson" JSONB,
    "summary" TEXT,
    "resultRedactedJson" JSONB,
    "errorText" TEXT,
    "workspaceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdsActionAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AdsActionAudit_workspaceId_actionId_createdAt_idx" ON "AdsActionAudit"("workspaceId", "actionId", "createdAt");
CREATE INDEX IF NOT EXISTS "AdsActionAudit_workspaceId_event_createdAt_idx" ON "AdsActionAudit"("workspaceId", "event", "createdAt");

-- AdsWallet --------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "AdsWallet" (
    "id" TEXT NOT NULL,
    "balanceJod" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "workspaceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AdsWallet_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AdsWallet_balanceJod_non_negative" CHECK ("balanceJod" >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "AdsWallet_workspaceId_key" ON "AdsWallet"("workspaceId");

-- AdsWalletTransaction -----------------------------------------------------------

CREATE TABLE IF NOT EXISTS "AdsWalletTransaction" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amountJod" DECIMAL(12,4) NOT NULL,
    "balanceAfterJod" DECIMAL(12,4) NOT NULL,
    "description" TEXT,
    "breakdownJson" JSONB,
    "costBasisUsd" DECIMAL(24,14),
    "costBasisJod" DECIMAL(24,14),
    "externalRef" TEXT,
    "workspaceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdsWalletTransaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AdsWalletTransaction_externalRef_key" ON "AdsWalletTransaction"("externalRef");
CREATE INDEX IF NOT EXISTS "AdsWalletTransaction_workspaceId_createdAt_idx" ON "AdsWalletTransaction"("workspaceId", "createdAt");
CREATE INDEX IF NOT EXISTS "AdsWalletTransaction_walletId_createdAt_idx" ON "AdsWalletTransaction"("walletId", "createdAt");

-- Foreign keys ------------------------------------------------------------------

DO $$ BEGIN
  ALTER TABLE "AdsChatSession" ADD CONSTRAINT "AdsChatSession_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "AdsChatMessage" ADD CONSTRAINT "AdsChatMessage_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "AdsChatSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "AdsChatMessage" ADD CONSTRAINT "AdsChatMessage_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "AdsPendingAction" ADD CONSTRAINT "AdsPendingAction_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "AdsActionAudit" ADD CONSTRAINT "AdsActionAudit_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "AdsWallet" ADD CONSTRAINT "AdsWallet_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "AdsWalletTransaction" ADD CONSTRAINT "AdsWalletTransaction_walletId_fkey"
    FOREIGN KEY ("walletId") REFERENCES "AdsWallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "AdsWalletTransaction" ADD CONSTRAINT "AdsWalletTransaction_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
