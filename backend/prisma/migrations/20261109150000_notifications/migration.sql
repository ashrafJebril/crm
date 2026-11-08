-- Notifications, per-type preferences, note threads/mentions/read receipts.
-- Additive only: new tables, and new columns that are nullable or defaulted,
-- so the currently deployed code is unaffected.
ALTER TABLE "Note"
  ADD COLUMN IF NOT EXISTS "parentId" TEXT,
  ADD COLUMN IF NOT EXISTS "mentions" TEXT[] DEFAULT ARRAY[]::TEXT[];

CREATE TABLE IF NOT EXISTS "NoteSeen" (
  "noteId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NoteSeen_pkey" PRIMARY KEY ("noteId", "userId")
);

CREATE TABLE IF NOT EXISTS "Notification" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT,
  "recordKind" TEXT,
  "recordId" TEXT,
  "actorId" TEXT,
  "readAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "NotificationPreference" (
  "workspaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "inApp" BOOLEAN NOT NULL DEFAULT true,
  "sound" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("workspaceId", "userId", "type")
);

CREATE INDEX IF NOT EXISTS "Note_parentId_idx" ON "Note"("parentId");
CREATE INDEX IF NOT EXISTS "NoteSeen_userId_idx" ON "NoteSeen"("userId");
CREATE INDEX IF NOT EXISTS "Notification_workspaceId_userId_readAt_idx" ON "Notification"("workspaceId", "userId", "readAt");
CREATE INDEX IF NOT EXISTS "Notification_workspaceId_userId_createdAt_idx" ON "Notification"("workspaceId", "userId", "createdAt");

DO $$ BEGIN
  ALTER TABLE "Note" ADD CONSTRAINT "Note_parentId_fkey"
    FOREIGN KEY ("parentId") REFERENCES "Note"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "NoteSeen" ADD CONSTRAINT "NoteSeen_noteId_fkey"
    FOREIGN KEY ("noteId") REFERENCES "Note"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
