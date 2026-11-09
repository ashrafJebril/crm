# Tkana Parity Roadmap: Master Implementation Plan

> **For agentic workers:** this is a **master plan**. Each `SP-xx` sub-project below gets its own detailed TDD plan (superpowers:writing-plans → `docs/superpowers/plans/<date>-<sp-slug>.md`) before anyone writes code, and is then carried out with superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking. Do not implement straight from this file: it fixes scope, order, shared contracts and acceptance criteria, not the step-by-step code.

**Goal:** Build every user-facing capability that Tkana's web portal (`tkana-main/apps/web`) has and Aram CRM lacks, without losing the features where we are already ahead (workflows, social publishing, AI kill-switch, HJZ sync, Cmd+K, super-admin).

**Architecture:** The ~95 gaps are grouped into 31 sub-projects in 6 phases. Phase 1 lays the data foundations that later phases depend on: conversation ownership, a richer contact model, notifications, permissions and the record sheet. Each sub-project is one branch and one PR off `main`, and ships working, tested software on its own. Every schema change is additive. The shared contracts in §2 are the only interfaces sub-projects may assume of each other.

**Tech Stack:** NestJS 10 + Prisma 5 (Postgres/Neon), jest/ts-jest (backend). React 18 + Vite, hash router (`src/router.tsx`), `useFetch`/`useMutation` (`src/api/useFetch.ts`), vitest for pure frontend logic. socket.io realtime (`backend/src/realtime`). Zernio for WhatsApp/social. Stripe (already used by the ads wallet).

**Spec:** The gap analysis from the 2026-11-08 session (Tkana web portal vs Aram CRM). Tkana source of truth: `C:\Users\ashra\Downloads\tkana-main\tkana-main\apps\web\app\`. Each sub-project below names the Tkana files to read before writing its detailed plan.

## Global Constraints

- **Bilingual copy:** every user-facing string goes through `tx("English", "العربية")` with real Arabic. Layouts are RTL-safe (logical CSS properties, `dir` on dialogs).
- **Migrations:** hand-written SQL folder `backend/prisma/migrations/<yyyymmddhhmmss>_<name>/migration.sql` plus `npx prisma migrate deploy`. Never `migrate dev` (it is broken by tsvector drift). The shared Neon DB is **production**: migrations are additive and idempotent, and any backfill is a separate, rerunnable step.
- **Tenancy:** every new route is workspace-scoped through the existing `WorkspaceInterceptor`/`@CurrentWorkspace`. An id from another workspace returns **404**, never 403, so existence is not leaked.
- **Permissions:** from SP-25 on, every new mutating route declares `@RequirePermission(resource, action)` (§2.5). Routes built before SP-25 use the current `WorkspaceRolesGuard` and are migrated in SP-25.
- **Tests:** backend from `backend/`: `npx jest <path>`, full suite `npm test`. Frontend from the repo root: `npm test` (vitest, for pure logic such as `src/screens/contacts/paging.ts`) and `npm run typecheck`. UI is verified end-to-end through the `verify` skill.
- **Commits:** selective `git add <paths>`, never `-A`. Trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. One PR per sub-project, based on `main`.
- **New dependencies** are only those approved in §5 (Open decisions). Anything else needs the user's approval first.
- **Do not regress what we already do better:** workflows, social publishing/calendar, AI emergency stop and shadow mode, HJZ sync, Cmd+K search, admin impersonation, SSO bridges. Any sub-project that touches these runs their existing specs.
- **Phase 0 prerequisite:** the uncommitted contacts-pagination work on `feat/contacts-pagination` (`backend/src/contacts/*`, `src/screens/Contacts.tsx`, `src/screens/contacts/{Pager.tsx,paging.ts,paging.test.ts}`) is finished, merged and taken as the base of SP-02/SP-03.

## Review Focus

The five failure modes no single sub-project's happy-path tests cover, most likely first. Each line names the sub-project that owns the pinning test.

1. **Restricted member reads a record through a side door.** An agent whose role has `conversations.visibility = "assigned"` must not see an unassigned conversation through search (Cmd+K), the record sheet, CSV export, the copilot `@` picker, or notification deep links. Owner: SP-25, test `permission-sidedoors.e2e-spec.ts` (one case per door, each expects 404).
2. **Deleting something that is still referenced.** Deleting a custom field that has values, a stage that has cards, a service used by bookings, a member who owns open work, or a tag used by a smart audience must preview the impact and migrate or refuse; it must never orphan rows or 500. Owners: SP-02 (field), SP-07 (stage), SP-10 (service), SP-26 (member), SP-16 (tag in rule). Each adds a `delete-<thing>-with-references` spec.
3. **Large volumes.** Importing 50 000 contacts, exporting 100 000, and a campaign with 100 000 recipients must neither block the event loop nor time out: import is a background job polled by id, export streams, and recipient pages are cursor-based. Owners: SP-03 (`import-50k.spec.ts` with generated rows), SP-12 (`recipients-cursor.spec.ts`).
4. **Two people acting on the same thing at once.** Two agents assigning the same conversation, two owners saving the pipeline editor, a booking placed on a slot just taken. Last write must not silently win: a `version` check returns 409 with the current state. Owners: SP-01 (`assign-conflict.spec.ts`), SP-07 (`pipeline-draft-conflict.spec.ts`), SP-10 (`slot-race.spec.ts`).
5. **Arabic and mixed-direction data.** Arabic names in CSV import/export (UTF-8 BOM for Excel), Arabic custom-field labels, Arabic `@mentions`, and RTL in every new dialog. Owners: SP-03 (`csv-arabic-roundtrip.spec.ts`), SP-05 (`mention-parse-arabic.test.ts`).

---

## 1. Phases and order

| Phase | Sub-projects | Why in this order |
|---|---|---|
| 0 | Finish contacts pagination | Uncommitted base for SP-02/03 |
| 1 Foundations | SP-01, SP-02, SP-05, SP-25, SP-06 | Assignee, contact fields, notifications, permissions and the record sheet are used by almost everything later |
| 2 Core CRM work | SP-03, SP-04, SP-07, SP-08, SP-31 | Daily-use gaps; need the Phase 1 models |
| 3 Channels & marketing | SP-19 → SP-12, SP-13, SP-14, SP-15, SP-16, SP-17 | Multiple WhatsApp numbers (SP-19) is a prerequisite for sender choice, number tabs and number health |
| 4 Support, bookings, insights | SP-09, SP-10, SP-11 | Insights read data produced by Phases 1–3 |
| 5 AI | SP-21, SP-20, SP-18, SP-24, SP-22, SP-23 | Knowledge before sandbox/onboarding; copilot needs record refs (SP-06) and permissions (SP-25) |
| 6 Account & business | SP-26, SP-27, SP-28, SP-29, SP-30 | Independent of product features; can run in parallel with Phases 3–5 |

Sub-projects in the same phase without a dependency arrow can run in parallel. Within Phase 1, SP-25 depends on SP-01 (visibility needs `assigneeId`), and SP-06 depends on SP-25 (the record read is permission-gated).

## 2. Shared contracts (every sub-project relies on these exact names)

### 2.1 Conversation ownership (SP-01)
- `Conversation.assigneeId String?` (FK User, `onDelete: SetNull`), `Conversation.version Int @default(0)`.
- `Conversation.status` values grow to: `open | pending_customer | escalated | resolved | closed | spam`. Legacy `human` maps to `open` with `assigneeId` kept. Existing `aiEnabled`/`resolution*` are unchanged.
- `ConversationLabel {id, workspaceId, name, color}` + `ConversationLabelLink {conversationId, labelId}`.
- `PATCH /conversations/:id` body `{status?, assigneeId?, escalateReason?, pinned?, version}` → 409 `{current}` on version mismatch.

### 2.2 Contact model (SP-02)
- `Contact` gains `firstName String?`, `lastName String?`, `email String?`, `marketingOptOut Boolean @default(false)`, `notALead Boolean @default(false)`, `ownerId String?`. `name` stays as the display name, kept in sync.
- `CustomFieldDef {id, workspaceId, entity:"contact", key, label, labelAr, type:"text"|"number"|"date"|"select"|"boolean", options Json?, order, archivedAt?}`; `CustomFieldValue {defId, contactId, value Json}` with `@@unique([defId, contactId])`.
- Contact list query DTO (extends pagination): `{q, groupId, lifecycle, pipelineId, stageId, nextStep:"overdue"|"none", tag, field:{key,op,value}[], cursor, limit}`. SP-03 export and SP-16 audiences use this same filter.

### 2.3 Activities (SP-04)
- `Activity {id, workspaceId, kind:"follow_up"|"call"|"meeting"|"task"|"note_log", title, dueAt?, doneAt?, outcome?, assigneeId?, contactId?, ticketId?, bookingId?, createdById}`.
- "Next step" of a record = its earliest not-done `Activity` by `dueAt`.

### 2.4 Notifications (SP-05)
- `Notification {id, workspaceId, userId, type, title, body?, recordKind?, recordId?, readAt?, createdAt}`. Types: `assignment | mention | activity_due | connector_needs_attention | knowledge_source_failed | campaign_finished | import_finished`.
- `NotificationPreference {userId, workspaceId, type, inApp Boolean, sound Boolean}`.
- Producer API (backend): `NotificationsService.notify(userIds: string[], n: NotifyInput): Promise<void>`. It persists the notification and emits socket event `notification:new` to `user:<id>`.

### 2.5 Permissions (SP-25)
- Resources: `conversations, contacts, tickets, pipelines, bookings, campaigns, templates, audiences, knowledge, agent, channels, connectors, members, roles, billing, settings, api_keys, reports`. Actions: `view, create, update, delete, manage`.
- `Role {id, workspaceId, name, isSystem, permissions Json /* {resource: action[]} */, conversationVisibility:"all"|"assigned"}`. `WorkspaceMember.roleId` replaces the string `role`; the system roles owner/admin/agent/viewer are seeded per workspace.
- Backend: `@RequirePermission('contacts','update')` + `PermissionGuard`. Frontend: `usePermissions(): {can(resource, action): boolean}` from `GET /me/permissions`.

### 2.6 Record references (SP-06)
- `RecordKind = "contact" | "conversation" | "ticket" | "booking" | "campaign"`. URL form inside the hash: `#/<route>?record=<kind>:<id>`.
- `GET /records/:kind/:id` → `{kind, id, title, subtitle, fields, links: {kind,id,title}[]}`. It is permission-gated, and SP-18's copilot `@` refs reuse it.

