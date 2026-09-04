-- Per-conversation opt-in for l agent auto-replies. Default false: existing
-- threads keep answering by hand until someone explicitly turns this on.
ALTER TABLE "Conversation" ADD COLUMN "aiEnabled" BOOLEAN NOT NULL DEFAULT false;
