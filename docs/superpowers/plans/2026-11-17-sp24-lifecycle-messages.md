# SP-24 Lifecycle Messages: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- **One settings page for every automatic message.** A new Settings tab "Automatic messages" / "الرسائل التلقائية" lists a fixed catalog of lifecycle messages:
  - customer messages: booking confirmed, booking reminder, booking cancelled, ticket opened, ticket resolved;
  - staff messages: ticket opened, new lead.
- **Per message:** on/off, edit (the AR and EN template bodies), recipient, the reminder offset, the WhatsApp template status of each language (approved / in review / rejected / paused / not set up) with **Sync** and **Resubmit**, and a link to "Custom automations" (the existing workflow builder, prefilled with the same trigger).
- **One automation engine (roadmap Approach).** Each lifecycle message is a **system workflow** (`backend/src/workflows`): a `Workflow` row with a `systemKey`, a locked trigger, and one send step. The page is a focused view over those rows. Roadmap acceptance: `toggling off disables the system workflow`; `rejected template shows resubmit and blocks enable`.
- **Safe by default.**
  - Nothing is created or sent until an owner presses **Set up** for a message (ruling 2).
  - A message set up starts **off**.
  - Every send keeps the existing gates: payment lock (park), the contact's opt-out (skip, ruling 5), SP-19 R9 (a disconnected number is refused, never rerouted), and the template's live approval (skip when not approved).

**Architecture:**
- **Catalog in code** (`backend/src/lifecycle/lifecycle-catalog.ts`, mirrored keys in `src/screens/settings/lifecycle/lifecycleCatalog.ts`, a test pins equality):
  | key | audience | trigger (`Workflow.triggerType`) | triggerConfig | step |
  |---|---|---|---|---|
  | `booking_confirmed` | customer | `appointment_confirmed` | `{}` | `send_whatsapp_template` (AR/EN variants) |
  | `booking_reminder` | customer | `appointment_reminder_due` | `{offsetMinutes}` (default 1440, 60…10080) | `send_whatsapp_template` |
  | `booking_cancelled` | customer | `appointment_cancelled` | `{}` | `send_whatsapp_template` |
  | `ticket_opened` | customer | `ticket_created` | `{pipelineKind: "support"}` | `send_whatsapp_template` |
  | `ticket_resolved` | customer | `ticket_resolved` | `{pipelineKind: "support"}` | `send_whatsapp_template` |
  | `ticket_opened_staff` | staff | `ticket_created` | `{pipelineKind: "support"}` | `notify_staff` |
  | `new_lead_staff` | staff | `ticket_created` | `{pipelineKind: "leads"}` | `notify_staff` |
  - `Workflow.systemKey = "lifecycle." + key`. One row per (workspace, systemKey), unique index.
  - Each customer key carries default AR and EN bodies, a variable map, and template names `kewy_<key>_ar` / `kewy_<key>_en` (Meta UTILITY category; the footer is the workspace name, so the customer never sees our brand; Tkana does the same).
- **Triggers (new emitters, all after commit, never throwing):**
  - `appointment_confirmed`: `BookingWriter` on a create with `status = "confirmed"` and on a transition into `confirmed`.
  - `appointment_cancelled`: `BookingWriter` on a transition into `cancelled`.
  - `appointment_reminder_due`: emitted only by the new `LifecycleReminderScheduler` (every 5 min) for each active `booking_reminder` system workflow:
    - it finds `pending`/`confirmed` bookings whose `startAt` lies in `(now + offset − 15 min, now + offset]` and is still in the future;
    - it starts the workflow run directly through `WorkflowDispatchService.startTriggeredRun` (no event bus round trip).
  - `ticket_resolved`: `TicketsService` everywhere it already emits `ticket_stage_changed` (create, move, bulk move; `resolveTicket` goes through `moveTicket`), when the new stage is terminal **and** won.
  - `ticket_created` is unchanged. The new `pipelineKind` trigger filter separates support tickets from leads.
  - The payload of every new trigger carries pre-formatted texts so templates never format dates themselves: `appointment.{dateTextAr, dateTextEn, timeTextAr, timeTextEn}` in the workspace timezone, Latin digits (`ar-SA-u-nu-latn`, the SP-04 rule), and `occurrenceKey` (below).
