-- SP-09 support tickets. Hand-written, additive and idempotent.
-- Equal to `prisma migrate diff --from-schema-datamodel <ab353a4 schema>
-- --to-schema-datamodel prisma/schema.prisma --script`, plus IF NOT EXISTS,
-- the duplicate_object wrappers around the foreign keys, and the SLA trigger
-- (Prisma does not model triggers).
-- Safe for the deployed main:
--   * "priority" has a constant default (metadata-only on Postgres 11+, no
--     rewrite); main's inserts omit it and get 'normal'. "category" and
--     "slaDueAt" are nullable and never selected by main's client.
--   * The trigger only writes "slaDueAt", a column main never reads, and never
--     raises (a missing stage row leaves it null). It does not touch
--     "enteredStageAt".
--   * main deleting a ticket or a media file cascades the TicketAttachment row.
--   * No existing column, constraint or index changes; no data is rewritten.
--     The SLA backfill for existing tickets is a separate, user-approved
--     script (backend/scripts/backfill-ticket-sla.sql).
-- Apply with `prisma migrate deploy` only, after the user's explicit approval.

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN IF NOT EXISTS "category" TEXT,
ADD COLUMN IF NOT EXISTS "priority" TEXT NOT NULL DEFAULT 'normal',
ADD COLUMN IF NOT EXISTS "slaDueAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE IF NOT EXISTS "TicketAttachment" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "messageId" TEXT,
    "addedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TicketAttachment_workspaceId_idx" ON "TicketAttachment"("workspaceId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TicketAttachment_mediaId_idx" ON "TicketAttachment"("mediaId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "TicketAttachment_ticketId_mediaId_key" ON "TicketAttachment"("ticketId", "mediaId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Ticket_workspaceId_slaDueAt_idx" ON "Ticket"("workspaceId", "slaDueAt");

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "TicketAttachment" ADD CONSTRAINT "TicketAttachment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "TicketAttachment" ADD CONSTRAINT "TicketAttachment_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "TicketAttachment" ADD CONSTRAINT "TicketAttachment_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "Media"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "TicketAttachment" ADD CONSTRAINT "TicketAttachment_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- SLA due date on stage entry (ruling 1). Every writer of "stageId" passes
-- here: the app, bulk moves, imports, workflows, the resolution sweep, undo,
-- reopen, stage deletes, and the deployed main. Due = entry + slaMinutes
-- (wall clock); null when the stage has no SLA or is terminal. Editing a
-- stage's slaMinutes later does not move existing due dates (ruling 2).
-- The entry time is the writer's own "enteredStageAt" when it set one in this
-- statement, else now() in UTC (Prisma stores TIMESTAMP(3) as UTC).
CREATE OR REPLACE FUNCTION "ticket_sla_due_at"() RETURNS trigger AS $$
DECLARE
  st RECORD;
  entered TIMESTAMP(3);
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."stageId" IS NOT DISTINCT FROM OLD."stageId" THEN
    RETURN NEW;
  END IF;
  SELECT "slaMinutes", "isTerminal" INTO st FROM "TicketStage" WHERE "id" = NEW."stageId";
  IF TG_OP = 'INSERT' OR NEW."enteredStageAt" IS DISTINCT FROM OLD."enteredStageAt" THEN
    entered := NEW."enteredStageAt";
  ELSE
    entered := timezone('UTC', now());
  END IF;
  IF st."slaMinutes" IS NULL OR st."isTerminal" OR entered IS NULL THEN
    NEW."slaDueAt" := NULL;
  ELSE
    NEW."slaDueAt" := entered + make_interval(mins => st."slaMinutes");
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "Ticket_sla_due_at" ON "Ticket";
CREATE TRIGGER "Ticket_sla_due_at"
  BEFORE INSERT OR UPDATE OF "stageId" ON "Ticket"
  FOR EACH ROW EXECUTE FUNCTION "ticket_sla_due_at"();
