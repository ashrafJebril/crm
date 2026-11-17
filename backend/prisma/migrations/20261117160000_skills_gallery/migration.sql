-- SP-22 skills gallery: the per-workspace skills ledger (SkillInstall) and the
-- agent's CRM tool-call log (AgentToolCall). Additive and idempotent; no
-- backfill: a workspace with no SkillInstall row keeps today's default skills
-- (booking, customer records, photos), exactly main's behaviour.
--
-- Safe for the deployed main: two new tables main never reads. No existing
-- table, column, constraint or index changes; no UPDATE, DELETE or DROP.
-- lock_timeout makes the DDL give up after 5 s instead of queueing behind a
-- long transaction (only the FKs touch existing tables, briefly); a
-- timed-out deploy is simply rerun.
SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "SkillInstall" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "skillKey" TEXT NOT NULL,
    "installedVersion" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'enabled',
    "config" JSONB NOT NULL DEFAULT '{}',
    "needsConfig" BOOLEAN NOT NULL DEFAULT false,
    "lastAppliedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "installedById" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SkillInstall_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AgentToolCall" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "skillKey" TEXT,
    "outcome" TEXT NOT NULL,
    "errorCode" TEXT,
    "durationMs" INTEGER NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentToolCall_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SkillInstall_workspaceId_skillKey_key" ON "SkillInstall"("workspaceId", "skillKey");

CREATE INDEX IF NOT EXISTS "AgentToolCall_workspaceId_at_idx" ON "AgentToolCall"("workspaceId", "at");

CREATE INDEX IF NOT EXISTS "AgentToolCall_workspaceId_skillKey_at_idx" ON "AgentToolCall"("workspaceId", "skillKey", "at");

DO $$ BEGIN
    ALTER TABLE "SkillInstall" ADD CONSTRAINT "SkillInstall_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "SkillInstall" ADD CONSTRAINT "SkillInstall_installedById_fkey" FOREIGN KEY ("installedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "AgentToolCall" ADD CONSTRAINT "AgentToolCall_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
