-- Remove the AI feature set.
--
-- Live rows still carry AI-era values, so migrate the data BEFORE dropping
-- anything: conversations the AI handled become plain human threads, and any
-- message or booking the AI produced is re-attributed to a human. All three
-- target values are already valid members of their respective enums, so these
-- updates are safe against existing data.

UPDATE "Conversation" SET "status" = 'human' WHERE "status" = 'ai';
UPDATE "Conversation" SET "lastFrom" = 'human' WHERE "lastFrom" = 'ai';
UPDATE "Message" SET "from" = 'human' WHERE "from" = 'ai';
UPDATE "Appointment" SET "source" = 'human' WHERE "source" = 'ai';

-- `aiPaused` only meant "AI auto-reply is paused on this thread", and
-- `suggested` held the AI's drafted reply — neither has a producer any more.
ALTER TABLE "Conversation" DROP COLUMN "aiPaused";
ALTER TABLE "Conversation" DROP COLUMN "suggested";

-- These pointed at the static AI agent roster (Luna/Atlas/Nova/Rumi), which is
-- gone. Human ownership is tracked separately: Appointment."staffId" for
-- bookings, and workspace membership roles elsewhere.
ALTER TABLE "Conversation" DROP COLUMN "agent";
ALTER TABLE "Appointment" DROP COLUMN "agentId";
ALTER TABLE "Campaign" DROP COLUMN "agent";
