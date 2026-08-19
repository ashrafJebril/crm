-- Stage-driven smart segments: one crm-origin segment per pipeline stage, per
-- workspace, filtering contacts by "has a deal currently in this stage"
-- ({"stageAny":["<key>"]}). Names/Arabic names come from the workspace's own
-- stage labels; hues map from the stage's color token. Idempotent: skips any
-- workspace that already has a segment with the same stageAny filter.
INSERT INTO "Segment" ("id", "name", "nameAr", "color", "filter", "origin", "workspaceId", "createdAt", "updatedAt")
SELECT
  md5('stage-segment:' || ts."workspaceId" || ':' || ts."key"),
  CASE WHEN ts."isTerminal" THEN ts."label" || ' deals' ELSE ts."label" END,
  CASE
    WHEN ts."isWon" THEN 'صفقات ' || ts."labelAr"
    WHEN ts."isTerminal" THEN 'صفقات ' || ts."labelAr"
    ELSE ts."labelAr"
  END,
  CASE ts."color"
    WHEN 'ok' THEN '150'
    WHEN 'bad' THEN '0'
    WHEN 'warn' THEN '30'
    WHEN 'accent' THEN '270'
    WHEN 'info' THEN '210'
    ELSE '210'
  END,
  '{"stageAny":["' || ts."key" || '"]}',
  'crm',
  ts."workspaceId",
  NOW(),
  NOW()
FROM "TicketStage" ts
JOIN "Pipeline" p ON p."id" = ts."pipelineId" AND p."isDefault" = true
WHERE NOT EXISTS (
  SELECT 1 FROM "Segment" s
  WHERE s."workspaceId" = ts."workspaceId"
    AND s."filter" = '{"stageAny":["' || ts."key" || '"]}'
)
ORDER BY ts."workspaceId", ts."order";
