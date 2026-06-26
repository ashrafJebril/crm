-- JOTECK admin: per-workspace module flag list.
-- NULL = all modules enabled (backwards compatible).
ALTER TABLE "Workspace" ADD COLUMN "enabledModules" JSONB;
