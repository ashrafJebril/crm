-- Cache column for the l platform agent slug this workspace's Kewy AI
-- screens operate on. Nullable and lazily populated — resolved the first
-- time a tool/MCP-server bind call needs it, via l's idempotent
-- "ensure default agent" endpoint.
ALTER TABLE "Workspace" ADD COLUMN "lAgentSlug" TEXT;
