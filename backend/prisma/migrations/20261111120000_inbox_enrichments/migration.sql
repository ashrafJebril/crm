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

-- When a booking's status last changed. A BEFORE UPDATE trigger keeps every
-- writer (app, HJZ sync, webhooks) correct; deployed code never reads it.
ALTER TABLE "Appointment" ADD COLUMN IF NOT EXISTS "statusChangedAt" TIMESTAMP(3);

CREATE OR REPLACE FUNCTION "appointment_status_changed_at"() RETURNS trigger AS $$
BEGIN
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    NEW."statusChangedAt" = now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "Appointment_status_changed_at" ON "Appointment";
CREATE TRIGGER "Appointment_status_changed_at"
  BEFORE UPDATE ON "Appointment"
  FOR EACH ROW EXECUTE FUNCTION "appointment_status_changed_at"();
