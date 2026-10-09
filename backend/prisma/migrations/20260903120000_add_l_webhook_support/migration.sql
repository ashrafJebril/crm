-- Add l (agent platform) workspace mapping
ALTER TABLE "Workspace" ADD COLUMN "lWorkspaceId" TEXT;
CREATE UNIQUE INDEX "Workspace_lWorkspaceId_key" ON "Workspace"("lWorkspaceId");

-- Add l conversation tracking fields
ALTER TABLE "Conversation" ADD COLUMN "lConversationId" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "lAgentId" TEXT;
CREATE INDEX "Conversation_lConversationId_idx" ON "Conversation"("lConversationId");
