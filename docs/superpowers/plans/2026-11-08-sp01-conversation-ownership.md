# SP-01 Conversation Ownership, Status & Inbox Filtering: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let staff assign conversations, move them through statuses (open / pending customer / resolved / closed / spam), escalate them with a reason, and label them. The inbox list gains a "Mine" view, a working Filter and Sort, a needs-attention strip, and list/table/board views.

**Architecture:** Changes to `Conversation` are additive: `assigneeId`, `version`, `escalateReason`, `statusChangedAt`, plus a label catalogue. The stored status `"human"` keeps meaning **Open**, so the 6 integration writers that create conversations with `status: "human"` stay untouched. A DB trigger reopens `pending_customer`/`resolved` threads when the customer writes, covering every inbound path at once. Filtering stays **client-side** over the merged list (DB rows + live FB/IG threads), in one pure, tested module `src/screens/inbox/inboxFilters.ts`. This deviates from the roadmap's server cursor paging, because live FB/IG threads are not in our DB; server paging is deferred until they are stored. New inbox UI lives in focused files under `src/screens/inbox/`, and `Inbox.tsx` only wires them in.

**Tech Stack:** NestJS 10 + Prisma 5 + jest (backend). React 18 + `useFetch`/`useMutation` + vitest (frontend).

**Spec:** `docs/superpowers/plans/2026-11-08-tkana-parity-roadmap.md` § SP-01 and §2.1. Tkana reference (read-only): `C:\Users\ashra\Downloads\tkana-main\tkana-main\apps\web\app\` → `routes/conversations.$id.server.ts` (reassign 960, updateStatus 912), `lib/conversations/inbox-params.ts`, `components/conversations/{FilterBar,ListPane,TriageList,EscalateReasonDialog,LabelChips,table-columns}.tsx`, `routes/pipeline.conversations.tsx`.

## Global Constraints

- Every user-facing string goes through `tx("English", "العربية")` with real Arabic. Use logical CSS properties (`marginInlineStart`, `insetInlineEnd`).
- Migration: hand-written `backend/prisma/migrations/20261108120000_conversation_ownership/migration.sql`, additive and idempotent (`IF NOT EXISTS`). Apply it **only to the Neon dev branch** the user provides, never to the production URL in `backend/.env`.
- Tenancy: an id from another workspace returns 404. A new model with `workspaceId` must be added to `SCOPED_MODELS` in `backend/src/common/prisma-tenancy.ts`.
- Stored status values: `human` (shown as "Open"), `pending_customer`, `resolved`, `closed`, `spam`. Never write `"open"`.
- Tests: from `backend/` run `npx jest src/conversations`; from the repo root run `npx vitest run src/screens/inbox` and `npm run typecheck`.
- Commits: selective `git add`; trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; branch `feat/tkana-parity`.
- Live FB/IG threads (ids not in our DB) render the new controls disabled, with the tooltip `tx("Available for WhatsApp and synced threads", "متاح لواتساب والمحادثات المتزامنة")`.

## Review Focus

1. **Two agents assigning the same thread at once.** The second save carries a stale `version` and gets 409 with the current row. The UI shows the current assignee and a toast, not a silent overwrite. → Task 2 test `returns 409 with current when version is stale`.
2. **Assigning to someone who isn't a member of this workspace** (a removed member, or another tenant's user id) → 400 `assignee is not a member`. → Task 2 test.
3. **A customer writing into a resolved, pending or closed thread** must reopen it to Open, but only for messages newer than the status change (backfilled history never reopens). Spam stays sticky. → Task 1 trigger + Task 2 test `reopen trigger SQL covers pending_customer, resolved and closed, not spam, and ignores backfill`, which asserts on the migration text.
4. **Deleting a label still attached to conversations** removes the links (cascade) and doesn't 500. Rows that showed it simply lose the chip. → Task 3 test.
5. **Filters combined with Arabic search and live FB/IG threads.** A live thread has no assignee or labels. "Mine" must exclude it, and "All" must keep it. → Task 4 tests.

---

### Task 1: Schema, migration and reopen trigger

**Files:**
- Modify: `backend/prisma/schema.prisma` (the `Conversation` model; new `ConversationLabel` and `ConversationLabelLink` models; back-relations on `Workspace` and `User`)
- Create: `backend/prisma/migrations/20261108120000_conversation_ownership/migration.sql`
- Modify: `backend/src/common/prisma-tenancy.ts` (add `"ConversationLabel"` to `SCOPED_MODELS`)

**Interfaces (produces):**
- `Conversation.assigneeId String?` (relation `assignee User? @relation("ConversationAssignee", onDelete: SetNull)`), `version Int @default(0)`, `escalateReason String?`, `statusChangedAt DateTime?`, `labels ConversationLabelLink[]`; `@@index([workspaceId, assigneeId])`.
- `ConversationLabel {id, workspaceId, name, color, createdAt}` with `@@unique([workspaceId, name])`; `color` is one of `ink|info|ok|warn|bad|accent|human`.
- `ConversationLabelLink {conversationId, labelId, createdAt}` with `@@id([conversationId, labelId])`; both FKs `onDelete: Cascade`.

- [ ] **Step 1:** Edit the schema as above.
- [ ] **Step 2:** Write migration.sql. Add the columns with `ADD COLUMN IF NOT EXISTS`, create both tables `IF NOT EXISTS` with their FKs and indexes, then add this trigger:

```sql
CREATE OR REPLACE FUNCTION conversation_reopen_on_inbound() RETURNS trigger AS $$
BEGIN
  IF NEW."from" = 'them' THEN
    UPDATE "Conversation"
       SET "status" = 'human', "statusChangedAt" = NOW(), "version" = "version" + 1
     WHERE "id" = NEW."conversationId"
       AND "status" IN ('pending_customer', 'resolved', 'closed')
       AND ("statusChangedAt" IS NULL OR NEW."createdAt" >= "statusChangedAt");
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS conversation_reopen_on_inbound ON "Message";
CREATE TRIGGER conversation_reopen_on_inbound AFTER INSERT ON "Message"
  FOR EACH ROW EXECUTE FUNCTION conversation_reopen_on_inbound();
