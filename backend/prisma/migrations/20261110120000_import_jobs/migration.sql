-- SP-03 contacts import/export. Additive and idempotent: a new "ImportJob"
-- table only; no existing table is altered.
CREATE TABLE IF NOT EXISTS "ImportJob" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'uploaded',
  "fileMediaId" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "totalRows" INTEGER NOT NULL,
  "processed" INTEGER NOT NULL DEFAULT 0,
  "created" INTEGER NOT NULL DEFAULT 0,
  "updated" INTEGER NOT NULL DEFAULT 0,
  "skipped" INTEGER NOT NULL DEFAULT 0,
  "failed" INTEGER NOT NULL DEFAULT 0,
  "duplicateInFile" INTEGER NOT NULL DEFAULT 0,
  "errors" JSONB NOT NULL DEFAULT '[]',
  "mapping" JSONB,
  "options" JSONB,
  "heartbeatAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ImportJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ImportJob_workspaceId_createdAt_idx" ON "ImportJob"("workspaceId", "createdAt");
CREATE INDEX IF NOT EXISTS "ImportJob_status_heartbeatAt_idx" ON "ImportJob"("status", "heartbeatAt");

DO $$ BEGIN
  ALTER TABLE "ImportJob" ADD CONSTRAINT "ImportJob_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
