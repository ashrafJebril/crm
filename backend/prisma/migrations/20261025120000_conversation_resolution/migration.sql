-- Conversation resolution (judged by Kewy AI after the thread goes quiet).
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "resolutionStatus" TEXT;
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "resolution" TEXT;
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "resolutionIssue" TEXT;
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "resolutionConfidence" DOUBLE PRECISION;
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "resolutionSentiment" TEXT;
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "resolutionSummary" TEXT;
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "resolutionRationale" TEXT;
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "resolvedAt" TIMESTAMP(3);
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "resolutionCheckedAt" TIMESTAMP(3);
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "resolutionAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "resolutionError" TEXT;

-- The sweep finds each conversation's latest message among recent ones.
CREATE INDEX IF NOT EXISTS "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");
CREATE INDEX IF NOT EXISTS "Message_createdAt_idx" ON "Message"("createdAt");

-- Existing threads are judged from their next message on, not back-filled:
-- marking them checked now keeps the first sweep from classifying (and
-- ticketing) a workspace's whole history at once.
UPDATE "Conversation" SET "resolutionCheckedAt" = NOW() WHERE "resolutionCheckedAt" IS NULL;
