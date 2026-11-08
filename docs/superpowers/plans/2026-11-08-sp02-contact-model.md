# SP-02 Contact Model: Editing, Custom Fields, Consent: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Contacts become a real CRM record. Staff can edit them (first/last name, phone, email, owner, lifecycle) and give them typed custom fields. Contacts can opt out of marketing or be marked "not a lead", and deleting one that has linked records triggers a warning. The list can be filtered by any of these and acted on in bulk, including across every page. Tags can be merged.

**Architecture:** Changes to `Contact` are additive. `name` stays the display name, kept in sync from first/last name. Custom fields are a definition table plus a value table, with values stored as JSON and validated by the field type. The contacts list filter is one shared DTO and `where` builder (`contact-filter.ts`), used by `/contacts/page`, `/contacts/ids` and `/contacts/bulk`. SP-03's export and SP-16's audiences will reuse it. Bulk "add to pipeline" goes through the existing `TicketsService.createTicket`. Campaign sending skips opted-out contacts through the existing `buildRecipients` skip counters. New UI lives in focused files under `src/screens/contacts/`; `Contacts.tsx` (1353 lines) only wires it in.

**Tech Stack:** NestJS 10 + Prisma 5 + jest (backend). React 18 + `useFetch`/`useMutation` + vitest for pure logic (frontend).