### 2.7 Channels (SP-19)
- `Channel {id, workspaceId, kind:"whatsapp"|"telegram"|"webchat"|"facebook"|"instagram"|"tiktok", provider:"zernio"|"meta"|"telegram"|"native", externalId, displayName, phoneNumber?, status, health Json?, isDefault}`. It replaces the `Integration @@unique([workspaceId, platform])` limit; `Integration` rows are migrated to `Channel` rows.
- `Conversation.channelId String?`, `Campaign.senderChannelId String?`.

---

## 3. Sub-projects

Each sub-project lists: **Gaps** (what Tkana has), **Read in Tkana**, **Data**, **API**, **UI**, **Acceptance** (named tests the detailed plan must contain), **Size** (S ≤2d, M ≤1w, L ≤2w, XL >2w).

### Phase 1: Foundations

#### SP-01 Conversation ownership, status and inbox filtering. Size L
- [x] Detailed plan written (`docs/superpowers/plans/2026-11-08-sp01-conversation-ownership.md`)
- [x] Shipped on `feat/tkana-parity`; migration applied 2026-11-08. **Deviation:** filtering runs in the browser, so the acceptance tests `filters by assignee=me` and `cursor pages are stable under new inserts` are not met yet. Server cursor paging waits until FB/IG threads are stored.
- **Gaps:** assign a conversation + "Mine" filter; status actions (resolve, close, pending customer, reopen, spam, pin); escalate with a reason; conversation labels; advanced filter menu (label, channel, number*, assignee, ad source*, contact tag, lifecycle, date range, status); server-side cursor pagination; table view; conversations kanban board with drag to change status; "Needs attention" triage section; add the filtered list's customers to a group. (*number filter turns on with SP-19; ad source with SP-15.)
- **Read in Tkana:** `routes/conversations.tsx`, `conversations.$id.server.ts` (reassign, updateStatus), `lib/conversations/inbox-params.ts`, `components/conversations/{FilterBar,ListPane,TriageList,EscalationStrip,EscalateReasonDialog,LabelChips,table-columns}.tsx`, `routes/pipeline.conversations.tsx`, `routes/conversations.page.ts`.
- **Data:** §2.1.
- **API:** `GET /conversations?cursor&limit&status&assignee=me|<id>|none&labelIds&channel&tag&lifecycle&from&to&view` → `{items, nextCursor, counts}`; `PATCH /conversations/:id` (§2.1); `POST/PATCH/DELETE /conversation-labels`; `POST /conversations/:id/labels/:labelId`, `DELETE` the same; `POST /conversations/filtered/add-to-group {filter, groupId}`.
- **UI:** working Filter/Sort buttons (`Inbox.tsx:964-969`); a status/assign/escalate action bar in the thread header; label chips; a list/table/board switch (`src/screens/inbox/`); triage strip at the top of the list.
- **Acceptance:** `conversations.service.spec.ts`: `filters by assignee=me`, `cursor pages are stable under new inserts`, `assign-conflict returns 409 with current` (Review Focus 4), `foreign label id → 404`; `inbox-params.test.ts` (frontend, vitest): URL ↔ filter round-trip.

