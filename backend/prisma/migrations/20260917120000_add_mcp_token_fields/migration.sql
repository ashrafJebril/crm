-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "mcpTokenCreatedAt" TIMESTAMP(3),
ADD COLUMN     "mcpTokenHash" TEXT,
ADD COLUMN     "mcpTokenPrefix" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_mcpTokenPrefix_key" ON "Workspace"("mcpTokenPrefix");

