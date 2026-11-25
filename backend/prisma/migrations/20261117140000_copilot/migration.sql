-- SP-18 in-app copilot. Hand-written, additive and idempotent.
-- Equal to `prisma migrate diff --from-schema-datamodel <fdd11c9 schema>
-- --to-schema-datamodel prisma/schema.prisma --script` (Prisma 5.22.0, no DB),
-- plus IF NOT EXISTS, the duplicate_object wrappers around the foreign keys
-- and the lock_timeout below.
-- Safe for the deployed main:
--   * Five new tables (CopilotSession, CopilotMessage, CopilotPendingAction,
--     CopilotAttachment, CopilotActionAudit) that main never reads or writes.
--   * No existing table, column, constraint or index changes (the Ads* tables
--     are untouched); no data is rewritten; nothing is dropped and no column
--     type changes. No backfill.
--   * The foreign keys live on the new tables only. Adding one takes a
--     SHARE ROW EXCLUSIVE lock on the referenced table ("Workspace", "User",
--     "Media") until commit: writes to those tables wait for the moment the
--     empty-table validation needs; reads are not blocked.
--   * lock_timeout: if a long transaction holds a referenced table, the
--     statement gives up after 5 s instead of queueing every later request
--     behind it. Prisma then records the migration as failed (P3009 on the
--     next deploy). To retry: run
--     `npx prisma migrate resolve --rolled-back 20261117140000_copilot`,
--     then `npx prisma migrate deploy` again. The script is idempotent.
-- Applies after 20261117130000_agent_config (SP-20) and before
-- 20261117150000_lifecycle_messages (SP-24), in timestamp order.
-- Apply with `prisma migrate deploy` only, after the user's explicit approval.

-- Give up instead of stalling the lock queue (SP-10 precedent).
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE IF NOT EXISTS "CopilotSession" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "persona" TEXT NOT NULL DEFAULT 'aida',
    "title" TEXT,
    "runningUntil" TIMESTAMP(3),
    "tainted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CopilotSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CopilotMessage" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL DEFAULT '',
    "content" JSONB,
    "references" JSONB,
    "attachments" JSONB,
    "sources" JSONB,
    "pageContext" JSONB,
    "usage" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CopilotMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CopilotPendingAction" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "argsJson" JSONB NOT NULL,
    "argsHash" TEXT NOT NULL,
    "card" JSONB NOT NULL,
    "permission" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "decidedBy" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "feedback" TEXT,
    "refusal" TEXT,
    "resultJson" JSONB,
    "errorKey" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CopilotPendingAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CopilotAttachment" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT,
    "mediaId" TEXT,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "text" TEXT,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CopilotAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CopilotActionAudit" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "actorId" TEXT,
    "tool" TEXT NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CopilotActionAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CopilotSession_workspaceId_userId_updatedAt_idx" ON "CopilotSession"("workspaceId", "userId", "updatedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CopilotMessage_sessionId_createdAt_idx" ON "CopilotMessage"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CopilotMessage_workspaceId_idx" ON "CopilotMessage"("workspaceId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CopilotPendingAction_workspaceId_userId_status_idx" ON "CopilotPendingAction"("workspaceId", "userId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CopilotPendingAction_sessionId_idx" ON "CopilotPendingAction"("sessionId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CopilotAttachment_workspaceId_userId_idx" ON "CopilotAttachment"("workspaceId", "userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CopilotAttachment_sessionId_idx" ON "CopilotAttachment"("sessionId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CopilotAttachment_mediaId_idx" ON "CopilotAttachment"("mediaId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CopilotActionAudit_workspaceId_actionId_createdAt_idx" ON "CopilotActionAudit"("workspaceId", "actionId", "createdAt");

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "CopilotSession" ADD CONSTRAINT "CopilotSession_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "CopilotSession" ADD CONSTRAINT "CopilotSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "CopilotMessage" ADD CONSTRAINT "CopilotMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CopilotSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "CopilotPendingAction" ADD CONSTRAINT "CopilotPendingAction_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CopilotSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "CopilotAttachment" ADD CONSTRAINT "CopilotAttachment_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "Media"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