```

- [ ] **Step 3:** Run `npx prisma validate` and `npx prisma generate` from `backend/`. Expected: both succeed.
- [ ] **Step 4:** Add `"ConversationLabel"` to `SCOPED_MODELS`. `npx tsc --noEmit -p tsconfig.json` passes.
- [ ] **Step 5:** Commit: `feat(conversations): schema for assignee, labels, status history`.

### Task 2: Conversation update (status, assignee, escalate, version)

**Files:** Modify `backend/src/conversations/conversations.dto.ts` and `conversations.service.ts`. Create `backend/src/conversations/conversations.service.spec.ts`.

**Interfaces:**
- Consumes: Task 1 columns.
- Produces: `STATUSES = ["human","pending_customer","resolved","closed","spam"]`. `UpdateConversationDto` gains `assigneeId?: string | null` (`@IsOptional() @ValidateIf(v => v !== null) @IsString()`), `escalateReason?: string` (≤ 500 chars), `version?: number` (`@IsInt()`).
- `ConversationsService.update(workspaceId, id, dto)`:
  - 404 if the conversation is not in the workspace.
  - If `dto.version` is given and differs from the row's `version`, throw `ConflictException({ message: "Conversation changed", current })`, where `current` is the row.
  - If `assigneeId` is a string, it must be a `WorkspaceMember` of this workspace, else `BadRequestException("assignee is not a member")`.
  - `escalated: true` requires a non-empty `escalateReason` (400 otherwise). `escalated: false` clears the reason.
  - A status change sets `statusChangedAt = now`. Every successful update does `version: { increment: 1 }`.
  - The write uses `updateMany({ where: { id, workspaceId, version: row.version } })`. If 0 rows change, a concurrent write won the race: re-read the row and throw 409 the same way.
  - Emits `inbox.activity` as today.
- `list()` and `get()` include `labels: { select: { labelId: true } }` and map them to `labelIds: string[]`.

- [ ] **Step 1: Failing tests** in `conversations.service.spec.ts`, using a mocked prisma in the style of `backend/src/contacts/contacts.service.spec.ts`:
  - `sets status, bumps version and stamps statusChangedAt`
  - `returns 409 with current when version is stale` (expect `ConflictException`; `getResponse().current.version === 3`)
  - `returns 409 when the guarded write matches no row` (`updateMany` → `{count: 0}`)
  - `rejects an assignee who is not a member` (`workspaceMember.findFirst` → null → `BadRequestException`)
  - `unassigns with null`
  - `escalating requires a reason`; `de-escalating clears the reason`
  - `404 for a conversation in another workspace`
  - `reopen trigger SQL covers pending_customer, resolved and closed, not spam, and ignores backfill` (read the migration file with `fs`; assert the trigger's `IN (...)` list is exactly those three and the `createdAt >= statusChangedAt` guard is present)
- [ ] **Step 2:** `npx jest src/conversations`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npx jest src/conversations`. Expected: PASS. Then the full `npm test`, to confirm the 6 `status: "human"` writers' specs still pass.
- [ ] **Step 5:** Commit: `feat(conversations): assign, status, escalate with optimistic version`.

### Task 3: Conversation labels API

**Files:** Create `backend/src/conversations/conversation-labels.service.ts`, `conversation-labels.controller.ts` and `conversation-labels.service.spec.ts`. Register them in `conversations.module.ts`.

