-- HJZ SSO bridge — additive schema for cross-system identity sync.
-- Adds:
--   Workspace.externalTenantId (unique)  → maps hjz tenant id → tkana workspace
--   User.externalId            (unique)  → maps hjz user id  → tkana user
--   User.password → nullable             → SSO users don't have a local password
--
-- Contact already has externalSource + externalId with a composite unique
-- (workspaceId, externalSource, externalId) — HJZ-synced contacts will use
-- externalSource='hjz' and no further schema change is needed there.

-- AlterTable
ALTER TABLE "User"
  ADD COLUMN "externalId" TEXT,
  ALTER COLUMN "password" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN "externalTenantId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_externalId_key" ON "User"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_externalTenantId_key" ON "Workspace"("externalTenantId");
