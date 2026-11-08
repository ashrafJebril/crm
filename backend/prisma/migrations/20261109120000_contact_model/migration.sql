-- Contact model: structured name, email, owner, consent flags, custom fields.
-- Additive only: every new column is nullable or defaulted.
ALTER TABLE "Contact"
  ADD COLUMN IF NOT EXISTS "firstName" TEXT,
  ADD COLUMN IF NOT EXISTS "lastName" TEXT,
  ADD COLUMN IF NOT EXISTS "email" TEXT,
  ADD COLUMN IF NOT EXISTS "marketingOptOut" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "notALead" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "ownerId" TEXT;

CREATE TABLE IF NOT EXISTS "CustomFieldDef" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "entity" TEXT NOT NULL DEFAULT 'contact',
  "key" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "labelAr" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "options" JSONB,
  "order" INTEGER NOT NULL DEFAULT 0,
  "archivedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomFieldDef_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CustomFieldValue" (
  "defId" TEXT NOT NULL,
  "contactId" TEXT NOT NULL,
  "value" JSONB NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomFieldValue_pkey" PRIMARY KEY ("defId", "contactId")
);

CREATE INDEX IF NOT EXISTS "Contact_workspaceId_email_idx" ON "Contact"("workspaceId", "email");
CREATE INDEX IF NOT EXISTS "Contact_workspaceId_ownerId_idx" ON "Contact"("workspaceId", "ownerId");
CREATE UNIQUE INDEX IF NOT EXISTS "CustomFieldDef_workspaceId_entity_key_key" ON "CustomFieldDef"("workspaceId", "entity", "key");
CREATE INDEX IF NOT EXISTS "CustomFieldDef_workspaceId_idx" ON "CustomFieldDef"("workspaceId");
CREATE INDEX IF NOT EXISTS "CustomFieldValue_contactId_idx" ON "CustomFieldValue"("contactId");

DO $$ BEGIN
  ALTER TABLE "Contact" ADD CONSTRAINT "Contact_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "CustomFieldDef" ADD CONSTRAINT "CustomFieldDef_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "CustomFieldValue" ADD CONSTRAINT "CustomFieldValue_defId_fkey"
    FOREIGN KEY ("defId") REFERENCES "CustomFieldDef"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "CustomFieldValue" ADD CONSTRAINT "CustomFieldValue_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Backfill first/last name from the display name (idempotent: only rows not yet split).
UPDATE "Contact" SET "firstName" = split_part(trim(name), ' ', 1),
  "lastName" = NULLIF(trim(substr(trim(name), length(split_part(trim(name), ' ', 1)) + 1)), '')
WHERE "firstName" IS NULL;

-- Lower-case the built-in lifecycle values once (idempotent); the API lower-cases them on write.
UPDATE "Contact" SET lifecycle = lower(lifecycle)
WHERE lower(lifecycle) IN ('lead','customer','churned','patient','blocked') AND lifecycle <> lower(lifecycle);
