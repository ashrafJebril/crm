-- SP-04 activities and follow-ups. Additive and idempotent: a new "Activity"
-- table only; no existing table is altered.
CREATE TABLE IF NOT EXISTS "Activity" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "notes" TEXT,
  "dueAt" TIMESTAMP(3),
  "doneAt" TIMESTAMP(3),
  "outcome" TEXT,
  "notifiedAt" TIMESTAMP(3),
  "assigneeId" TEXT,
  "contactId" TEXT,
  "ticketId" TEXT,
  "bookingId" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Activity_workspaceId_assigneeId_doneAt_dueAt_idx" ON "Activity"("workspaceId", "assigneeId", "doneAt", "dueAt");
CREATE INDEX IF NOT EXISTS "Activity_workspaceId_contactId_idx" ON "Activity"("workspaceId", "contactId");
CREATE INDEX IF NOT EXISTS "Activity_workspaceId_ticketId_idx" ON "Activity"("workspaceId", "ticketId");

DO $$ BEGIN
  ALTER TABLE "Activity" ADD CONSTRAINT "Activity_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "Activity" ADD CONSTRAINT "Activity_assigneeId_fkey"
    FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "Activity" ADD CONSTRAINT "Activity_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "Activity" ADD CONSTRAINT "Activity_ticketId_fkey"
    FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "Activity" ADD CONSTRAINT "Activity_bookingId_fkey"
    FOREIGN KEY ("bookingId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
