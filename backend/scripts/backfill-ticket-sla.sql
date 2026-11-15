-- SP-09 (ruling 2): one-off SLA backfill for tickets that existed before the
-- "Ticket_sla_due_at" trigger (migration 20261116120000_support_tickets).
--
-- NOT run by the build, by `prisma migrate` or by any app code. Run it by hand,
-- ONLY after the migration is applied AND the user has explicitly approved this
-- backfill (an approval of the migration does not cover it).
--
-- How to run (psql >= 10, Postgres >= 11):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/scripts/backfill-ticket-sla.sql
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v cutoff='2026-11-16 12:00:00' -f backend/scripts/backfill-ticket-sla.sql
-- Run it in psql's default autocommit mode. NEVER with -1 / --single-transaction
-- and never inside BEGIN ... COMMIT: the DO block COMMITs after every batch
-- (transaction control in a top-level DO needs that), so each batch of 1 000
-- tickets holds its row locks only for its own UPDATE, and an error in a late
-- batch keeps the batches already committed (rerun to finish).
--
-- What it does: for each ticket with "slaDueAt" IS NULL, whose current stage
-- has "slaMinutes" and is not terminal, and which entered that stage BEFORE the
-- cutoff, sets "slaDueAt" = "enteredStageAt" + slaMinutes (wall clock), in
-- batches of 1 000 tickets by id. Old tickets in an SLA stage may therefore
-- show as overdue on day one (accepted in ruling 2).
--
-- The cutoff (UTC, a timestamp): `-v cutoff=...` when given; otherwise the
-- moment the migration finished, read from "_prisma_migrations". Every ticket
-- that entered its stage after that went through the trigger already, so a
-- rerun later (for example after a stage gains slaMinutes) never changes
-- tickets the trigger left without a due date (ruling 2). Without a cutoff
-- (migration not applied) the script refuses to run.
--
-- Rerunnable: it only touches rows still NULL and older than the cutoff. It
-- never changes "stageId" or "enteredStageAt" (the trigger does not fire: it
-- is `UPDATE OF "stageId"` only), and never clears a due date.

\if :{?cutoff}
SELECT set_config('sp09.backfill_cutoff', :'cutoff', false);
\else
SELECT set_config('sp09.backfill_cutoff', '', false);
\endif

DO $$
DECLARE
  cutoff TIMESTAMP(3);
  last_id TEXT := '';
  batch_ids TEXT[];
  touched INT;
  total INT := 0;
BEGIN
  cutoff := NULLIF(current_setting('sp09.backfill_cutoff', true), '')::timestamp(3);
  IF cutoff IS NULL THEN
    SELECT timezone('UTC', m.finished_at)::timestamp(3) INTO cutoff
    FROM "_prisma_migrations" m
    WHERE m.migration_name = '20261116120000_support_tickets'
      AND m.finished_at IS NOT NULL
      AND m.rolled_back_at IS NULL
    ORDER BY m.finished_at DESC
    LIMIT 1;
  END IF;
  IF cutoff IS NULL THEN
    RAISE EXCEPTION 'backfill-ticket-sla: no cutoff (pass -v cutoff=... or apply migration 20261116120000_support_tickets first)';
  END IF;
  RAISE NOTICE 'backfill-ticket-sla: cutoff % (UTC)', cutoff;

  LOOP
    SELECT array_agg(id ORDER BY id) INTO batch_ids
    FROM (
      SELECT t."id"
      FROM "Ticket" t
      JOIN "TicketStage" s ON s."id" = t."stageId"
      WHERE t."slaDueAt" IS NULL
        AND s."slaMinutes" IS NOT NULL
        AND s."isTerminal" = false
        AND t."enteredStageAt" < cutoff
        AND t."id" > last_id
      ORDER BY t."id"
      LIMIT 1000
    ) b;

    EXIT WHEN batch_ids IS NULL;

    UPDATE "Ticket" t
    SET "slaDueAt" = t."enteredStageAt" + make_interval(mins => s."slaMinutes")
    FROM "TicketStage" s
    WHERE s."id" = t."stageId"
      AND t."id" = ANY (batch_ids)
      AND t."slaDueAt" IS NULL
      AND s."slaMinutes" IS NOT NULL
      AND s."isTerminal" = false
      AND t."enteredStageAt" < cutoff;

    GET DIAGNOSTICS touched = ROW_COUNT;
    total := total + touched;
    last_id := batch_ids[array_length(batch_ids, 1)];
    RAISE NOTICE 'backfill-ticket-sla: % tickets in this batch (% so far), up to id %', touched, total, last_id;
    -- One transaction per batch (review I1).
    COMMIT;
  END LOOP;
  RAISE NOTICE 'backfill-ticket-sla: done, % tickets updated', total;
END $$;
