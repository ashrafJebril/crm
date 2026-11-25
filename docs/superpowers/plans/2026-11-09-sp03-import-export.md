# SP-03 Contacts Import & Export: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- **Import:** upload a CSV or XLSX file, map its columns to contact and custom fields, preview the outcome (new, update, unchanged, invalid), then run it as a resumable background job with progress and a result screen.
- **Optional extras on import:** tag the imported contacts, add them to a group, or place them in a pipeline.
- **Export:** stream a CSV of the currently filtered contact list (Excel-safe UTF-8 with BOM).
- **Audiences:** create a new audience group straight from a file.

**Architecture:**
- **Parsing:** `exceljs` reads both CSV and XLSX. It is a new backend dependency (ruling D1).
- **Storage:** the uploaded file goes through the existing media storage (`MediaService`), and an `ImportJob` row tracks it.
- **Running:** the job processes 500 rows per batch, yielding the event loop with `setImmediate` between batches, and persists `processed` after each batch.
- **Resume:** a `@Cron(EVERY_MINUTE)` sweep resumes `running` jobs whose heartbeat is older than 2 minutes, so a crash or restart continues from `processed`.
- **Matching:** existing contacts are matched by normalized phone (E.164), then by email.
- **Export:** reuses SP-02's shared `buildContactWhere`, so it matches the list exactly. It streams with a Prisma cursor in pages of 1000.

**Tech Stack:** NestJS 10, Prisma 5, jest, exceljs (backend); React 18, vitest (frontend).

**Spec:** `docs/superpowers/plans/2026-11-08-tkana-parity-roadmap.md` §SP-03 and Review Focus 3 and 5. Tkana reference: `apps/web/app/components/crm/contacts-import/*`, `routes/crm.contacts.imports.$id.ts`, `routes/crm.contacts.export.ts`, `routes/marketing.tsx` (`importAndCreateGroup`).

## Global Constraints
- **File limits:** ≤ 10 MB, ≤ 50 000 data rows; `.csv` or `.xlsx` only. Anything else is a 400 with a bilingual message key.
- **Header row:** the first non-empty row. Empty columns are ignored, and duplicate header names get a `_2` suffix.
- **Mapping targets:** `firstName`, `lastName`, `name`, `phone`, `email`, `lifecycle`, `tags` (split on `,`, `;` or `،`), `owner` (member email or name), `source`, `industry`, `value`, `custom:<defId>`, `ignore`.
  - At least one of `name`, `firstName` or `phone` must be mapped.
  - Custom values are validated with SP-02's rules, including Arabic-Indic digits.
- **Phone normalization:** `normalizeImportPhone(raw, defaultCountryCode)`.
  - It accepts `+CC…` and `00CC…`.
  - A local `0…` number gets `defaultCountryCode` after the leading 0 is dropped.
  - Arabic-Indic digits are normalized first.
  - `defaultCountryCode` comes from `Workspace.timezone`: Asia/Dubai → 971, Asia/Riyadh → 966, Asia/Amman → 962, Asia/Kuwait → 965, Asia/Qatar → 974, Asia/Bahrain → 973, Asia/Muscat → 968, Africa/Cairo → 20. Anything else has no default, so local numbers are invalid.
- **Matching:** with `matchBy: "phone_then_email"` (the default), a row with an existing normalized phone or email in the workspace is an update when `updateExisting` is set. Otherwise it is "unchanged/skipped".
  - Duplicate rows inside the file are merged: the first wins and later ones are counted as `duplicateInFile`.