**Spec:** `docs/superpowers/plans/2026-11-08-tkana-parity-roadmap.md` §SP-02 and §2.2. Tkana reference, read-only, under `C:\Users\ashra\Downloads\tkana-main\tkana-main\apps\web\app\`:
- `routes/crm.contacts*.tsx`
- `routes/settings.custom-fields.tsx`
- `routes/crm.tags.tsx` (merge)
- `components/crm/{customer-fields-card,customer-field-filter,not-a-lead,customer-records}.tsx`
- `components/crm/contacts-list/bulk-bar.tsx`
- `components/CustomerDetail.tsx`
- `lib/customers/marketing-preference.ts`

## Global Constraints

- **Copy:** every user-facing string goes through `tx("English", "العربية")` with real Arabic. Use logical CSS properties, and `dir="auto"` on any user-entered text (names, field values).
- **Migration:** hand-written `backend/prisma/migrations/20261109120000_contact_model/migration.sql`, additive and idempotent. The name backfill only touches rows `WHERE "firstName" IS NULL` and is safe to rerun. Apply it only when the user's tooling permits; agents never run `migrate deploy`, `db push` or anything else that connects to a database.
- **Tenancy:** an id from another workspace returns 404. `CustomFieldDef` goes in `SCOPED_MODELS`. `CustomFieldValue` has no `workspaceId`, so every access goes through a workspace-verified contact or def first.
- **Name sync:** when `firstName`/`lastName` are written, `name` = `[firstName, lastName].filter(Boolean).join(" ")`. When only `name` is written, it is split on the first whitespace into `firstName` (the rest goes to `lastName`). `name` must never be stored empty: an empty result is a 400.
- **Email:** optional, lower-cased and trimmed, validated with `@IsEmail()`, and not unique.
- **Lifecycle values** stay free text. The UI offers `lead | customer | churned`.
- **Tests:** from `backend/` run `npx jest src/contacts src/custom-fields src/tags src/campaigns src/tickets`, and `npx tsc --noEmit -p tsconfig.json`. From the repo root run `npx vitest run` and `npm run typecheck`. A known unrelated failure is `src/hjz-sync/hjz-client-sync.service.spec.ts`.
- **Commits:** selective `git add`; trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; branch `feat/tkana-parity`.

## Review Focus

1. **Deleting a custom field that has values** shows how many values it holds (delete preview), then archives the field (`archivedAt`). Values stay, but the field is hidden and can no longer be filtered or edited. Nothing is orphaned and nothing 500s. → Task 3 test `delete-custom-field-with-references archives and keeps values`.
2. **An opted-out contact in a campaign audience** is skipped and counted under `skipped.optedOut`, in both preview and launch. → Task 2 test `opted-out contact is skipped by campaign send`.
3. **Merging tags**:
   - Merging "VIP" into "Gold" rewrites exact array elements only, so "VIPER" is untouched.
   - It dedupes contacts that had both tags.
   - It rewrites saved segment filters and deletes the source tag, all in one transaction.

   → Task 5 tests.
4. **Select-all across pages** returns only the ids matching the current filter, capped at 10 000. When the total is over the cap, the API says so (`truncated: true`), so the UI never acts on a partial set silently. → Task 4 tests `select-all ids honours filter` and `select-all caps at 10000 and flags truncated`.
5. **Arabic names and values**:
   - The name split works on Arabic ("محمد أحمد علي" gives first "محمد" and last "أحمد علي").
   - Custom-field text values keep Arabic.
   - A number field rejects "١٢" written in Arabic-Indic digits unless they are normalized. Rule: normalize Arabic-Indic digits to ASCII before validating.

   → Task 2 and Task 3 tests.

---

### Task 1: Schema and migration

**Files:** Modify `backend/prisma/schema.prisma` and `backend/src/common/prisma-tenancy.ts`. Create `backend/prisma/migrations/20261109120000_contact_model/migration.sql`.

**Interfaces (produces):**
- `Contact` gains:
  - `firstName String?`, `lastName String?`, `email String?`
  - `marketingOptOut Boolean @default(false)`, `notALead Boolean @default(false)`
  - `ownerId String?` (relation `owner User? @relation("ContactOwner", onDelete: SetNull)`)
  - `fieldValues CustomFieldValue[]`
  - indexes `@@index([workspaceId, email])` and `@@index([workspaceId, ownerId])`
- `CustomFieldDef {id, workspaceId, entity String @default("contact"), key, label, labelAr, type, options Json?, order Int @default(0), archivedAt DateTime?, createdAt}`, with `@@unique([workspaceId, entity, key])` and `type ∈ text|number|date|select|boolean`.
- `CustomFieldValue {defId, contactId, value Json, updatedAt}`, with `@@id([defId, contactId])` and both FKs `onDelete: Cascade`.

- [ ] **Step 1:** Edit the schema. **Step 2:** Write the SQL:
  - `IF NOT EXISTS` on every column, table and index;
  - FKs wrapped in `DO $$ … duplicate_object` blocks;
  - backfill `UPDATE "Contact" SET "firstName" = split_part(trim(name), ' ', 1), "lastName" = NULLIF(trim(substr(trim(name), length(split_part(trim(name), ' ', 1)) + 1)), '') WHERE "firstName" IS NULL;`
- [ ] **Step 3:** `npx prisma validate` and `npx prisma generate`. Add `"CustomFieldDef"` to `SCOPED_MODELS`. `npx tsc --noEmit` passes.
- [ ] **Step 4:** Commit: `feat(contacts): schema for names, email, owner, consent, custom fields`.

### Task 2: Contact editing, consent, delete guard

**Files:** Modify `backend/src/contacts/contacts.dto.ts`, `contacts.service.ts`, `contacts.controller.ts`, `contacts.service.spec.ts`, `backend/src/campaigns/campaign-audience.ts`, `campaign-send.service.ts` and their specs. Create `backend/src/contacts/contact-name.ts` with `contact-name.spec.ts`.

**Interfaces (produces):**
- `splitName(name: string): {firstName: string; lastName: string | null}`, splitting on the first whitespace run after trim.
- `joinName(first?: string | null, last?: string | null): string`.
- `normalizeDigits(s: string): string`, which maps Arabic-Indic `٠-٩` and Persian `۰-۹` to `0-9`. It is exported for Task 3.
- Create and Update DTOs gain `firstName`, `lastName`, `email` (`@IsEmail()`, then lower/trim), `ownerId` (string|null; must be a `WorkspaceMember`, else 400 `owner is not a member`), `marketingOptOut`, `notALead`. `phone` is normalized with `normalizeDigits`.
- `shape()` adds `firstName`, `lastName`, `email` (`""` when null), `ownerId`, `marketingOptOut`, `notALead`, `createdAt`.
- `DELETE /contacts/:id`:
  - without `?force=1`, when the contact has tickets or appointments → 409 `{ message: "Contact has linked records", linked: { tickets, appointments } }`;
  - with `force=1`, it deletes (existing cascades apply).
- `AudienceContact` gains `marketingOptOut`. In `buildRecipients`, `marketingOptOut === true` counts as `skipped.optedOut`, the same as `churned`. `audience()` selects it.

- [ ] **Step 1: Failing tests:**
  - `splitName handles Arabic three-part names`
  - `splitName single word → lastName null`
  - `normalizeDigits maps Arabic-Indic and Persian digits`
  - `update with firstName/lastName rewrites name`
  - `update with only name splits into first/last`
  - `empty resulting name → 400`
  - `email lower-cased; invalid email → 400`
  - `owner not a member → 400`
  - `delete with linked tickets → 409 with counts`
  - `delete force=1 deletes`
  - `delete foreign contact → 404`
  - `opted-out contact is skipped by campaign send` (counted in `skipped.optedOut`)
- [ ] **Step 2:** Run the tests and expect them to FAIL. **Step 3:** Implement. **Step 4:** Run them and expect PASS.
- [ ] **Step 5:** Commit: `feat(contacts): editable names, email, owner, opt-out, delete guard`.

### Task 3: Custom fields API

**Files:** Create `backend/src/custom-fields/{custom-fields.module.ts,custom-fields.service.ts,custom-fields.controller.ts,custom-fields.dto.ts,custom-fields.service.spec.ts}` and register the module in `backend/src/app.module.ts`.

**Interfaces (produces):**
- `GET /custom-fields?includeArchived=0|1` → defs ordered by `order`.
- `POST /custom-fields {label, labelAr, type, options?}` → def.
  - The key is a slug of `label`: lower-case, `[a-z0-9_]`; if empty, `field_<n>`.
  - It must be unique per workspace, with a `_2`, `_3` suffix on a clash.
  - `select` requires `options: string[]` (1–50 items, trimmed, unique).
- `PATCH /custom-fields/:id {label?, labelAr?, options?, order?}`. Type is immutable (400).
- `GET /custom-fields/:id/delete-preview` → `{ valueCount }`.
- `DELETE /custom-fields/:id` sets `archivedAt` and returns `{ ok, valueCount }`. Values are kept.
- `GET /contacts/:id/fields` → `{ defId, key, label, labelAr, type, options, value }[]` for non-archived defs.
- `PUT /contacts/:id/fields { values: Record<defId, unknown | null> }` validates each value by type:
  - text: string, at most 2000 characters;
  - number: finite, after `normalizeDigits`;
  - date: `YYYY-MM-DD`;
  - select: one of the options;
  - boolean;
  - `null` deletes the value.

  An unknown or archived defId returns 404. The whole request is one transaction and returns the same list as GET.
- Exported for Task 4: `fieldWhere(def: {id; type}, op: "eq"|"contains"|"gt"|"lt"|"set"|"unset", value?: string): Prisma.ContactWhereInput`, built on `fieldValues: { some: { defId, value: { path: [], equals/string_contains/gt/lt } } }`. Use JSON filters that Prisma 5 supports on Postgres for `Json` columns. Document the chosen operator per type.

- [ ] **Step 1: Failing tests:**
  - `creates select field with options; rejects select without options`
  - `key slug unique with suffix`
  - `type is immutable`
  - `delete-custom-field-with-references archives and keeps values` (Review Focus 1)
  - `put validates by type` (one case each)
  - `number accepts Arabic-Indic digits` (Review Focus 5)
  - `null deletes value`
  - `archived def → 404 on put`
  - `foreign contact → 404`
  - `fieldWhere builds expected where for each type`
- [ ] **Step 2:** Run and expect FAIL. **Step 3:** Implement. **Step 4:** Run and expect PASS.
- [ ] **Step 5:** Commit: `feat(contacts): custom fields API`.

### Task 4: Shared list filter, select-all ids, bulk actions, paged records

**Files:**
- Create `backend/src/contacts/contact-filter.ts` with `contact-filter.spec.ts`.
- Modify `contacts.controller.ts`, `contacts.service.ts` and `contacts.service.spec.ts`.
- Create `backend/src/contacts/contacts-bulk.service.ts` with `contacts-bulk.service.spec.ts`, and register it in `contacts.module.ts`. Import `TicketsModule` or the service; check for module cycles and use `forwardRef` only if needed.

**Interfaces (produces):**
- `ContactListFilter`:

  ```ts
  {
    q?;
    segmentId?;
    lifecycle?: string[];
    tags?: string[];
    tagMode?: "any" | "all";
    ownerId?: string | "none";
    pipelineId?;
    stageId?;
    optOut?: boolean;
    notALead?: boolean;
    fields?: { defId; op; value? }[];
  }
  ```

  It is parsed from query params, where arrays are comma-separated and `fields` is JSON. Bad JSON returns 400.
- `buildContactWhere(workspaceId, f, deps): Promise<Prisma.ContactWhereInput>`:
  - It reuses `SegmentsService.resolveContactWhere` for `segmentId`.
  - Tags use exact jsonb-element matching via a raw id subquery or `string_contains` on the quoted name. Choose the approach that keeps "VIP" ≠ "VIPER", and test it.
  - `pipelineId`/`stageId` filter on `tickets: { some: { pipelineId, stageId?, closedAt: null } }`.
  - `fields` go through Task 3's `fieldWhere`, and each def must belong to the workspace.
- `/contacts/page` accepts the full filter and keeps its existing response shape.
- `GET /contacts/ids?<filter>` → `{ ids: string[], total: number, truncated: boolean }`, capped at 10 000.
- `POST /contacts/bulk { ids?: string[], filter?: ContactListFilter, op, ... }`:
  - exactly one of `ids`/`filter` is required; with `filter` the 10 000 cap applies and the response carries `truncated`;
  - `op` is one of:
    - `addTags {names}` / `removeTags {names}` (delegates to `TagsService.assign`);
    - `addToGroup {segmentId}` (manual groups only, else 400);
    - `setOwner {ownerId|null}` (membership checked);
    - `setOptOut {value}`, `setNotALead {value}`;
    - `addToPipeline {pipelineId, stageId?}`: one ticket per contact via `TicketsService.createTicket`, titled with the contact's name, in the first stage by `order` unless `stageId` is given. Contacts that already have an open ticket (`closedAt: null`) in that pipeline are skipped. Returns `{created, skipped}`.
    - `delete {force?}`: without force, linked contacts are skipped and returned in `blocked`.
  - It returns `{ affected, skipped?, blocked?, truncated? }`.
- `GET /contacts/:id/tickets?page&pageSize` and `GET /contacts/:id/appointments?page&pageSize` → `{items, total, page, pageSize, pageCount}`, newest first, `pageSize` capped at 50.

- [ ] **Step 1: Failing tests:**
  - `buildContactWhere` cases: each filter key; tag "VIP" ≠ "VIPER"; foreign field def → 404
  - `select-all ids honours filter`
  - `select-all caps at 10000 and flags truncated` (Review Focus 4)
  - `bulk requires exactly one of ids/filter`
  - `addToPipeline skips contacts with an open ticket and uses first stage`
  - `addToGroup rejects non-manual group`
  - `bulk delete without force reports blocked`
  - `paged tickets for contact`
  - `foreign contact → 404`
- [ ] **Step 2:** Run and expect FAIL. **Step 3:** Implement. **Step 4:** Run and expect PASS, plus `npx jest src/tickets src/segments src/tags`.
- [ ] **Step 5:** Commit: `feat(contacts): shared list filter, select-all, bulk actions, paged records`.

### Task 5: Merge tags

**Files:** Modify `backend/src/tags/tags.module.ts` and its spec (create `tags.service.spec.ts` if none exists).

**Interfaces (produces):** `POST /tags/merge { fromIds: string[], intoId: string }` → `{ contactsUpdated, segmentsUpdated, removed: number }`.
- All ids must be in the workspace (404 otherwise). `intoId` must not appear in `fromIds` (400).
- Everything runs in one transaction:
  - for each source tag, rewrite contact arrays with the same exact-element jsonb SQL that `update()` uses for renames, with `DISTINCT` to dedupe;
  - rewrite saved crm segment filters with `rewriteFilterTagName`;
  - delete the source tags.

- [ ] **Step 1: Failing tests:**
  - `merge rewrites exact elements only (VIP≠VIPER)`, asserting on the SQL parameters/shape the way existing tag specs do
  - `merge rewrites segment filters`
  - `into in from → 400`
  - `foreign tag → 404`
- [ ] **Steps 2–4:** RED, implement, GREEN.
- [ ] **Step 5:** Commit: `feat(tags): merge tags`.

### Task 6: Contact drawer — edit details, custom fields, consent, records, delete guard

**Files:**
- Create `src/screens/contacts/ContactDetailsForm.tsx`: edit mode for first/last name, phone, email, owner (from `GET /team`), lifecycle select, marketing opt-out toggle and not-a-lead toggle. Saves through `PATCH /contacts/:id`. On 400, the server message is shown inline.
- Create `src/screens/contacts/CustomFieldsCard.tsx`: an inline editor per type (text, number, date, select dropdown, boolean toggle) that saves through `PUT /contacts/:id/fields`.
- Create `src/screens/contacts/ContactRecords.tsx`: paged tickets and bookings, using `Pager` with page size 10.
- Create `src/screens/contacts/DeleteContactDialog.tsx`. On 409 it shows the linked counts and a "Delete anyway" button (`?force=1`).
- Modify `src/screens/contacts/ContactDetailDrawer.tsx` to mount these. Opted-out shows a badge `tx("Opted out of marketing","ألغى الاشتراك في التسويق")`; not-a-lead shows `tx("Not a lead","ليس عميلًا محتملًا")`.
- Modify `src/lib/types.ts`: `Contact` gains the Task 2 fields. Add `CustomFieldDef` and `ContactFieldValue`.
- Pure logic goes in `src/screens/contacts/fieldValue.ts` with `fieldValue.test.ts`: `parseFieldInput(type, raw): {ok: true, value} | {ok: false, error}`, which mirrors the server rules including Arabic-Indic digit normalization, and `formatFieldValue(type, value, lang)`.

- [ ] **Step 1:** Write failing vitest tests for `fieldValue.ts`, one case per type, including Arabic digits and an invalid date. **Step 2:** Implement until they pass.
- [ ] **Step 3:** Build the components. `npm run typecheck` is clean.
- [ ] **Step 4:** Commit: `feat(contacts): editable drawer with custom fields, consent, records, delete guard`.

### Task 7: Contacts list — filters, bulk bar, select-all, fields settings, merge tags, new contact

**Files:**
- Create `src/screens/contacts/ContactFilterBar.tsx`. Filter chips with popovers for lifecycle (multi), tags (any/all), owner (incl. "Unassigned"), pipeline then stage, opted-out, not-a-lead, and custom field (pick a field, then an operator valid for its type, then a value). Filter state lives in the hash query `#/contacts?cf=<base64 json>`. Reuse the unicode-safe encode/decode approach from `src/screens/inbox/inboxHash.ts`; extract it into a shared `src/lib/hashState.ts` with tests if that avoids duplication, and update inbox to use it.
- Create `src/screens/contacts/contactFilter.ts` with tests: `toQuery(filter): URLSearchParams`, matching the backend parser, and `activeCount(filter)`.
- Modify the bulk bar in `src/screens/Contacts.tsx`, adding Remove tag, Add to pipeline (pipeline and stage picker; toast "Added n · skipped m"), Set owner, Opt out / opt in, Mark not a lead, and Add to group.
  - **"Select all n matching"** appears once the whole page is selected. It calls `GET /contacts/ids` and uses those ids. When the response says `truncated`, show `tx("Only the first 10,000 will be included.","سيتم تضمين أول ١٠٬٠٠٠ فقط.")`.
  - Bulk delete reports blocked contacts and offers force.
