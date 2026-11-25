# SP-08 Board Upgrades & Lead Pipeline: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- **Board views.** Every pipeline board can switch between the kanban view and a sortable, paged table. Both views share date-range, customer and assignee filters.
- **Bulk actions.** Selected cards can be assigned, marked lost (with a reason from the SP-07 catalogue) or marked not-a-lead.
- **Lead pipeline.** A pipeline of `kind:"leads"` keeps one open card per contact, tied to the contact's lifecycle. Winning sets the contact to customer. Losing asks for a reason. A lost lead can be reopened, and "Not a lead" closes the card and flags the contact.

**Architecture:**
- **Server-side list:** `GET /tickets` gains server-side filtering, sorting and cursor paging, used by the table view. The kanban keeps its per-stage loading and adds the same filters.
- **Bulk:** one endpoint, `POST /tickets/bulk`, gated per row exactly like `contacts/bulk`.
- **Lead behaviour:** lives in `TicketsService`, keyed on `pipeline.kind === "leads"`.
  - It uses a fixed lifecycle mapping: open stage → `lead`, won → `customer`, lost → unchanged.
  - Before creating a card in a leads pipeline, the service checks the contact has no open card there, which keeps it to one per contact.
- **Reopen:** returns a closed ticket to the stage it was in before closing. That stage is read from its latest `TicketActivity` of kind `stage_changed`.

**Tech Stack:** NestJS 10, Prisma 5, jest; React 18, vitest.

**Spec:** roadmap §SP-08. Tkana reference: `apps/web/app/routes/pipeline.customers.tsx`, `components/pipeline/{table,date-filter,customer-filter}.tsx`, `components/pipeline/customers/*`, `components/crm/bulk-add-to-pipeline-dialog.tsx`.

## Global Constraints
- **Permissions (SP-25):**
  - List: `tickets.view`.
  - Bulk: assign and lost need `tickets.update`. Not-a-lead needs `tickets.update` and `contacts.update`.
  - Reopen: `tickets.update`.
  - Every route goes in `permission-map.ts`. The `agentCanMove` gate from SP-07 applies to bulk lost too, because it moves cards.
- **Filters:**
  - `from`/`to` are inclusive local days in the workspace timezone, applied to `createdAt`. Reuse SP-04's `localDayBounds`.
  - `contactId`.
  - `ownerId`, either a user id or `none`.
  - `stageId`.
  - `q` searches the title and the contact name.
  - `status`: `open`, `won` or `lost`.
- **Sort:** `createdAt`, `updatedAt`, `value` or `enteredStageAt`, ascending or descending, with `id` as the tie-break.
- **Paging:** cursor-based, 50 rows per page.
- **Bulk limits:** at most 500 ids. Each row is checked for workspace membership and permission. Ids that fail are returned in `skipped`.
- **Lead uniqueness:** creating a second open card for the same contact in the same leads pipeline returns 409 `tickets.lead_exists` with the existing id. Bulk add-to-pipeline (SP-02) skips those rows, as it already does for open tickets.
- **Not a lead:** sets `Contact.notALead = true`, closes the card into the lost stage with the reason snapshot "Not a lead" (EN and AR), and logs an activity.
- **Copy:** every user-facing string goes through `tx("English","العربية")` with real Arabic.
- **Migrations:** none expected. If an index is needed for the sorts (for example `Ticket(workspaceId, pipelineId, createdAt)`), add a hand-written, additive migration.
- **Tests:** backend `npx jest src/tickets src/pipelines src/contacts src/permissions` plus tsc. Frontend `npx vitest run` plus `npm run typecheck`.
- **Commits:** selective `git add`; trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus
1. **Lead won:**
   - The contact's lifecycle becomes `customer`.
   - Reopening the card sets it back to `lead`, but only if it is still `customer` and was set by this card. Track this with an activity note.
   - Test: `lead won sets contact lifecycle customer`.