**Interfaces (produces):**
- `GET /conversation-labels` → `{id, name, color, count}[]`, where `count` is the number of linked conversations.
- `POST /conversation-labels {name, color}` → the label. A duplicate name returns 409 `label exists`. Name is trimmed, 1–40 chars, and colour is validated against the list in Task 1.
- `PATCH /conversation-labels/:id {name?, color?}`; `DELETE /conversation-labels/:id` → `{ok:true, unlinked:number}`.
- `PUT /conversations/:id/labels {labelIds: string[]}` replaces the conversation's label set. Every id must belong to the workspace, else 404. It bumps the conversation's `version` and emits `inbox.activity`. Returns `{labelIds}`.

- [ ] **Step 1: Failing tests:** `lists with counts`, `rejects duplicate name with 409`, `delete reports unlinked count` (Review Focus 4), `set labels replaces the set`, `foreign label id → 404`, `foreign conversation → 404`.
- [ ] **Step 2:** Run and expect FAIL. **Step 3:** Implement. **Step 4:** Run and expect PASS.
- [ ] **Step 5:** Commit: `feat(conversations): label catalogue and per-thread labels`.

### Task 4: Frontend types, API hooks and the filter module

**Files:**
- Modify: `src/lib/types.ts` (`Conversation.status` union becomes `"human" | "pending_customer" | "resolved" | "closed" | "spam"`; add `assigneeId?: string | null`, `version?: number`, `escalateReason?: string | null`, `labelIds?: string[]`, `statusChangedAt?: string | null`; add `ConversationLabel {id, name, color, count}` and `TeamMember {id, name, email, initials, color, role}` unless an equivalent already exists, in which case reuse it).
- Create: `src/screens/inbox/inboxFilters.ts` and `src/screens/inbox/inboxFilters.test.ts`.

**Interfaces (produces):**

```ts
export type InboxView = "list" | "table" | "board";
export type InboxSort = "recent" | "oldest" | "unread";
export interface InboxFilter {
  bucket: "all" | "mine" | "unassigned" | "unread" | "human" | "pending_customer" | "resolved" | "closed" | "spam";
  assigneeIds: string[];      // empty = anyone
  labelIds: string[];         // match ANY
  tags: string[];             // contact tags, match ANY
  lifecycles: string[];       // contact lifecycle, case-insensitive
  from?: string; to?: string; // ISO dates (inclusive days) on updatedAt
  escalatedOnly: boolean;
}
export const EMPTY_FILTER: InboxFilter;
export interface FilterCtx { meId: string; contactById: Map<string, { tags: string[]; lifecycle: string; name: string }>; isLive: (c: Conversation) => boolean }
export function matchesFilter(c: Conversation, f: InboxFilter, ctx: FilterCtx): boolean;
export function sortConversations(list: Conversation[], sort: InboxSort): Conversation[]; // pinned first in every sort
export function needsAttention(c: Conversation, ctx: FilterCtx): boolean; // escalated, OR (status human AND lastFrom "them" AND no assignee)
export function bucketCounts(list: Conversation[], ctx: FilterCtx): Record<InboxFilter["bucket"], number>;
export function activeFilterCount(f: InboxFilter): number; // excludes bucket
```

- [ ] **Step 1: Failing vitest tests:**
  - `mine excludes live FB/IG threads and others' threads` (Review Focus 5)
  - `all keeps live threads`
  - `labels match any`
  - `tags come from the contact`
  - `lifecycle is case-insensitive`
  - `date range is inclusive of the to-day`
  - `pinned stays first in every sort`
  - `needsAttention flags escalated and unassigned waiting threads`
  - `bucketCounts counts each bucket in one pass`
- [ ] **Step 2:** `npx vitest run src/screens/inbox`. Expected: FAIL. **Step 3:** Implement. **Step 4:** Expected: PASS, and `npm run typecheck` is clean.
- [ ] **Step 5:** Commit: `feat(inbox): filter, sort and triage logic`.

### Task 5: Thread header actions

**Files:**
- Create: `src/screens/inbox/ConversationActions.tsx`, containing an assign menu (team from `GET /team`, "Assign to me", "Unassign"), a status menu (Open, Pending customer, Resolved, Closed, Spam, plus "Reopen" when resolved or closed), pin/unpin, and Escalate / De-escalate.
- Create: `src/screens/inbox/EscalateDialog.tsx`, using the `Modal` from `@/components/Modal`, with a required reason textarea capped at 500 characters.
- Create: `src/screens/inbox/LabelPicker.tsx`: a checklist of labels with create-new inline (name + colour swatch). It saves through `PUT /conversations/:id/labels`.
- Modify: `src/screens/Inbox.tsx`, mounting these in the thread header next to `ConversationAiToggle`.

