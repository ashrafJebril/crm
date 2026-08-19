-- Managed tag catalog over the existing name-based Contact.tags storage.
-- The absorb step promotes every distinct tag name already in use into the
-- catalog with a deterministic 12-step hue, so day one shows real data.
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Tag_workspaceId_name_key" ON "Tag"("workspaceId", "name");
CREATE INDEX "Tag_workspaceId_idx" ON "Tag"("workspaceId");

ALTER TABLE "Tag" ADD CONSTRAINT "Tag_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Absorb existing tags (idempotent; md5 ids are fine — cuid is client-side).
INSERT INTO "Tag" ("id", "workspaceId", "name", "color")
SELECT md5(random()::text || clock_timestamp()::text || t."workspaceId" || t.name),
       t."workspaceId",
       t.name,
       ((abs(hashtext(t.name)) % 12) * 30)::text
FROM (
  SELECT DISTINCT c."workspaceId", trim(e) AS name
  FROM "Contact" c, jsonb_array_elements_text(c."tags"::jsonb) e
  WHERE trim(e) <> ''
) t
ON CONFLICT ("workspaceId", "name") DO NOTHING;