- **No double sends.** `WorkflowDispatchService.startTriggeredRun` gets a claim for system workflows:
  - an emitter puts `occurrenceKey` in the payload (`confirmed:<startAt ISO>`, `cancelled:<startAt ISO>`, `reminder:<startAt ISO>:<offsetMinutes>`, `ticket_created:<ticketId>`, `ticket_resolved:<ticketId>:<enteredStageAt ISO>`);
  - before the run starts, `INSERT … ON CONFLICT DO NOTHING` into `LifecycleDelivery (workflowId, entityId, occurrenceKey)`; no row inserted → no run.
  - So a scheduler tick that overlaps the last, two app instances, or a replayed event send once. A reschedule changes `startAt`, so the new time gets its own reminder.
  - The claim is not undone when a send is skipped or fails (one attempt per occurrence; the run's result records why). Ruling 7.
- **Language.** The template step gains optional `variants: {ar: {name, language: "ar"}, en: {name, language: "en"}}`. `pickLanguage(context)` chooses:
  - `ar` when the newest inbound message of the target conversation contains Arabic letters;
  - `en` when it contains Latin letters and no Arabic;
  - otherwise the workspace's `lang`.

  Then it prefers the chosen variant if its template is `approved`, else the other one if that is approved (Tkana does the same), else it skips with reason `template_not_approved`. There is no `Contact.lang` (ruling 4).
- **Send gates, in the runner, in this order** (the first three exist today; 4–6 are new):
  1. payment lock: park the run (unchanged);
  2. `marketingOptOut`: skip with `opted_out` (unchanged; it applies to lifecycle templates too, ruling 5);
  3. no WhatsApp conversation for the contact: fail with the existing reason;
  4. **channel**: the template executor resolves the channel with `ChannelResolver.forSend` instead of `forConversation`. A disconnected number throws `channels.disconnected`, and the step records `{skipped: true, reason: "channel_disconnected"}`. No fallback to another number (SP-19 R9). This also applies to user workflows (ruling 8);
  5. **template approval**: the live `Template.status` of the chosen variant must be `approved`, else skip `template_not_approved`;
  6. the workflow is still `active` at send time (a toggle-off between trigger and send wins).
- **Staff step `notify_staff`** (new step type, no customer send):
  - config `{recipient: "assignee" | "permitted" | "members", userIds?: string[], messageKey: "lifecycle.ticket_opened" | "lifecycle.new_lead"}`.
  - It resolves users; intersects them with `PermissionService.membersWith(ws, "tickets.view")` and, for a ticket with a conversation, with the users who can see that conversation (Review Focus 1); then calls `NotificationsService.notify(ws, userIds, {type: "lifecycle", title: messageKey, body: JSON {number, title, contactName}, recordKind: "ticket", recordId})`.
  - `assignee` with no assignee falls back to `permitted`.
- **Locked system workflows.** `WorkflowsService`:
  - `update` refuses `triggerType`/`triggerConfig` changes on a system row with 409 `workflows.system_locked`, and edits to `steps` too, unless they come from the lifecycle service;
  - `remove` refuses with the same error;
  - `activate`/`deactivate` stay allowed and are what the lifecycle toggle calls;
  - `list` and `get` return `systemKey`.

  `deactivate` of a system workflow also marks its `waiting` runs `cancelled` (a run parked by the payment lock must not send after the owner switched the message off).
- **Template status and actions** reuse SP-14's template code; nothing new talks to Meta:
  - **Sync** = `TemplatesService.list(ws)` (the reconcile against Zernio that `GET /templates` already does).
  - **Resubmit** = the existing template editor `PATCH /templates/:id` (`templates.update`). The page opens it for the variant.
  - **Edit** is the same editor, with a warning that Meta re-reviews the template and pauses that message until it is approved again.
- **Set up** (`POST /lifecycle/:key/setup`, explicit owner action):
  - creates the AR and EN `Template` rows through `TemplatesService.create`, which submits them through the default WhatsApp number exactly like a manual template. An existing template of the same name is reused, never overwritten;
  - creates the system workflow with `status: "draft"`;
  - with no WhatsApp connected it gives 409 `lifecycle.whatsapp_not_connected` (SP-13 gating copy).

  Staff keys need no template: setup only creates the workflow.

**Tech Stack:** NestJS 10, Prisma 5 (Postgres/Neon), `@nestjs/schedule`, `@nestjs/event-emitter`, jest/ts-jest; React 18 + Vite, vitest. **No new dependencies.** **No Claude/Anthropic call is added by this plan.** If an implementer adds or touches any Claude code (for example AI-drafted copy, or the ads chat), they must load the `claude-api` skill first and take model ids only from it; any such addition needs a controller ruling first. Any later Claude call goes through SP-21's planned `backend/src/ai/claude.service.ts` once it has shipped (SP-21 ruling 1 decides SDK vs raw `fetch`). Never copy the stale default model or `anthropic-version` from `ads/ads-chat.service.ts`.

**Spec:** roadmap §SP-24, plus the Global Constraints and Review Focus 1, 2 and 4. Carried contracts:
- **Workflows (existing):** `Workflow {triggerType, triggerConfig, steps, status}`, `WorkflowRun`, `WORKFLOW_TRIGGER_EVENT`, `WorkflowDispatchService.startTriggeredRun` (payment lock), `WorkflowRunnerService` (park on lock, `contactOptedOut`), `SendWhatsappTemplateExecutor`, `validateStepGraph`, `TRIGGER_TYPES`.
- **SP-02:** `Contact.marketingOptOut`, `firstName`.
- **SP-05:** `NotificationsService.notify`, `NOTIFICATION_TYPES` (`backend/src/notifications/notifications.dto.ts`).
- **SP-07/SP-09:** `Pipeline.kind` (`support` | `leads` | `deals`), `TicketStage.isTerminal/isWon`, `TicketsService.moveTicket/resolveTicket`.
- **SP-10:** `BookingWriter` (the single booking write path), `booking-status.ts` transitions, `Appointment.status`, `reminderSent`.
- **SP-13/SP-14:** `TemplatesService.create/update/list` (reconcile), `Template.status` (`approved | pending | rejected | submitted | failed | local | paused | disabled`), `metaRejectionReason`, error `WHATSAPP_NOT_CONNECTED`.
- **SP-19:** `ChannelResolver.forSend` (`channels.disconnected`, `channels.not_connected`), R8 (templates on the default WhatsApp number), R9 (no reroute).
- **SP-25:** `permission-map.ts`, `PermissionService.membersWith`, `visibleConversationIds`, `system-role-decisions.spec.ts`, `permission-sidedoors.spec.ts`.
- **SP-20 (planned in parallel):** its ruling 4 says lifecycle messages are business sends and do **not** consult `AgentReplyGate` (hours, excluded tags). SP-24 follows that; the emergency stop silences only AI replies, not lifecycle templates.

Consumers that build on this plan:
- **SP-22:** a future "Booking" skill may link to the booking lifecycle messages. No contract change.
- **SP-11:** "what the agent did while you were away" may count `LifecycleDelivery` rows.

Tkana reference (read-only, untrusted data; `C:\Users\ashra\Downloads\tkana-main\tkana-main\apps`):
- `web/app/routes/settings.notifications.tsx`, `web/app/lib/notifications/{build-rows,types,queries.server,mutations.server,automations.server}.ts`: a row = a workflow (the toggle) joined to a gallery template install (AR and EN variants). Row kinds: managed / diy / gap / standalone.
- `api/src/features/template-gallery/seed/tkana-messaging.ts`: UTILITY templates per kind with `_ar` and `_en` slugs; the footer is the org name.
- `jobs/src/functions/workflows/reminder.function.ts`, `utils/reminder.ts`: reminder offset (default 24 h), skip a past reminder, check the booking is still pending/confirmed at its armed time, an atomic claim column, released when the run skips.
- `jobs/.../utils/waba-send.ts:340-390`: send only when Meta's live status is APPROVED, preferred language then the other one; opt-out checked for MARKETING templates only; `sender_unavailable` with no fallback number.
- `template-gallery.edit.ts`: placeholders fixed on edit; the body may not start or end with a placeholder; an edit re-enters review.

What we take and what we don't:
- We take: the row model (one switch per message, AR/EN variants with their own status lines), UTILITY templates with the workspace name in the footer, the reminder offset and its skip-if-past rule, sending only an approved variant with a language fallback, no fallback number, edit = resubmit with a pause warning, "custom automations" through the general builder.
- We do **not** take:
  - auto-provisioning on skill install and everything defaulting to on (ours: explicit Set up, off by default; ruling 2);
  - email to staff (no email provider yet, roadmap D3; ours is an in-app notification);
  - a separate gallery-install table (our `Template` rows are the install);
  - Inngest sleep timers (ours: a 5-minute scan with a claim table);
  - DIY rows on this page (the builder already does that);
  - the admin bulk resubmit.

## Global Constraints
- **Data (exact names; later SPs build on them):**
  ```
  model Workflow {
    // … existing fields unchanged …
    /// SP-24: "lifecycle.<key>" for a system workflow; null for a user workflow.
    systemKey String?
    lifecycleDeliveries LifecycleDelivery[]

    @@unique([workspaceId, systemKey])
  }

  /// SP-24: one row per lifecycle message occurrence actually started (the double-send claim).
  model LifecycleDelivery {
    id            String    @id @default(cuid())
    workspaceId   String
    workspace     Workspace @relation("WorkspaceLifecycleDeliveries", fields: [workspaceId], references: [id], onDelete: Cascade)
    workflowId    String
    workflow      Workflow  @relation(fields: [workflowId], references: [id], onDelete: Cascade)
    entityKind    String    // "appointment" | "ticket"
    entityId      String    // no FK: the booking/ticket may be deleted later; the claim must outlive it
    occurrenceKey String
    runId         String?   // the WorkflowRun started (no FK: runs are pruned with the workflow)
    createdAt     DateTime  @default(now())

    @@unique([workflowId, entityId, occurrenceKey])
    @@index([workspaceId, createdAt])
  }
  ```
  - The `Workspace` back-relation (`lifecycleDeliveries`) is Prisma-only.
  - `Workflow.triggerType` doc comment adds `appointment_confirmed | appointment_cancelled | appointment_reminder_due | ticket_resolved`.
- **Constants** (`backend/src/lifecycle/lifecycle-catalog.ts`):
  - `LIFECYCLE_KEYS` (the seven keys above, in display order);
  - `REMINDER_OFFSET_DEFAULT_MIN = 1440`, `REMINDER_OFFSET_MIN = 60`, `REMINDER_OFFSET_MAX = 10080`;
  - `REMINDER_TICK_MS = 5 * 60_000`, `REMINDER_LOOKBACK_MIN = 15`;
  - `LIFECYCLE_TEMPLATE_PREFIX = "kewy_"`.

  `TRIGGER_TYPES` adds `appointment_confirmed`, `appointment_cancelled`, `appointment_reminder_due`, `ticket_resolved`. The step types add `notify_staff`. `NOTIFICATION_TYPES` adds `lifecycle` (ruling 6).
- **Default bodies** (variables in order; none at the start or end of a body):
  - `booking_confirmed`: EN "Hello {{1}}, your booking for {{2}} on {{3}} at {{4}} is confirmed. Reply here if you need to change it." / AR "مرحبًا {{1}}، تم تأكيد حجزك لخدمة {{2}} يوم {{3}} الساعة {{4}}. ردّ على هذه الرسالة إذا أردت تعديله." Vars: firstName‖name, service (AR: serviceAr), dateText, timeText.
  - `booking_reminder`: EN "Hello {{1}}, a reminder of your booking for {{2}} on {{3}} at {{4}}. We look forward to seeing you." / AR "مرحبًا {{1}}، نذكّرك بحجزك لخدمة {{2}} يوم {{3}} الساعة {{4}}. بانتظارك."
  - `booking_cancelled`: EN "Hello {{1}}, your booking for {{2}} on {{3}} at {{4}} has been cancelled. Reply here to book another time." / AR "مرحبًا {{1}}، تم إلغاء حجزك لخدمة {{2}} يوم {{3}} الساعة {{4}}. ردّ على هذه الرسالة لحجز موعد آخر."
  - `ticket_opened`: EN "Hello {{1}}, we received your request #{{2}} and our team is on it. We will update you here." / AR "مرحبًا {{1}}، استلمنا طلبك رقم {{2}} وفريقنا يعمل عليه. سنوافيك بالتحديثات هنا."
  - `ticket_resolved`: EN "Hello {{1}}, your request #{{2}} has been resolved. Reply here if you need anything else." / AR "مرحبًا {{1}}، تم حل طلبك رقم {{2}}. ردّ على هذه الرسالة إذا احتجت أي شيء آخر."
  - The footer of each is the workspace name (`Workspace.name`, ≤ 60 chars, truncated).
- **DTOs:**
  - `LifecycleRowDto = {key, audience: "customer"|"staff", setUp: boolean, enabled: boolean, workflowId: string|null, recipient: {kind: "customer"|"assignee"|"permitted"|"members", userIds: string[]}, offsetMinutes: number|null, variants: {ar: TemplateVariantDto|null, en: TemplateVariantDto|null} | null, blockedReason: "template_rejected"|"template_missing"|"whatsapp_not_connected"|null, lastSentAt: string|null, sent30d: number}`.
  - `TemplateVariantDto = {templateId, name, language, status, rejectionReason: string|null, quality: string|null}`.
  - `PatchLifecycleDto = {enabled?: boolean, recipient?: {kind, userIds?}, offsetMinutes?: number, version?: never}` (`forbidNonWhitelisted`; `recipient.kind` must be allowed for the key's audience; `userIds` ≤ 20, each an active member of the workspace).
- **API** (every route workspace-scoped; an unknown key is 404 `lifecycle.unknown_key`; a foreign `userIds` entry is 400 `lifecycle.invalid_recipient`, which does not reveal which id):
  - `GET /lifecycle` (`workflows.view`) → `{rows: LifecycleRowDto[], whatsappConnected: boolean, lastSyncedAt: string|null}`. It reads local rows only (no provider call).
  - `POST /lifecycle/:key/setup` (`workflows.create`) → `LifecycleRowDto`. Idempotent: a second call returns the row unchanged.
  - `PATCH /lifecycle/:key` (`workflows.update`) body `PatchLifecycleDto` → `LifecycleRowDto`.
    - `enabled: true` runs the enable gate: 409 `lifecycle.not_set_up`, 409 `lifecycle.template_rejected {language, reason}`, 409 `lifecycle.template_missing {language}` (both variants must exist, and neither may be rejected or disabled). `pending`/`submitted`/`paused` are allowed and shown "in review" / "paused"; at send time they are skipped.
    - `enabled: false` deactivates and cancels the workflow's waiting runs.
  - `POST /lifecycle/sync` (`templates.view`, the same permission as `GET /templates`, which already writes the reconcile) → `{rows, lastSyncedAt}`; 409 `lifecycle.whatsapp_not_connected` when no WhatsApp channel.
  - `GET /workflows`, `GET /workflows/:id` add `systemKey`; `PATCH`/`DELETE /workflows/:id` give 409 `workflows.system_locked` as described.
- **Error keys** (`backend/src/lifecycle/lifecycle-errors.ts`, `{statusCode, message: key, …extra}` like `channelError`):
  - 400: `lifecycle.invalid_recipient`, `lifecycle.invalid_offset`;
  - 404: `lifecycle.unknown_key`;
  - 409: `lifecycle.not_set_up`, `lifecycle.template_rejected`, `lifecycle.template_missing`, `lifecycle.whatsapp_not_connected`, `workflows.system_locked`.
  - Frontend `src/screens/settings/lifecycle/lifecycleErrors.ts` has `tx` copy for every key, with a test covering every key.
- **Copy and layout:**
  - Every string through `tx("English","العربية")` with real Arabic. Row titles:
    - Booking confirmed / تأكيد الحجز
    - Booking reminder / تذكير بالحجز
    - Booking cancelled / إلغاء الحجز
    - Ticket opened / فتح تذكرة
    - Ticket resolved / حل التذكرة
    - New ticket for the team / تذكرة جديدة للفريق
    - New lead for the team / عميل محتمل جديد للفريق
  - Statuses:
    - Approved / معتمد
    - In review / قيد المراجعة
    - Rejected / مرفوض
    - Paused by WhatsApp / أوقفه واتساب
    - Not set up / غير مُعدّ
  - Actions:
    - Set up / إعداد
    - Sync / مزامنة
    - Fix and resubmit / تصحيح وإعادة الإرسال
    - Edit message / تعديل الرسالة
    - Custom automations / أتمتة مخصصة
  - Edit warning: "Saving sends the message to WhatsApp for review again. It stays paused until it is approved." / "عند الحفظ تُرسل الرسالة إلى واتساب لمراجعتها من جديد، وتبقى متوقفة حتى تُعتمد."
  - Logical CSS only (`margin-inline-start`, `padding-inline`, `inset-inline-end`, `text-align: start`). Template names and counts sit in `<bdi>`; bodies use `dir="auto"`; the edit drawer sets `dir` per language tab (the AR tab is `rtl` even in the English UI).
- **Permissions (SP-25).** No catalogue change. `permission-map.ts` adds:
  - `GET /lifecycle`: `workflows.view`
  - `POST /lifecycle/:key/setup`: `workflows.create`
  - `PATCH /lifecycle/:key`: `workflows.update`
  - `POST /lifecycle/sync`: `templates.view`

  `system-role-decisions.spec.ts` adds an `SP-24 lifecycle routes` block:
  - owner and admin can do everything;
  - agent can view, set up and toggle (agents hold `workflows` create/update today, the SP-25 ruling);
  - viewer can view and sync but gets 403 on setup and patch.

  `permission-sidedoors.spec.ts` adds `staff lifecycle notification skips members who cannot see the ticket conversation`.
- **Migration:**
  - File: `backend/prisma/migrations/20261117150000_lifecycle_messages/migration.sql`. The timestamp is after `20261116130000_bookings_catalog` and after the parallel SP-21/SP-20/SP-18 slots (`20261117120000`–`20261117140000`). **An applied migration is never edited.** Hand-written, LF line endings; apply with `npx prisma migrate deploy` only (from `backend/`, Prisma 5.22), never `migrate dev`.
  - **Additive and idempotent:**
    ```sql
    ALTER TABLE "Workflow" ADD COLUMN IF NOT EXISTS "systemKey" TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS "Workflow_workspaceId_systemKey_key" ON "Workflow"("workspaceId","systemKey");
    CREATE TABLE IF NOT EXISTS "LifecycleDelivery" (
      "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "workflowId" TEXT NOT NULL,
      "entityKind" TEXT NOT NULL, "entityId" TEXT NOT NULL, "occurrenceKey" TEXT NOT NULL, "runId" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "LifecycleDelivery_pkey" PRIMARY KEY ("id"));
    CREATE UNIQUE INDEX IF NOT EXISTS "LifecycleDelivery_workflowId_entityId_occurrenceKey_key"
      ON "LifecycleDelivery"("workflowId","entityId","occurrenceKey");
    CREATE INDEX IF NOT EXISTS "LifecycleDelivery_workspaceId_createdAt_idx" ON "LifecycleDelivery"("workspaceId","createdAt");
    -- FKs, each in DO $$ BEGIN … EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    --  LifecycleDelivery_workspaceId_fkey (CASCADE), LifecycleDelivery_workflowId_fkey (CASCADE); ON UPDATE CASCADE.
    ```
  - **Prisma-conformant names** as listed. `prisma migrate diff --from-schema-datamodel <base schema> --to-schema-datamodel prisma/schema.prisma --script` (no DB) must equal the file apart from `IF NOT EXISTS` and the `DO` wrappers (the SP-13/14/09 check).
  - **Safe for the deployed `main`:**
    - `systemKey` is nullable. `main` never writes it (its rows stay null; Postgres treats nulls as distinct, so the unique index never blocks `main`'s inserts).
    - `LifecycleDelivery` is unknown to `main`; deleting a workflow or workspace cascades it.
    - No existing column, constraint or index changes. No `UPDATE`, `DELETE`, `DROP` or `ALTER … TYPE`.
    - **Locks:** the unique index on `Workflow` is built non-concurrently (a few hundred rows: milliseconds); Task 3 records the row count first.
    - **Rollback hazard (runbook):** the deployed `main` would dispatch an active system workflow on `ticket_created` and fail it on the unknown `notify_staff` step, and would list system rows as editable. Before rolling the backend back below SP-24, run `docs/runbooks/lifecycle-rollback.md` (written in Task 1): deactivate every `systemKey IS NOT NULL` workflow (gate query must return 0 active rows).
  - **No backfill.**
- **Tests:**
  - backend: `npx jest src/lifecycle src/workflows src/bookings src/tickets src/notifications src/permissions src/templates` plus `npx tsc --noEmit -p tsconfig.json`; the full `npm test` once per task. Known unrelated failure: `hjz-client-sync › is inert when HJZ is not configured`.
  - frontend (repo root): `npx vitest run` plus `npm run typecheck`; `npm run build` once in Task 2.
  - **Named acceptance tests (exact names):**
    - `toggling off disables the system workflow` (backend jest, `src/lifecycle/lifecycle.service.spec.ts`)
    - `rejected template shows resubmit and blocks enable` (backend jest, `src/lifecycle/lifecycle.service.spec.ts`, for the 409; **and** frontend vitest, `src/screens/settings/lifecycle/lifecycleRows.test.ts`, for the row model: Resubmit shown, switch disabled with the reason)
  - No provider is called in any spec (Zernio, Meta and l are fakes).
- **Commits:** selective `git add <paths>`, never `-A`. Trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not stage `.playwright-mcp/`, `.claude/worktrees/` or any untracked file this plan did not create.

## Review Focus
1. **No surprise customer messages.**
   - Nothing is created on any provider and nothing is sent until an owner presses Set up and switches a message on.
   - A message switched off, a workspace payment-locked, a contact opted out, a disconnected number or an unapproved template sends nothing, and the run's result says why.
   - Tests: `toggling off disables the system workflow`, `toggle off cancels parked runs`, `disconnected number is skipped not rerouted`, `unapproved variant falls back then skips`, `opted-out contact gets no lifecycle message`.
2. **Exactly once per occurrence.**
   - Two scheduler ticks, two instances or a replayed event start at most one run per (workflow, booking/ticket, occurrence). A reschedule earns a new reminder; a reminder for a time already past is never sent.
   - Tests: `reminder claimed once across overlapping ticks`, `rescheduled booking gets a new reminder`, `past reminder is skipped`, `cancelled or completed booking gets no reminder`.
3. **The trigger is locked, the engine is shared.**
   - A system workflow's trigger, config and steps can only be changed through the lifecycle API, and it cannot be deleted. User workflows on the same triggers keep working, and an unfiltered `ticket_created` user workflow still fires for every pipeline.
   - Tests: `system workflow trigger is locked`, `pipelineKind filter matches only that kind`, `user workflow without filter still fires`.
4. **Staff notifications respect visibility (Review Focus 1 of the roadmap).**
   - A staff lifecycle notification never reaches a member without `tickets.view`, or an assigned-only member for a ticket whose conversation they cannot see.
   - Test: `staff lifecycle notification skips members who cannot see the ticket conversation`.
5. **Rejected templates.**
   - A rejected or missing variant blocks enabling; the row shows Fix and resubmit with Meta's reason; after a resubmit becomes approved (sync), enabling works.
   - Test: `rejected template shows resubmit and blocks enable`.

## Architecture Rulings and Risks
Each item names the risk, then the recommended ruling. Items marked **(needs controller ruling)** are repeated under Controller rulings, where the controller fills in the decision.

1. **Engine.** The roadmap fixes "system workflow with a locked trigger and a template step".
   - **Ruling:** `Workflow.systemKey` plus the lifecycle service as the only writer of system rows. Staff messages use a new `notify_staff` step in the same engine.
   - **Alternative:** a separate `LifecycleSetting` table and sender. That is the second engine the roadmap forbids. **(needs controller ruling, minor)**
2. **Defaults and provisioning.** Tkana provisions and enables everything on skill install. Here, creating templates submits them to Meta through Zernio (an external action), and a switched-on message writes to real customers.
   - **Ruling:** nothing is created until an owner presses Set up (per message, or "Set up all"); a set-up message starts off. No backfill and no automatic provisioning for existing workspaces.
   - **Alternative:** auto-provision drafts for every WhatsApp-connected workspace on deploy. That submits ~10 templates per workspace to Meta unasked. **(needs controller ruling)**
3. **Reminder timing.**
   - **Ruling:** a 5-minute scan with a 15-minute lookback window (a missed tick still sends), `startAt` must still be in the future, `pending` or `confirmed` only, claimed in `LifecycleDelivery`. The legacy `Appointment.reminderSent` flag is set to true after a successful reminder send (the Calendar shows it); `main` and staff can still set it by hand.
   - **Alternative:** per-booking timers. No timer infrastructure exists here. **(needs controller ruling, minor)**
4. **Language.** There is no `Contact.lang`.
   - **Ruling:** the script of the newest inbound message, else `Workspace.lang`; the other variant only when the preferred one is not approved.
   - **Alternative:** add `Contact.lang`. That is an SP-02 contract change, deferred. **(needs controller ruling, minor)**
5. **Opt-out.** Tkana checks opt-out for MARKETING templates only (lifecycle messages are UTILITY). Our runner skips **every** template step for an opted-out contact today, and the user's rule is that automatic customer messages respect opt-outs.
   - **Ruling:** keep the runner as it is: an opted-out contact receives no lifecycle message either (`opted_out` in the run result, counted on the page as "skipped: opted out").
   - **Alternative:** exempt UTILITY lifecycle templates from `marketingOptOut` (Tkana behaviour), so a cancelled booking still reaches an opted-out customer. **(needs controller ruling)**
6. **Staff channel and notification type.** There is no email provider (roadmap D3), and `§2.4` fixes the notification types.
   - **Ruling:** staff messages are in-app notifications (bell, sound per preferences) with a new type `lifecycle`, added to `NOTIFICATION_TYPES` and to the preference screen. Email follows SP-26/D3.
   - **Alternative:** reuse `assignment`. That would mix two meanings, and members cannot mute one without the other. **(needs controller ruling)**
7. **Claim on skip.** A claimed occurrence whose send is skipped (template not approved, channel disconnected, no WhatsApp chat yet) is not retried.
   - **Ruling:** one attempt per occurrence. Each skip is visible on the page (last 30 days: sent / skipped by reason) and in the workflow's Runs tab. A later fix applies to the next occurrence.
   - **Alternative:** release the claim on skip (Tkana), so the next tick retries a reminder. That fits reminders only and risks a late "your booking is confirmed" hours later. **(needs controller ruling)**
8. **`forSend` for template steps (SP-19 R9).** `SendWhatsappTemplateExecutor` resolves the channel with `forConversation`, which returns a disconnected channel too. Today a send on a disconnected Zernio account fails at the provider, and SP-19 R9 says a disconnected number is refused, never rerouted.
   - **Ruling:** switch the executor to `forSend`. `channels.disconnected` / `channels.not_connected` become a recorded skip (`channel_disconnected`), not a run failure. This also changes user workflows (they now skip with a clear reason instead of failing with a provider error).
   - **Alternative:** apply it to system workflows only. **(needs controller ruling)**
9. **HJZ-synced bookings.** HJZ may already message its own customers about HJZ bookings.
   - **Ruling:** lifecycle triggers fire for every booking `BookingWriter` writes, including HJZ-synced rows. On a workspace with `externalTenantId`, the booking rows show a note: "Bookings synced from HJZ also get these messages." / "الحجوزات المتزامنة من HJZ تصلها هذه الرسائل أيضًا." Defaults are off, so nothing changes unless the owner turns them on.
   - **Alternative:** skip HJZ-sourced bookings. **(needs controller ruling)**
10. **Ticket resolved emitters.** `ticket_stage_changed` is emitted by `TicketsService` (create/move/bulk) only. The resolution sweep, workflow `update_data` and imports move tickets without emitting.
    - **Ruling:** `ticket_resolved` is emitted exactly where `ticket_stage_changed` is. The AI resolution sweep does not message the customer. That is consistent with user workflows today, and avoids an AI-judged "resolved" message.
    - **Alternative:** emit from the sweep too. **(needs controller ruling)**
11. **Templates on the default number (SP-19 R8).** Templates live on the default WhatsApp number. A conversation on another number whose template list lacks the lifecycle template fails at the provider.
    - **Ruling:** unchanged from R8. The failure is recorded per run. Per-number templates remain an SP-13/14 follow-up.
    - **Accept:** a multi-number workspace may see `template_not_found` skips on its secondary number. **(needs controller ruling, minor)**
12. **Rollback.** See Migration → Rollback hazard.
    - **Ruling:** a runbook with a gate query, as SP-13 did.
    - **Accept.** **(needs controller ruling, minor)**
13. **Shared files with SP-21/20/18 (planned in parallel) and SP-22/23.** These touch `schema.prisma`, `permission-map.ts`, `system-role-decisions.spec.ts`, `permission-sidedoors.spec.ts`, `notifications.dto.ts`, `Settings.tsx`, `src/lib/types.ts`.
    - **Ruling:** SP-24 bases on the then-current `feat/tkana-parity` head (recording that SHA). Task 1 owns `schema.prisma` and the migration for SP-24. Migrations apply in timestamp order (`…150000` SP-24 → `…160000` SP-22 → `…170000` SP-23). The second branch to merge rebases its `schema.prisma` and `permission-map.ts` hunks. **(needs controller ruling)**
14. **Verification touches production** (as SP-09 R12).
    - Task 3 runs against the production DB in throwaway workspaces, with local stubs for Zernio (template submit, list and send) and l, and no other provider.
    - The reminder scheduler runs only through `tick({workspaceIds})` restricted to the test workspaces; every cron is otherwise off.
    - The migration needs the user's **explicit approval**; earlier approvals do not carry over. **(needs controller ruling)**
15. **Size.** The roadmap says M. Two build tasks plus verification. **(needs controller ruling, minor)**

### Controller rulings
*Decided 2026-11-16 by the controller: R1–R15 accepted as proposed in Architecture Rulings and Risks. Base commit 2e59053 (feat/tkana-parity: SP-09, SP-10, SP-11 and SP-21 Task 1 merged). SP-24 owns its own migration folder; it is independent of SP-20 20261117130000 and SP-21 20261117120000, and each is applied only with user approval. Migration `20261117150000_lifecycle_messages` needs explicit user approval before it runs.*
- **R1** (system workflows + `notify_staff`): accepted.
- **R2** (explicit Set up, off by default, no auto-provisioning): accepted.
- **R3** (5-minute scan, 15-minute lookback, claim table, `reminderSent` set after send): accepted.
- **R4** (language from the last inbound script, else workspace): accepted.
- **R5** (opt-out blocks lifecycle templates too): accepted.
- **R6** (in-app staff notifications, new type `lifecycle`): accepted.
- **R7** (one attempt per occurrence; skips visible): accepted.
- **R8** (`forSend` in the template executor for every workflow): accepted.
- **R9** (HJZ-synced bookings included, with a note): accepted.
- **R10** (`ticket_resolved` only where `ticket_stage_changed` is emitted): accepted.
- **R11** (templates on the default number, R8 unchanged): accepted.
- **R12** (rollback runbook): accepted.
- **R13** (base SHA, schema ownership, migration order): accepted.
- **R14** (verification on the production DB with stubs; explicit migration approval): accepted.
- **R15** (size M; 2 build tasks + verification): accepted.

---

### Task 1: Backend — schema, migration, lifecycle catalog and service, triggers, dispatch claim, runner gates, reminder scheduler, locked system workflows
**Owns:** `schema.prisma` and the migration for all of SP-24. Task 2 depends on this contract and does not edit the backend.

**Files:**
- `backend/prisma/schema.prisma`: Global Constraints → Data.
- `backend/prisma/migrations/20261117150000_lifecycle_messages/migration.sql` and `backend/src/lifecycle/lifecycle-migration.spec.ts`.
- `docs/runbooks/lifecycle-rollback.md` (gate query `SELECT count(*) FROM "Workflow" WHERE "systemKey" IS NOT NULL AND status = 'active'` and the deactivate statement).
- Create in `backend/src/lifecycle/`, each with a spec:
  - `lifecycle-catalog.ts`: keys, audience, trigger, triggerConfig defaults, default bodies, variable maps, template names, `templateDraft(key, lang, workspaceName)`.
  - `lifecycle-language.ts`: `pickLanguage({lastInboundBody, workspaceLang})`, `chooseVariant(variants, statuses, preferred)`.
  - `lifecycle-text.ts`: `formatBookingTexts(startAt, tz)` → `{dateTextAr, dateTextEn, timeTextAr, timeTextEn}` (Latin digits).
  - `lifecycle-errors.ts`.
  - `lifecycle.service.ts`: `list`, `setup`, `patch`, `sync`, the enable gate, row stats (`sent30d`, `lastSentAt` and skips by reason from `WorkflowRun.result` of the last 30 days).
  - `lifecycle.controller.ts`, `lifecycle.module.ts` (imports `WorkflowsModule`, `TemplatesModule`, `NotificationsModule`, `PermissionsModule`).
  - `lifecycle-reminder.scheduler.ts`: `@Cron("*/5 * * * *") run()` → `tick({now, workspaceIds?})`, skips a payment-locked workspace (the claim is not taken, so the next tick retries while still in the window).
- `backend/src/workflows/`:
  - `workflows.dto.ts`: the four trigger types.
  - `workflow-steps.ts`: `NotifyStaffStep`, `SendWhatsappTemplateConfig.variants?`, validation for both.
  - `workflow-dispatch.service.ts`: the `pipelineKind` matcher (one pipeline lookup per event, cached per event) and the `LifecycleDelivery` claim in `startTriggeredRun` for `systemKey` rows with an `occurrenceKey`.
  - `workflow-runner.service.ts`: gate 6 (workflow still active, for system rows), `notify_staff` dispatch, and the recorded skips.
  - `executors/send-whatsapp-template.executor.ts`: `forSend`, variant choice and approval gate, skip results `{skipped: true, reason}` for `channel_disconnected | template_not_approved | template_not_found`.
  - new `executors/notify-staff.executor.ts`.
  - `workflows.service.ts`: `systemKey` in the shapes, `workflows.system_locked`, cancel waiting runs on deactivate of a system row, and an internal `upsertSystemWorkflow(ws, systemKey, data)` used only by the lifecycle service.
- `backend/src/bookings/booking-writer.ts`: emit `appointment_confirmed` / `appointment_cancelled` after commit with the formatted texts and `occurrenceKey`.
- `backend/src/tickets/tickets.service.ts`: emit `ticket_resolved` beside each `ticket_stage_changed` when the stage is terminal and won; add `occurrenceKey` to `ticket_created` payloads; `pipelineKind` in ticket trigger payloads.
- `backend/src/notifications/notifications.dto.ts`: `lifecycle` type.
- `backend/src/permissions/permission-map.ts` + `permission-map.spec.ts`, `system-role-decisions.spec.ts` (`SP-24 lifecycle routes`), `permission-sidedoors.spec.ts`.
- Test doubles: `backend/src/pipelines/test-prisma.ts` / `channels/test-prisma.ts` gain `lifecycleDelivery` (unique-key semantics) and `workflow.systemKey`.

**Produces (contract for Task 2):** every route, DTO and error key in Global Constraints; the `systemKey` field on workflow DTOs.

- [ ] Write the failing tests:
  - `migration is additive, idempotent and Prisma-named (SP-24)`:
    - every `ADD COLUMN`, `CREATE TABLE` and `CREATE INDEX` has `IF NOT EXISTS`; FKs are in `duplicate_object` blocks; no `UPDATE`, `DELETE`, `DROP`, `ALTER COLUMN` or `TYPE`;
    - the folder name is greater than `20261116130000` and `20261117140000`;
    - the sha256 of `20261116120000_support_tickets` and `20261116130000_bookings_catalog` are pinned;
    - the SQL has LF line endings;
    - the `prisma migrate diff` statements match (recorded as SP-09 did).
  - **`toggling off disables the system workflow`**:
    - set up and enable `booking_confirmed` → its `Workflow.status = "active"`;
    - `PATCH {enabled: false}` → `status = "draft"`;
    - a following `appointment_confirmed` event starts no run;
    - a run parked by the payment lock (`waiting`) becomes `cancelled`;
    - the row reads `enabled: false`.
  - **`rejected template shows resubmit and blocks enable`**:
    - with the AR variant `rejected` (reason "INVALID_FORMAT") → `PATCH {enabled: true}` is 409 `lifecycle.template_rejected {language: "ar", reason}` and the workflow stays draft;
    - the row has `blockedReason: "template_rejected"` and the variant's `rejectionReason`;
    - after the reconcile marks it `approved`, enabling succeeds.
  - `enable needs both variants`: a missing EN template → 409 `lifecycle.template_missing {language: "en"}`. `pending` or `paused` variants enable (in review / paused) but send nothing until approved.
  - `setup is idempotent and creates nothing on a provider twice`:
    - the first call creates two templates through `TemplatesService.create` (fake records the payload: UTILITY, the body, footer = workspace name) and a draft system workflow;
    - a second call creates nothing;
    - an existing same-name template is reused unchanged;
    - no WhatsApp → 409 `lifecycle.whatsapp_not_connected` and nothing is created;
    - staff keys create only the workflow.
  - `system workflow trigger is locked`: `PATCH /workflows/:id {triggerType}` or `{steps}` and `DELETE` → 409 `workflows.system_locked`; `name` edits are also refused; `activate`/`deactivate` work.
  - `pipelineKind filter matches only that kind`, `user workflow without filter still fires` (a user `ticket_created` workflow with `{}` config fires for support and leads tickets).
  - `reminder claimed once across overlapping ticks`:
    - two concurrent `tick()` calls over one due booking → one `LifecycleDelivery`, one run;
    - a third tick in the window → none.
  - `rescheduled booking gets a new reminder` (a new `startAt` → a new occurrence key → a new run), `past reminder is skipped` (offset window reached after `startAt` → no run), `cancelled or completed booking gets no reminder`, `reminder respects offset bounds` (400 `lifecycle.invalid_offset` outside 60…10080).
  - `confirmed event sends once per startAt`: create as confirmed → one run; an unrelated update (note) → none; cancel → `appointment_cancelled` once; a replayed event (same occurrence) → none.
  - `unapproved variant falls back then skips`:
    - AR preferred but `pending`, EN `approved` → EN sent;
    - both unapproved → `{skipped: true, reason: "template_not_approved"}`, nothing sent (the Zernio fake records zero sends).
  - `language follows the last inbound script`: Arabic → `ar`; Latin only → `en`; none → `Workspace.lang`.
  - `disconnected number is skipped not rerouted` (also for a user workflow, ruling 8): the conversation's channel `disconnected` → skip `channel_disconnected`; the default number receives nothing.
  - `opted-out contact gets no lifecycle message` (ruling 5): skip `opted_out`.
  - `payment lock parks a lifecycle run` (unchanged behaviour, now covered for system rows); `toggle off cancels parked runs`.
  - `ticket resolved fires on won terminal stages only`: move to `resolved` (won, terminal) → `ticket_resolved` once; to `dismissed` (lost, terminal) → none; reopen and resolve again → a new occurrence.
  - **`staff lifecycle notification skips members who cannot see the ticket conversation`** (sidedoors):
    - recipients `permitted` on a ticket whose conversation is unassigned → the assigned-only agent is not notified; owner and admin are;
    - a viewer without `tickets.view` (custom role) is not notified;
    - `assignee` with an assignee → only the assignee (if permitted).
  - `lifecycle templates use utility category and fixed placeholders`: each catalog body has the placeholders 1…n in order, none at the start or end; the AR body contains Arabic letters.
  - `permission map covers SP-24 routes`, plus the `SP-24 lifecycle routes` system-role block.
- [ ] Implement until green.
- [ ] `npx tsc --noEmit -p tsconfig.json`, the listed jest paths, then the full `npm test` once. Run `npx prisma generate` (an EPERM on the engine DLL while the dev watcher runs is harmless; restart the watcher). **Do not run `migrate`** (ruling 14). Existing `workflows/*.spec.ts`, `booking-writer.spec.ts`, `tickets.*.spec.ts` and `send-whatsapp-template.executor.spec.ts` stay green, extended only (the executor spec gains the `forSend` cases).
- [ ] Commit `feat(lifecycle): system lifecycle workflows, reminder scheduler, once-per-occurrence claim and send gates`.

### Task 2: Frontend — Automatic messages tab
**Depends on:** Task 1's contract (it can start from the contract while Task 1 is in review).

**Files:**
- **F1 Model (pure):**
  - `src/screens/settings/lifecycle/lifecycleCatalog.ts`: keys, titles and descriptions (`tx`), audience, variable labels per key.
  - `src/screens/settings/lifecycle/lifecycleRows.ts`: `rowView(row, can)` → `{title, statusPill, switch: {shown, disabled, reason}, actions: ("setup"|"edit"|"resubmit"|"sync"|"recipient"|"offset")[], variants: [{lang, pill, reason}]}`. The pill priority (as Tkana): Not set up → Paused by WhatsApp → In review → Rejected → Approved; AR is the main variant.
  - `src/screens/settings/lifecycle/lifecycleErrors.ts`.
  - Tests: `lifecycleRows.test.ts`, `lifecycleCatalog.test.ts`, `lifecycleErrors.test.ts`.
- **F2 Tab:** `src/screens/settings/LifecycleTab.tsx` in `Settings.tsx`, shown with `workflows.view`.
  - Groups: Bookings / الحجوزات, Tickets / التذاكر, Leads / العملاء المحتملون.
  - Each row: title, description, audience chip (Customer / العميل, Team / الفريق), a status pill per language, switch, "Set up", "Edit message", "Fix and resubmit", recipient select (staff rows: Assignee / المسؤول, Everyone who can see tickets / كل من يرى التذاكر, Specific members / أعضاء محددون with a member multi-select), reminder offset (1 h, 3 h, 12 h, 1 day, 2 days, 1 week), and "Sent in the last 30 days: N · Skipped: M (reasons)".
  - Header: "Sync" with "Last synced <time>" (workspace timezone) and the "WhatsApp not connected" gate (SP-13 copy) when `whatsappConnected` is false.
  - "Custom automations" opens `#/workflows?new=1&trigger=<triggerType>`; `WorkflowsPage` reads `trigger` to prefill a new user workflow.
- **F3 Edit drawer:** `src/screens/settings/lifecycle/EditLifecycleMessage.tsx` with AR and EN tabs (each tab `dir` set):
  - the body with placeholders highlighted and named (e.g. `{{1}}` = Customer name / اسم العميل);
  - a save through `PATCH /templates/:id` with the warning copy;
  - client-side checks mirroring the server: placeholders unchanged, not at the start or end, 1–1024 chars;
  - server errors shown in the drawer.
- **F4 Workflows list:** `WorkflowsPage.tsx` shows a "Managed in Automatic messages" / "تُدار من الرسائل التلقائية" badge on `systemKey` rows, hides Delete and the trigger editor for them, and links to the tab.
- **F5 Types:** `src/lib/types.ts`: `LifecycleRow`, `TemplateVariant`, `Workflow.systemKey`.
- **Permission gating** with `usePermissions().can(...)`: setup `workflows.create`; switch, recipient and offset `workflows.update`; edit/resubmit `templates.update`; sync `templates.view`. Hidden actions are not rendered; a 403 shows the shared no-permission toast.

**Produces:** the Automatic messages tab in English and Arabic (RTL).

- [ ] Write the failing vitest tests:
  - **`rejected template shows resubmit and blocks enable`**: a row with the AR variant rejected → `actions` includes `resubmit`, `switch.disabled` with the reason text in both languages, the Rejected pill with Meta's reason; after the variant is approved → the switch is enabled and there is no resubmit.
  - `row pill priority follows not set up, paused, in review, rejected, approved`.
  - `staff rows offer recipients and customer rows do not`; `reminder offset choices stay within the server bounds`.
  - `edit drawer refuses placeholder changes and edge placeholders` (pure validator).
  - `lifecycle error copy covers every SP-24 key in both languages`.
  - `catalog keys equal the backend keys` (shared fixture).
- [ ] Implement until green, then build the components.
- [ ] `npx vitest run`, `npm run typecheck` and `npm run build` clean.
- [ ] Commit `feat(lifecycle): automatic messages settings tab with template status, sync and resubmit`.

### Task 3: Verification (live, production DB, throwaway workspaces)
Apply `20261117150000_lifecycle_messages` with `npx prisma migrate deploy` (from `backend/`), only when the controller and the user explicitly approve it (ruling 14). Record the results in `.superpowers/sdd/2026-11-17-sp24-lifecycle-messages/live-verification.md`, in the format of SP-09's/SP-15's: summary, a results table with evidence, DB-side checks, findings, cleanup, pending items. If the harness refuses the write, put the tables in the scratchpad and say so; do not reroute.

**Before approval (read-only, production):**
- `SELECT count(*) FROM "Workflow"` and `SELECT reltuples FROM pg_class WHERE relname = 'Workflow'`;
- `SELECT count(*) FROM "Workflow" WHERE "triggerType" IN ('ticket_created')` (user workflows the new filter must not change);
- after apply, `SELECT count(*) FROM "Workflow" WHERE "systemKey" IS NOT NULL AND status = 'active'` must be 0 before any test (no real workspace has lifecycle messages yet; the reminder tick would otherwise touch them).

**Isolation** (no repo code changed; scripts derived from SP-09's/SP-17's in the session scratchpad `C:\Users\ashra\AppData\Local\Temp\claude\7b75a64029a712a6\ebb2057a-6300-4548-9aec-b98487880afb\scratchpad\`):
- **Own instance:** `launch-sp24.js`, derived from `launch-sp17.js`. Backend on **:4260** (pick another free port if busy and record it), compiled with `tsc -p tsconfig.build.json` into `backend/.verify-dist-sp24` (never `backend/dist`), working directory `sp24-run/`. The user's :4100 process is not touched.
- **Crons:** all `@nestjs/schedule` jobs disabled (the SP-13 `lookupSchedulers` patch). The reminder scheduler is exercised only by `sp24-tick.js`, which boots an application context against the same env and calls `LifecycleReminderScheduler.tick({now, workspaceIds: [<test workspaces>]})`. A `tick` without `workspaceIds` is never called.
- **Storage:** every `DO_SPACES_*` is an empty string.
- **No external call, ever:**
  - **Zernio:** `ZERNIO_BASE_URL=http://127.0.0.1:4261/api/v1`, `ZERNIO_API_KEY=zz-verify-stub`, pointing at `zernio-stub-sp24.js` (derived from SP-17's). It:
    - accepts template creation and records the payload;
    - serves the template list with a controllable status per name (`POST /__control/template-status {name, status, reason}`);
    - accepts template sends and records them;
    - accepts text sends for the inbound replay.
  - **l:** `L_API_URL=http://127.0.0.1:4262` (the SP-17 l stub, unused but present so nothing points at the real l).
  - **HJZ, Meta, OpenAI, Anthropic, kewy-ai:** every key and base URL an empty string (SP-19 E2: empty, not deleted).
  - **The launcher refuses to start** unless `ZERNIO_BASE_URL` and `L_API_URL` begin with `http://127.0.0.1`, `ZERNIO_API_KEY` equals `zz-verify-stub`, and every `DO_SPACES_*`, `HJZ_*`, `META_*`, `ANTHROPIC_*` and `KEWY_AI_*` value is empty.
  - The SP-13 egress guard (fetch/http/https to any non-loopback host throws and is logged to `blocked-egress-sp24.jsonl`) stays. Before cleanup the script asserts the file is empty.
- Test tag `zz-verify-<ts>` on every name and email.

**Setup** (writes only rows of throwaway workspaces; every id recorded in `verify-created-sp24.json`):
1. Register an owner and a foreign owner. Invite an admin, an agent with `assigned` visibility (custom role), and a viewer.
2. Insert a Zernio WhatsApp channel (default) and a second Zernio channel; replay signed inbound messages so that:
   - contact A has an Arabic conversation on the default number;
   - contact B has an English one;
   - contact C has a conversation on the second number;
   - contact D has `marketingOptOut = true`.
3. Create a support pipeline (SP-07) with stages open, in_progress, resolved (won, terminal), dismissed (terminal), and a leads pipeline.
4. Create a service and staff resource (SP-10) so bookings can be confirmed.
5. Record the before-counts listed under Cleanup.

**Checks:**
- **Migration:** the column, unique index and table exist (`information_schema`, `pg_indexes`); every pre-existing workflow has `systemKey IS NULL`.
- **Set up:** `POST /lifecycle/booking_confirmed/setup` → two template creations in the stub log (UTILITY, footer = the test workspace name, bodies as the catalog); a draft workflow with `systemKey`; a second call → no new stub call. Staff key setup → no stub call.
- **`rejected template shows resubmit and blocks enable` (live):** the stub marks the AR template REJECTED → `POST /lifecycle/sync` → the row shows rejected with the reason; `PATCH {enabled: true}` → 409; mark APPROVED → sync → enable works. UI: the row shows "Fix and resubmit" and the disabled switch.
- **Sends:**
  - confirm a booking for contact A → exactly one AR template send in the stub, variables in the right order with Latin digits;
  - contact B → EN;
  - contact D → no send, run result `opted_out`;
  - confirm again after a note-only edit → no second send;
  - cancel → one cancelled send.
- **Reminder:** set up and enable `booking_reminder` (offset 60 min); create a confirmed booking at now + 55 min; `sp24-tick.js` twice in parallel → exactly one send and one `LifecycleDelivery`; reschedule to now + 58 min and tick → one more send; a booking at now + 5 min with offset 60 → no send (past).
- **`toggling off disables the system workflow` (live):** switch off → `Workflow.status = 'draft'`; confirm another booking → no run, no send; a run parked by a simulated payment lock (set the test workspace's lock fields, as SP-13 did) → `cancelled` after the toggle.
- **R9:** disconnect the second channel (`DELETE /channels/:id`), confirm a booking for contact C → run result `channel_disconnected`; the stub shows no send from the default number.
- **Tickets:** enable `ticket_opened` and `ticket_resolved` and both staff keys:
  - creating a support ticket for contact A → one customer send and staff notifications to owner and admin, but not the assigned-only agent (conversation unassigned) or the viewer;
  - a leads-pipeline ticket → one `new_lead_staff` notification set;
  - resolve → one resolved send;
  - dismiss another → none.
- **Locks:** `PATCH /workflows/<system id> {triggerType}` → 409 `workflows.system_locked`; `DELETE` → 409; the foreign owner's `GET /lifecycle` sees none of the test workspace's rows, and `PATCH /workflows/<id>` → 404.
- **Roles:** agent and viewer per the `SP-24 lifecycle routes` block (403 where expected).
- **Migration rerun:** the SP-24 SQL again inside a transaction that is always rolled back: no error, 0 rows changed. If the tool safety layer refuses DDL even in a rolled-back transaction, record it and ask the user; do not reroute.
- **UI through the `verify` skill:** the Automatic messages tab in English and Arabic (RTL); pills, set up, edit drawer (AR tab RTL), sync, offset, recipients; the workflows list badge; screenshots.

**Cleanup:**
- Delete only the recorded test rows: the workspaces (the cascade covers channels, contacts, conversations, messages, templates, workflows, runs, `LifecycleDelivery`, appointments, services, staff, pipelines, tickets, notifications and roles), then the users.
- Residue sweep over every table with a `workspaceId` column, including `LifecycleDelivery`.
- Read-only counts before and after: `Workspace`, `User`, `Channel`, `Contact`, `Conversation`, `Message`, `Template`, `Workflow`, `WorkflowRun`, `LifecycleDelivery`, `Appointment`, `Service`, `StaffResource`, `Ticket`, `Notification`, `Role`, `WorkspaceMember`. Every count identical.
- Assert the egress log is empty and the stub log has no call that did not come from a test workspace.
- Stop :4260 and the stubs; remove the outDir and `sp24-run/`.

Then tick SP-24's "Detailed plan written" and "Shipped" boxes in the roadmap, noting the rulings and deviations. Add the deferred items: email to staff (D3/SP-26), per-number lifecycle templates, `Contact.lang`, reminder retries on skip, and lifecycle messages for Telegram/web chat (templates are WhatsApp-only).