**Interfaces:** consumes Tasks 2–4. Every PATCH sends `version` from the conversation. On 409, refetch the list and the active conversation and show `tx("Someone else just changed this conversation — showing the latest.", "قام شخص آخر بتعديل هذه المحادثة للتو — نعرض أحدث نسخة.")`.

- [ ] **Step 1:** Build the components. Live FB/IG threads get the disabled state from Global Constraints.
- [ ] **Step 2:** `npm run typecheck` is clean. **Step 3:** Commit: `feat(inbox): assign, status, escalate and label actions in the thread`.

### Task 6: List pane — buckets, Filter, Sort, label chips, triage strip

**Files:**
- Create: `src/screens/inbox/InboxFilterMenu.tsx`, a popover with Assignee (multi), Labels (multi), Contact tags (multi, from `GET /tags`), Lifecycle (lead/customer/churned), date from/to, "Escalated only", and Clear. The Filter button shows `activeFilterCount`.
- Create: `src/screens/inbox/InboxSortMenu.tsx` (Recent, Oldest, Unread first).
- Create: `src/screens/inbox/TriageStrip.tsx`, a collapsible "Needs attention (n)" section above the rows, listing the `needsAttention` conversations.
- Create: `src/screens/inbox/LabelChips.tsx`, showing at most 2 chips plus "+n" on a row.
- Modify: `src/screens/Inbox.tsx`:
  - Replace `FilterId` and the pills with buckets All · Mine · Unassigned · Unread · Open · Pending · Resolved · Closed · Spam, using `bucketCounts`.
  - Wire the dead Filter/Sort buttons (`Inbox.tsx:964-969`).
  - Show label chips and the assignee initials on `.conv-row`.
  - Keep the filter state in the URL hash query (`#/inbox?f=<base64 json>`). Parse failures fall back to `EMPTY_FILTER`.

- [ ] **Step 1:** Implement. Name search is applied after `matchesFilter`.
- [ ] **Step 2:** `npm run typecheck` and `npx vitest run src/screens/inbox` pass. **Step 3:** Commit: `feat(inbox): mine/unassigned buckets, working filter and sort, triage strip`.

### Task 7: Table and board views, add filtered to group

**Files:**
- Create: `src/screens/inbox/InboxTable.tsx`, a table over the filtered and sorted list with columns Contact, Channel, Status, Assignee, Labels, Last message, Updated. Client-side paging uses `Pager` from `src/screens/contacts/Pager.tsx` (25/50/100). Clicking a row opens the thread in list view.
- Create: `src/screens/inbox/InboxBoard.tsx`, with columns Open / Pending customer / Escalated / Resolved / Closed. Escalated means `escalated === true` and takes precedence. Dragging between columns PATCHes `status`; dropping on Escalated opens `EscalateDialog`. Live threads can't be dragged.
- Create: `src/screens/inbox/AddFilteredToGroup.tsx`, a button that opens a picker of manual groups (`GET /segments`, origin `manual`) and calls `POST /segments/:id/members {contactIds}` with the unique contact ids of the filtered DB conversations. Its toast reads "Added n contacts".
- Modify: `src/screens/Inbox.tsx`, adding a list/table/board switch in the list header, kept in the hash query `v=`.

- [ ] **Step 1:** Implement. **Step 2:** `npm run typecheck` is clean. **Step 3:** Commit: `feat(inbox): table and board views, add filtered contacts to a group`.

### Task 8: End-to-end verification (Neon dev branch)

- [ ] **Step 1:** Using the dev `DATABASE_URL` from the user, run `npx prisma migrate deploy` from `backend/`. The new migration must show as applied.
- [ ] **Step 2:** Start the backend on a spare port (4100 is used by `crm-mobile`) and Vite with `VITE_API_URL` pointed at it, then follow the `verify` skill:
  - Assign to me → the thread appears under Mine.
  - Set Pending → insert an inbound `Message` (`from: "them"`) through SQL → the status returns to Open (trigger).
  - Escalate without a reason → blocked; with a reason → shown in the triage strip.
  - Create and attach a label → the chip appears, and the Labels filter narrows the list.
  - Two tabs, each assigning → the second gets the 409 toast.
  - Board drag Open → Resolved persists after reload.
  - Table paging works.
  - Add filtered to group → the member count rises.
  - Arabic UI: every new control is translated and RTL-correct.
- [ ] **Step 3:** Run the full backend `npm test`, frontend `npm test`, `npm run typecheck` and `npm run build`. All pass.
- [ ] **Step 4:** Tick SP-01 in the roadmap, noting the server-paging deferral. Commit: `docs: SP-01 shipped`.
