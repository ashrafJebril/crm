# SP-04 Activities & Follow-ups: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff can do four things with this sub-project:
- log activities on contacts and tickets: calls, meetings and notes-as-log;
- schedule follow-ups and tasks with a due time, assignee and outcome;
- work a follow-ups queue: Mine or Team, grouped Overdue / Today / Upcoming, filtered, with single or bulk done, reassign and reschedule;
- see a contact timeline that merges activities, notes, ticket activity and messages.

Contacts and ticket cards also show a "next step" chip, and due follow-ups notify their assignee.

**Architecture:**
- **Activity model.** A new `Activity` table holds every kind of activity. The next step of a contact or ticket is its earliest open activity by `dueAt`.
- **Today and overdue.** These buckets are computed in the workspace timezone (`Workspace.timezone`), using a small pure date helper.
- **Due notifications.** A minute cron sends a single `activity_due` notification per activity (SP-05), guarded by `notifiedAt`.
- **Timeline.** `GET /contacts/:id/timeline` merges four sources by time with a shared cursor, and respects SP-25 conversation visibility for messages.
- **New screen.** `followups` RouteId.
- **Next step chip.** Shown in the contacts list and pipeline cards. It is batch-loaded per page, so the lists don't make N+1 queries.

**Tech Stack:** NestJS 10, Prisma 5, jest; React 18, vitest.

**Spec:** `docs/superpowers/plans/2026-11-08-tkana-parity-roadmap.md` §SP-04 and §2.3. Tkana reference: `apps/web/app/routes/sales.follow-ups*.ts(x)`, `components/follow-ups/*`, `components/pipeline/customers/{assign-work-dialog,next-step-chip}.tsx`, `components/collaboration/*`.

## Global Constraints
- **Activity kinds:** `follow_up | call | meeting | task | note_log`.
  - `follow_up` and `task` need a `dueAt`.
  - `call`, `meeting` and `note_log` are logged entries. `doneAt` defaults to the creation time unless `dueAt` is in the future, which makes it a scheduled meeting.
- **Links:** an activity links to at least one of `contactId` or `ticketId`. A `bookingId` is optional.
  - Every linked id is workspace-verified.
  - Linking an activity to a ticket also sets the ticket's contact as `contactId`.
- **Permissions (SP-25).** Every new route goes in `permission-map.ts`.
  - **Mapping by link:** activities on a contact use `contacts.*`; activities on a ticket use `tickets.*`. Reading requires `.view`; create, update and complete require `.update`; delete requires `.delete`.
  - **Assigned-only viewers:**
    - Activities are visible when their contact is.
    - Timeline messages are filtered by conversation visibility.
    - The queue's Team scope shows only activities on records the viewer can open.
- **Buckets (workspace timezone):**
  - overdue: `dueAt < now` and not done
  - today: `dueAt` falls on today's local calendar date and is ≥ now
  - upcoming: after today
  - done items are excluded from all three
- **Bulk limits:** at most 500 ids. Ids the actor may not update are skipped and reported as `skipped`.
- **Copy and layout:** every user-facing string goes through `tx("English","العربية")` with real Arabic. Use logical CSS and `dir="auto"`.
- **Migration:** hand-written `backend/prisma/migrations/20261110150000_activities/migration.sql`, additive and idempotent.
- **Tests:**
  - backend: `npx jest src/activities src/contacts src/tickets src/notifications src/permissions` plus tsc
  - frontend: `npx vitest run` plus `npm run typecheck`
- **Commits:** selective `git add`; trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus
1. **Timezone buckets:**
   - In Asia/Dubai, a follow-up due at 23:30 local today counts as "today", not "upcoming".
   - One due at 00:30 local tomorrow counts as "upcoming".
   - One due 1 minute ago counts as "overdue".

   → `buckets.spec.ts` with a fixed clock.