- Create `src/screens/contacts/FieldsTab.tsx`, a 4th Contacts tab "Fields / الحقول" visible to owner/admin roles: list, create (label EN/AR, type, options for select), rename, reorder with up/down, and delete with a preview count.
- Modify `src/screens/contacts/TagsTab.tsx`, adding "Merge into…": select source tags, pick a target, confirm with counts.
- Create `src/screens/contacts/NewContactModal.tsx`, replacing the quick-create with first/last, phone, email, owner, lifecycle and tags. If the existing quick-create is used elsewhere, keep its props.

- [ ] **Step 1:** Write failing tests for `contactFilter.ts` (and `hashState.ts` if extracted). **Step 2:** Implement until they pass.
- [ ] **Step 3:** Build the components. `npm run typecheck` and `npx vitest run` pass.
- [ ] **Step 4:** Commit: `feat(contacts): filters, bulk actions, select-all, custom field settings, merge tags`.

### Task 8: End-to-end verification

- [ ] **Step 1:** Apply the migrations through the user's own deploy path. The agent tooling may not touch the production DB. Then start the backend on a spare port (4100 is used by `crm-mobile`) and Vite against it, following the `verify` skill.
- [ ] **Step 2:** Check, then revert any test data:
  - Edit a contact's names, email and owner, then reload and confirm they persisted.
  - Create a field of each type, then set and clear its values.
  - Delete a field → the preview count matches, and it disappears from the drawer.
  - Opt a contact out → the campaign preview's skipped count rises.
  - Filter by tag, owner and custom field → the counts match.
  - Select all matching → a bulk tag, then remove it.
  - Add to pipeline → tickets are created and the second run skips them.
  - Merge two test tags.
  - Delete a contact that has tickets → 409 dialog.
  - Arabic UI and RTL.
- [ ] **Step 3:** Run the full suites, typecheck and build. **Step 4:** Tick SP-02 in the roadmap.
