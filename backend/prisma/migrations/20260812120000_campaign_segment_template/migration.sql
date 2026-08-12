-- Honest campaign drafts: bind a draft to the real segment + WhatsApp template
-- it will use, so the builder stores data instead of hardcoded strings.
ALTER TABLE "Campaign" ADD COLUMN "segmentId" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "templateId" TEXT;
