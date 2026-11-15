# SP-09 Support Tickets: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- **Ticket fields.** Every ticket gains a **priority** (`low | normal | high | urgent`, default `normal`), a **category** (a fixed bilingual list, ruling 3), a derived **channel** (from the linked conversation), a visible **request number** (the existing per-pipeline `Ticket.number`, ruling 4) and an **SLA due date** `slaDueAt`.
- **SLA.** `slaDueAt` is computed from `TicketStage.slaMinutes` **on stage entry**, by every writer (app, bulk, imports, workflows, the resolution sweep, undo, reopen, a stage delete that moves cards). It is null when the stage has no `slaMinutes` or is terminal. The UI shows an overdue badge when `now > slaDueAt` and the stage is not terminal, and a "due soon" badge within 24 h (roadmap acceptance `slaDueAt recalculated on stage change`, `overdue badge when now > slaDueAt and not terminal`).
- **Attachments.** Customer files (media already stored on inbound messages of the ticket's conversation) and staff files (uploaded on the ticket) are linked to the ticket through `TicketAttachment`, listed on the ticket, and served only through a gated route `GET /tickets/:id/attachments/:attId` that checks `tickets.view`, the workspace (404 for a foreign id; acceptance `attachment route 404 for foreign workspace`), and for customer files the viewer's conversation visibility (Review Focus 1).
- **Resolve and comment.** "Resolve" moves a ticket to its pipeline's won terminal stage (support: `resolved`) with a resolution note in one call. "Comment" reuses the SP-05 notes (mentions, replies) already on the ticket drawer; no second note system.
- **Booking cards on a ticket.** The ticket sheet shows the ticket contact's upcoming **pending** and **confirmed** bookings as cards, with Confirm / Cancel actions for `bookings.update` (ruling 7). No new booking-request entity.
- **List.** The board and the SP-08 table gain priority, category and SLA columns/chips; filters `priority`, `category`, `sla=overdue|due_soon|none`; sorts `slaDueAt` and `priority`.

**Architecture:**
- **SLA by trigger (ruling 1).** A `BEFORE INSERT OR UPDATE OF "stageId"` trigger on `"Ticket"` computes `slaDueAt`, as SP-31 did for `Appointment.statusChangedAt`. About nine code paths write `Ticket.stageId` today (`tickets.service.ts` create/move/reopen/undo, `tickets-bulk.service.ts`, `contacts-bulk.service.ts` add-to-pipeline, `import-runner.service.ts` pipeline placement, `pipeline-automation.service.ts`, `conversation-resolution.service.ts`, `workflows/executors/update-data.executor.ts`, `pipelines.service.ts` delete-stage moves), and the deployed `main` keeps writing until SP-09 ships. A trigger is the only place every writer passes.
  ```sql
  CREATE OR REPLACE FUNCTION "ticket_sla_due_at"() RETURNS trigger AS $$
  DECLARE
    st RECORD;
    entered TIMESTAMP(3);
  BEGIN
    IF TG_OP = 'UPDATE' AND NEW."stageId" IS NOT DISTINCT FROM OLD."stageId" THEN
      RETURN NEW;
    END IF;
    SELECT "slaMinutes", "isTerminal" INTO st FROM "TicketStage" WHERE "id" = NEW."stageId";
    -- The writer's own enteredStageAt when it set one in this statement, else now().
    IF TG_OP = 'INSERT' OR NEW."enteredStageAt" IS DISTINCT FROM OLD."enteredStageAt" THEN
      entered := NEW."enteredStageAt";
    ELSE
      entered := now();
    END IF;
    IF st."slaMinutes" IS NULL OR st."isTerminal" THEN
      NEW."slaDueAt" := NULL;
    ELSE
      NEW."slaDueAt" := entered + make_interval(mins => st."slaMinutes");
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;
  ```
  - The trigger does **not** touch `enteredStageAt` (that is the writer's, and `main`'s stale-card logic reads it).
  - A stage's `slaMinutes` edited later in the SP-07 editor does **not** move the due dates of tickets already in it (ruling 2).
  - The pure TS mirror `slaDueAtFor({slaMinutes, isTerminal}, enteredAt)` in `backend/src/tickets/ticket-sla.ts` is used only by the in-memory test double and the frontend preview; the database is the authority. A DB-backed spec (skipped without `TICKETS_TEST_DATABASE_URL`, the `conversation-resolution.db.spec.ts` pattern) and Task 3 prove the trigger itself.
- **SLA state (pure, shared shape):** `slaState({slaDueAt, stageIsTerminal}, now) → "none" | "finished" | "breached" | "due_soon" | "on_track"`, `SLA_DUE_SOON_MS = 24 h` (Tkana `SLA_DUE_SOON_HOURS = 24`). Backend `backend/src/tickets/ticket-sla.ts`, frontend `src/screens/pipeline/ticketSla.ts`. `finished` (terminal) is never shown as breached.
- **Attachments** (`backend/src/tickets/ticket-attachments.service.ts`):
  - `TicketAttachment {id, workspaceId, ticketId, mediaId, source: "customer"|"staff", messageId?, addedById?, createdAt}`, unique `(ticketId, mediaId)`.
  - **Customer:** only a `Media` id referenced by `Message.attach` of a message with `from = 'them'` in the ticket's own `conversationId`. `GET /tickets/:id/attachments/candidates` lists those not yet attached (newest first, ≤ 50); `POST /tickets/:id/attachments {mediaId}` links one. Nothing is attached automatically (ruling 6).
  - **Staff:** `POST /tickets/:id/attachments/upload` (multipart `file`, `tickets.update`) runs `MediaService.finalizeUpload` (SP-13 types, sniffing, limits: images 20 MB, video 300 MB, PDF 100 MB) and links the new media with `source: "staff"`. A staff member does not need `conversations.create` (the `/media/upload` permission) to attach a file to a ticket.
  - At most `TICKET_ATTACHMENTS_MAX = 50` per ticket (400 `tickets.attachments_full`).
  - **Link writes** run in one `$transaction` that takes `lockMediaForReference` (SP-13 M1) and re-reads the ticket by `(id, workspaceId)`.
  - **Serving:** `GET /tickets/:id/attachments/:attId` loads the ticket by `(id, workspaceId)` and the attachment by `(attId, ticketId)` (each miss → 404 `tickets.attachment_not_found`, the same for foreign, missing and other-ticket ids). For `source = "customer"` it also requires `PermissionService.assertConversationVisible(ws, ticket.conversationId, viewer)` (404 when hidden). It then streams the bytes through the same code as `GET /media/:id/file` (refactored into `MediaService.sendResolved(res, resolved)`), never a 302 (ruling 5). The media row is loaded by `(mediaId, workspaceId)` and **not** through `MediaService.get(..., viewer)`, whose visibility rule is the media library's, not the ticket's.
  - **Unlink:** `DELETE /tickets/:id/attachments/:attId` (`tickets.update`) removes the link; the file stays in the media library.
  - **Media delete:** `MediaService.remove` adds `tickets: {id, number, pipelineId}[]` to the 409 `media.in_use` body when a `TicketAttachment` references the file (Review Focus 2 pattern; FK `CASCADE` as the backstop for a reference added after the check, ruling 8).
- **Resolve:** `POST /tickets/:id/resolve {note?: string, version?: never}` → `TicketsService.resolveTicket`. Target = the pipeline's won terminal stage with the lowest `order` (support: `resolved`); none → 409 `tickets.no_resolved_stage`. It calls `moveTicket(ws, id, {stageId, note})`, so activity logging, lead lifecycle and realtime are unchanged; an already-terminal ticket → 409 `tickets.already_closed`. The note is stored as the move's `TicketActivity.note` (kind `won`).
- **Channel (derived, no column):** `getTicket`/`listTickets` add `channel: {kind, channelId, displayName} | null` from `Conversation.channel` / `Conversation.channelRef` when the ticket has a conversation **visible to the viewer** (otherwise null, ruling 4).
- **Booking cards:** `GET /tickets/:id/bookings` (`bookings.view`; the service also requires `tickets.view` and loads the ticket by `(id, workspaceId)`) → the ticket contact's appointments with `status IN ('pending','confirmed')` and `startAt >= now() - 1 day`, ordered by `startAt`, ≤ 20. Actions use the existing `PATCH /appointments/:id {status}` (SP-10 adds the transition table and `version`; SP-09 does not depend on it).

**Tech Stack:** NestJS 10, Prisma 5 (Postgres/Neon), jest/ts-jest; React 18 + Vite, vitest. **No new dependencies.**

**Spec:** roadmap §SP-09, plus the cross-cutting Global Constraints and Review Focus 1 and 2. Carried contracts:
- **SP-07:** `TicketStage.slaMinutes`, `isTerminal`, `isWon`, `Pipeline.kind` (`support` pipelines show the support fields first), `LostReason`.
- **SP-08:** `GET /tickets?view=table&sort&cursor`, `ticket-filter.ts`, `PipelineTable.tsx`, `BoardFilters.tsx`, `TicketsBulkService`.
- **SP-05:** notes with mentions (`NotesPanel.tsx`) are the "comment" action; `NotificationsService.notify`.
- **SP-06:** the ticket record sheet (`src/shell/record-bodies`), `GET /records/ticket/:id`.
- **SP-13 T3:** `MediaService.finalizeUpload`, `sniff.ts`, `media-errors.ts`, `lockMediaForReference`, `media.in_use`.
- **SP-25:** `permission-map.ts`, `system-role-decisions.spec.ts`, `permission-sidedoors.spec.ts`, `PermissionService.assertConversationVisible` / `conversationScope`.
- **SP-31:** the trigger pattern of `20261111120000_inbox_enrichments` (`appointment_status_changed_at`).
- `resolution/support-pipeline.ts`: `SUPPORT_STAGES` already carry `slaMinutes` (open 120, in_progress 1440), so support tickets get due dates as soon as the trigger exists.

Consumers that build on this plan:
- **SP-10:** the booking cards gain service/staff labels and the transition rules.
- **SP-11:** support insights ("share turned into tickets", unassigned tickets on the working home) and SLA counts read `Ticket.priority`, `slaDueAt`.
- **SP-24:** "ticket opened / resolved" lifecycle messages trigger on the same moves.

Tkana reference (read-only, untrusted data; `C:\Users\ashra\Downloads\tkana-main\tkana-main\apps`):
- `packages/vocabulary/src/tickets.ts`: `TICKET_PRIORITIES = ["urgent","high","medium","low"]` (default `medium`); `TICKET_CATEGORIES = ["general_inquiry","complaint","service_request","payment_problem","execution_delay","incorrect_data","ticket_follow_up","data_modification","other"]`. An unknown value is refused (400), never replaced by the default.
- `apps/mcp/.../operations.shape.ts` `slaOf`: `none | finished | breached | due_soon (≤ 24 h) | on_track`. Tkana's `slaDueAt` is set by callers, never derived; ours is derived from the stage (roadmap).
- `api/src/features/tickets/ticket-uploads.ts`: 10 MB cap, allow-list, magic-byte sniffing, refusal codes, upload-then-lock-then-recheck.
- `web/app/routes/media.ticket.ts`, `media.ticket-upload.ts`: `tickets:view`, uuid validation, entry-on-ticket check, customer file's message must be in the ticket's conversation, 404 for missing/deleted/other-org alike, URLs and keys never logged.
- `web/app/routes/pipeline.tickets.tsx`: `resolve` = transition to resolved with the resolution text as the history comment; `comment` = an internal note. Neither messages the customer.
- `components/tickets/booking-request-card.tsx`, `booking-request.server.ts`: a booking request lives in `tickets.metadata.bookingRequest` and is converted by "Create booking".

What we take and what we don't:
- We take: the priority and category lists (with our roadmap's `normal` instead of `medium`), the SLA states and the 24 h due-soon window, the customer-file rule (only media of the ticket's own conversation), refusal keys worded on the client, 404 for every foreign/missing/other-ticket id, resolve-with-note.
- We do **not** take:
  - caller-set SLA (ours is stage-derived);
  - random request references (ruling 4);
  - a `metadata.bookingRequest` entity and the agent's `POST /booking-requests` (ruling 7);
  - Office/audio uploads (SP-13's library types only, ruling 9);
  - one-active-ticket-per-conversation (our sales automation keeps a ticket per conversation per pipeline already);
  - Meilisearch.

## Global Constraints
- **Data (exact names; later SPs build on them):**
  ```
  model Ticket {
    // … existing fields unchanged …
    /// SP-09: "low" | "normal" | "high" | "urgent".
    priority  String    @default("normal")
    /// SP-09: a key of TICKET_CATEGORIES; null = not set.
    category  String?
    /// SP-09: set by the "ticket_sla_due_at" trigger on stage entry; null = no SLA (or terminal).
    slaDueAt  DateTime?
    attachments TicketAttachment[]

    @@index([workspaceId, slaDueAt])
  }

  /// SP-09: a file on a ticket. The file itself is a Media row (library, storage, sniffing).
  model TicketAttachment {
    id          String    @id @default(cuid())
    workspaceId String
    workspace   Workspace @relation("WorkspaceTicketAttachments", fields: [workspaceId], references: [id], onDelete: Cascade)
    ticketId    String
    ticket      Ticket    @relation(fields: [ticketId], references: [id], onDelete: Cascade)
    mediaId     String
    media       Media     @relation("MediaTicketAttachments", fields: [mediaId], references: [id], onDelete: Cascade)
    source      String    // "customer" | "staff"
    messageId   String?   // the inbound Message that carried a customer file (no FK: messages may be pruned)
    addedById   String?
    addedBy     User?     @relation("TicketAttachmentAddedBy", fields: [addedById], references: [id], onDelete: SetNull)
    createdAt   DateTime  @default(now())

    @@unique([ticketId, mediaId])
    @@index([workspaceId])
    @@index([mediaId])
  }
  ```
  - Back-relations on `Workspace` (`ticketAttachments`), `Media` (`ticketAttachments`), `User` (`ticketAttachmentsAdded`) are Prisma-only.
  - **Roadmap names kept:** `Ticket.priority`, `category`, `slaDueAt`; `TicketAttachment {ticketId, mediaId, source}`. Everything else is additive.
- **Constants** (`backend/src/tickets/ticket-fields.ts`, mirrored in `src/screens/pipeline/ticketFields.ts`, a test pins equality of the key lists):
  - `TICKET_PRIORITIES = ["urgent", "high", "normal", "low"]` (sort rank in this order).
  - `TICKET_CATEGORIES = ["general_inquiry", "complaint", "service_request", "payment_problem", "execution_delay", "incorrect_data", "ticket_follow_up", "data_modification", "other"]`.
  - `SLA_DUE_SOON_MS = 24 * 60 * 60 * 1000`; `TICKET_ATTACHMENTS_MAX = 50`.
- **DTOs:**
  - `CreateTicketDto`, `CreateFromConversationDto`, `UpdateTicketDto` gain `priority?` (`@IsIn(TICKET_PRIORITIES)`) and `category?: string | null` (`@IsIn(TICKET_CATEGORIES)` or null). An unknown value is 400; it is never coerced.
  - `ListTicketsQuery` gains `priority?` (CSV of priorities), `category?` (CSV), `sla?: "overdue" | "due_soon" | "none"`; `sort` adds `"slaDueAt" | "priority"`. `slaDueAt` sorts nulls last in both directions; `priority` sorts by rank (`CASE`), then `id`. Cursor encoding follows SP-08's (`sort value + id`).
  - Ticket DTO (`getTicket`, list rows, record sheet) gains `priority`, `category`, `slaDueAt`, `channel: {kind, channelId, displayName} | null`, `attachmentCount: number`.
  - `TicketAttachmentDto = {id, ticketId, mediaId, source, fileName, mimeType, sizeBytes, messageId, addedBy: {id, name} | null, createdAt, url}` with `url = "/api/tickets/<ticketId>/attachments/<id>"` (never a storage URL).
  - `TicketBookingCardDto = {id, startAt, durationMin, status, service, serviceAr, staffId, source, hjzSyncError}`.
- **API** (every route workspace-scoped; a foreign id gives **404**):
  - `GET /tickets/:id/attachments` (`tickets.view`) → `{items: TicketAttachmentDto[]}`. Customer items whose conversation the viewer cannot see are **omitted** (no count).
  - `GET /tickets/:id/attachments/candidates` (`tickets.update`; plus conversation visibility, else `{items: []}`) → `{items: {mediaId, messageId, fileName, mimeType, sizeBytes, at}[]}`.
  - `POST /tickets/:id/attachments` (`tickets.update`) body `{mediaId}` → `TicketAttachmentDto`. Errors: 404 `tickets.attachment_source_not_found` (media not on an inbound message of this ticket's conversation), 409 `tickets.attachment_exists`, 400 `tickets.attachments_full`, 400 `tickets.no_conversation`.
  - `POST /tickets/:id/attachments/upload` (`tickets.update`, multipart `file`) → `TicketAttachmentDto`; the SP-13 `media.*` keys on refusal.
  - `GET /tickets/:id/attachments/:attId` (`tickets.view`) → the file's bytes (`Content-Disposition` per `applyServeHeaders`; `Cache-Control: private, max-age=300`).
  - `DELETE /tickets/:id/attachments/:attId` (`tickets.update`) → `{ok: true}`. Idempotent per id: a second call is 404.
  - `POST /tickets/:id/resolve` (`tickets.update`) body `{note?: string ≤ 2000}` → the ticket DTO.
  - `GET /tickets/:id/bookings` (`bookings.view`, plus `tickets.view` in the service) → `{items: TicketBookingCardDto[]}`.
  - **Route order:** `attachments/candidates` and `attachments/upload` are declared before `attachments/:attId`.
- **Error keys** (`backend/src/tickets/ticket-errors.ts`, `{statusCode, message: key, …extra}` like `channelError`):
  - 400: `tickets.invalid_priority`, `tickets.invalid_category`, `tickets.attachments_full`, `tickets.no_conversation`;
  - 404: `tickets.attachment_not_found`, `tickets.attachment_source_not_found`;
  - 409: `tickets.attachment_exists`, `tickets.no_resolved_stage`, `tickets.already_closed`.
  - Frontend `src/screens/pipeline/ticketErrors.ts` has `tx` copy for every key, with a test covering every key.
- **Copy and layout:**
  - Every string through `tx("English","العربية")` with real Arabic. Priority: Low / منخفضة, Normal / عادية, High / مرتفعة, Urgent / عاجلة. SLA: "Overdue" / "متأخرة", "Due soon" / "تستحق قريبًا", "Due <time>" / "تستحق <time>", "No SLA" / "بلا مهلة". Categories: General inquiry / استفسار عام, Complaint / شكوى, Service request / طلب خدمة, Payment problem / مشكلة في الدفع, Execution delay / تأخر في التنفيذ, Incorrect data / بيانات غير صحيحة, Ticket follow-up / متابعة تذكرة, Data change / تعديل بيانات, Other / أخرى.
  - Logical CSS only (`margin-inline-start`, `padding-inline`, `inset-inline-end`, `text-align: start`). The request number, file sizes and times sit in `<bdi>`; file names use `dir="auto"`. Dialogs set `dir`.
  - Times render in the workspace timezone (`Intl.DateTimeFormat` with `timeZone`), Latin digits (`ar-SA-u-nu-latn`), as SP-04 does.
- **Permissions (SP-25).** No catalogue change. `permission-map.ts` adds:
  - `GET /tickets/:id/attachments`: `tickets.view`
  - `GET /tickets/:id/attachments/candidates`: `tickets.update`
  - `POST /tickets/:id/attachments`: `tickets.update`
  - `POST /tickets/:id/attachments/upload`: `tickets.update`
  - `GET /tickets/:id/attachments/:attId`: `tickets.view`
  - `DELETE /tickets/:id/attachments/:attId`: `tickets.update`
  - `POST /tickets/:id/resolve`: `tickets.update`
  - `GET /tickets/:id/bookings`: `bookings.view`

  `system-role-decisions.spec.ts` adds an `SP-09 ticket routes` block: owner, admin and agent can view, attach, upload, unlink and resolve; viewer can list and download (tickets.view) but gets 403 on attach, upload, unlink and resolve; every role with `bookings.view` reads the booking cards. Impersonation is not blocked.

  `permission-sidedoors.spec.ts` adds `ticket attachment from a hidden conversation is 404 for an assigned-only agent` (list omits it, download 404, candidates empty) and `ticket channel is null when its conversation is hidden`.
- **Migration:**
  - File: `backend/prisma/migrations/20261116120000_support_tickets/migration.sql`. The timestamp is after SP-16's `20261115130000_smart_audiences` and SP-17's `20261115140000_media_ai_details`. **Every applied migration is never edited.** Hand-written; apply with `npx prisma migrate deploy` only, never `migrate dev`.
  - **Additive and idempotent:**
    ```sql
    ALTER TABLE "Ticket" ADD COLUMN IF NOT EXISTS "priority" TEXT NOT NULL DEFAULT 'normal',
                         ADD COLUMN IF NOT EXISTS "category" TEXT,
                         ADD COLUMN IF NOT EXISTS "slaDueAt" TIMESTAMP(3);
    CREATE TABLE IF NOT EXISTS "TicketAttachment" (
      "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "ticketId" TEXT NOT NULL, "mediaId" TEXT NOT NULL,
      "source" TEXT NOT NULL, "messageId" TEXT, "addedById" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "TicketAttachment_pkey" PRIMARY KEY ("id"));
    CREATE UNIQUE INDEX IF NOT EXISTS "TicketAttachment_ticketId_mediaId_key" ON "TicketAttachment"("ticketId","mediaId");
    CREATE INDEX IF NOT EXISTS "TicketAttachment_workspaceId_idx" ON "TicketAttachment"("workspaceId");
    CREATE INDEX IF NOT EXISTS "TicketAttachment_mediaId_idx" ON "TicketAttachment"("mediaId");
    CREATE INDEX IF NOT EXISTS "Ticket_workspaceId_slaDueAt_idx" ON "Ticket"("workspaceId","slaDueAt");
    -- FKs, each in DO $$ BEGIN … EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    --  TicketAttachment_workspaceId_fkey (CASCADE), _ticketId_fkey (CASCADE), _mediaId_fkey (CASCADE),
    --  _addedById_fkey (SET NULL); all ON UPDATE CASCADE.
    CREATE OR REPLACE FUNCTION "ticket_sla_due_at"() … (Architecture);
    DROP TRIGGER IF EXISTS "Ticket_sla_due_at" ON "Ticket";
    CREATE TRIGGER "Ticket_sla_due_at" BEFORE INSERT OR UPDATE OF "stageId" ON "Ticket"
      FOR EACH ROW EXECUTE FUNCTION "ticket_sla_due_at"();
    ```
  - **Prisma-conformant names** as listed. `prisma migrate diff --from-schema-datamodel <base schema> --to-schema-datamodel prisma/schema.prisma --script` (no DB) must equal the file apart from `IF NOT EXISTS`, the `DO` wrappers and the trigger block (Prisma does not model triggers), as in SP-13/14/31.
  - **Safe for the deployed `main`:**
    - `priority` is `NOT NULL DEFAULT 'normal'` (a constant default: metadata-only on Postgres 11+, no rewrite). `main`'s inserts omit it and get `normal`. `category` and `slaDueAt` are nullable and never selected by `main`'s client.
    - The trigger only writes `slaDueAt`, a column `main` never reads, and never raises: a missing stage row gives `st` all-null → `slaDueAt` null.
    - `main` deleting a ticket cascades its attachments; `main` deleting a media file (`MediaService.remove` of `main` does not know `TicketAttachment`) cascades the link (ruling 8).
    - No existing column, constraint or index changes. No `UPDATE`, `DELETE`, `DROP` (other than `DROP TRIGGER IF EXISTS` of our own new trigger) or `ALTER … TYPE`.
    - **Locks:** `CREATE INDEX` on `Ticket` blocks ticket writes for its build (seconds at most at our size). `CREATE TRIGGER` takes a short `SHARE ROW EXCLUSIVE` lock. Task 3 records the pre-apply `Ticket` row count.
  - **Backfill (separate, rerunnable, ruling 2):** `backend/scripts/backfill-ticket-sla.sql` sets `slaDueAt = "enteredStageAt" + slaMinutes` for tickets with `slaDueAt IS NULL` whose current stage has `slaMinutes` and is not terminal, in batches of 1 000 by id, `WHERE "slaDueAt" IS NULL` so a rerun is a no-op. Run only after the user approves it, after the migration.
- **Tests:**
  - backend: `npx jest src/tickets src/media src/permissions src/pipelines src/resolution src/records` plus `npx tsc --noEmit -p tsconfig.json`; the full `npm test` once per task. Known unrelated failure: `hjz-client-sync › is inert when HJZ is not configured`.
  - frontend (repo root): `npx vitest run` plus `npm run typecheck`; `npm run build` once in Task 2.
  - **Named acceptance tests (exact names):**
    - `slaDueAt recalculated on stage change` (backend jest, `src/tickets/ticket-sla.spec.ts` over the in-memory double that runs `slaDueAtFor` on stage writes, **and** `src/tickets/ticket-sla.db.spec.ts` against a real Postgres, skipped without `TICKETS_TEST_DATABASE_URL`; Task 3 runs the DB spec)
    - `attachment route 404 for foreign workspace` (backend jest, `src/tickets/ticket-attachments.service.spec.ts`)
    - `overdue badge when now > slaDueAt and not terminal` (frontend vitest, `src/screens/pipeline/ticketSla.test.ts`)
  - No provider is called in any spec.
- **Commits:** selective `git add <paths>`, never `-A`. Trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not stage `.playwright-mcp/`, `.claude/worktrees/` or any untracked file this plan did not create.

## Review Focus
1. **Every stage writer gets the SLA.**
   - A ticket entering an SLA stage by any path (move, bulk move, contacts bulk add-to-pipeline, import placement, workflow update-data, automation, resolution sweep, undo, reopen, stage delete with move-to) has `slaDueAt = entered + slaMinutes`; a terminal stage clears it; an update that does not change `stageId` leaves it alone.
   - Tests: `slaDueAt recalculated on stage change`, `sla trigger covers every stage writer` (DB spec: one statement per writer's SQL shape), `sla unchanged when other fields change`.
2. **Customer files through a side door.**
   - A customer attachment is served only to a viewer who can see the ticket's conversation; staff files only need `tickets.view`. The download route never returns a storage URL and never logs a key.
   - Tests: `attachment route 404 for foreign workspace`, `ticket attachment from a hidden conversation is 404 for an assigned-only agent`, `attachment id of another ticket is 404`.
3. **Attaching only what belongs.**
   - A customer attachment must be media of an inbound message of **this** ticket's conversation in this workspace. A media id from another conversation, another workspace or a staff upload claimed as `customer` is 404 `tickets.attachment_source_not_found`.
   - Tests: `customer attachment must come from the ticket conversation`, `attach and media delete serialize` (the lock: either 409 `media.in_use` with the ticket, or 404 on attach).
4. **Unknown values are refused, not defaulted.**
   - Priority/category outside the lists → 400; legacy rows read `normal` / null; a filter value outside the list is ignored, not a 500.
   - Tests: `unknown priority or category is 400`, `ticket filters ignore unknown values`.
5. **Resolve is a normal move.**
   - Resolve logs the same `TicketActivity`, runs the same lead-lifecycle sync and realtime as a move, refuses an already-closed ticket, and never messages the customer.
   - Tests: `resolve moves to the first won terminal stage with the note`, `resolve on a closed ticket is 409`.

## Architecture Rulings and Risks
Each item names the risk, then the recommended ruling. Items marked **(needs controller ruling)** are repeated under Controller rulings, where the controller fills in the decision.

1. **Where `slaDueAt` is computed.** About nine code paths write `Ticket.stageId`, and the deployed `main` writes tickets until SP-09 ships. Computing in the app risks a missed writer and leaves `main`'s writes without a due date.
   - **Ruling:** a `BEFORE INSERT OR UPDATE OF "stageId"` trigger (SP-31 precedent), plus a pure TS mirror for the in-memory double. The DB spec and Task 3 prove the trigger; unit specs prove callers' expectations.
   - **Alternative:** a `stageEntryData(stage, now)` helper used by every writer, no trigger. Simpler to unit-test, but `main`'s writes and any future writer that forgets it get no SLA. **(needs controller ruling)**
2. **SLA semantics.** Roadmap: "computed from `TicketStage.slaMinutes` on stage entry".
   - **Ruling:**
     - due = stage entry time + `slaMinutes`, wall-clock minutes (no business hours, no pause on `pending_customer`);
     - editing a stage's `slaMinutes` does not move due dates of tickets already in it;
     - reopen and undo restart the clock at the move time;
     - existing open tickets are back-filled once by `backfill-ticket-sla.sql` from their `enteredStageAt` (separate, rerunnable, user-approved), so old tickets in SLA stages may show as overdue on day one.
   - **Alternative:** no backfill (old tickets show "No SLA" until they next move). **(needs controller ruling)**
3. **Category shape.** The roadmap says `category String?`. Tkana uses a fixed list.
   - **Ruling:** a fixed list of keys (Tkana's nine) stored in the string column, with bilingual labels in the frontend. A per-workspace category catalog is deferred.
   - **Alternative:** free text with suggestions. Free text fragments insights (SP-11) and breaks Arabic/English grouping. **(needs controller ruling, minor)**
4. **Request number and channel.**
   - **Ruling:**
     - the request number is the existing per-pipeline `Ticket.number`, shown as `#<number>` and searchable (`q` matches a number). No new column. Sequential numbers reveal volume to a customer who is told the number; accepted (Tkana uses random references for that reason).
     - channel is derived at read time from the linked conversation, null when there is none or the viewer cannot see it. No column, so it can never disagree with the conversation.
   - **Alternative:** a random `requestNumber` column (`T-XXXXXX`) like Tkana. **(needs controller ruling, minor)**
5. **Serving: stream or redirect.** The roadmap says the route "redirects to a signed URL". Our frontend fetches media with an `Authorization` header (`src/lib/mediaFetch.ts`), and `GET /media/:id/file` already streams instead of redirecting because DO Spaces' CORS allowlist rejects `authorization` on a redirect.
   - **Ruling:** stream through the backend with the same code (`MediaService.sendResolved`), never expose a signed URL. Gating is identical.
   - **Alternative:** a 302 to a 5-minute signed URL, with the frontend opening it in a new tab without auth headers. **(needs controller ruling)**
6. **Customer attachments: manual or automatic.**
   - **Ruling:** manual. The ticket sheet lists candidate files from its conversation ("Files from this conversation") and an agent links them. Nothing is attached automatically on create, because our sales automation creates a ticket for almost every conversation and auto-attaching would copy every customer photo onto deal cards.
   - **Alternative:** auto-attach inbound media on support-kind tickets created from a conversation (`createFromConversation` and the resolution sweep), last 20 messages. **(needs controller ruling)**
7. **Booking-request cards.** Tkana stores a requested slot on the ticket (`metadata.bookingRequest`) and converts it into a booking. We have no booking-request entity; the AI agent books directly as `pending` through the MCP `create_appointment` tool.
   - **Ruling:** the card shows the ticket contact's upcoming `pending`/`confirmed` bookings with Confirm / Cancel (`bookings.update`, through `PATCH /appointments/:id`). No new table or column; SP-10's transition table and `version` apply automatically once SP-10 ships.
   - **Alternative:** a `Ticket.bookingRequest Json?` (Tkana shape) written by a new MCP tool and converted by SP-10's slot-checked create. It needs SP-10 first and an agent prompt change. Deferred. **(needs controller ruling)**
8. **Deleting a file still attached (Review Focus 2).**
   - **Ruling:** `MediaService.remove` refuses with 409 `media.in_use` listing `tickets: {id, number, pipelineId}[]`, under the existing media lock. The FK is `CASCADE` (not `RESTRICT`) so the deployed `main`, which does not know the table, can still delete media without a 500; a link deleted that way simply disappears.
   - **Alternative:** allow the delete and cascade silently. **(needs controller ruling, minor)**
9. **Upload types.** Tkana accepts Office documents, audio and text up to 10 MB. Our library accepts images, MP4/MOV and PDF (SP-13).
   - **Ruling:** ticket uploads accept the SP-13 library types and limits only. Office/audio deferred (they would need new sniffing rules and the library would show them).
   - **Alternative:** add `docx/xlsx/txt/csv` for ticket uploads only, hidden from the library like import files. **(needs controller ruling, minor)**
10. **Viewer scope.** Roadmap rule: viewer scope applies to conversation data.
    - **Ruling:** customer attachments, candidates and the derived channel follow `PermissionService` conversation visibility; the ticket itself follows `tickets.view` as today. A hidden attachment is omitted (not counted).
    - Accept: `attachmentCount` on the ticket DTO counts only what the viewer can open. **(needs controller ruling, minor)**
11. **Shared files with SP-16/SP-17 (in progress) and SP-10/SP-11 (same phase).** SP-16 Task 1 is merged (26c8dbc); SP-16 Tasks 2–4 and SP-17 touch `schema.prisma`, `permission-map.ts`, `system-role-decisions.spec.ts`, `permission-sidedoors.spec.ts`, `media.service.ts` (SP-17: details and `list_photos`), `src/lib/types.ts` and `channels/test-prisma.ts`. SP-10 edits `appointments/*` and `schema.prisma`.
    - **Ruling:** SP-09 bases on the commit that ships SP-17 (or the then-current `feat/tkana-parity` head) and records that SHA. Task 1 owns `schema.prisma` and the migration for SP-09. Edits to `media.service.ts` are limited to `remove`'s reference check and the `sendResolved` extraction. If SP-10 runs in parallel, migrations apply in timestamp order (SP-09 `20261116120000` before SP-10 `20261116130000`), and the second branch to merge rebases its `schema.prisma` hunk. **(needs controller ruling)**
12. **Verification touches production** (as SP-12 R14 … SP-15 R15).
    - Task 3 runs against the production DB in throwaway workspaces, with local stubs for Zernio (the inbound customer image) and no other provider. Storage is local (every `DO_SPACES_*` empty).
    - The migration and, separately, the SLA backfill need the user's **explicit approval**; earlier approvals do not carry over.
    - The deployed app is unaffected: its writes get `slaDueAt` from the trigger, a column it never reads. **(needs controller ruling)**
13. **Size.** The roadmap says M. Two build tasks plus verification. **(needs controller ruling, minor)**

### Controller rulings
*Pending.*
- **R1** (SLA by trigger + TS mirror; DB spec). Recommend: accept.
- **R2** (wall-clock SLA from stage entry; no recompute on `slaMinutes` edits; one-off approved backfill). Recommend: accept.
- **R3** (fixed category key list). Recommend: accept.
- **R4** (request number = existing `number`; channel derived at read time). Recommend: accept.
- **R5** (stream attachments, never 302). Recommend: accept.
- **R6** (manual customer attachments with a candidates list). Recommend: accept.
- **R7** (booking cards = the contact's upcoming pending/confirmed bookings; no booking-request entity). Recommend: accept; booking requests as a follow-up after SP-10.
- **R8** (media delete refused with `media.in_use` tickets; FK cascade backstop). Recommend: accept.
- **R9** (SP-13 library types only). Recommend: accept.
- **R10** (conversation visibility for customer files and channel; counts only visible). Recommend: accept.
- **R11** (base on the SP-17 ship commit; Task 1 owns the schema; migration order SP-09 → SP-10 → SP-11). Recommend: accept.
- **R12** (verification on the production DB with throwaway workspaces and a Zernio stub; migration and backfill each need explicit user approval). Recommend: accept.
- **R13** (size M; 2 build tasks + verification). Recommend: accept.

---

### Task 1: Backend — schema, migration and SLA trigger, ticket fields and filters, attachments, resolve, booking cards
**Owns:** `schema.prisma` and the migration for all of SP-09. Task 2 depends on this contract and does not edit the backend.

**Files:**
- `backend/prisma/schema.prisma`: Global Constraints → Data.
- `backend/prisma/migrations/20261116120000_support_tickets/migration.sql` and `backend/src/tickets/support-tickets-migration.spec.ts`.
- `backend/scripts/backfill-ticket-sla.sql` (not run by the build).
- Create in `backend/src/tickets/`, each with a spec:
  - `ticket-fields.ts`: `TICKET_PRIORITIES`, `TICKET_CATEGORIES`, `priorityRank`, `parseCsvList(v, allowed)`.
  - `ticket-sla.ts`: `slaDueAtFor(stage, enteredAt)`, `slaState(t, now)`, `SLA_DUE_SOON_MS`.
  - `ticket-errors.ts`.
  - `ticket-attachments.service.ts`: `list`, `candidates`, `attach`, `upload`, `serve`, `unlink` (Architecture).
  - `ticket-attachments.controller.ts` (route order as listed).
  - `ticket-sla.db.spec.ts` (skipped without `TICKETS_TEST_DATABASE_URL`; creates and deletes its own workspace).
- `tickets.dto.ts`: the new fields and query params. `ticket-filter.ts`: `priority`, `category`, `sla` filters and the two sorts (with the cursor).
- `tickets.service.ts`: write `priority`/`category` on create/update/createFromConversation; the DTO additions (`channel` under the viewer's scope, `attachmentCount`); `resolveTicket`; `bookingsForTicket`.
- `tickets.controller.ts`: `POST /tickets/:id/resolve`, `GET /tickets/:id/bookings` (pass `@CurrentViewer()`).
- `tickets.module.ts`: the new provider and controller; import `MediaModule`.
- `backend/src/media/media.service.ts`: `remove` checks `ticketAttachment` references inside the existing lock; extract `sendResolved(res, resolved)` used by both `media.controller.ts` and the ticket download.
- `backend/src/media/media.controller.ts`: use `sendResolved` (behaviour unchanged; `media.controller.spec.ts` stays green).
- `backend/src/records/records.service.ts`: the ticket record adds priority, category and SLA fields.
- `backend/src/pipelines/test-prisma.ts` and `backend/src/channels/test-prisma.ts`: `ticketAttachment`, the new `Ticket` columns, and the `slaDueAtFor` hook on `ticket.create/update/updateMany` when `stageId` changes.
- `backend/src/permissions/permission-map.ts` + `permission-map.spec.ts`, `system-role-decisions.spec.ts` (`SP-09 ticket routes`), `permission-sidedoors.spec.ts`.

**Produces (contract for Task 2):**
- The ticket DTO additions, `TicketAttachmentDto`, `TicketBookingCardDto`, every route and error key in Global Constraints.
- `slaState` semantics, mirrored by the frontend.

- [ ] Write the failing tests:
  - `migration is additive, idempotent and Prisma-named (SP-09)` (reads the SQL):
    - every `CREATE TABLE`, `ADD COLUMN` and `CREATE INDEX` has `IF NOT EXISTS`; every FK is in a `duplicate_object` block; the trigger is `CREATE OR REPLACE FUNCTION` + `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER`;
    - the names are exactly as listed; `priority` has `DEFAULT 'normal'`;
    - there is no `UPDATE`, `DELETE`, `ALTER COLUMN`, `TYPE`, or `DROP` other than `DROP TRIGGER IF EXISTS "Ticket_sla_due_at"`;
    - the folder name is greater than `20261115140000`;
    - the sha256 of `20261115120000_ctwa_attribution` and `20261115130000_smart_audiences` are pinned (unchanged);
    - `prisma migrate diff` from the base schema yields the same table/column/index statements (recorded as SP-13/14 did).
  - **`slaDueAt recalculated on stage change`**:
    - create in a stage with `slaMinutes: 120` at T → `slaDueAt = T + 120 min`;
    - move to a stage with `slaMinutes: 1440` at T2 → `T2 + 1440 min`;
    - move to a stage with no `slaMinutes` → null; to a terminal stage → null;
    - reopen at T3 into an SLA stage → `T3 + slaMinutes`;
    - an update of title/owner/priority only → unchanged;
    - DB spec: the same through real SQL, plus `sla trigger covers every stage writer` (raw `UPDATE "Ticket" SET "stageId"` without `enteredStageAt` → based on `now()`; with `enteredStageAt` → based on it; `INSERT` without `slaDueAt` → set) and `sla unchanged when other fields change`.
  - `unknown priority or category is 400` (create, update, from-conversation; `null` category clears it) and `ticket filters ignore unknown values`.
  - `ticket list filters and sorts by priority, category and sla`: `sla=overdue` = `slaDueAt < now` and stage not terminal; `due_soon` = within 24 h and not overdue; `none` = null; `sort=slaDueAt` nulls last both ways; `sort=priority` urgent → low; cursor pages are stable under a new insert.
  - **`attachment route 404 for foreign workspace`**: workspace B's ticket id, or a valid ticket with workspace B's attachment id, from A → 404 `tickets.attachment_not_found`; no storage read happens (the storage fake records zero calls).
  - `attachment id of another ticket is 404` (same workspace).
  - `customer attachment must come from the ticket conversation`:
    - a media id on an inbound (`them`) message of the ticket's conversation → linked, `source: "customer"`, `messageId` set;
    - a media id on an outbound message, on another conversation, in another workspace, or a staff upload → 404 `tickets.attachment_source_not_found`;
    - a ticket without a conversation → 400 `tickets.no_conversation`;
    - the same media twice → 409 `tickets.attachment_exists`;
    - the 51st → 400 `tickets.attachments_full`.
  - `staff upload links a sniffed library file`: a PNG with real magic bytes → a `Media` row with `uploadedById`, a `TicketAttachment` `source: "staff"`; a PNG-declared HTML file → 400 `media.type_mismatch` and nothing linked; works for a custom role with `tickets.update` and without `conversations.create`.
  - `ticket attachment from a hidden conversation is 404 for an assigned-only agent` (sidedoors): the list omits the customer file, the download is 404, candidates is empty; the staff file on the same ticket downloads (200).
  - `ticket channel is null when its conversation is hidden` (sidedoors).
  - `download streams bytes and never exposes a storage url`: local storage → the file bytes with the SP-13 serve headers; Spaces → the proxied stream; the response body and every `Logger` call contain no `storedPath` and no signed URL.
  - `unlink keeps the library file`; `attach and media delete serialize` (two interleavings through the lock fake: delete-first → attach 404; attach-first → delete 409 `media.in_use {tickets:[…]}`).
  - `resolve moves to the first won terminal stage with the note` (one `TicketActivity` kind `won` with the note; lead lifecycle sync runs for a leads pipeline; realtime emitted) and `resolve on a closed ticket is 409`; a pipeline with no won terminal stage → 409 `tickets.no_resolved_stage`.
  - `ticket booking cards list upcoming pending and confirmed bookings of the contact`: completed, cancelled, no-show and older-than-1-day rows excluded; another contact's bookings excluded; foreign ticket id → 404; `bookings.view` missing → 403 through the guard.
  - `permission map covers SP-09 routes`, plus the `SP-09 ticket routes` system-role block.
- [ ] Implement until green.
- [ ] `npx tsc --noEmit -p tsconfig.json`, the listed jest paths, then the full `npm test` once. Run `npx prisma generate` (an EPERM on the engine DLL while the dev watcher runs is harmless, as in SP-12/13/14; restart the watcher). **Do not run `migrate`** (ruling 12). Existing specs `tickets.*.spec.ts`, `pipelines/*.spec.ts`, `media.*.spec.ts`, `conversation-resolution.service.spec.ts` stay green, extended only.
- [ ] Commit `feat(tickets): priority, category, stage SLA, gated attachments, resolve and booking cards`.

### Task 2: Frontend — ticket fields, SLA badges, filters, attachments, resolve, booking cards
**Depends on:** Task 1's contract (it can start from the contract while Task 1 is in review).

**Files:**
- **F1 Model (pure):**
  - `src/screens/pipeline/ticketFields.ts`: priorities and categories with `tx` labels and tones; `priorityLabel`, `categoryLabel`.
  - `src/screens/pipeline/ticketSla.ts`: `slaState(t, now)` (mirror of the backend), `slaBadge(state, slaDueAt, tz, tx)`.
  - `src/screens/pipeline/ticketErrors.ts`.
  - Tests: `ticketSla.test.ts`, `ticketFields.test.ts`, `ticketErrors.test.ts`.
- **F2 Board and table:** `TicketCard.tsx` (priority chip for `high`/`urgent`, SLA badge, `#number`, attachment count), `PipelineTable.tsx` (columns Priority, Category, Channel, SLA; sortable SLA and Priority), `BoardFilters.tsx` + `boardQuery.ts` (priority, category, SLA filters kept in the hash).
- **F3 Ticket sheet** (`TicketDetailDrawer.tsx` / the SP-06 ticket body in `src/shell/record-bodies`):
  - priority and category selects (`tickets.update`);
  - SLA line with the due time in the workspace timezone and the badge;
  - channel chip;
  - `TicketAttachments.tsx`: the list (thumbnail for images through `mediaFetch` of the ticket route, file name `dir="auto"`, size and source "Customer" / "العميل" or "Team" / "الفريق"), "Upload" (`tickets.update`), "Files from this conversation" picker from `candidates`, Unlink with confirm;
  - `ResolveDialog.tsx` (`dir` set): resolution note (≤ 2 000) → `POST /tickets/:id/resolve`;
  - "Comment" reuses `NotesPanel` (SP-05) already in the drawer;
  - `TicketBookingCards.tsx` (`bookings.view`): date/time in the workspace timezone, service (`serviceAr` in Arabic), status chip, `hjzSyncError` warning, Confirm / Cancel (`bookings.update`) through `PATCH /appointments/:id`.
- **F4 New ticket:** `NewTicketModal.tsx` gains priority and category.
- **F5 Types:** `src/lib/types.ts`: `Ticket` gains `priority`, `category`, `slaDueAt`, `channel`, `attachmentCount`; `TicketAttachment`, `TicketBookingCard`, `TicketPriority`, `TicketCategory`.
- **Permission gating** with `usePermissions().can(...)`: edits, upload, attach, unlink and resolve need `tickets.update`; booking cards `bookings.view`, their actions `bookings.update`. Hidden actions are not rendered; a 403 shows the shared no-permission toast.

**Produces:** the support fields, badges, filters, attachments, resolve and booking cards in English and Arabic (RTL).

- [ ] Write the failing vitest tests:
  - **`overdue badge when now > slaDueAt and not terminal`**: overdue for an open stage past due; `finished` (no badge) for a terminal stage past due; `due_soon` within 24 h; `on_track` beyond; `none` for null; boundaries at exactly `slaDueAt` (not overdue) and exactly 24 h.
  - `sla badge text in both languages uses the workspace timezone and Latin digits`.
  - `priority and category labels cover every key in both languages` (and the key lists equal the backend's, pinned by a shared fixture).
  - `ticket error copy covers every SP-09 key in both languages`.
  - `board query round-trips priority, category and sla filters through the hash` (old hashes decode to no filter; unknown values are dropped).
- [ ] Implement until green, then build the components.
- [ ] `npx vitest run`, `npm run typecheck` and `npm run build` clean.
- [ ] Commit `feat(tickets): support fields, sla badges, attachments, resolve dialog and booking cards`.

### Task 3: Verification
Apply `20261116120000_support_tickets` with `npx prisma migrate deploy`, only when the controller and the user explicitly approve it (ruling 12). Run `backfill-ticket-sla.sql` only on a separate explicit approval. Record the results in `.superpowers/sdd/2026-11-16-sp09-support-tickets/live-verification.md`, in the format of SP-15's: summary, a results table with evidence, DB-side checks, findings, cleanup, pending items. If the harness refuses the write, put the tables in the scratchpad and say so; do not reroute.

**Before approval (read-only, production):** `SELECT count(*) FROM "Ticket"`, `SELECT count(*) FROM "Ticket" t JOIN "TicketStage" s ON s.id = t."stageId" WHERE s."slaMinutes" IS NOT NULL AND NOT s."isTerminal"` (the backfill size), and `SELECT reltuples FROM pg_class WHERE relname = 'Ticket'`.

**Isolation** (no repo code changed; scripts derived from SP-15's in the session scratchpad `C:\Users\ashra\AppData\Local\Temp\claude\7b75a64029a712a6\ebb2057a-6300-4548-9aec-b98487880afb\scratchpad\`):
- **Own instance:** `launch-sp09.js`, derived from `launch-sp15.js`. Backend on **:4240**, compiled with `tsc -p tsconfig.build.json` into `backend/.verify-dist-sp09` (never `backend/dist`), started with `node` and its working directory set to `sp09-run/`, so `LocalStorage` writes to `sp09-run/uploads`. The user's :4100 process is not touched.
- **Crons:** all `@nestjs/schedule` jobs disabled (the SP-13 `lookupSchedulers` patch). The resolution sweep, the HJZ sweep and the activity-due scheduler never run.
- **Storage:** every `DO_SPACES_*` is an **empty string**, so nothing is written to the real bucket.
- **No external call, ever:**
  - **Zernio:** `ZERNIO_BASE_URL=http://127.0.0.1:4239/api/v1`, `ZERNIO_API_KEY=zz-verify-stub`, pointing at `zernio-stub-sp09.js` (derived from SP-15's). It serves the inbound image's media download (a small PNG) and records every call. `ZERNIO_WEBHOOK_SECRET` is a test value so the inbound image message can be replayed signed.
  - **HJZ:** `HJZ_API_URL`, `HJZ_OUTBOUND_URL` and `HJZ_WEBHOOK_SECRET` are empty strings, so `HjzAppointmentSyncService.isConfigured()` is false; the test workspaces have no `externalTenantId`.
  - **Meta, l, OpenAI:** every key and base URL an empty string (SP-19 finding E2: empty, not deleted).
  - **The launcher refuses to start** unless `ZERNIO_BASE_URL` begins with `http://127.0.0.1`, `ZERNIO_API_KEY` equals `zz-verify-stub`, every `DO_SPACES_*` and `HJZ_API_URL`, `HJZ_OUTBOUND_URL`, `HJZ_WEBHOOK_SECRET` are empty.
  - The SP-13 egress guard (fetch/http/https to any non-loopback host throws and is logged to `blocked-egress-sp09.jsonl`) stays. Before cleanup the script asserts the file is empty and that the stub log holds no send (`POST …/messages`).
- Test tag `zz-verify-<ts>` on every name and email.

**Setup** (writes only rows of throwaway workspaces; every id recorded in `verify-created-sp09.json`):
1. Register an owner and a foreign owner. Invite an admin, an agent with `assigned` visibility (custom role), and a viewer.
2. Insert a Zernio WhatsApp channel (`externalId zz-verify-acc-<ts>`). Replay a signed inbound image message → contact, conversation, message with `attach = <mediaId>`. Create a second conversation (another contact) with its own inbound image. Assign conversation 1 to nobody (so the assigned-only agent cannot see it).
3. Create a support pipeline (SP-07 `kind: support`) with stages open (`slaMinutes 120`), in_progress (`1440`), resolved (won, terminal), dismissed (terminal); and a deals pipeline.
4. Record the before-counts listed under Cleanup.

**Checks:**
- **Migration and trigger:** the columns, table, indexes and trigger exist (`information_schema`, `pg_trigger`); `priority` of every pre-existing ticket reads `normal` (`SELECT count(*) WHERE "priority" <> 'normal'` = 0 right after apply).
- **`slaDueAt recalculated on stage change` (live):** create a ticket in `open` → `slaDueAt ≈ created + 120 min` (DB); move to `in_progress` → `≈ now + 1440`; move to `resolved` → null; reopen → `≈ now + 120`; a title edit leaves it; bulk move (`POST /tickets/bulk`), a workflow-style raw update (`UPDATE … SET "stageId"` in a rolled-back transaction) and a stage delete with move-to each set it.
- **Run `ticket-sla.db.spec.ts`** with `TICKETS_TEST_DATABASE_URL` = production, confined to its own throwaway workspace (the spec creates and deletes it): green.
- **Fields and filters:** priority/category set and refused (unknown → 400); `sla=overdue` after setting one test ticket's `slaDueAt` into the past (raw, test row only); sorts; the table view.
- **Attachments:**
  - candidates list the conversation-1 image only; attach → `source: customer`; the conversation-2 image → 404 `attachment_source_not_found`;
  - staff upload of a PNG → linked; an HTML-as-PNG → 400 `media.type_mismatch`;
  - download as owner → the bytes (hash equal); as the assigned-only agent → customer file 404, staff file 200; as the foreign owner → 404 for both ids;
  - unlink keeps the media row; `DELETE /media/:id` of an attached file → 409 `media.in_use` with the ticket;
  - no storage path or URL in any response or log line of :4240 (grep).
- **Resolve:** resolve with a note → stage `resolved`, `TicketActivity` kind `won` with the note, `slaDueAt` null; again → 409 `already_closed`.
- **Booking cards:** insert a pending and a completed appointment for the contact (no `externalTenantId`, so no HJZ push) → only the pending one is listed; Confirm as the agent → `confirmed`; the viewer sees cards but no actions (403 on PATCH).
- **Roles:** agent and viewer per the `SP-09 ticket routes` block (403 where expected).
- **Index use:** `EXPLAIN` (no `ANALYZE`) of the `sla=overdue` list query inside `BEGIN; SET LOCAL enable_seqscan = off; … ROLLBACK;` uses `Ticket_workspaceId_slaDueAt_idx`.
- **Migration rerun:** the SP-09 SQL again inside a transaction that is always rolled back: no error, 0 rows changed. If the tool safety layer refuses DDL even in a rolled-back transaction (as in SP-13/14), record it and ask the user; do not reroute.
- **Backfill (only if approved):** run `backfill-ticket-sla.sql`, record the rows set; run it again → 0 rows.
- **UI through the `verify` skill:** the board and table with priority, category, channel and SLA columns/badges in English and Arabic (RTL); the filters surviving a reload; the ticket sheet's attachments (upload, conversation picker, image preview, unlink), the resolve dialog, the booking cards; screenshots.

**Cleanup:**
- Delete only the recorded test rows: the workspaces (the cascade covers channels, contacts, conversations, messages, media rows, tickets, `TicketAttachment`, appointments, pipelines, notes, notifications and roles), then the users. Delete the stored files under `sp09-run/uploads`.
- Residue sweep over every table with a `workspaceId` column, including `TicketAttachment`.
- Read-only counts before and after: `Workspace`, `User`, `Channel`, `Contact`, `Conversation`, `Message`, `Media`, `Ticket`, `TicketActivity`, `TicketAttachment`, `Appointment`, `Pipeline`, `TicketStage`, `Note`, `Notification`, `Role`, `WorkspaceMember`. Every count identical (apart from the backfill, which changes no count).
- Stop :4240, the stub, and remove the outDir and `sp09-run/`.

Then tick SP-09's "Detailed plan written" and "Shipped" boxes in the roadmap, noting the rulings and deviations. Add the deferred items: booking requests on tickets (ruling 7), Office/audio uploads (ruling 9), a per-workspace category catalog (ruling 3), business-hours SLA and SLA-breach notifications.
