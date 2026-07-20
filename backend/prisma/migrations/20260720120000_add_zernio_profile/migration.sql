-- Zernio integration. Additive + backward-compatible.
--
-- Integration.provider already supports arbitrary transports (added with the
-- Kapso migration); Zernio rows simply use provider = 'zernio', so no change to
-- the Integration table is needed here.

-- Workspace.zernioProfileId: the Zernio "profile" this workspace maps to
-- (groups the workspace's connected social accounts). Created the first time we
-- generate a Zernio connect link and reused thereafter. Auth is the global
-- ZERNIO_API_KEY, so no per-integration token is stored. Null until first connect.
ALTER TABLE "Workspace" ADD COLUMN "zernioProfileId" TEXT;
