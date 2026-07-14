-- Per-message delivery tracking (WhatsApp status webhooks: sent/delivered/read/failed).
-- `metaMessageId` is Meta's `wamid` for outbound messages; webhook payloads
-- reference it so we can match the status back to the right Message row.

ALTER TABLE "Message" ADD COLUMN "metaMessageId" TEXT;
ALTER TABLE "Message" ADD COLUMN "deliveryStatus" TEXT;
ALTER TABLE "Message" ADD COLUMN "deliveryStatusAt" TIMESTAMP(3);

CREATE INDEX "Message_metaMessageId_idx" ON "Message"("metaMessageId");
