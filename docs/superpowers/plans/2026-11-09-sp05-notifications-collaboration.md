# SP-05 Notifications & Collaboration: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Notifications are stored per member, typed, deep-linked to their record and delivered live.
- The bell shows them with mark-read, alongside the existing unread-conversation feed, and each member can switch notification types on or off.
- Notes gain @mentions (with a warning when a mentioned person can't open the record), one level of replies, and "seen by" marks.
- A conversation's internal notes appear inline in the thread.

**Architecture:**
- **Data:** new `Notification` and `NotificationPreference` tables; `Note` gains `parentId` and `mentions` (text[]); a `NoteSeen` table.
- **Producing:** `NotificationsService.notify()` is the single producer API. It checks preferences, persists the notification, and emits to a per-user socket room. The gateway joins every socket to `user:<workspaceId>:<userId>`.
- **Mentions:** encoded in the note body as `@[Display Name](user:<id>)`, with one pure parser on each side, tested with Arabic names.
- **Producers in this SP:**
  - conversation assignment (SP-01's `ConversationsService.update`);
  - ticket owner change;
  - note mentions.

  `activity_due`, `connector_needs_attention`, `knowledge_source_failed`, `campaign_finished` and `import_finished` are declared now and produced by their later sub-projects.

**Tech Stack:** NestJS 10, Prisma 5, jest, socket.io (backend); React 18, vitest (frontend).

**Spec:** `docs/superpowers/plans/2026-11-08-tkana-parity-roadmap.md` §SP-05 and §2.4. Tkana reference (read-only) at `C:\Users\ashra\Downloads\tkana-main\tkana-main\apps\web\app\`:
- `routes/notifications.ts`, `routes/notifications.preferences.ts`
- `components/notifications/{notification-bell,alert-settings-dialog}.tsx`
- `routes/collaboration.ts`, `components/collaboration/*`

## Global Constraints
- Every user-facing string goes through `tx("English","العربية")` with real Arabic. Use logical CSS properties, and `dir="auto"` on user-entered text.
- **Migration:** hand-written `backend/prisma/migrations/20261109150000_notifications/migration.sql`, additive and idempotent. It must not change behaviour for the code that is currently deployed.
- **Tenancy:**
  - Every route is workspace-scoped, and an id from another workspace returns 404.
  - Notifications are additionally user-scoped: a member only ever reads or marks their own.
  - `Notification` and `NotificationPreference` go in `SCOPED_MODELS`. `NoteSeen` has no `workspaceId`; reach it only through a workspace-verified note.
- **Notification types:** `assignment | mention | activity_due | connector_needs_attention | knowledge_source_failed | campaign_finished | import_finished`.
- **Record kinds** (§2.6, used for deep links): `contact | conversation | ticket | booking | campaign`. A deep link is the hash URL `#/<route>?record=<kind>:<id>`. Until SP-06 adds the record sheet, the bell routes by kind: conversation → `#/inbox` with that thread selected; ticket → `#/pipeline` with the ticket open; contact → `#/contacts` with the drawer open. Use whatever existing selection mechanism each screen has, or add a minimal `?open=<id>` hash param.
- **No self-notifications:** an actor never notifies themselves.
- **Tests:** backend `npx jest src/notifications src/notes src/conversations src/tickets src/realtime` plus tsc. Frontend `npx vitest run` plus `npm run typecheck`. A known unrelated failure exists in `src/hjz-sync/hjz-client-sync.service.spec.ts`.
- **Commits:** selective `git add`, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, branch `feat/tkana-parity`.

## Review Focus
1. **A member reading or marking another member's notification:** must 404. The test is `read/mark another member's notification → 404`.
2. **Mentioning someone who can't open the record:** a non-member or removed member gets no notification, and the note response carries `warnings: [{userId, reason:"not_a_member"}]`.
   - Before SP-25, every member can open every record, so only non-membership warns.
   - The check goes through `canOpenRecord(workspaceId, userId, kind, id)`. That one function is the hook SP-25 will tighten.
3. **Arabic mention parsing:** `@[محمد أحمد](user:abc)` round-trips; a stray `@` or a malformed token is plain text; two mentions of the same user produce one notification.
4. **Preferences off for a type:** nothing is persisted or emitted for that member and type. Defaults are on when no preference row exists.
5. **Burst of notifications:** the bell list is cursor-paginated (20 per page), and the unread count is a cheap `count`. Mark-all is one `updateMany`.

---

### Task 1: Schema and migration
**Files:** `backend/prisma/schema.prisma`, `backend/prisma/migrations/20261109150000_notifications/migration.sql`, `backend/src/common/prisma-tenancy.ts`, `backend/src/prisma/prisma.service.ts` (accessors, if that file exposes per-model getters).

**Produces:**
- `Notification {id, workspaceId, userId, type, title, body?, recordKind?, recordId?, actorId?, readAt?, createdAt}`, with `@@index([workspaceId, userId, readAt])` and `@@index([workspaceId, userId, createdAt])`. FK user cascades.
- `NotificationPreference {workspaceId, userId, type, inApp Boolean @default(true), sound Boolean @default(true)}`, with `@@id([workspaceId, userId, type])`.
- `Note` gains `parentId String?` (self relation `replies`, `onDelete: Cascade`) and `mentions String[] @default([])`.
- `NoteSeen {noteId, userId, seenAt @default(now())}`, with `@@id([noteId, userId])` and FK note cascade.

- [ ] **Step 1:** Edit the schema.
- [ ] **Step 2:** Write the SQL: `IF NOT EXISTS` everywhere, FKs inside `DO $$ … duplicate_object` blocks, and Prisma-conformant names.
- [ ] **Step 3:** Run `prisma validate` and `generate`, update `SCOPED_MODELS`, and run tsc.
- [ ] **Step 4:** Commit `feat(notifications): schema for notifications, preferences, note threads`.

### Task 2: Notifications service, per-user realtime, producers
**Files:**
- Create `backend/src/notifications/{notifications.module.ts,notifications.service.ts,notifications.controller.ts,notifications.dto.ts,notifications.service.spec.ts}`.
- Create `backend/src/notifications/record-access.ts`: `canOpenRecord(prisma, workspaceId, userId, kind, id): Promise<boolean>`. Today: member of the workspace and the record exists in the workspace.
- Modify `backend/src/realtime/realtime.gateway.ts` and `realtime.service.ts`: join `userRoom(workspaceId, sub)` on connect; add `emitToUser(workspaceId, userId, event, payload)`.
- Modify `backend/src/conversations/conversations.service.ts` (assignment producer), `backend/src/tickets/tickets.service.ts` (owner-change producer) and `backend/src/app.module.ts`.

**Produces:**
- `NotificationsService.notify(workspaceId: string, userIds: string[], n: { type; title; body?; recordKind?; recordId?; actorId? }): Promise<number>`.
  - It dedupes ids and drops `actorId`.
  - It skips members whose preference has `inApp === false`.
  - It persists with `createMany` and emits `notification:new` with `{ id, type, title, body, recordKind, recordId, createdAt, sound }` to each user room.
  - It returns the count created.
  - It never throws to the caller: errors are logged and the result is 0.
- `GET /notifications?cursor&limit=20` returns `{ items, nextCursor }` for the current user, newest first.
- `GET /notifications/unread-count` returns `{ count }`.
- `POST /notifications/read { ids?: string[], all?: boolean }` returns `{ updated }`, and touches only the current user's rows.
- `GET /notifications/preferences` returns all 7 types with effective values; a missing row means on.
- `PUT /notifications/preferences { items: {type, inApp, sound}[] }` upserts the rows.
- **Message format:** `title` stores a stable message key, and `body` stores JSON params, for example `title: "assignment.conversation"` with `body: {"contactName":"…"}`. The UI maps keys to `tx` strings, so text follows the reader's language.
- **Assignment producer:** when `update()` changes `assigneeId` to a user who isn't the actor, send type `assignment` with key `"assignment.conversation"`, params `{contactName}`, and kind `conversation`.
- **Ticket owner producer:** when the owner changes to someone other than the actor, send key `"assignment.ticket"`, kind `ticket`.
- `update()` needs the acting user id, passed from the controller via `@CurrentUserId()`. Keep the old signature working: actorId is an optional last parameter.

- [ ] **Step 1: Failing tests:**
  - `notify skips actor and duplicates`
  - `notify respects inApp=false`
  - `notify emits to user room`
  - `notify never throws`
  - `list is cursor-paginated and user-scoped`
  - `read/mark another member's notification → 404` (or the update count is 0, with no change)
  - `read all only touches mine`
  - `preferences default on`
  - `assignment produces a notification for the assignee, not the actor`
  - `ticket owner change notifies new owner`
- [ ] **Steps 2–4:** RED, then implement, then GREEN. Also run `npx jest src/conversations src/tickets src/realtime`.
- [ ] **Step 5:** Commit `feat(notifications): service, per-user realtime, assignment producers`.

### Task 3: Notes — mentions, replies, seen
**Files:**
- Create `backend/src/notes/mentions.ts` and `mentions.spec.ts`: `parseMentions(body): string[]` (unique user ids, in order) and `MENTION_RE`. The token is `@[name](user:<id>)`, where the id matches `[A-Za-z0-9_-]+` and the name has no `]`.
- Modify `backend/src/notes/notes.dto.ts`, `notes.service.ts`, `notes.controller.ts`; create `notes.service.spec.ts`.

**Produces:**
- `POST /notes` accepts `{ …, parentId? }`.
  - The parent must be in the same workspace and on the same contact, and must itself be top-level. Otherwise 400 `replies are one level`.
  - The server parses mentions, keeps only workspace members, and for each checks `canOpenRecord`. The record is the note's conversation, else its ticket, else its contact.
  - It notifies those who can, with key `"mention.note"`, `body` params `{ excerpt }` (the first 120 characters with tokens rendered as `@name`), and the record kind/id.
  - It stores `mentions` = all parsed member ids.
  - It returns `{ ...note, warnings: [{ userId, reason: "not_a_member" | "no_access" }] }`.
- `PATCH /notes/:id`: re-parses the body and notifies only mentions that are newly added.
- The list endpoints return top-level notes, each with `replies` (oldest first) and `seenBy: {userId, seenAt}[]`.
- `POST /notes/:id/seen` is idempotent (upsert) and verifies the note is in the workspace.

- [ ] **Step 1: Failing tests:**
  - `parseMentions handles Arabic names and dedupes`
  - `malformed tokens are plain text`
  - `reply to a reply → 400`
  - `reply on another contact → 400`
  - `mention of non-member returns warning and does not notify`
  - `mention notifies member, not the author`
  - `edit notifies only newly added mentions`
  - `list nests replies and seenBy`
  - `seen is idempotent`
  - `foreign note → 404`
- [ ] **Steps 2–4:** RED, implement, GREEN.
- [ ] **Step 5:** Commit `feat(notes): mentions, one-level replies, seen marks`.

### Task 4: Bell — stored notifications and preferences
**Files:**
- Create `src/shell/NotificationsList.tsx`: a paginated list with "Load more", unread dot, mark-read on click, "Mark all read", deep link, and relative time.
- Create `src/shell/NotificationPrefsDialog.tsx`: per-type In-app and Sound switches saved via PUT.
- Create `src/lib/notificationText.ts` and its test: `notificationText(tx, n): { title: string; body?: string }`. It maps keys (`assignment.conversation`, `assignment.ticket`, `mention.note`, and fallbacks for the later types) to EN/AR strings with params. Unknown keys show the raw `title`.
- Create `src/lib/recordLink.ts` and its test: `recordHref(kind, id): string`, following the Global Constraints routing.
- Modify `src/shell/NotificationsBell.tsx`:
  - Add a "Notifications" section or tab next to the existing unread-conversations feed. Keep the chime, mute and toasts.
  - The badge is the stored unread count plus the existing conversation unread count, labelled separately in the panel.
  - Listen to `notification:new` via `useRealtime`: prepend the item, bump the count, play the chime if `sound` and not muted, and show a toast using the existing toast stack.
- Add `Notification` and `NotificationPreference` types in `src/lib/types.ts`.

- [ ] **Step 1:** Write failing vitest tests for `notificationText` and `recordHref`.
- [ ] **Step 2:** Implement; the tests pass.
- [ ] **Step 3:** Build the components. `npm run typecheck` is clean.
- [ ] **Step 4:** Commit `feat(notifications): bell list, live delivery, preferences`.

### Task 5: Notes UI — mention picker, replies, seen, inline thread notes
**Files:**
- Create `src/lib/mentions.ts` and its test: `parseMentions`, mirroring the backend; `renderMentionParts(body): Array<{text} | {mention: {id, name}}>`; and `insertMention(body, caret, member): {body, caret}`.
- Create `src/components/MentionInput.tsx`: a textarea where typing `@` opens a member list (from `GET /team`), filtered by the following text, navigable with Up/Down/Enter/Escape and RTL-safe. It inserts a token and shows it as `@name` while editing. Either keep tokens in the raw value and display them highlighted, or keep a side map and serialise on submit. Pick the approach that keeps `dir="auto"` text editing reliable, and document it.
- Modify `src/components/NotesPanel.tsx`:
  - Use `MentionInput`.
  - Render mention chips.
  - Show the server's `warnings` inline: `"<name> isn't in this workspace and wasn't notified"` / `"<name> ليس عضوًا في مساحة العمل ولم يتم إشعاره"`.
  - Add a Reply action (one level) and render replies indented.
  - Show "Seen by" initials, and POST `/notes/:id/seen` when a note scrolls into view or the panel opens. Throttle to once per note per session.
- Modify `src/screens/Inbox.tsx`: show the conversation's notes inline in the thread, merged with the messages by `createdAt` and styled as internal notes. Keep the existing collapsible panel as the composer.
- Modify `src/lib/types.ts`: `Note` gains `parentId`, `mentions`, `replies?`, `seenBy?`.

- [ ] **Step 1:** Write failing vitest tests for `src/lib/mentions.ts`. Cover the Arabic round-trip, malformed tokens, and `insertMention` at the caret.
- [ ] **Step 2:** Implement; the tests pass.
- [ ] **Step 3:** Build the components; typecheck and vitest are clean.
- [ ] **Step 4:** Commit `feat(notes): mention picker, replies, seen, notes inline in the thread`.

### Task 6: Verification
- Apply the migration after checking it is safe for the deployed code.
- Run the live API checks:
  - assignment and ticket-owner notifications;
  - mentions with and without membership;
  - preferences off;
  - mark read and mark all;
  - another member's notification returns 404.
- Run a browser smoke test of the bell and notes in EN and AR.
- Revert all test data, then tick SP-05 in the roadmap.
