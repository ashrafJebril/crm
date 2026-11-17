-- SP-28 billing portal, re-scoped (Kewy/Joteck stays the biller; no Stripe):
-- usage metering (the UsageEvent table), the wallet's `meter` column on the
-- existing AdsWalletTransaction ledger, and the super-admin plan override
-- for Kewy plans (Workspace.planOverriddenAt, Workspace.kewyPlan). Additive
-- and idempotent; no backfill.
--
-- Safe for the deployed main: two nullable Workspace columns and one
-- nullable AdsWalletTransaction column (metadata-only, no rewrite); main's
-- inserts omit them. One new table unknown to main. No UPDATE, DELETE, DROP
-- or type change.
--
-- The ALTERs take a brief ACCESS EXCLUSIVE lock and the FK a SHARE ROW
-- EXCLUSIVE lock on "Workspace". lock_timeout makes the DDL give up after
-- 5 s instead of queueing requests behind a long transaction; a timed-out
-- deploy is simply rerun.
SET lock_timeout = '5s';

ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "planOverriddenAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "kewyPlan" TEXT;

ALTER TABLE "AdsWalletTransaction" ADD COLUMN IF NOT EXISTS "meter" TEXT;

CREATE TABLE IF NOT EXISTS "UsageEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "meter" TEXT NOT NULL,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceKind" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "walletTxId" TEXT,

    CONSTRAINT "UsageEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "UsageEvent_idempotencyKey_key" ON "UsageEvent"("idempotencyKey");

CREATE INDEX IF NOT EXISTS "UsageEvent_workspaceId_meter_at_idx" ON "UsageEvent"("workspaceId", "meter", "at");

DO $$ BEGIN
    ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
