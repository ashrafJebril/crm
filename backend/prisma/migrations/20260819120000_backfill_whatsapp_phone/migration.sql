-- Contacts created from WhatsApp conversations never had their phone set,
-- even though the WhatsApp participant id (Contact.externalId) IS the phone
-- number in E.164 digits. Backfill existing rows; ingestion populates new
-- rows from 2026-08-19 on. Only fills empty phones — never overwrites a
-- hand-edited value.
UPDATE "Contact"
SET "phone" = '+' || "externalId"
WHERE "externalSource" = 'whatsapp'
  AND ("phone" IS NULL OR "phone" = '')
  AND "externalId" ~ '^[0-9]{8,15}$';
