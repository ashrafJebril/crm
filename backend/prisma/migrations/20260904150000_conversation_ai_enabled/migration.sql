-- Per-conversation opt-in for l agent auto-replies. Default false: existing
-- threads keep answering by hand until someone explicitly turns this on.
-- IF NOT EXISTS: 20260828120000_conversation_ai_flags adds the same column, so
-- on a database that already ran it a plain ADD COLUMN fails the deploy.
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "aiEnabled" BOOLEAN NOT NULL DEFAULT false;