#### SP-02 Contact model: editing, custom fields, consent. Size L
- [x] Detailed plan written (`docs/superpowers/plans/2026-11-08-sp02-contact-model.md`)
- [x] Shipped on `feat/tkana-parity`; migration applied 2026-11-08. **Post-deploy step:** run `backend/scripts/normalize-lifecycle.sql` once this code is live.
- **Gaps:** first/last name, email and owner; edit details in the drawer; a "new contact" page; custom fields (text/number/date/select/boolean) with a settings page, delete preview, editing on the contact and filtering the list; marketing opt-out (blocks template/campaign sends); "not a lead" marking; delete guard when bookings/tickets are linked (force confirm); merge tags; bulk remove tag, add to pipeline, select all across pages (`getAllIds`); list filters by group, lifecycle, pipeline/stage, next step (overdue/none, active after SP-04), custom field; paginated bookings and tickets on the contact; Meta lead-form data on the contact (visible once SP-15 captures it).
- **Read in Tkana:** `routes/crm.contacts*.tsx`, `routes/settings.custom-fields.tsx`, `routes/crm.tags.tsx` (merge), `components/crm/{customer-fields-card,customer-field-filter,not-a-lead,contact-meta-leads,customer-records}.tsx`, `components/crm/contacts-list/bulk-bar.tsx`, `components/CustomerDetail.tsx`, `lib/customers/marketing-preference.ts`.
- **Data:** §2.2. Backfill `firstName/lastName` from `name` (split on the first space), rerunnable.
- **API:** `PATCH /contacts/:id`; `GET /contacts/ids?<filter>` (select-all); `DELETE /contacts/:id?force=1` → 409 `{linked:{tickets,bookings}}` without force; `GET/POST/PATCH/DELETE /custom-fields` (+ `GET /custom-fields/:id/delete-preview` → `{valueCount}`); `POST /tags/merge {fromIds, intoId}` rewriting contact tag arrays and segment rules; `POST /contacts/bulk {ids|filter, op:"removeTag"|"addToPipeline"|…}`.
- **UI:** an editable `ContactDetailDrawer.tsx`; a custom-fields settings tab; field filter chips; bulk-bar ops; opt-out toggle with a badge; delete-guard dialog.
- **Acceptance:** `delete-custom-field-with-references` (Review Focus 2); `opted-out contact is skipped by campaign send` (assert in `campaign-send.service.spec.ts`); `merge tags rewrites segment rules exactly ("VIP" ≠ "VIPER")`; `select-all ids honours filter`.

