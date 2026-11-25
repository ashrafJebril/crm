-- SP-11 insights and working home: three nullable columns, nothing else.
--
-- Safe for the deployed main: nullable with no default, so Postgres 11+ only
-- updates the catalog (no table rewrite, not even on "Message"); main never
-- selects these columns and its inserts leave them null. No index, no foreign
-- key, no constraint and no backfill (SP-11 rulings 2 and 4). IF NOT EXISTS
-- makes a rerun a no-op.
--
-- Each ALTER takes a brief ACCESS EXCLUSIVE lock on its table. lock_timeout
-- makes it give up after 5 s instead of queueing behind a long query while
-- every later read and write on "Message" waits behind it; a timed-out deploy
-- is simply rerun.
SET lock_timeout = '5s';

ALTER TABLE "WorkspaceMember" ADD COLUMN IF NOT EXISTS "homeSeenAt" TIMESTAMP(3),
                              ADD COLUMN IF NOT EXISTS "homeDay1DismissedAt" TIMESTAMP(3);

ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "sentById" TEXT;
