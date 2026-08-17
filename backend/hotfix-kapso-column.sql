-- HOTFIX 2026-08-17: re-add the column dropped by 20260811150000_remove_kapso.
-- The deployed app (origin/main) still selects Workspace.kapsoCustomerId on
-- every workspace query, so dropping it broke live login on the shared DB.
-- Nullable + unused by current code; drop again in a proper migration AFTER
-- the new code is deployed.
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "kapsoCustomerId" TEXT;