2. **Bulk with mixed permissions:** a bulk reschedule over ids some of which the actor can't update applies only the permitted ones and returns `skipped`. → spec.
3. **Due notification fires once:** the cron run twice leaves exactly one notification, guarded by `notifiedAt`. Rescheduling clears `notifiedAt` so the activity can notify again. → spec.
4. **Timeline privacy:** an assigned-only viewer sees no messages from hidden conversations in a contact's timeline. → spec.
5. **N+1:** the next-step chips for a 50-row contacts page or a pipeline column cost one query. → spec asserts a single `findMany` with `in`.

---

### Task 1: Schema, buckets helper, activities API, due cron
**Files:**
- Schema and migration.
- `prisma-tenancy.ts`: add `Activity`.
- Create `backend/src/activities/{activities.module.ts,activities.service.ts,activities.controller.ts,activities.dto.ts,buckets.ts,activity-due.scheduler.ts}` with specs.
- Update `permission-map.ts` and `app.module.ts`.

**Produces:**
- `Activity {id, workspaceId, kind, title, notes?, dueAt?, doneAt?, outcome?, notifiedAt?, assigneeId?, contactId?, ticketId?, bookingId?, createdById?, createdAt, updatedAt}`.
  - Indexes: `@@index([workspaceId, assigneeId, doneAt, dueAt])`, `@@index([workspaceId, contactId])`, `@@index([workspaceId, ticketId])`.
  - FKs: workspace cascades; contact, ticket and booking cascade; assignee is set null.
- `buckets.ts`:
  - `bucketOf(dueAt: Date, now: Date, tz: string): "overdue"|"today"|"upcoming"`
  - `localDayBounds(now, tz): {start: Date, end: Date}`, using `Intl.DateTimeFormat` with `timeZone` only. No new dependency.
- Routes:
  - `POST /activities` and `PATCH /activities/:id`.
  - `POST /activities/:id/complete {outcome?}`.
  - `DELETE /activities/:id`.
  - `GET /activities?contactId|ticketId` (newest first, cursor).
  - `GET /activities/queue?scope=mine|team&assigneeId&kind&pipelineId&cursorUpcoming`: returns `{ overdue: Activity[], today: Activity[], upcoming: Activity[] (paged 50), counts: {overdue, today, upcoming} }`. Each item embeds `{contact:{id,name}, ticket?:{id,number,title}}`.
  - `POST /activities/bulk {ids, op:"done"|"reassign"|"reschedule", assigneeId?, dueAt?}`: returns `{affected, skipped}`.
  - `GET /activities/next-steps?contactIds=a,b|ticketIds=…`: returns `{ [id]: {activityId, kind, title, dueAt, overdue:boolean} }`, built with one query.
- `activity-due.scheduler.ts`: every minute, takes open activities with `dueAt <= now`, `notifiedAt null` and an assignee. It notifies each assignee with type `activity_due` and key `"activity.due"`, params `{title, contactName}`, and kind/id = ticket or contact. It then sets `notifiedAt`, using a compare-and-set update per row.
  - Notifications are suppressed for activities whose `dueAt` is more than 24 h in the past, so backlogs don't flood. Those rows are marked `notifiedAt` without notifying.
- Assignee changes to someone other than the actor notify the new assignee with key `"assignment.activity"`.

- [ ] Write the failing tests:
  - `buckets.spec.ts` (Review Focus 1)
  - CRUD, including linking to a ticket setting `contactId`
  - foreign ids → 404
  - complete
  - the queue's mine and team scopes
  - bulk with mixed permissions (Review Focus 2)
  - the due cron's single fire and reschedule re-arm (Review Focus 3)
  - next-steps uses one query (Review Focus 5)
  - assigned-only team scope
- [ ] Implement, get them GREEN, then run the full jest once.
- [ ] Commit `feat(activities): activities, follow-up queue, due notifications`.

### Task 2: Contact timeline
**Files:** `backend/src/contacts/contact-timeline.service.ts` with spec; a controller route; the permission map.

