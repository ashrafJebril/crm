-- Comment auto-reply (comment -> Meta private reply -> inbox conversation).
-- Hand-written, additive and idempotent, matching this repo's migration style.
-- Equal to `prisma migrate diff --from-schema-datamodel <d8107f9 schema>
-- --to-schema-datamodel prisma/schema.prisma --script` (Prisma 5.22.0, no DB),
-- plus IF NOT EXISTS and the duplicate_object wrappers around the foreign keys.
--
-- Safe for the deployed main:
--   * Two brand-new tables. main neither reads nor writes them, so this is a
--     catalog-only change with no backfill and no lock on existing data.
--   * No UPDATE, DELETE, DROP or ALTER ... TYPE; no existing table is touched.
--   * Both FKs are on new, empty tables, so they validate instantly.

SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE IF NOT EXISTS "CommentAutoReply" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "automationId" TEXT,
    "keywords" TEXT NOT NULL,
    "matchMode" TEXT NOT NULL DEFAULT 'contains',
    "platformPostId" TEXT,
    "dmMessage" TEXT NOT NULL,
    "commentReply" TEXT,
    "replyOncePerPerson" BOOLEAN NOT NULL DEFAULT true,
    "dmDelaySeconds" INTEGER NOT NULL DEFAULT 0,
    "handoffToAgent" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "enabledAt" TIMESTAMP(3),
    "disabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommentAutoReply_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CommentLead" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "accountId" TEXT,
    "commentId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorName" TEXT,
    "text" TEXT,
    "postId" TEXT,
    "platformPostId" TEXT,
    "permalink" TEXT,
    "adId" TEXT,
    "adTitle" TEXT,
    "isDarkPost" BOOLEAN,
    "contactId" TEXT,
    "linkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommentLead_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CommentAutoReply_workspaceId_idx" ON "CommentAutoReply"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CommentAutoReply_workspaceId_accountId_key" ON "CommentAutoReply"("workspaceId", "accountId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CommentLead_workspaceId_platform_authorId_idx" ON "CommentLead"("workspaceId", "platform", "authorId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CommentLead_workspaceId_contactId_idx" ON "CommentLead"("workspaceId", "contactId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CommentLead_workspaceId_commentId_key" ON "CommentLead"("workspaceId", "commentId");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "CommentAutoReply" ADD CONSTRAINT "CommentAutoReply_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "CommentLead" ADD CONSTRAINT "CommentLead_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
