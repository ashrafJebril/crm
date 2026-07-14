-- Segment — a named, saved filter spec over the Contact table. Used by the
-- Contacts chip bar and the Campaigns audience picker. `filter` is JSON.
CREATE TABLE "Segment" (
  "id"          TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "nameAr"      TEXT,
  "color"       TEXT,
  "filter"      TEXT NOT NULL DEFAULT '{}',
  "workspaceId" TEXT NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Segment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Segment_workspaceId_idx" ON "Segment"("workspaceId");

ALTER TABLE "Segment"
  ADD CONSTRAINT "Segment_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