**Produces:**
- `GET /contacts/:id/timeline?before=<ISO>&limit=30` returns `{ items: TimelineItem[], nextBefore?: string }`.
- `TimelineItem = { type:"activity"|"note"|"ticket_activity"|"message", at: string, id: string, data: … }`.
- It merges the newest-first slices of each source (each queried with `createdAt < before`, `take: limit`), then sorts and cuts to `limit`.
- Messages come only from conversations the viewer can see (`conversationScope`). Each message carries its `conversationId` and channel.
- Ticket activities come only from tickets on this contact.
- The contact must be openable, otherwise 404.

- [ ] Write the failing tests:
  - merge order across the four sources
  - the cursor pages without gaps or duplicates when several items share a timestamp (tie-break by `type`+`id`)
  - an assigned-only viewer doesn't see hidden messages (Review Focus 4)
  - foreign contact → 404
- [ ] Commit `feat(contacts): unified contact timeline`.

### Task 3: Frontend: follow-ups screen, timeline, next-step chips, activity dialogs
**Files:**
- Add `followups` to `RouteId` in `src/lib/types.ts`, plus the router entry and the sidebar nav item. Hide the nav item when the user lacks both `contacts.view` and `tickets.view`.
- Create `src/screens/FollowUps.tsx` and `src/screens/followups/{FollowUpRow.tsx, BulkFollowUpBar.tsx, followupsLogic.ts}`, with `followupsLogic.test.ts`.
- Create `src/components/activities/{ActivityDialog.tsx, ActivityList.tsx, NextStepChip.tsx, Timeline.tsx}`.
- Modify:
  - `ContactDetailDrawer` content: a "Timeline" tab next to the existing sections, and a "Log activity" / "Schedule follow-up" action.
  - The Contacts table: a "Next step" column, batch-loaded per page.
  - Pipeline cards: a next-step chip, batch-loaded per board.
  - `TicketDetailDrawer`: an activities section with a schedule action.
  - The record-sheet ticket and contact bodies get the same through the shared contents.

**Produces:**
- **Follow-ups screen:**
  - Mine and Team tabs; Team requires `contacts.view`.
  - Overdue, Today and Upcoming sections with counts, and "Load more" for Upcoming.
  - Filters: person, kind and pipeline.
  - Row actions: done (with an outcome prompt), reschedule (quick +1h / tomorrow 9:00 / next week, or a custom time), reassign, and open the record in the record sheet.
  - Multi-select bulk bar.
  - Filter state lives in the hash (`?fu=`) through `hashState`.
- **Activity dialog:** kind, title, due time (a datetime-local input interpreted in the workspace timezone; show the timezone label), assignee (defaults to me), notes and outcome.
- **Timeline:** infinite scroll on `nextBefore`, an icon per type, messages showing the channel and a link to the conversation (the record sheet, or `?open=` for opaque ids), with Arabic and RTL support.
- **Next-step chip:**
  - "Call Ahmad · Tomorrow 10:00", red when overdue, and "No next step" muted.
  - Clicking it opens the activity dialog.
- `followupsLogic.ts`: `groupForDisplay`, `quickReschedule(now, choice, tz)`, `formatDue(dueAt, now, tz, lang)`, with tests including the Dubai timezone.

- [ ] Write failing vitest tests for `followupsLogic.ts`, then implement until they pass.
- [ ] Build the components; typecheck and vitest are clean.
- [ ] Commit `feat(activities): follow-ups screen, timeline, next-step chips`.

### Task 4: Verification
Apply the migration once it's safe, then do the live checks:
- create a follow-up due in 1 minute → the bell notifies once;
- check the buckets around midnight Dubai time (by API, with a crafted dueAt);
- bulk reschedule;
- the timeline shows all sources;
- an assigned-only role hides hidden messages.

Revert the test data, then tick SP-04.
