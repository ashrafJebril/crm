-- SP-21 knowledge upgrade. Hand-written, additive and idempotent.
-- Equal to `prisma migrate diff --from-schema-datamodel <c7bb50f schema>
-- --to-schema-datamodel prisma/schema.prisma --script` (Prisma 5.22.0, no DB),
-- plus IF NOT EXISTS, the duplicate_object wrappers around the foreign keys,
-- the lock_timeout below, and the full-text index "KnowledgeChunk_fts_idx"
-- (an expression index Prisma cannot model).
-- Safe for the deployed main:
--   * Three new tables (KnowledgeSource, KnowledgePage, KnowledgeChunk) that
--     main never reads or writes.
--   * No existing table, column, constraint or index changes; no data is
--     rewritten; nothing is dropped and no column type changes.
--   * The foreign keys live on the new tables only. Adding one takes a
--     SHARE ROW EXCLUSIVE lock on the referenced table ("Workspace", "Media")
--     until commit: writes to those two tables wait for the moment the
--     empty-table validation needs; reads are not blocked.
--   * main's media library may list knowledge PDFs and images uploaded
--     through SP-21 until SP-21 is deployed (ruling 9, accepted).
--   * lock_timeout: if a long transaction holds "Workspace" or "Media", the
--     FK gives up after 5 s instead of queueing every later request behind
--     it. Prisma then records the migration as failed (P3009 on the next
--     deploy). To retry: run
--     `npx prisma migrate resolve --rolled-back 20261117120000_knowledge_upgrade`,
--     then `npx prisma migrate deploy` again. The script is idempotent.
-- Applies after 20261116130000_bookings_catalog (SP-10) and
-- 20261116140000_insights_home (SP-11), in timestamp order.
-- Apply with `prisma migrate deploy` only, after the user's explicit approval.

-- Give up instead of stalling the lock queue (SP-10 precedent).
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE IF NOT EXISTS "KnowledgeSource" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ready',
    "error" TEXT,
    "title" TEXT NOT NULL,
    "bodyJson" JSONB,
    "body" TEXT,
    "question" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "mediaId" TEXT,
    "typedKind" TEXT,
    "url" TEXT,
    "scope" TEXT,
    "schedule" TEXT,
    "nextSyncAt" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "syncStartedAt" TIMESTAMP(3),
    "refreshRequestedAt" TIMESTAMP(3),
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastRun" JSONB,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "contentHash" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "upstream" JSONB,
    "publishState" TEXT NOT NULL DEFAULT 'none',
    "legacyRef" TEXT,
    "createdById" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "KnowledgePage" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "urlKey" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "httpStatus" INTEGER,
    "title" TEXT,
    "contentHash" TEXT,
    "missedRuns" INTEGER NOT NULL DEFAULT 0,
    "lastSeenAt" TIMESTAMP(3),
    "lastReadAt" TIMESTAMP(3),
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgePage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "KnowledgeChunk" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "pageId" TEXT,
    "ord" INTEGER NOT NULL,
    "heading" TEXT,
    "text" TEXT NOT NULL,
    "rowRef" INTEGER,
    "validTo" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "KnowledgeSource_workspaceId_kind_order_idx" ON "KnowledgeSource"("workspaceId", "kind", "order");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "KnowledgeSource_status_nextSyncAt_idx" ON "KnowledgeSource"("status", "nextSyncAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "KnowledgeSource_mediaId_idx" ON "KnowledgeSource"("mediaId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "KnowledgeSource_workspaceId_legacyRef_key" ON "KnowledgeSource"("workspaceId", "legacyRef");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "KnowledgePage_workspaceId_idx" ON "KnowledgePage"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "KnowledgePage_sourceId_urlKey_key" ON "KnowledgePage"("sourceId", "urlKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "KnowledgeChunk_workspaceId_sourceId_idx" ON "KnowledgeChunk"("workspaceId", "sourceId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "KnowledgeChunk_pageId_idx" ON "KnowledgeChunk"("pageId");

-- CreateIndex (outside the Prisma model, like SP-09's trigger): full-text search.
-- The search service queries exactly to_tsvector('simple', "text") so this index is used.
CREATE INDEX IF NOT EXISTS "KnowledgeChunk_fts_idx" ON "KnowledgeChunk" USING GIN (to_tsvector('simple', "text"));

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "KnowledgeSource" ADD CONSTRAINT "KnowledgeSource_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "KnowledgeSource" ADD CONSTRAINT "KnowledgeSource_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "Media"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "KnowledgePage" ADD CONSTRAINT "KnowledgePage_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "KnowledgeSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "KnowledgeSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "KnowledgePage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
