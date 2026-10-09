-- Kewy AI — per-conversation AI control.
--
-- Both columns are additive and safe on a live table: `aiEnabled` defaults to
-- FALSE so switching the AI on for a workspace can never retroactively start
-- answering existing threads, and `aiPausedAt` is nullable with no default.
--
-- No backfill and no index: `aiEnabled` is only ever read alongside a
-- conversation already fetched by id, so it rides the existing primary key.

ALTER TABLE "Conversation"
  ADD COLUMN IF NOT EXISTS "aiEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "aiPausedAt" TIMESTAMP(3);
