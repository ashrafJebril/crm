-- SP-20 agent configuration. Hand-written, additive and idempotent.
-- Equal to `prisma migrate diff --from-schema-datamodel <a717d0d schema>
-- --to-schema-datamodel prisma/schema.prisma --script` (Prisma 5.22.0, no DB),
-- plus IF NOT EXISTS, the duplicate_object wrappers around the foreign keys
-- and the lock_timeout below.
-- Safe for the deployed main:
--   * Two new tables (AgentSettings, AgentSandboxThread) that main never
--     reads or writes.
--   * One nullable column "Workspace"."onboardingState" (JSONB, no default):
--     a metadata-only change, no table rewrite. main's Prisma client selects
--     only the columns it knows, so it never sees it.
--   * No data is rewritten; nothing is dropped and no column type changes.
--     No backfill: a workspace without an AgentSettings row behaves as today
--     (always on, nothing excluded, not stopped).
--   * The foreign keys live on the new tables only. Adding one takes a
--     SHARE ROW EXCLUSIVE lock on the referenced table ("Workspace", "User")
--     until commit: writes to those tables wait for the moment the
--     empty-table validation needs; reads are not blocked.
--   * lock_timeout: if a long transaction holds "Workspace" or "User", the
--     statement gives up after 5 s instead of queueing every later request
--     behind it. Prisma then records the migration as failed (P3009 on the
--     next deploy). To retry: run
--     `npx prisma migrate resolve --rolled-back 20261117130000_agent_config`,
--     then `npx prisma migrate deploy` again. The script is idempotent.
-- Applies after 20261117120000_knowledge_upgrade (SP-21), in timestamp order.
-- Apply with `prisma migrate deploy` only, after the user's explicit approval.

-- Give up instead of stalling the lock queue (SP-10 precedent).
SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "onboardingState" JSONB;

-- CreateTable
CREATE TABLE IF NOT EXISTS "AgentSettings" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "nameEn" TEXT,
    "nameAr" TEXT,
    "greeting" TEXT,
    "greetingAr" TEXT,
    "tone" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "hoursMode" TEXT NOT NULL DEFAULT 'always',
    "schedule" JSONB,
    "excludedTagIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "stoppedAt" TIMESTAMP(3),
    "stoppedReason" TEXT,
    "stoppedById" TEXT,
    "publishState" TEXT NOT NULL DEFAULT 'none',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "AgentSandboxThread" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "messages" JSONB NOT NULL DEFAULT '[]',
    "transcript" JSONB NOT NULL DEFAULT '[]',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentSandboxThread_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "AgentSettings_workspaceId_key" ON "AgentSettings"("workspaceId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AgentSandboxThread_expiresAt_idx" ON "AgentSandboxThread"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "AgentSandboxThread_workspaceId_userId_key" ON "AgentSandboxThread"("workspaceId", "userId");

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "AgentSettings" ADD CONSTRAINT "AgentSettings_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "AgentSandboxThread" ADD CONSTRAINT "AgentSandboxThread_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "AgentSandboxThread" ADD CONSTRAINT "AgentSandboxThread_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
