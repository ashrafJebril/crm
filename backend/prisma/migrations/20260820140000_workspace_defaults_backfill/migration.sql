-- Backfill the defaults every workspace is supposed to have. Provisioning now
-- creates these (src/workspaces/workspace-defaults.ts), but every workspace
-- created before that shipped has no pipeline, no stages, and no smart groups:
-- their Pipeline screen is empty and the inbound-message automation no-ops
-- because it resolves stages by groupKey. Idempotent — each step skips what
-- already exists, so re-running is a no-op.

-- 1. Default sales pipeline, for any workspace lacking one.
INSERT INTO "Pipeline" ("id", "key", "name", "nameAr", "isDefault", "workspaceId", "createdAt")
SELECT md5('pipeline:sales:' || w."id"), 'sales', 'Sales', 'المبيعات', true, w."id", NOW()
FROM "Workspace" w
WHERE NOT EXISTS (
  SELECT 1 FROM "Pipeline" p WHERE p."workspaceId" = w."id" AND p."key" = 'sales'
);

-- 2. The six stages, into each workspace's sales pipeline. groupKey values
--    'new' and 'contacted' are what the auto-ticket automation looks up.
INSERT INTO "TicketStage" ("id", "pipelineId", "key", "label", "labelAr", "color", "order", "groupKey", "isTerminal", "isWon", "slaMinutes", "workspaceId")
SELECT
  md5('stage:' || p."workspaceId" || ':' || s."key"),
  p."id", s."key", s."label", s."labelAr", s."color", s."order", s."key",
  s."isTerminal", s."isWon", s."slaMinutes", p."workspaceId"
FROM "Pipeline" p
CROSS JOIN (VALUES
  ('new',        'New',        'جديد',       'info',   0, false, false, 240),
  ('contacted',  'Contacted',  'تم التواصل', 'info',   1, false, false, 1440),
  ('interested', 'Interested', 'مهتم',       'accent', 2, false, false, 2880),
  ('waiting',    'Waiting',    'بالانتظار',  'warn',   3, false, false, 4320),
  ('won',        'Won',        'تم الفوز',   'ok',     4, true,  true,  NULL),
  ('lost',       'Lost',       'خسارة',      'bad',    5, true,  false, NULL)
) AS s("key", "label", "labelAr", "color", "order", "isTerminal", "isWon", "slaMinutes")
WHERE p."key" = 'sales'
  AND NOT EXISTS (
    SELECT 1 FROM "TicketStage" ts
    WHERE ts."workspaceId" = p."workspaceId" AND ts."key" = s."key"
  );

-- 3. Starter smart groups (property-based) + one per stage (deal-based), for
--    any workspace missing them by name.
INSERT INTO "Segment" ("id", "name", "nameAr", "color", "filter", "origin", "workspaceId", "createdAt", "updatedAt")
SELECT
  md5('segment:' || w."id" || ':' || g."name"),
  g."name", g."nameAr", g."color", g."filter", 'crm', w."id", NOW(), NOW()
FROM "Workspace" w
CROSS JOIN (VALUES
  ('All leads',       'العملاء المحتملون', '30',  '{"lifecycle":["lead"]}'),
  ('Customers',       'العملاء',           '150', '{"lifecycle":["customer"]}'),
  ('Has phone',       'لديهم هاتف',        '240', '{"hasPhone":true}'),
  ('No phone',        'بدون هاتف',         '320', '{"hasPhone":false}'),
  ('New',             'جديد',              '210', '{"stageAny":["new"]}'),
  ('Contacted',       'تم التواصل',        '210', '{"stageAny":["contacted"]}'),
  ('Interested',      'مهتم',              '270', '{"stageAny":["interested"]}'),
  ('Waiting',         'بالانتظار',         '30',  '{"stageAny":["waiting"]}'),
  ('Won deals',       'صفقات تم الفوز',    '150', '{"stageAny":["won"]}'),
  ('Lost deals',      'صفقات خسارة',       '0',   '{"stageAny":["lost"]}')
) AS g("name", "nameAr", "color", "filter")
WHERE NOT EXISTS (
  SELECT 1 FROM "Segment" s WHERE s."workspaceId" = w."id" AND s."name" = g."name"
);
