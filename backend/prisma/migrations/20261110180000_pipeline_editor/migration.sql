-- SP-07 pipeline editor. Additive and idempotent: new nullable/defaulted
-- columns, one new table, one backfill. Deployed code ignores all of it.

ALTER TABLE "Pipeline" ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Pipeline" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);
ALTER TABLE "Pipeline" ADD COLUMN IF NOT EXISTS "staleDays" INTEGER;
ALTER TABLE "Pipeline" ADD COLUMN IF NOT EXISTS "agentCanMove" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Pipeline" ADD COLUMN IF NOT EXISTS "assignsConversations" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Pipeline" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'deals';

ALTER TABLE "Ticket" ADD COLUMN IF NOT EXISTS "lostReasonId" TEXT;

CREATE TABLE IF NOT EXISTS "LostReason" (
  "id" TEXT NOT NULL,
  "pipelineId" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "labelAr" TEXT NOT NULL,
  "order" INTEGER NOT NULL DEFAULT 0,
  "archivedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "workspaceId" TEXT NOT NULL,
  CONSTRAINT "LostReason_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "LostReason_pipelineId_idx" ON "LostReason"("pipelineId");
CREATE INDEX IF NOT EXISTS "LostReason_workspaceId_idx" ON "LostReason"("workspaceId");
CREATE INDEX IF NOT EXISTS "Ticket_lostReasonId_idx" ON "Ticket"("lostReasonId");

DO $$ BEGIN
  ALTER TABLE "LostReason" ADD CONSTRAINT "LostReason_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "LostReason" ADD CONSTRAINT "LostReason_pipelineId_fkey"
    FOREIGN KEY ("pipelineId") REFERENCES "Pipeline"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_lostReasonId_fkey"
    FOREIGN KEY ("lostReasonId") REFERENCES "LostReason"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The support pipeline (resolution/support-pipeline.ts, key "support").
UPDATE "Pipeline" SET "kind" = 'support' WHERE "key" = 'support' AND "kind" = 'deals';

-- Backfill: the five reasons previously hardcoded in LostReasonModal.tsx, for
-- every pipeline that has no lost reasons yet (re-running adds nothing).
INSERT INTO "LostReason" ("id", "pipelineId", "workspaceId", "label", "labelAr", "order")
SELECT 'lr_' || md5(p."id" || ':' || r."ord"::text || clock_timestamp()::text),
       p."id", p."workspaceId", r."label", r."labelAr", r."ord"
FROM "Pipeline" p
CROSS JOIN (VALUES
  (0, 'Price too high', 'السعر مرتفع'),
  (1, 'Found cheaper alternative', 'وجد بديلاً أرخص'),
  (2, 'Customer went silent', 'توقف العميل'),
  (3, 'Wrong product fit', 'غير مناسب'),
  (4, 'Other', 'أخرى')
) AS r("ord", "label", "labelAr")
WHERE NOT EXISTS (SELECT 1 FROM "LostReason" lr WHERE lr."pipelineId" = p."id");
