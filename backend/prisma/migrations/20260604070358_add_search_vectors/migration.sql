-- Full-text search vectors for Contact / Conversation / Ticket.
--
-- Uses the `simple` tsearch config (no English stemming) so Arabic words
-- aren't mangled. Generated-always columns keep the vector in lock-step
-- with the source data without trigger maintenance.

-- ─── Contact ──────────────────────────────────────────────────────────────
ALTER TABLE "Contact"
  ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce("name",      '')), 'A') ||
    setweight(to_tsvector('simple', coalesce("phone",     '')), 'B') ||
    setweight(to_tsvector('simple', coalesce("industry",  '')), 'C') ||
    setweight(to_tsvector('simple', coalesce("lifecycle", '')), 'C') ||
    setweight(to_tsvector('simple', coalesce("source",    '')), 'D') ||
    setweight(to_tsvector('simple', coalesce("tags",      '')), 'D')
  ) STORED;
CREATE INDEX "Contact_searchVector_idx"
  ON "Contact" USING GIN ("searchVector");

-- ─── Conversation ─────────────────────────────────────────────────────────
ALTER TABLE "Conversation"
  ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce("preview", '')), 'A') ||
    setweight(to_tsvector('simple', coalesce("intent",  '')), 'C')
  ) STORED;
CREATE INDEX "Conversation_searchVector_idx"
  ON "Conversation" USING GIN ("searchVector");

-- ─── Ticket ───────────────────────────────────────────────────────────────
ALTER TABLE "Ticket"
  ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce("title",       '')), 'A') ||
    setweight(to_tsvector('simple', coalesce("description", '')), 'B')
  ) STORED;
CREATE INDEX "Ticket_searchVector_idx"
  ON "Ticket" USING GIN ("searchVector");
