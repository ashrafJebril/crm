# SP-06 Universal Record Sheet: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Any record can open in one side sheet over the current page:
- Adding `?record=<kind>:<id>` to the current hash opens it.
- Chips inside the sheet link to related records and swap the sheet in place.
- Browser Back steps back through the records.
- Notifications, mentions and cross-screen links use the sheet, so the user keeps their page and filters.

**Architecture:**
- **Backend:** `GET /records/:kind/:id` returns a compact, permission-checked summary with links to related records. It reuses SP-25's `canOpenRecord` (permission plus conversation visibility), so a record the viewer may not open returns 404.
- **Frontend:**
  - One `RecordSheetHost` is mounted in the shell. It reads the `record` hash param on every route.
  - Each record is pushed as a real history entry by assigning `location.hash`, so Back works natively.
  - Closing the sheet removes the param with `replaceState`.
  - Sheet bodies reuse the existing drawers (contact, ticket) where possible, and use small new bodies for conversation, booking and campaign.
- `recordHref` switches from route-specific `?open=` links to `?record=` on the current route. `useOpenParam` stays for old links.

**Tech Stack:** NestJS 10, Prisma 5, jest; React 18, vitest.

**Spec:** `docs/superpowers/plans/2026-11-08-tkana-parity-roadmap.md` §SP-06, §2.6. Tkana reference: `apps/web/app/components/shell/{record-sheet-host,record-sheet}.tsx`, `routes/record.$kind.$id.ts`.

## Global Constraints
- `RecordKind = "contact" | "conversation" | "ticket" | "booking" | "campaign"`.
- The URL form is `#/<route>?record=<kind>:<id>`. Other hash params (`f`, `v`, `cf`, `open`) are preserved. Use `src/lib/hashState.ts`.
- A kind/id that the viewer can't open, or that doesn't exist, or that belongs to another workspace, returns 404. The sheet then shows tx("This record isn't available.", "هذا السجل غير متاح.") with a Close button.
- Opaque FB/IG thread ids (`t_…`, `ig:…`) are not records. Links to them go to `#/inbox?open=<id>`, as today.
- Every user-facing string goes through `tx("English","العربية")` with real Arabic. Use logical CSS (the sheet slides in from the inline-end side) and `dir="auto"` on record text.
- The sheet is a dialog:
  - `role="dialog"` with `aria-modal="true"` and a label;
  - focus moves into the sheet on open and returns to the opener on close;
  - Escape closes it;
  - on phone widths (<640px) it is full-width.
- Tests: backend `npx jest src/records src/notifications src/permissions` plus tsc; frontend `npx vitest run` plus `npm run typecheck`.
- Commits: selective `git add`; trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus
1. **Restricted viewers:** an assigned-only member opening `?record=conversation:<unassigned>` gets 404 and the "isn't available" state. The contact record's `links` list only conversations that viewer can see. → Task 1 tests.
2. **Back and Forward:**
   - Open contact A, follow a chip to ticket B, then follow a chip to conversation C.
   - Back shows B, Back again shows A, Back again closes the sheet.
   - Closing with X or Escape doesn't add history entries.

   → Task 2 tests on the pure history helper, plus a live check.
3. **Filters survive:** with the inbox filtered (`f=`) or contacts filtered (`cf=`), opening and closing a record leaves those params unchanged. → `recordParam` tests.
4. **Unknown kind or malformed param:** `?record=foo`, `?record=ticket:`, `?record=bogus:1` are ignored and nothing crashes. → tests.
5. **Stale sheet after a delete:** deleting a contact or ticket from inside the sheet closes the sheet and refreshes the page behind it. → Task 2.

---

### Task 1: Records API
**Files:**
- Create `backend/src/records/{records.module.ts,records.service.ts,records.controller.ts,records.service.spec.ts}`.
- Register the module.
- Add `GET /records/:kind/:id` → `"authenticated"` in `backend/src/permissions/permission-map.ts`; the per-kind permission is checked inside.

