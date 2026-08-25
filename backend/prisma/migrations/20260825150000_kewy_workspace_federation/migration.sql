-- Kewy workspace federation: link crm workspaces/users back to the Kewy
-- control panel, and add the single-use guard for Kewy SSO handoff tokens.
-- All additive and nullable; existing rows and flows are untouched.

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "kewyWorkspaceId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "kewyAccountId" TEXT;

-- CreateTable
CREATE TABLE "SsoNonce" (
    "jti" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SsoNonce_pkey" PRIMARY KEY ("jti")
);

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_kewyWorkspaceId_key" ON "Workspace"("kewyWorkspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "User_kewyAccountId_key" ON "User"("kewyAccountId");

-- CreateIndex
CREATE INDEX "SsoNonce_expiresAt_idx" ON "SsoNonce"("expiresAt");
