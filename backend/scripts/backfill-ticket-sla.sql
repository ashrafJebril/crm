-- SP-09 (ruling 2): one-off SLA backfill for tickets that existed before the
-- "Ticket_sla_due_at" trigger (migration 20261116120000_support_tickets).
--
-- NOT run by the build, by `prisma migrate` or by any app code. Run it by hand,
-- ONLY after the migration is applied AND the user has explicitly approved this
-- backfill (an approval of the migration does not cover it), e.g.
--   psql "$DATABASE_URL" -f backend/scripts/backfill-ticket-sla.sql
--
-- What it does: for each ticket with "slaDueAt" IS NULL whose current stage has
-- "slaMinutes" and is not terminal, sets "slaDueAt" = "enteredStageAt" +
-- slaMinutes (wall clock), in batches of 1 000 tickets by id. Old tickets in an
-- SLA stage may therefore show as overdue on day one (accepted in ruling 2).
--
-- Rerunnable: it only touches rows still NULL, so a second run is a no-op.
-- It never changes "stageId" or "enteredStageAt" (the trigger does not fire:
-- it is `UPDATE OF "stageId"` only), and never clears a due date.

DO $$
DECLARE
  last_id TEXT := '';
  batch_ids TEXT[];
  touched INT;
  total INT := 0;
BEGIN
  LOOP
    SELECT array_agg(id ORDER BY id) INTO batch_ids
    FROM (
      SELECT t."id"
      FROM "Ticket" t
      JOIN "TicketStage" s ON s."id" = t."stageId"
      WHERE t."slaDueAt" IS NULL
        AND s."slaMinutes" IS NOT NULL
        AND s."isTerminal" = false
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
      AND s."isTerminal" = false;

    GET DIAGNOSTICS touched = ROW_COUNT;
    total := total + touched;
    last_id := batch_ids[array_length(batch_ids, 1)];
    RAISE NOTICE 'backfill-ticket-sla: % tickets in this batch (% so far), up to id %', touched, total, last_id;
  END LOOP;
  RAISE NOTICE 'backfill-ticket-sla: done, % tickets updated', total;
END $$;
