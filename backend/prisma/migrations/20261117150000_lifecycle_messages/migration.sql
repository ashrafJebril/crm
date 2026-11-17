-- SP-24 lifecycle messages: Workflow.systemKey (+ its unique index) and the
-- LifecycleDelivery claim table. Additive and idempotent; no backfill.
--
-- Safe for the deployed main: "systemKey" is nullable and main never writes
-- it (NULLs are distinct, so the unique index never blocks main's inserts);
-- LifecycleDelivery is unknown to main and cascades with its workflow and
-- workspace. No existing column, constraint or index changes.
--
-- The unique index on "Workflow" is built non-concurrently (a few hundred
-- rows: milliseconds). lock_timeout makes the DDL give up after 5 s instead
-- of queueing behind a long transaction while later reads wait behind it; a
-- timed-out deploy is simply rerun.
SET lock_timeout = '5s';

ALTER TABLE "Workflow" ADD COLUMN IF NOT EXISTS "systemKey" TEXT;

CREATE TABLE IF NOT EXISTS "LifecycleDelivery" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "entityKind" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "occurrenceKey" TEXT NOT NULL,
    "runId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LifecycleDelivery_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "LifecycleDelivery_workspaceId_createdAt_idx" ON "LifecycleDelivery"("workspaceId", "createdAt");

CREATE UNIQUE INDEX IF NOT EXISTS "LifecycleDelivery_workflowId_entityId_occurrenceKey_key" ON "LifecycleDelivery"("workflowId", "entityId", "occurrenceKey");

CREATE UNIQUE INDEX IF NOT EXISTS "Workflow_workspaceId_systemKey_key" ON "Workflow"("workspaceId", "systemKey");

DO $$ BEGIN
    ALTER TABLE "LifecycleDelivery" ADD CONSTRAINT "LifecycleDelivery_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "LifecycleDelivery" ADD CONSTRAINT "LifecycleDelivery_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
