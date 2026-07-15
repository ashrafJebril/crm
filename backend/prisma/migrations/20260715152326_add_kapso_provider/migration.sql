-- WhatsApp via Kapso BSP (embedded signup). Additive + backward-compatible.

-- Integration.provider: "meta" (direct Cloud API) | "kapso" (via Kapso BSP).
ALTER TABLE "Integration" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'meta';

-- accessToken is null for kapso-provider WhatsApp (auth is the global project
-- API key, not a per-integration token). Relax the NOT NULL constraint.
ALTER TABLE "Integration" ALTER COLUMN "accessToken" DROP NOT NULL;

-- Workspace.kapsoCustomerId: the Kapso "customer" this workspace maps to.
ALTER TABLE "Workspace" ADD COLUMN "kapsoCustomerId" TEXT;
