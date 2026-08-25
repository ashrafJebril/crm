-- HOTFIX 2026-08-17 (part 2): restore ALL remaining columns the live July
-- build (commit 4294dc9) still selects, which the 20260810 remove_ai
-- migration dropped from the shared DB. Computed by diffing that commit's
-- schema against information_schema — this is the complete set, so no more
-- column-by-column whack-a-mole.
-- All nullable/defaulted and ignored by the new code. Together with
-- kapsoCustomerId (part 1), drop them again in ONE cleanup migration AFTER
-- the new code is deployed and verified.
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "agent" TEXT;
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "suggested" TEXT;
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "aiPaused" BOOLEAN DEFAULT false;
ALTER TABLE "Appointment" ADD COLUMN IF NOT EXISTS "agentId" TEXT;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "agent" TEXT;