**Produces:** `GET /records/:kind/:id` → `RecordSummary`:
```ts
{
  kind: RecordKind; id: string;
  title: string; subtitle?: string;            // e.g. contact name + phone; ticket "#12 · title"; conversation contact name + channel
  fields: { key: string; value: string | number | boolean | null }[];  // stable keys, translated in the UI
  links: { kind: RecordKind; id: string; title: string; subtitle?: string }[];
}
```
- **Per kind:**
  - **contact:**
    - fields: lifecycle, phone, email, owner, tags, createdAt;
    - links: up to 5 visible conversations, newest first, plus up to 5 open tickets and up to 5 upcoming bookings.
  - **conversation:**
    - fields: channel, status, assignee, escalated, lastAt;
    - links: the contact and its tickets that carry this conversationId.
  - **ticket:**
    - fields: number, pipeline, stage, value, owner, createdAt;
    - links: the contact, and the conversation if it is a DB conversation the viewer can see.
  - **booking** (Appointment):
    - fields: service, start, status, staff;
    - links: the contact.
  - **campaign:**
    - fields: status, sent, delivered, read, failed;
    - links: none.
- **Access:**
  - Use `canOpenRecord(workspaceId, userId, kind, id)` from SP-25. Check its signature first, because it now takes `perm` or `eff`.
  - If the kind isn't supported by `canOpenRecord`, add it there with its `<resource>.view` mapping: booking → `bookings.view`, campaign → `campaigns.view`.
  - Every link is filtered by the same check.
  - Super-admin and impersonation follow the existing bypass rules.
- **Errors:** an unknown kind returns 400; a hidden or missing record returns 404.

- [ ] **Failing tests:**
  - one per kind for the happy path
  - `foreign workspace id → 404`
  - `assigned-only viewer: hidden conversation → 404`
  - `contact links omit hidden conversations`
  - `missing view permission → 404`
  - `unknown kind → 400`
- [ ] Implement, get GREEN, then commit `feat(records): record summary API`.

### Task 2: Record sheet UI
**Files:**
- Create `src/lib/recordParam.ts` and its test:
  - `parseRecordParam(hash): {kind, id} | null` validates the kind and requires a non-empty id;
  - `withRecord(hash, rec | null): string` keeps other params;
  - `isRecordKind`.
- Create `src/shell/RecordSheetHost.tsx`:
  - It listens to `hashchange`, parses `record`, and renders `RecordSheet` when present.
  - Opening another record sets `location.hash = withRecord(current, rec)`, which pushes a history entry.
  - Close uses `history.replaceState` with `withRecord(current, null)`, then dispatches nothing extra.
  - It owns focus return.
- Create `src/shell/RecordSheet.tsx`: the frame (header with title, subtitle and close; scrollable body; 404 state; loading skeleton) and the link chips.
- Create `src/shell/record-bodies/`:
  - `ContactBody.tsx` reuses the contents of `ContactDetailDrawer`. Refactor the drawer so its inner content is exported as `ContactDetailContent`; the drawer keeps working on the Contacts screen.
  - `TicketBody.tsx` reuses `TicketDetailDrawer` content in the same way. Its required `pipelineId`/`stageId` props come from the ticket detail fetch.
  - `ConversationBody.tsx`: the last 10 messages read-only, plus an "Open in inbox" button (`#/inbox?open=<id>`).
  - `BookingBody.tsx`: summary fields plus "Open calendar".
  - `CampaignBody.tsx`: stat fields.
- Modify:
  - `src/shell/*` (the layout file that renders `Topbar`/`ScreenSlot`) to mount `RecordSheetHost` once.
  - `src/lib/recordLink.ts`: `recordHref` returns `withRecord(currentHash, {kind, id})` for all five kinds. It falls back to `#/inbox?open=` for opaque thread ids. Update its tests.
  - `TicketDetailDrawer`'s `onOpenConversation` and the Contacts drawer's conversation and ticket links open the sheet record instead of navigating away.
- **Deletes inside the sheet:** a contact or ticket deleted from inside the sheet closes the sheet. The sheet then broadcasts `window.dispatchEvent(new CustomEvent("record:changed", {detail: {kind, id}}))`, and the Contacts and Pipeline screens refetch on it.

- [ ] **Failing vitest tests:** `recordParam` (parse and serialize, preserving `f`/`cf`/`v`, malformed inputs) and `recordHref`.
- [ ] Implement until they pass.
- [ ] Build the components. typecheck and vitest are clean.
- [ ] Commit `feat(records): universal record sheet with in-place links and back navigation`.

### Task 3: Verification
- No migration is needed.
- Live checks:
  - open each kind of record through the API and in the browser;
  - follow chips and check Back steps through the records;
  - an assigned-only test role gets 404 for hidden records;
  - filters survive opening and closing the sheet;
  - notifications open the sheet.
- Tick SP-06 in the roadmap.
