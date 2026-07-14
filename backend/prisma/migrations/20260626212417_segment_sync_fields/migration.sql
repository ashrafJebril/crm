-- Extend Segment with sync fields for HJZ-CRM bidirectional integration
ALTER TABLE "Segment" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'crm';
ALTER TABLE "Segment" ADD COLUMN "externalId" TEXT;
ALTER TABLE "Segment" ADD COLUMN "externalRules" TEXT;
ALTER TABLE "Segment" ADD COLUMN "lastSyncedAt" TIMESTAMP(3);

-- Unique constraint on (workspaceId, origin, externalId) — NULLs are distinct
ALTER TABLE "Segment" ADD CONSTRAINT "Segment_workspaceId_origin_externalId_key" UNIQUE ("workspaceId", "origin", "externalId");

-- Materialized membership table for hjz-origin segments
CREATE TABLE "SegmentMember" (
    "segmentId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SegmentMember_pkey" PRIMARY KEY ("segmentId","contactId")
);

-- Index on contactId for reverse lookups
CREATE INDEX "SegmentMember_contactId_idx" ON "SegmentMember"("contactId");

-- Foreign key constraints
ALTER TABLE "SegmentMember" ADD CONSTRAINT "SegmentMember_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "Segment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SegmentMember" ADD CONSTRAINT "SegmentMember_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
