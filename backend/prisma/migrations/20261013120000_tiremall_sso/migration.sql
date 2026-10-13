-- Tiremall SSO: identity columns for the Tiremall workspace and its users.
ALTER TABLE "User" ADD COLUMN "tiremallUserId" TEXT;
ALTER TABLE "Workspace" ADD COLUMN "tiremallTenantId" TEXT;
CREATE UNIQUE INDEX "User_tiremallUserId_key" ON "User"("tiremallUserId");
CREATE UNIQUE INDEX "Workspace_tiremallTenantId_key" ON "Workspace"("tiremallTenantId");
