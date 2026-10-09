-- Where this workspace's human replies are posted on the l side, and the
-- secret that authenticates them. Nullable: a workspace with no agent
-- platform behind it simply does not forward.
ALTER TABLE "Workspace" ADD COLUMN "lEndpointId" TEXT;
ALTER TABLE "Workspace" ADD COLUMN "lEndpointSecret" TEXT;