#### SP-05 Notifications and collaboration. Size M
- [x] Detailed plan written (`docs/superpowers/plans/2026-11-09-sp05-notifications-collaboration.md`)
- [x] Shipped on `feat/tkana-parity`; migration applied and live-verified 2026-11-09.
- **Gaps:** notifications stored on the server, typed and deep-linked; a bell list with mark read/all; per-type preference dialog; notes with @mentions (warning when the mentioned person can't open the record), replies and seen marks; notes inline in the conversation thread.
- **Read in Tkana:** `routes/notifications.ts`, `routes/notifications.preferences.ts`, `components/notifications/{notification-bell,alert-settings-dialog}.tsx`, `routes/collaboration.ts`, `components/collaboration/{thread-note,note-replies}.tsx`, `lib/**/mentions-seen.ts`.
- **Data:** §2.4. `Note` gains `parentId String?` and `mentions String[]`; `NoteSeen {noteId, userId, seenAt}`.
- **API:** `GET /notifications?cursor`, `POST /notifications/read {ids|all}`, `GET/PUT /notifications/preferences`; notes `POST` parses mentions → `notify(type:"mention")`; `POST /notes/:id/seen`.
- **UI:** replace the polling body of `src/shell/NotificationsBell.tsx` with server items (keep the chime and mute); a mention picker in `NotesPanel.tsx`; note bubbles in the Inbox thread.
- **Acceptance:** `mention-parse-arabic.test.ts` (Review Focus 5); `mention of member without access returns warning and does not notify`; `assignment in SP-01 emits notification` (added to SP-01's spec once SP-05 lands).

#### SP-25 Roles and permissions. Size L
- [x] Detailed plan written (`docs/superpowers/plans/2026-11-09-sp25-roles-permissions.md`)
- [x] Shipped on `feat/tkana-parity`; migration applied and live-verified 2026-11-09.
- **Gaps:** custom roles with a resource × action matrix (whole row/column toggles); conversation visibility all/assigned; per-record gating on boards, calendar and follow-ups; replace the mock Roles tab (`src/data/team-extras.ts` `PERM_MATRIX`).
- **Read in Tkana:** `routes/settings.roles.tsx`, `components/RolePermissionMatrix.tsx`, `lib/permissions/role-matrix*`, every `requirePermission`/`usePermissions` call.
- **Data:** §2.5. Migration: create 4 system roles per workspace, set `WorkspaceMember.roleId` from the `role` string, and keep `role` until a later cleanup.
- **API:** `GET/POST/PATCH/DELETE /roles`, `GET /me/permissions`, `PATCH /workspaces/:id/members/:userId {roleId}`. Migrate every existing controller from `WorkspaceRolesGuard` to `@RequirePermission`.
- **UI:** `settings/RolesTab.tsx` with the matrix; `usePermissions` hides or disables controls across screens.
- **Acceptance:** `permission-sidedoors.e2e-spec.ts` (Review Focus 1: search, record sheet, export, copilot refs, notification deep link); `system roles reproduce today's guard decisions` (a table test over every existing route); `cannot delete a role in use`.

#### SP-06 Universal record sheet. Size M
- [x] Detailed plan written (`docs/superpowers/plans/2026-11-09-sp06-record-sheet.md`)
- [x] Shipped on `feat/tkana-parity`; migration applied and live-verified 2026-11-09.
- **Gaps:** `?record=kind:id` opens one side sheet over any page; chips link to other records and swap the sheet in place; browser Back steps through them.
- **Read in Tkana:** `components/shell/{record-sheet-host,record-sheet}.tsx`, `routes/record.$kind.$id.ts`.
- **Data:** none.
- **API:** `GET /records/:kind/:id` (§2.6).
- **UI:** `src/shell/RecordSheetHost.tsx` mounted in the shell; it reads `record` from the hash query (the router already tolerates `?`, see `parseHash`). Existing `ContactDetailDrawer`/`TicketDetailDrawer` become sheet bodies.
- **Acceptance:** `record-param.test.ts` (parse/serialize, history push); `GET /records foreign id → 404`; `record read respects visibility=assigned`.

### Phase 2: Core CRM work

#### SP-03 Contacts import and export. Size L
- [x] Detailed plan written (`docs/superpowers/plans/2026-11-09-sp03-import-export.md`)
- [x] Shipped on `feat/tkana-parity`; migration applied and live-verified 2026-11-09.
- **Gaps:** CSV/XLSX import (upload → map columns including custom fields and assignee → preview new/update/unchanged/invalid → background job with progress → result screen → optional pipeline placement); CSV export of the filtered list; import a file into a new audience group (Marketing).
- **Read in Tkana:** `components/crm/contacts-import/*`, `routes/crm.contacts.imports.$id.ts`, `routes/crm.contacts.export.ts`, `routes/marketing.tsx` (`importAndCreateGroup`).
- **Data:** `ImportJob {id, workspaceId, kind:"contacts"|"audience"|"catalog", status, total, processed, created, updated, failed, errors Json, mapping Json, options Json, fileMediaId, createdById}`.
- **API:** `POST /imports` (multipart) → `{id, columns, sampleRows}`; `POST /imports/:id/preview {mapping}` → counts + invalid rows; `POST /imports/:id/run`; `GET /imports/:id`; `GET /contacts/export?<filter>` streams `text/csv` with a UTF-8 BOM. The job runs in batches of 500 on a DB-backed queue (a poller like `WorkflowRun`), so a restart resumes it. Matching key: phone (E.164), then email.
- **UI:** a `ContactsImportWizard` with 4 steps; an export button that respects the current filter; Marketing › Audiences "Import file".
- **Acceptance:** `import-50k.spec.ts` (Review Focus 3); `csv-arabic-roundtrip.spec.ts` (Review Focus 5); `phone normalization merges +971/00971/05x`; `resume after crash continues from processed`.

#### SP-04 Activities and follow-ups. Size L
- [x] Detailed plan written (`docs/superpowers/plans/2026-11-09-sp04-activities-followups.md`)
- [x] Shipped on `feat/tkana-parity`; migration applied and live-verified 2026-11-09.
- **Gaps:** contact activity timeline (logged calls/meetings, scheduled follow-ups, outcome, complete); a follow-ups queue (Mine/Team, Overdue/Today/Upcoming with counts, filters by person/type/pipeline, done/reassign/reschedule singly or in bulk); a "next step" chip/column on contacts and cards; assign work from a card.
- **Read in Tkana:** `routes/sales.follow-ups*.ts(x)`, `components/follow-ups/*`, `components/pipeline/customers/{assign-work-dialog,next-step-chip}.tsx`, `components/collaboration/*` (timeline).
- **Data:** §2.3. The timeline merges `Activity`, `Note`, `TicketActivity` and messages by `createdAt`.
- **API:** `GET/POST/PATCH /activities`, `POST /activities/bulk {ids, op:"done"|"reassign"|"reschedule", …}`, `GET /activities/queue?scope=mine|team&bucket` → `{overdue, today, upcoming, counts}`, `GET /contacts/:id/timeline?cursor`. A scheduler emits `activity_due` notifications (SP-05).
- **UI:** a `Follow-ups` screen (new `RouteId` `followups`); a timeline in the contact drawer/sheet; a next-step chip.
- **Acceptance:** `bucketing uses workspace timezone` (dueAt 23:30 local is "today"); `bulk reschedule only touches permitted rows`; `due notification fires once`.

#### SP-07 Pipeline and stage editor. Size M
- [x] Detailed plan written (`docs/superpowers/plans/2026-11-10-sp07-pipeline-editor.md`)
- [x] Shipped on `feat/tkana-parity`; migration applied and live-verified 2026-11-09. **Post-deploy:** re-run the lost-reasons backfill.
- **Gaps:** create/rename/archive pipelines; add/reorder/recolour/remove stages with a move-cards-to target; one draft save with a conflict check; a bilingual lost-reasons catalog per pipeline; a stale-card threshold (amber after N days); flags `agentCanMove`, `assignsConversations`, "not a lead" definition.
- **Read in Tkana:** `routes/settings.pipelines.tsx`, `lib/pipeline/stage-draft.ts`, `components/pipeline/customers/lost-reasons-editor.tsx`.
- **Data:** `Pipeline` + `archivedAt`, `version`, `staleDays Int?`, `agentCanMove Boolean`, `assignsConversations Boolean`, `kind:"deals"|"leads"|"support"`; `LostReason {pipelineId, label, labelAr, order, archivedAt}`; `Ticket.lostReasonId`.
- **API:** `PUT /pipelines/:id/draft {version, name, stages:[{id?,key,label,labelAr,color,order,slaMinutes,isWon,isTerminal}], removed:[{stageId, moveTo}], lostReasons}` → 409 on version; `POST /pipelines`; `POST /pipelines/:id/archive`.
- **UI:** `settings/PipelinesTab.tsx`; `LostReasonModal.tsx` reads the catalog instead of the hardcoded `REASONS`.
- **Acceptance:** `pipeline-draft-conflict.spec.ts` (Review Focus 4); `delete-stage-with-references moves cards and logs TicketActivity` (Review Focus 2); `cannot remove the last won stage`.

#### SP-08 Board upgrades and lead pipeline. Size M
- [x] Detailed plan written (`docs/superpowers/plans/2026-11-10-sp08-board-upgrades.md`)
- [x] Shipped on `feat/tkana-parity`; migration applied and live-verified 2026-11-09.
- **Gaps:** a sortable, paged table view for every board; date range, customer and assignee filters; bulk assign/lost/not-a-lead; a lead pipeline (one card per person tied to the contact lifecycle; won/lost from the card menu; dropping onto a lost stage asks why; reopen lost; not-a-lead); bulk add to a pipeline from Contacts; stale cards turn amber.
- **Read in Tkana:** `routes/pipeline.customers.tsx`, `components/pipeline/{table,date-filter,customer-filter}.tsx`, `components/pipeline/customers/*`, `components/crm/bulk-add-to-pipeline-dialog.tsx`.
- **Depends on:** SP-02 (`notALead`), SP-07 (`kind`, `staleDays`).
- **API:** `GET /tickets?pipelineId&view=table&sort&cursor&from&to&contactId&ownerId`; `POST /tickets/bulk`; `POST /tickets/:id/reopen`. A lead stage change updates `Contact.lifecycle` through one mapping table on the pipeline.
- **UI:** `src/screens/pipeline/PipelineTable.tsx`, filter controls in `PipelineHeader.tsx`.
- **Acceptance:** `lead won sets contact lifecycle customer`; `reopen restores previous stage`; `one open lead card per contact per pipeline`.

#### SP-31 Inbox thread enrichments. Size L
- [x] Detailed plan written (`docs/superpowers/plans/2026-11-10-sp31-inbox-enrichments.md`)
- [x] Shipped on `feat/tkana-parity`; migration applied and live-verified 2026-11-09. The Zernio reaction payload is still unverified live.
- **Gaps:** one customer thread across channels/conversations (segment seams, lazy older segments, handoff markers); in-thread events (stage moves, ticket/booking events) with undo for a stage move; customer reactions on messages; template picker with header image (upload or library) and preview; AI summary popover, topics/pain points card, summary translation; linked tickets/bookings card; saved replies (neither app has these; they replace the 3 hardcoded chips at `Inbox.tsx:1510`).
- **Read in Tkana:** `routes/conversations.customer.$id.stream.ts`, `conversations.segment.$id.ts`, `components/conversations/{SegmentSeam,HandoffSeamMarker,ThreadEvent,reactions,SummaryStrip,TopicsCard,LinkedItemsCard,ThreadPane}.tsx`, `routes/conversations.$id.templates.ts`.
- **Data:** `Message.reaction String?`, `Message.kind:"message"|"event"`, `Message.event Json?`; `Conversation.topics Json?`, `painPoints Json?`; `SavedReply {workspaceId, title, body, bodyAr?, shortcut}`.
- **API:** `GET /contacts/:id/thread?before=<cursor>` (segments); `POST /tickets/:id/undo-stage`; `POST /conversations/:id/summary/translate {lang}`; `/saved-replies` CRUD.
- **Acceptance:** `thread stitches 3 conversations in order across channels`; `undo only the latest stage move within 10 min`; `reaction webhook updates target message`.

### Phase 3: Channels and marketing

#### SP-19 Channels hub and multiple numbers. Size XL
- [x] Detailed plan written (`docs/superpowers/plans/2026-11-11-sp19-channels.md`)
- [x] Shipped on `feat/tkana-parity`; migration applied and live-verified 2026-11-09. Live checks covered webchat, limits and signup config. Telegram, Meta signup/landline and Zernio sync still need live provider checks. **Before release:** set TOKEN_ENC_KEY and PUBLIC_BASE_URL on Fly, and supply the Meta config for embedded signup.
- **Gaps:** one channels hub (list, add, detail, status badges); several WhatsApp numbers per workspace (inbox number tabs + filter); one-click WhatsApp signup through Meta, with landline verification and number-limit handling; website chat widget (embed snippet) + hosted chat page link; Telegram channel.
- **Read in Tkana:** `routes/channels*.tsx`, `components/channels/{use-embedded-signup,landline-verification-card,widget-snippet-dialog,chat-page-link}.tsx`, `apps/chat-widget/` (widget runtime), `channels.new.tsx` (`provisionTelegramChannel`).
- **Data:** §2.7, with a migration from `Integration`.
- **API:** `GET/POST/PATCH/DELETE /channels`; `POST /channels/whatsapp/embedded-signup {code}`; `POST /channels/telegram {botToken}` + webhook `/webhooks/telegram/:channelId`; widget: public `GET /widget/:channelId/config`, `POST /widget/:channelId/messages`, socket room per visitor; `public/widget.js` loader.
- **UI:** `src/screens/channels/` (new `RouteId` `channels`), replacing the channel cards in `IntegrationsTab.tsx`/`ZernioCard.tsx`; number tabs in the Inbox.
- **Acceptance:** `migration maps each Integration to one Channel`; `inbound on number B lands in B's conversations`; `widget rejects foreign origin`; `telegram webhook secret validated`.

#### SP-12 Campaign recipients and reporting. Size L
- [x] Detailed plan written (`docs/superpowers/plans/2026-11-12-sp12-campaign-recipients.md`)
- [x] Shipped on `feat/tkana-parity`; migration applied and live-verified 2026-11-09 against a local Zernio stub. **Pending:** a read-only probe of the real Zernio recipients endpoint (paging, id scheme), plus a re-run of EXPLAIN once real tracked campaigns exist.
- **Gaps:** a detail page per campaign; a per-recipient table (status, delivered/read/replied times, reply text, button tapped, failure reason, sending number) with an outcome filter and paging; recipient CSV export (all/filter/ticked); funnel; read-time chart; failure-reason breakdown; reply summary; follow-up actions (create group / add to group / tag from an outcome or ticked rows); filling `replied`/`conversions`.
- **Read in Tkana:** `routes/marketing.campaigns.$id*.ts(x)`, `components/marketing/campaign-page/*`, `lib/marketing/{campaign-details.server,campaign-insights,campaign-failure-reason}.ts`.
- **Data:** `CampaignRecipient {id, campaignId, contactId, channelId, phone, status:"queued"|"sent"|"delivered"|"read"|"replied"|"failed"|"skipped", messageId?, sentAt?, deliveredAt?, readAt?, repliedAt?, replyText?, buttonPayload?, failureCode?, failureReason?}` with an index on `(campaignId, status)`.
- **API:** the send pipeline (`campaign-send.service.ts`) writes recipients; delivery webhooks update them by `messageId`; an inbound message within 72h of `sentAt` marks `replied`. `GET /campaigns/:id/recipients?status&cursor`, `GET /campaigns/:id/insights`, `GET /campaigns/:id/export?status|ids` (stream), `POST /campaigns/:id/follow-up {outcome|ids, action:"createGroup"|"addToGroup"|"tag", …}`.
- **UI:** `src/screens/campaigns/CampaignDetail.tsx` (new hash route `campaigns?id=`).
- **Acceptance:** `recipients-cursor.spec.ts` (Review Focus 3); `delivery webhook out of order (read before delivered) keeps both timestamps`; `reply attribution window 72h`.

#### SP-13 Campaign sending options and media picker. Size M
- [ ] Detailed plan written
- [ ] Shipped
- **Gaps:** "Send from" number picker with a per-number split in preview and report; template variables mapped to any contact/custom field with fallbacks; clear "WhatsApp not connected" gating (AR/EN) on marketing actions; a media library picker in the template editor and campaign header; a Gallery tab.
- **Depends on:** SP-19, SP-02.
- **Read in Tkana:** `components/marketing/{CampaignSenders,CustomerFieldFallbacks,MediaLibrary}.tsx`, `lib/marketing/{campaign-senders,campaign-custom-fields,samples}.ts`, `routes/media.library.ts`.
- **API:** `Campaign.senderChannelIds String[]`, `Campaign.varMap Json {n: {source:"field"|"custom"|"static", key, fallback}}`; error code `WHATSAPP_NOT_CONNECTED`.
- **Acceptance:** `missing field uses fallback, missing fallback skips recipient with reason`; `split sends round-robin across senders`.

#### SP-14 Number and template health. Size M
- [ ] Detailed plan written
- [ ] Shipped
- **Gaps:** a number health page (quality rating, messaging-limit tier, display-name status, verification, blocked/template problems) with a live check; template PAUSED/quality status and a health sheet.
- **Depends on:** SP-19.
- **Read in Tkana:** `routes/marketing.health*.ts(x)`, `components/marketing/{number-health-page,whatsapp-health-*,whatsapp-template-health}.tsx`, `lib/channels/waba-health.ts`.
- **Data:** `Channel.health Json` (`{quality, tier, nameStatus, verified, checkedAt, issues[]}`); `Template.quality String?`, `Template.status` adds `PAUSED|DISABLED`.
- **API:** `POST /channels/:id/health/check` (live call through the provider; a provider that can't supply a field returns `unknown`, never fake data); a daily sweep; `connector_needs_attention` notification on a downgrade.
- **Acceptance:** `quality drop emits one notification`; `unknown fields render as unknown`.

#### SP-15 Click-to-WhatsApp ad attribution and Meta Ads connect. Size L
- [ ] Detailed plan written
- [ ] Shipped
- **Gaps:** capture the ad referral on the first inbound message; an ads tab (conversations started, spend, cost per conversation, daily chart, date range); a per-ad page linking to its conversations; an attribution chip + ad-source filter in the inbox; Meta lead-form data on the contact; a Meta Ads account connect (OAuth, choose ad account/page, check, disconnect). The existing Salma/Pipeboard ads backend stays and gains a UI here.
- **Read in Tkana:** `routes/marketing.ads*.tsx`, `routes/marketing.meta-ads.tsx`, `components/marketing/{ctwa-ads-tab,ctwa-ad-page,meta-ads-connect}.tsx`, `lib/marketing/ctwa-ads*.ts`, `components/conversations/CtwaAttribution.tsx`.
- **Data:** `AdSource {id, workspaceId, sourceId, sourceType, headline, body, mediaUrl, adAccountId?}`, `Conversation.adSourceId`, `AdSpendDaily {adSourceId, date, spend, currency}`, `MetaAdsConnection {workspaceId, tokenEnc, adAccountId, pageId}`.
- **Acceptance:** `referral captured only on first inbound`; `cost per conversation = spend / started (0 started → null)`; `token stored encrypted (token-crypto.ts)`.

#### SP-16 Smart audiences. Size M
- [ ] Detailed plan written
- [ ] Shipped
- **Gaps:** rule conditions on last active, conversation count, channel, membership of another group, created date (relative/absolute), lifecycle, not-a-lead, pipeline stage, custom fields, combined with AND/OR; an audience detail page with candidate search; import a file into an audience (through SP-03).
- **Read in Tkana:** `routes/marketing.audiences*.tsx` (`createSmartGroup`, `previewSmartGroup`).
- **Data:** the `SegmentFilter` in `backend/src/segments/segments.service.ts` becomes `{op:"and"|"or", rules:(Rule|Group)[]}`; existing filters are read as an `and` group (backward-compatible).
- **Acceptance:** `legacy filter JSON evaluates identically`; `cyclic group membership rule rejected`; `delete-tag-in-rule warns with affected audiences` (Review Focus 2).

#### SP-17 Media details for the AI agent. Size S
- [ ] Detailed plan written
- [ ] Shipped
- **Gaps:** title, alt text, tags, "use when", approved/hidden switch and search on media; a "Photos" tab in agent knowledge; the agent can send approved photos.
- **Read in Tkana:** `routes/media.tsx:141-170`, `routes/knowledge.tsx` (photos).
- **Data:** `Media` + `title, alt, tags String[], useWhen, approvedForAgent Boolean @default(false)`.
- **API:** `PATCH /media/:id`, `GET /media?q&approved`; the agent tool `list_photos` returns only approved media.
- **Acceptance:** `agent tool never returns unapproved media`.

### Phase 4: Support, bookings and insights

#### SP-09 Support tickets. Size M
- [ ] Detailed plan written
- [ ] Shipped
- **Gaps:** priority, category, channel, request number, SLA due date with overdue display; ticket attachments (customer and staff files, served through gated routes); resolve/comment actions; booking-request cards on a ticket.
- **Read in Tkana:** `routes/pipeline.tickets.tsx`, `components/tickets/{tickets-page,ticket-attachments,booking-request-card}.tsx`, `routes/media.ticket*.ts`.
- **Data:** `Ticket` + `priority:"low"|"normal"|"high"|"urgent"`, `category String?`, `slaDueAt DateTime?` (computed from `TicketStage.slaMinutes` on stage entry); `TicketAttachment {ticketId, mediaId, source:"customer"|"staff"}`.
- **API:** `GET /tickets/:id/attachments/:attId` checks `tickets.view` and redirects to a signed URL.
- **Acceptance:** `slaDueAt recalculated on stage change`; `attachment route 404 for foreign workspace`; `overdue badge when now > slaDueAt and not terminal` (vitest).

#### SP-10 Bookings: services, staff, availability, board. Size XL
- [ ] Detailed plan written
- [ ] Shipped
- **Gaps:** a services catalog (colour, duration, price, providers, active); staff resources (role, weekly working schedule, services, active; cards/table, search); a schedule-fit gate plus slot availability; a bookings kanban with allowed transitions (pending → confirmed → completed / no-show / cancelled); agenda view with daily minutes; reschedule dialog; service filter; booking search typeahead; view/date in the URL; a catalog import wizard (paste / website URL / file → AI extraction → review with duplicates unchecked → resumable run, per-kind .xlsx templates).
- **Read in Tkana:** `routes/booking.*.ts(x)`, `routes/pipeline.bookings.tsx`, `components/booking/{resources-tab,services-tab,import-dialog,catalog-import,agenda-view,service-filter}.tsx`, `components/weekly-schedule-editor.tsx`, `lib/bookings/schedule-fit.ts`, `components/pipeline/bookings/stages.ts`.
- **Data:** `Service {name, nameAr, color, durationMin, price?, currency, active}`, `StaffResource {userId?, name, role, schedule Json /* {mon:[{from,to}]} */, active}`, `StaffService` join; `Appointment` + `serviceId?`, `resourceId?`, `status` with a transition table; the free-text `service` is kept for legacy rows and HJZ.
- **API:** CRUD for `/services` and `/staff`; `GET /bookings/availability?serviceId&resourceId&date` → slots; `POST /appointments` validates fit and overlap inside a transaction (409 `SLOT_TAKEN`); `POST /imports` with `kind:"catalog"` (reuses SP-03 `ImportJob`).
- **HJZ:** appointments synced from HJZ bypass the fit gate but still show conflicts. Regression: `hjz-sync` specs.
- **Acceptance:** `slot-race.spec.ts` (Review Focus 4); `schedule-fit rejects outside hours in workspace TZ`; `delete-service-with-references archives instead` (Review Focus 2); `illegal transition completed→pending rejected`.

#### SP-11 Insights, working home, module settings. Size L
- [ ] Detailed plan written
- [ ] Shipped
- **Gaps:** support insights (AI resolution rate, median first response, median handling time, time saved, share turned into tickets, resolution-mix donut, hour-of-day peaks, by WhatsApp number, topic friction, "ask" box, Team tab per agent); sales insights (leads, replied, speed to reply, waiting, won, weekly trend, lead sources, speed distribution, stage funnel, lost reasons, Reps table with follow-up totals); a working home ("needs a person": waiting conversations, late follow-ups, unassigned tickets; Today/Tomorrow; "what the agent did while you were away"; a one-time Day-1 home); a per-module settings hub; fix the hardcoded "Yara" greeting (`Dashboard.tsx:237`).
- **Depends on:** SP-01, SP-04, SP-07, SP-12.
- **Read in Tkana:** `routes/{customer-service.insights,sales.insights,home,module-settings}.tsx`, `components/analytics/{support-analytics,support-team}.tsx`, `components/sales-insights/*`, `components/home/{working-home,power-up-home}.tsx`.
- **API:** `GET /insights/support?from&to&channelId`, `GET /insights/sales?from&to&pipelineId`, `GET /home`. Metrics are defined in the detailed plan as SQL with fixture tests. The "ask" box sends the metrics JSON to the copilot (SP-18), or is hidden until SP-18 ships.
- **Acceptance:** one fixture test per metric (`median first response excludes AI-only replies`, etc.); `home lists only permitted records`.

### Phase 5: AI

#### SP-21 Knowledge upgrade. Size L
- [ ] Detailed plan written
- [ ] Shipped
- **Gaps:** a rich-text business content editor; a dedicated FAQ editor; guidelines (extra instructions); uploads of PDF/XLSX/CSV/ODS/images with processing status and a "what your assistant learned" preview; typed spreadsheet documents with downloadable .xlsx templates (offers, inventory, packages); website crawl sources (whole site or a path; daily/weekly/monthly/manual; per-page state synced / needs login / blocked).
- **Read in Tkana:** `routes/knowledge*.ts(x)`, `components/knowledge/{KnowledgeContentEditor,KnowledgeDocumentsPanel,document-preview,website-sources}.tsx`, `lib/website-sources.ts`, `lib/knowledge-documents.template.server.ts`.
- **Data:** `KnowledgeSource {kind:"content"|"faq"|"guideline"|"file"|"typed_doc"|"website", status, error?, schedule?, lastSyncAt}`, `KnowledgePage {sourceId, url, state, contentHash}`; the existing knowledge docs migrate in. HJZ-synced knowledge and the emergency stop are untouched.
- **Acceptance:** `crawler respects robots.txt and same-origin`; `failed source emits knowledge_source_failed`; `typed doc rejects wrong template columns with row errors`.

#### SP-20 Agent configuration, sandbox and onboarding. Size L
- [ ] Detailed plan written
- [ ] Shipped
- **Gaps:** agent name EN/AR, greeting, tone; working-hours mode (always / within hours / outside hours) with a weekly schedule; customer tags excluded from auto-replies; a "Try your agent" sandbox (writes sandboxed, tool-call lines, "Answered from" sources); conversational onboarding (business name → setup chat that reads the website → "What I learned" card; skip/resume) plus a standalone signup page.
- **Depends on:** SP-21 (website ingest).
- **Read in Tkana:** `routes/{settings.agent,try-agent,setup,setup.business,setup.try,signup}.tsx`, `components/{try-agent,setup}/*`, `aida-learn-card.tsx`.
- **Data:** `AgentSettings` (extends the existing ai-settings row) + `nameEn, nameAr, greeting, tone, hoursMode, schedule Json, excludedTags String[]`; `Workspace.onboardingState Json`.
- **API:** extend `PatchSettingsDto` (`backend/src/knowledge/ai-settings.controller.ts`); `POST /agent/sandbox/messages` (never creates Contact/Conversation; tools run in dry-run mode); `/onboarding/*`.
- **Acceptance:** `sandbox creates no contacts/conversations/tickets`; `excluded tag blocks auto-reply but not human send`; `outside-hours mode replies only outside schedule (workspace TZ)`; `kill-switch still overrides hours mode`.

#### SP-18 In-app copilot ("Aida"-style). Size XL
- [ ] Detailed plan written
- [ ] Shipped
- **Gaps:** a chat drawer that streams answers; history (resume, plus a page of all chats); `@` references to tickets/bookings/customers (max 5); confirmation cards before any write (approve, or decline with a note; permissions re-checked at approval) and an approval-mode picker (Manual / Agent decides / Auto); file and image attachments (text extracted; saving needs approval); starter prompts per page; source cards under answers.
- **Depends on:** SP-06 (record refs), SP-25 (permissions), SP-05 (optional notify).
- **Read in Tkana:** `routes/copilot.*.ts`, `routes/aida.tsx`, `components/copilot/*` (`AidaDrawer`, `use-aida-chat`, `aida-confirm-card`, `approval-mode-select`, `aida-mention-pill`, `aida-sources`, `aida-starters`), `apps/copilot/` (server tools).
- **Build on:** the ads chat backend (`backend/src/ads/`: streaming `POST ads/chat`, sessions, `AdsPendingAction` approve/reject). Generalise it into `CopilotSession/CopilotMessage/CopilotPendingAction` with a tool registry. Salma becomes one persona with its tool set, and existing ads tables keep working. Use `postStream` in `src/api/client.ts`.
- **Tools (first set):** search/read contacts, conversations, tickets, bookings, campaigns; create activity; move ticket stage; draft reply; summarize insights. Every write tool goes through a pending action.
- **Acceptance:** `write tool never executes without approval in Manual mode`; `approval re-checks permission (role changed mid-turn → refused)`; `@ref of record without access → refused` (Review Focus 1); `history scoped to the member`.

#### SP-24 Lifecycle messages. Size M
- [ ] Detailed plan written
- [ ] Shipped
- **Gaps:** one settings page for every automatic customer/staff message (booking confirmed/reminder/cancelled, ticket opened/resolved, new lead): on/off, edit, recipient, template status (approved/in review/rejected/paused) with sync/resubmit, AR/EN versions, custom automations.
- **Read in Tkana:** `routes/settings.notifications.tsx`.
- **Approach:** each lifecycle message is a **system workflow** (existing `backend/src/workflows`) with a locked trigger and a template step, so there is no second automation engine. The page is a focused view over those workflows.
- **Acceptance:** `toggling off disables the system workflow`; `rejected template shows resubmit and blocks enable`.

#### SP-22 Skills gallery. Size L (platform-dependent)
- [ ] Detailed plan written
- [ ] Shipped
- **Gaps:** install, update, enable/disable skills; a config form; a "connect X first" prerequisite; which agents use each skill; usage stats.
- **Read in Tkana:** `routes/skills*.tsx`, `components/skills/*`.
- **Approach:** a skill = a versioned bundle of {instructions, tools (existing custom HTTP tools `kewy-agent/ToolsTab.tsx` / MCP servers), required connector, config schema}. **Open decision D6:** this needs the Kewy/l agent platform to accept skill bundles; check before writing the detailed plan.
- **Acceptance:** `install with missing connector stays disabled`; `update preserves config`.

#### SP-23 Connectors gallery. Size L
- [ ] Detailed plan written
- [ ] Shipped
- **Gaps:** OAuth connectors (HubSpot, Pipedrive, Salla, Foodics, Calendly) with read/write switches per tool, re-scan, a recent-activity card, contact/booking sync cards, an agent picker, and custom connectors.
- **Read in Tkana:** `routes/connectors*.tsx`, `components/connectors/*`, `apps/mcp/`.
- **Approach:** extend `kewy-agent/McpServersTab.tsx` and the MCP server binding with `Connector {provider, authKind:"oauth"|"headers", tokenEnc, tools Json /* {name, access:"off"|"read"|"write"} */}`, plus a `ConnectorCall` audit log. One provider per sub-task in the detailed plan; Calendly and HubSpot first.
- **Acceptance:** `tool switched off is not exposed to agent`; `refresh token rotation`; `connector auth failure → connector_needs_attention`.

### Phase 6: Account and business

#### SP-26 Members, invites, handover, security. Size L
- [ ] Detailed plan written
- [ ] Shipped
- **Gaps:** email invitations (token, role travels with it) with pending/active filter, revoke, and an accept page; hand over open work when removing a member (preview + reassign); a page for users with no workspace; activation links by workspace slug; a team activity (audit) log; forgot/reset password; 2FA (TOTP); replace the mock Pending/Activity/2FA parts of `Team.tsx`.
- **Read in Tkana:** `routes/settings.members*.ts(x)`, `components/settings/member-handover-dialog.tsx`, `routes/{accept-invite,select-org,org.activate}.ts(x)`.
- **Data:** `Invitation {email, roleId, tokenHash, expiresAt, acceptedAt?, revokedAt?}`, `AuditLog {actorId, action, target, meta, createdAt}`, `User.totpSecretEnc?`, `PasswordReset {userId, tokenHash, expiresAt}`, `Workspace.slug @unique`.
- **API:** `GET /workspaces/:id/members/:userId/open-work` → counts by kind; `DELETE …/members/:userId {handoverTo}` reassigns tickets, conversations, activities and leads in one transaction.
- **Acceptance:** `delete-member-with-references requires handoverTo when open work > 0` (Review Focus 2); `invite token single-use and expires`; `reset token hashed and single-use`; `2FA required at login once enabled`. Admin-sets-password (ours) stays.

#### SP-27 API keys, webhooks and AI-tool access. Size M
- [ ] Detailed plan written
- [ ] Shipped
- **Gaps:** organization API keys with scopes (resource × read/write/delete/admin) and expiry; outgoing webhook endpoints; an API docs link; per-member OAuth access for AI tools (owner enables it, shares the address, can block a member; members disconnect their own tools; branded consent screen).
- **Read in Tkana:** `routes/settings.api-keys.tsx`, `lib/api-key-scopes.ts`, `components/settings/webhooks-section.tsx`, `routes/{settings.ai-tools,oauth-consent}.tsx`.
- **Data:** `ApiKey {name, prefix, hash, scopes Json, expiresAt?, lastUsedAt?, revokedAt?}`, `WebhookEndpoint {url, events String[], secretEnc, active}`, `WebhookDelivery {endpointId, event, status, attempts, responseCode}`, `OAuthGrant {userId, clientId, scopes, revokedAt?}`.
- **Approach:** API keys map onto the SP-25 permission model. Outgoing webhooks reuse the workflow-webhook signing code. MCP OAuth extends `backend/src/mcp-server` (the current single token `McpAccessCard.tsx` stays as "legacy token" until it is retired).
- **Acceptance:** `key without contacts.write gets 403 on POST /contacts`; `webhook retried with backoff and signed`; `blocked member's OAuth token rejected`.

#### SP-28 Billing portal. Size XL
- [ ] Detailed plan written
- [ ] Shipped
- **Gaps:** plans and add-ons with monthly/annual cycles; a prepaid wallet with top-up and embedded checkout; usage metering with a panel and drawer; payment method management; tax invoices with PDF; trial reminder and renewal-grace banners; live credit status; "not in plan" feature gating.
- **Read in Tkana:** `routes/settings.billing.*.tsx`, `routes/billing.*.tsx`, `routes/api.credit-status.ts`, `components/billing/*`, `apps/billing/`.
- **Approach:** Stripe Billing (already integrated for `AdsWallet`; reuse its customer and webhook code). One `Wallet` generalises `AdsWallet` (ads becomes one usage meter). `Subscription {planKey, cycle, status, currentPeriodEnd, addOns}`; `UsageEvent {meter, qty, at}`; the plan catalogue is in code. Invoices come from Stripe; PDF provider per **D4**. The existing payment lock (`backend/src/billing/payment-lock.ts`) is driven by the subscription status. Super-admin plan overrides in `Admin.tsx` remain.
- **Acceptance:** `webhook idempotent on replay`; `feature gated by plan returns 402 PLAN_REQUIRED and UI shows upgrade`; `wallet never goes negative under concurrent debits`.

#### SP-29 Organization branding. Size S
- [ ] Detailed plan written
- [ ] Shipped
- **Gaps:** business logo, brand colours and a sticky save bar in General settings.
- **Read in Tkana:** `routes/settings.general.tsx`.
- **Data:** `Workspace.logoMediaId?`, `brandColor?`. They are applied in the shell header, the hosted chat page (SP-19) and emails (SP-26).
- **Acceptance:** `logo upload validates type/size`; `save bar appears only when dirty` (vitest).

#### SP-30 Platform UX: responsive, i18n, public site. Size XL
- [ ] Detailed plan written
- [ ] Shipped
- **Gaps:** a responsive shell (collapsible sidebar, breakpoints) and phone-usable screens (today `src/styles` has no `@media` rules); language in the URL; locale files instead of inline strings; a public marketing website.
- **Read in Tkana:** `components/shell/use-shell-sidebar.ts`, `components/ui/sidebar.tsx`, `i18n/locales/`, `routes/{lang-redirect,website}.tsx`, `components/website/`.
- **Approach:** the responsive work is done screen by screen (Inbox, Contacts, Pipeline and Calendar first) with a shared breakpoint token set in `src/styles`. Language-in-URL and locale-file extraction follow **D5**. The public site follows **D7**.
- **Acceptance:** each screen is verified at 390px width through the `verify` skill with no horizontal scroll.

---

## 4. Coverage check (every gap → sub-project)

| Area | Gaps | Sub-projects |
|---|---|---|
| Inbox | assign/Mine, status actions, escalate reason, labels, filters, table, board, triage, paging, add-to-group | SP-01 |
| Inbox | stitched thread, events/undo, reactions, template header/preview, AI summary/topics/translate, linked items, saved replies | SP-31 |
| Inbox | notes @mentions/replies/seen inline | SP-05 |
| Inbox | number tabs, CTWA chip/filter | SP-19, SP-15 |
| Contacts | edit, email, custom fields, opt-out, not-a-lead, delete guard, merge tags, bulk ops, filters, paged records | SP-02 |
| Contacts | import/export | SP-03 |
| Contacts | timeline, follow-ups, next step | SP-04 |
| Sales | pipeline editor, lost reasons, stale, flags | SP-07 |
| Sales | lead pipeline, table, filters, bulk, bulk-add from contacts | SP-08 |
| Support | priority/category/SLA/attachments/booking cards | SP-09 |
| Bookings | services, staff, schedule fit, board, agenda, reschedule, filter, search, URL state, catalog import | SP-10 |
| Insights | support, sales, working home, module settings, greeting fix | SP-11 |
| Shell | record sheet | SP-06 |
| Marketing | campaign detail, recipients, CSV, funnel, follow-ups | SP-12 |
| Marketing | sender picker, field fallbacks, not-connected gating, gallery/picker | SP-13 |
| Marketing | number + template health | SP-14 |
| Marketing | CTWA ads, Meta Ads connect, lead-form data | SP-15 |
| Marketing | smart audience rules, detail page, file import | SP-16, SP-03 |
| Marketing | media metadata for agent | SP-17 |
| AI | copilot (all 6 items) | SP-18 |
| AI | onboarding, sandbox, agent config, signup | SP-20 |
| AI | knowledge (6 items) | SP-21 |
| AI | skills | SP-22 |
| AI | connectors | SP-23 |
| AI | lifecycle messages | SP-24 |
| Channels | hub, multi-number, embedded signup, widget, Telegram | SP-19 |
| Account | roles/permissions, per-record gating | SP-25 |
| Account | invites, handover, select/activate workspace, audit log, reset, 2FA | SP-26 |
| Account | API keys, webhooks, AI-tool OAuth | SP-27 |
| Account | billing (all) | SP-28 |
| Account | branding | SP-29 |
| Platform | responsive, i18n/URL, public site | SP-30 |

## 5. Open decisions (needed before the affected sub-project's detailed plan)

| ID | Decision | Affects | Suggested default |
|---|---|---|---|
| D1 | Spreadsheet parsing dependency (XLSX/ODS) | SP-03, SP-10, SP-21 | `exceljs` (read + write templates) |
| D2 | Rich-text editor dependency | SP-21 | TipTap (same as Tkana) |
| D3 | Transactional email provider for invites/reset/notifications | SP-26, SP-05 | Resend or SES |
| D4 | Tax invoice provider (UAE/KSA e-invoicing) | SP-28 | Stripe invoices first; Wafeq later if required |
| D5 | Move to locale files + `/:lang` in the URL, or keep inline `tx()` | SP-30 | Keep `tx()`; add `?lang=` only |
| D6 | Does the Kewy/l agent platform support skill bundles? | SP-22 | Confirm with platform owner |
| D7 | Is the public marketing website in scope for this repo? | SP-30 | No: separate site |
| D8 | PDF/image text extraction (knowledge + copilot uploads) | SP-21, SP-18 | `pdf-parse` + provider vision model |
| D9 | TOTP library for 2FA | SP-26 | `otplib` |

## 6. Process per sub-project

- [ ] Re-read the Tkana files listed for the sub-project and confirm the gap still exists in our code (grep before building).
- [ ] Write `docs/superpowers/plans/<date>-<sp-slug>.md` with superpowers:writing-plans, including the Acceptance tests named above plus this file's Global Constraints.
- [ ] Branch `feat/<sp-slug>` from current `main`; implement through TDD.
- [ ] Backend `npm test`, frontend `npm test` + `npm run typecheck` + `npm run build`; drive the screen through the `verify` skill.
- [ ] Open the PR; tick the sub-project's "Shipped" box here and note the PR URL beside it.
