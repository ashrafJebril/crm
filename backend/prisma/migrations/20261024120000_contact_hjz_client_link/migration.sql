-- Two-way HJZ client sync: a dedicated link column, so a contact that already
-- carries a channel identity (WhatsApp/FB/IG in externalSource/externalId) can
-- also be linked to its HJZ client.
ALTER TABLE "Contact" ADD COLUMN "hjzClientId" TEXT;
ALTER TABLE "Contact" ADD COLUMN "hjzSyncAttemptAt" TIMESTAMP(3);

-- Contacts that came from the HJZ webhook are already linked.
UPDATE "Contact" SET "hjzClientId" = "externalId"
WHERE "externalSource" = 'hjz' AND "externalId" IS NOT NULL;

CREATE UNIQUE INDEX "Contact_workspaceId_hjzClientId_key" ON "Contact"("workspaceId", "hjzClientId");