2. **Reopen:** the card returns to the stage it was in before closing, `closedAt` and `lostReason` are cleared, and an activity is logged. Test: `reopen restores previous stage`.
3. **Uniqueness:** there is one open lead card per contact per pipeline, under concurrent creates too. Use a serializable check inside a transaction, or a partial unique index created by raw SQL: `CREATE UNIQUE INDEX … ON "Ticket"("pipelineId","contactId") WHERE "closedAt" IS NULL AND <leads>`. That condition can't reference the pipeline kind, so choose the transaction plus a recheck, and document the choice.
4. **Mixed-permission bulk:** a bulk action over rows the actor can't update applies only the allowed rows and returns `skipped`.
5. **Filter parity:** the table and the kanban return the same set of tickets for the same filters. Assert this through a shared `where` builder.

---

### Task 1: Backend — filtered list, bulk, reopen, lead behaviour
**Files:** create `backend/src/tickets/ticket-filter.ts` with its spec and `backend/src/tickets/tickets-bulk.service.ts` with its spec. Modify `tickets.service.ts`, `tickets.controller.ts`, `tickets.dto.ts`, `permission-map.ts` and `contacts-bulk.service.ts`.

**Produces:**
- `buildTicketWhere(workspaceId, f, tz): Prisma.TicketWhereInput`, shared by list and kanban.
- `GET /tickets?pipelineId&view=table&…filters&sort&dir&cursor` returns `{items, nextCursor, total}`. Without `view=table` the existing response shape is unchanged; it only gains the filters.
- `POST /tickets/bulk {ids, op:"assign"|"lost"|"notALead", ownerId?, lostReasonId?}` returns `{affected, skipped}`.
- `POST /tickets/:id/reopen` returns the ticket.
- **Lead behaviour:**
  - When a card is won in a leads pipeline, the contact's lifecycle becomes `customer`.
  - Reopening a won lead restores `lead`, guarded by the activity marker.
  - Lead uniqueness is enforced on create.

- [ ] **Failing tests:**
  - every filter, including the timezone date bounds
  - sort plus cursor stability
  - the five Review Focus items
  - foreign ids return 404
  - not-a-lead flags the contact
- [ ] Implement, get the tests GREEN, then run the full jest suite once.
- [ ] Commit `feat(tickets): filtered table list, bulk actions, reopen, lead pipeline rules`.

### Task 2: Frontend — table view, filters, bulk bar, lead actions
**Files:**
- Create `src/screens/pipeline/{PipelineTable.tsx, BoardFilters.tsx, BoardBulkBar.tsx, boardQuery.ts}` and `boardQuery.test.ts`.
- Modify `PipelinePage.tsx` (Board/Table toggle, kept in the hash as `?pv=`, with filters in `?pf=` through `hashState`), `PipelineHeader.tsx`, `TicketCard.tsx` (selection checkbox, lead card menu) and `StageColumn.tsx`.
- Modify `TicketDetailContent` to add Reopen and Not-a-lead actions.

**Produces:**
- **Table:**
  - Columns: number, title, contact, stage, owner, value, created, updated, time in stage. Sortable headers.
  - Pager with 50 rows; reuse `Pager` with cursor-style Next/Prev, or "Load more".
  - Row click opens the record sheet (SP-06).
- **Filters:** a date range with presets (Today, 7 days, 30 days, this month, custom), a customer typeahead (contacts search), an assignee picker and a status picker.
- **Bulk bar:**
  - Assign.
  - Mark lost, with a reason picker from `/pipelines/:id/lost-reasons`.
  - Not a lead, shown only on leads pipelines.
  - Result toast: "n updated · m skipped".
- **Lead pipeline:**
  - The card menu has Won, Lost, Not a lead and Reopen.
  - Dropping a card onto the lost stage opens the reason picker (already partly there; wire it to the catalogue).
- `boardQuery.ts`: `toQuery(filters, sort)` matches the backend parser, and `presetRange(preset, now, tz)`. Both are tested.

- [ ] Write the failing vitest tests, then implement until they pass.
- [ ] Build the components. typecheck and vitest are clean.
- [ ] Commit `feat(pipeline): table view, board filters, bulk actions, lead card actions`.

### Task 3: Verification
Live check: table and kanban parity; filters; bulk actions with a mixed-permission role; a lead won and then reopened, checking the lifecycle; not-a-lead. Revert the test data, then tick SP-08.
