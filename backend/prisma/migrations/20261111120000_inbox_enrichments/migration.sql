-- SP-31 inbox enrichments. Additive and idempotent: nullable columns and one
-- new table. Deployed code ignores all of it.

ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "reaction" TEXT;
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "reactionAt" TIMESTAMP(3);

ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "topics" JSONB;
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "painPoints" JSONB;

CREATE TABLE IF NOT EXISTS "SavedReply" (
  "id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "bodyAr" TEXT,
  "shortcut" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "workspaceId" TEXT NOT NULL,
  CONSTRAINT "SavedReply_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SavedReply_workspaceId_shortcut_key" ON "SavedReply"("workspaceId", "shortcut");
CREATE INDEX IF NOT EXISTS "SavedReply_workspaceId_idx" ON "SavedReply"("workspaceId");

DO $$ BEGIN
  ALTER TABLE "SavedReply" ADD CONSTRAINT "SavedReply_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
