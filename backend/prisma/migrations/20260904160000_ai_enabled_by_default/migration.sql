-- The agent is the first responder, so new threads answer automatically and a
-- human takes over by switching a thread off rather than switching it on.
ALTER TABLE "Conversation" ALTER COLUMN "aiEnabled" SET DEFAULT true;

-- Existing threads too: they were created under the old default and would
-- otherwise stay silent forever.
UPDATE "Conversation" SET "aiEnabled" = true;