- **Invalid rows:** no name, phone or email, a bad email, or a bad custom value. They are counted, and the first 50 are kept with their reasons (row number, column, message key).
- **Lifecycle values** are lower-cased (SP-02's `normalizeLifecycle`).
- **Permissions** (SP-25):
  - `POST /imports`, preview and run require `contacts.create`. Run with `updateExisting` also requires `contacts.update`.
  - Export requires `contacts.manage`, so only owners and admins can bulk-export.
  - Audience import also requires `audiences.create`.
  - Every new route goes in `permission-map.ts`, or the coverage spec fails.
- **Migration:** hand-written `backend/prisma/migrations/20261110120000_import_jobs/migration.sql`, additive and idempotent.
- **Copy and layout:** every user-facing string goes through `tx("English","العربية")` with real Arabic. Use logical CSS, and set `dir="auto"` on cell values in previews.
- **Tests:** backend `npx jest src/imports src/contacts` plus tsc; frontend `npx vitest run` plus `npm run typecheck`. The known unrelated failure is hjz-sync.
- **Commits:** selective `git add`; trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus
1. **50k rows:**
   - The import runs in batches without blocking the event loop.
   - The test `import-50k.spec.ts` generates 50 000 rows and asserts the batch count, the progress writes, and that the work yields between batches. The yield is spied on.
   - Export of 100k rows streams. The test asserts cursor paging and that the full set is never loaded at once.
2. **Arabic round-trip:** `csv-arabic-roundtrip.spec.ts` exports contacts with Arabic names and tags (BOM present), re-parses the output, and gets the same values.
3. **Phone normalization:** `+971501234567`, `00971501234567` and `0501234567` (Asia/Dubai) all resolve to the same contact. `٠٥٠١٢٣٤٥٦٧` resolves too.
4. **Resume after a crash:** a job left `running` with `processed=1000` and a stale heartbeat resumes at row 1000. Already-created contacts are not duplicated, because rows are re-matched by phone or email.
5. **Tenancy:** a foreign job id returns 404. Owner, custom-field and group ids in the mapping or options are validated against the workspace.

---

### Task 1: ImportJob schema, parser, normalization
**Files:**
- `backend/prisma/schema.prisma` and `backend/prisma/migrations/20261110120000_import_jobs/migration.sql`
- `backend/package.json`: add `exceljs`. Install with the repo's package manager for backend/; check for a lockfile.
- `backend/src/imports/parse-file.ts` with `parse-file.spec.ts`
- `backend/src/imports/phone.ts` with `phone.spec.ts`
- `prisma-tenancy.ts`: add `ImportJob`.

**Produces:**
- `ImportJob {id, workspaceId, createdById, kind:"contacts"|"audience", status:"uploaded"|"previewed"|"running"|"done"|"failed"|"cancelled", fileMediaId, fileName, totalRows Int, processed Int @default(0), created Int @default(0), updated Int @default(0), skipped Int @default(0), failed Int @default(0), duplicateInFile Int @default(0), errors Json @default("[]"), mapping Json?, options Json?, heartbeatAt DateTime?, startedAt?, finishedAt?, createdAt}`, with `@@index([workspaceId, createdAt])` and `@@index([status, heartbeatAt])`.
- `parseFile(buffer, fileName): Promise<{ headers: string[]; rows: string[][] }>`. It handles CSV (comma or semicolon auto-detect, quoted fields, a BOM) and XLSX (first sheet; cells coerced to string; dates as ISO `YYYY-MM-DD`). It throws a typed error with a message key for empty, too-large or unsupported files.
- `normalizeImportPhone(raw, cc?): string | null` and `countryCodeForTimezone(tz): string | null`.

- [ ] Write the failing tests:
  - CSV with BOM and Arabic
  - semicolon CSV
  - quoted commas
  - XLSX fixture built in-test with exceljs
  - empty file → error
  - > 50 000 rows → error
  - duplicate headers suffixed
  - each phone case in Review Focus 3
- [ ] Implement them; the tests pass.
- [ ] Commit `feat(imports): job schema, CSV/XLSX parser, phone normalization`.

### Task 2: Import API and background runner
**Files:** create `backend/src/imports/{imports.module.ts,imports.service.ts,imports.controller.ts,imports.dto.ts,import-runner.service.ts,import-resume.scheduler.ts}` and their specs. Register the module and the permission-map entries.

**Produces:**
- `POST /imports` (multipart `file`, `kind`) returns `{ id, fileName, headers, sampleRows (first 20), totalRows, suggestedMapping }`.
  - `suggestedMapping` matches EN and AR header synonyms to targets. Examples: "Phone"/"Mobile"/"الجوال"/"الهاتف" → phone; "Name"/"الاسم" → name; "Email"/"البريد" → email; "Tags"/"الوسوم" → tags.
- `POST /imports/:id/preview { mapping, options }` returns `{ counts: {new, update, unchanged, invalid, duplicateInFile}, invalidSamples: [{row, column, key}] }` and stores the mapping and options. It processes all rows in memory-safe batches.
  - Options: `{ matchBy:"phone_then_email"|"phone"|"email", updateExisting:boolean, tags?:string[], ownerId?:string, groupId?:string, newGroupName?:string (audience kind), pipeline?:{pipelineId, stageId?} }`.
- `POST /imports/:id/run` sets status `running` and kicks the runner with `setImmediate`. It returns the job.
- `GET /imports/:id` returns the job (progress), and `GET /imports?limit=10` returns recent jobs.
- `POST /imports/:id/cancel` sets `cancelled`, and the runner stops at the next batch.
- **Runner:**
  - Each batch of 500 rows: match, then `createMany` new contacts with their custom values, then update existing ones, then apply tags (SP-02 `TagsService.assign`, which is set-based), then group membership, then pipeline placement.
  - Pipeline placement uses SP-02's bulk addToPipeline logic and keeps its 500 cap. A larger import with a pipeline is refused at preview with a 400 key.
  - After each batch it writes `processed`, the counters and `heartbeatAt`, then yields with `await new Promise(r => setImmediate(r))`.
  - At the end: status `done`, `finishedAt`, and a notification to `createdById` of type `import_finished` with key `"import.finished"` and params `{created, updated, failed}`. This uses SP-05's `NotificationsService.notify`.
  - Workflows: `createMany` emits no per-contact `contact_created` workflow trigger. That is acceptable for bulk imports; document it.
- **Resume scheduler:** every minute, jobs with `status="running"` and a heartbeat older than 2 minutes are re-kicked from `processed`.
- **Audience kind:** creates a manual group named `newGroupName` (or uses `groupId`), and every imported or matched contact is added.

- [ ] Write the failing tests:
  - `import-50k.spec.ts` (Review Focus 1)
  - preview counts
  - `updateExisting=false` → unchanged
  - duplicate in file
  - invalid samples capped at 50
  - owner by email resolves; a foreign owner is invalid
  - custom field validation
  - resume after crash (Review Focus 4)
  - cancel stops
  - notification sent
  - audience kind creates group
  - pipeline > 500 → 400
  - foreign job → 404
- [ ] Implement them; the tests pass. Run the full jest suite once.
- [ ] Commit `feat(imports): import preview, background runner, resume and audience import`.

### Task 3: Export
**Files:** `backend/src/contacts/contacts-export.service.ts` with its spec, the controller route `GET /contacts/export`, and the permission map.

**Produces:**
- `GET /contacts/export?<ContactListFilter>&ids=` sets `Content-Type: text/csv; charset=utf-8` and `Content-Disposition: attachment; filename="contacts-YYYY-MM-DD.csv"`, and writes the BOM.
- **Columns:** `id, firstName, lastName, name, phone, email, lifecycle, tags, owner, source, industry, marketingOptOut, notALead, createdAt`, plus one column per non-archived custom field (header = label).
- The CSV is RFC4180-escaped, and tags are joined with `", "`.
- It streams pages of 1000 by cursor.
- `ids` (optional, comma-separated, max 10 000) exports a selection.
- **Restricted viewers** (SP-25): `contacts.manage` already excludes agents. Super-admin and impersonation follow the bypass rules.

- [ ] Write the failing tests:
  - `csv-arabic-roundtrip.spec.ts` (Review Focus 2)
  - cursor paging for 100k mocked rows, never one `findMany` without `take`
  - escaping of quotes, commas and newlines
  - `ids` selection
  - filter parity with `/contacts/page` (same where)
- [ ] Commit `feat(contacts): streamed CSV export`.

### Task 4: Frontend: import wizard and export
**Files:**
- Create `src/screens/contacts/import/{ImportWizard.tsx, StepUpload.tsx, StepMap.tsx, StepPreview.tsx, StepRun.tsx, importMapping.ts}`, plus `importMapping.test.ts`.
- Modify `src/screens/Contacts.tsx` (Import and Export buttons in the toolbar, gated on `contacts.create` and `contacts.manage`).
- Modify `src/screens/contacts/GroupsTab.tsx` ("Import file" opens the wizard in audience kind, gated on `audiences.create`).

**Produces:**
- **Wizard:**
  - Upload: drag and drop or pick a file, with size and type checks client-side too.
  - Map: one select per column showing a sample value, a required-mapping check, and a custom field picker.
  - Options: match, update existing, tags, owner, group, pipeline.
  - Preview: the counts plus the invalid rows with translated reasons.
  - Run: a progress bar polling `GET /imports/:id` every 1.5 s, with Cancel.
  - Result: counts, "View contacts" (applies a `createdAt >= startedAt` filter if one exists; otherwise refreshes), and "Download errors as CSV" (client-side from `errors`).
  - Closing during a run keeps the job going. A small "Import running n%" chip appears in the Contacts header, polling until done.
- `importMapping.ts`: `validateMapping(mapping): {ok} | {error key}` and `targetsFor(customDefs)`.
- **Export:** a button that downloads the current filter (or the selection, when rows are selected) via an `<a href>` with the auth token. Check how other file downloads authenticate in `src/api/client.ts`. If downloads need a header, fetch a blob and save it.

- [ ] Write failing vitest tests for `importMapping.ts`, then implement until they pass.
- [ ] Build the components; typecheck and vitest are clean.
- [ ] Commit `feat(contacts): import wizard and CSV export`.

### Task 5: Verification
- Apply the migration once it has been checked safe for the deployed code; the user's permission is required.
- **Live checks** (all test data reverted afterwards):
  - import a 20-row CSV with Arabic and mixed phone formats;
  - preview counts are correct;
  - run, then verify that a re-run gives updates or unchanged rows;
  - export and re-import round-trip;
  - audience import creates a group.
- Tick SP-03 in the roadmap.
