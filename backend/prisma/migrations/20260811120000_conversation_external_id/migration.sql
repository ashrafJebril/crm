-- Provider-side conversation id (currently Zernio's).
--
-- Replying into a DB-backed conversation used to re-list the provider's
-- conversations on every send just to find the right one (~0.5s of the
-- reply's latency). The inbound webhook already knows the id, so persist it
-- once and address the provider conversation directly. Nullable: rows that
-- predate this column are resolved via the old list path and backfilled.
ALTER TABLE "Conversation" ADD COLUMN "externalId" TEXT;
