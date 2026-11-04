-- Campaigns send as Zernio WhatsApp broadcasts. Additive only: every new
-- column is nullable or defaulted, so code without these fields keeps working.
ALTER TABLE "Campaign"
  ADD COLUMN "zernioBroadcastId" TEXT,
  ADD COLUMN "scheduledAt" TIMESTAMP(3),
  ADD COLUMN "variableMapping" JSONB,
  ADD COLUMN "failed" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "skipped" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastError" TEXT,
  ADD COLUMN "launchedAt" TIMESTAMP(3),
  ADD COLUMN "statsSyncedAt" TIMESTAMP(3);
