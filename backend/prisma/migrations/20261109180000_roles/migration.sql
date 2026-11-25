-- SP-25 roles & permissions. Additive and idempotent: a new "Role" table and a
-- nullable "WorkspaceMember"."roleId". The legacy "WorkspaceMember"."role"
-- string is untouched, so the currently deployed code keeps working.
CREATE TABLE IF NOT EXISTS "Role" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "key" TEXT,
  "name" TEXT NOT NULL,
  "nameAr" TEXT NOT NULL,
  "isSystem" BOOLEAN NOT NULL DEFAULT false,
  "permissions" JSONB NOT NULL,
  "conversationVisibility" TEXT NOT NULL DEFAULT 'all',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "WorkspaceMember" ADD COLUMN IF NOT EXISTS "roleId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Role_workspaceId_key_key" ON "Role"("workspaceId", "key");
CREATE UNIQUE INDEX IF NOT EXISTS "Role_workspaceId_name_key" ON "Role"("workspaceId", "name");
CREATE INDEX IF NOT EXISTS "WorkspaceMember_roleId_idx" ON "WorkspaceMember"("roleId");

DO $$ BEGIN
  ALTER TABLE "Role" ADD CONSTRAINT "Role_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_roleId_fkey"
    FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The four system roles for every existing workspace. The JSON must equal
-- SYSTEM_ROLES in backend/src/permissions/system-roles.ts (a spec compares
-- them). Workspaces created later get them lazily from PermissionService.
-- ON CONFLICT DO NOTHING (both (workspaceId,key) and (workspaceId,name) are
-- unique) makes a re-run a no-op.
INSERT INTO "Role" ("id", "workspaceId", "key", "name", "nameAr", "isSystem", "permissions", "conversationVisibility", "createdAt", "updatedAt")
SELECT md5(random()::text || clock_timestamp()::text), w."id", r."key", r."name", r."nameAr", true, r."permissions"::jsonb, r."conversationVisibility", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Workspace" w
CROSS JOIN (VALUES
  ('owner', 'Owner', 'المالك', '{"conversations":["view","create","update","delete","manage"],"contacts":["view","create","update","delete","manage"],"tickets":["view","create","update","delete","manage"],"pipelines":["view","create","update","delete","manage"],"bookings":["view","create","update","delete","manage"],"campaigns":["view","create","update","delete","manage"],"templates":["view","create","update","delete","manage"],"audiences":["view","create","update","delete","manage"],"knowledge":["view","create","update","delete","manage"],"agent":["view","create","update","delete","manage"],"channels":["view","create","update","delete","manage"],"connectors":["view","create","update","delete","manage"],"members":["view","create","update","delete","manage"],"roles":["view","create","update","delete","manage"],"billing":["view","create","update","delete","manage"],"settings":["view","create","update","delete","manage"],"api_keys":["view","create","update","delete","manage"],"reports":["view","create","update","delete","manage"],"workflows":["view","create","update","delete","manage"]}', 'all'),
  ('admin', 'Admin', 'المسؤول', '{"conversations":["view","create","update","delete","manage"],"contacts":["view","create","update","delete","manage"],"tickets":["view","create","update","delete","manage"],"pipelines":["view","create","update","delete","manage"],"bookings":["view","create","update","delete","manage"],"campaigns":["view","create","update","delete","manage"],"templates":["view","create","update","delete","manage"],"audiences":["view","create","update","delete","manage"],"knowledge":["view","create","update","delete","manage"],"agent":["view","create","update","delete","manage"],"channels":["view","create","update","delete","manage"],"connectors":["view","create","update","delete","manage"],"members":["view","create","update","delete","manage"],"roles":["view","create","update","delete"],"billing":["view","create","update","delete"],"settings":["view","create","update","delete","manage"],"api_keys":["view","create","update","delete","manage"],"reports":["view","create","update","delete","manage"],"workflows":["view","create","update","delete","manage"]}', 'all'),
  ('agent', 'Agent', 'الموظف', '{"conversations":["view","create","update"],"contacts":["view","create","update"],"tickets":["view","create","update"],"pipelines":["view"],"bookings":["view","create","update","delete"],"campaigns":["view","create","update"],"templates":["view","create","update","delete"],"audiences":["view","create","update","delete"],"knowledge":["view"],"agent":["view"],"channels":["view"],"connectors":[],"members":["view"],"roles":[],"billing":[],"settings":[],"api_keys":[],"reports":["view"],"workflows":["view","create","update","delete"]}', 'all'),
  ('viewer', 'Viewer', 'المشاهد', '{"conversations":["view"],"contacts":["view"],"tickets":["view"],"pipelines":["view"],"bookings":["view"],"campaigns":["view"],"templates":["view"],"audiences":["view"],"knowledge":["view"],"agent":["view"],"channels":["view"],"connectors":["view"],"members":["view"],"roles":[],"billing":[],"settings":["view"],"api_keys":[],"reports":["view"],"workflows":["view"]}', 'all')
) AS r("key", "name", "nameAr", "permissions", "conversationVisibility")
ON CONFLICT DO NOTHING;

-- Point existing members at the system role matching their legacy role string.
UPDATE "WorkspaceMember" m
SET "roleId" = r."id"
FROM "Role" r
WHERE r."workspaceId" = m."workspaceId"
  AND r."key" = lower(m."role")
  AND m."roleId" IS NULL;
