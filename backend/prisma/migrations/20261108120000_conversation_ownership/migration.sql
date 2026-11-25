-- Conversation ownership: assignee, optimistic version, status history, labels.
-- Additive only: every new column is nullable or defaulted.
ALTER TABLE "Conversation"
  ADD COLUMN IF NOT EXISTS "assigneeId" TEXT,
  ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "escalateReason" TEXT,
  ADD COLUMN IF NOT EXISTS "statusChangedAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "ConversationLabel" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "color" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConversationLabel_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ConversationLabelLink" (
  "conversationId" TEXT NOT NULL,
  "labelId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConversationLabelLink_pkey" PRIMARY KEY ("conversationId", "labelId")
);

CREATE INDEX IF NOT EXISTS "Conversation_workspaceId_assigneeId_idx" ON "Conversation"("workspaceId", "assigneeId");
CREATE UNIQUE INDEX IF NOT EXISTS "ConversationLabel_workspaceId_name_key" ON "ConversationLabel"("workspaceId", "name");
CREATE INDEX IF NOT EXISTS "ConversationLabel_workspaceId_idx" ON "ConversationLabel"("workspaceId");
CREATE INDEX IF NOT EXISTS "ConversationLabelLink_labelId_idx" ON "ConversationLabelLink"("labelId");

DO $$ BEGIN
  ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_assigneeId_fkey"
    FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ConversationLabel" ADD CONSTRAINT "ConversationLabel_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ConversationLabelLink" ADD CONSTRAINT "ConversationLabelLink_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ConversationLabelLink" ADD CONSTRAINT "ConversationLabelLink_labelId_fkey"
    FOREIGN KEY ("labelId") REFERENCES "ConversationLabel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Reopen a pending/resolved/closed thread when the customer writes again.
-- Spam stays sticky. Backfilled history (older than the status change) is ignored.
CREATE OR REPLACE FUNCTION conversation_reopen_on_inbound() RETURNS trigger AS $$
BEGIN
  IF NEW."from" = 'them' THEN
    UPDATE "Conversation"
       SET "status" = 'human', "statusChangedAt" = NOW(), "version" = "version" + 1
     WHERE "id" = NEW."conversationId"
       AND "status" IN ('pending_customer', 'resolved', 'closed')
       AND ("statusChangedAt" IS NULL OR NEW."createdAt" >= "statusChangedAt");
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS conversation_reopen_on_inbound ON "Message";
CREATE TRIGGER conversation_reopen_on_inbound AFTER INSERT ON "Message"
  FOR EACH ROW EXECUTE FUNCTION conversation_reopen_on_inbound();
