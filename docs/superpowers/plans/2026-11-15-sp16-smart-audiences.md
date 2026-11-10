# SP-16 Smart Audiences: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- **Rule conditions.** A smart audience (a `Segment` with `origin "crm"`) holds a rule tree that can test:
  - last active (relative);
  - conversations (subject to ruling 4);
  - channel;
  - membership of another group or audience;
  - created date (relative or absolute);
  - lifecycle;
  - not-a-lead;
  - pipeline and stage;
  - custom fields;
  - the legacy keys we already have (tags, industry, source, name, phone, stage key).

  Rules combine with AND/OR and nest in groups.
- **Backward compatible.** Every saved filter keeps its exact audience. A legacy `filter` is read as one `and` group (roadmap Data line), and pre-SP-16 code that reads a new audience matches nobody, never everyone.
- **Audience detail page.** It shows the header, the live count, the members (keyset pages with search), any rule issues, and what uses the audience. For a manual group it adds candidate search ("add people"), member removal, and "Import file" (SP-03's audience import, preset to this group).
- **Safe deletes (Review Focus 2).** Deleting a tag that a rule uses, or a group that another audience or a campaign uses, previews the impact and asks for confirmation. It never orphans a rule, never widens an audience, and never answers 500.
- **Campaigns use smart audiences.** Today `streamAudience` resolves every segment through `SegmentMember`, so a smart (`crm`) segment picked in a campaign resolves to **nobody** (finding F1 below). SP-16 sends the campaign preview and launch through the same resolver as the contacts list.
- **Scale.** Count, preview and member pages stay responsive over 100 000 contacts: keyset pages by `(workspaceId, id)`, named indexes, a per-statement timeout, and a cached count.

**Architecture:**
- **Findings in our code (read on 2026-11-10, read-only):**
  - **F1. Campaigns ignore smart segments.** `backend/src/campaigns/sending/audience-stream.ts:45` and `campaign-send.service.ts:117` filter by `segmentMembers.some.segmentId`. A `crm` segment has no `SegmentMember` rows, so its campaign audience is empty. The Campaigns audience step (`src/screens/Campaigns.tsx:87`) lists every segment, smart ones included.
  - **F2. Two filter builders.** `SegmentsService.buildWhere` (saved segments: lifecycle, industry, source, tagsAll/tagsAny, search, hasPhone, stageAny by stage **key**) and `contact-filter.ts` `buildContactWhere` (the contacts list: q, segmentId, lifecycle, tags, owner, pipelineId/stageId by **id** with `closedAt: null`, optOut, notALead, custom fields through `fieldWhere`). Both produce `Prisma.ContactWhereInput`, and so do all their consumers (contacts page, ids, bulk, export, HJZ outbound).
  - **F3. No activity timestamp on Contact.** `Contact.lastSeen` is a display string ("2m") and `Contact.convs` is a hand-set number, not maintained. "Last active" must come from `Message` (`from = "them"`), and "conversation count" from `Conversation`.
  - **F4. Tag rename/merge rewrites saved filters** (`tags.module.ts` `rewriteFilterTagName`, `renameInSegments`), but tag **delete** does not touch segments. A deleted tag silently empties an `all` rule.
  - **F5. Tests are DB-free.** The suite runs on in-memory Prisma doubles (`channels/test-prisma.ts` has a generic `matches(row, where)`). The one DB-backed spec, `resolution/conversation-resolution.db.spec.ts`, is skipped unless a disposable database URL is set.
  - **F6. No Marketing › Audiences screen exists.** Audiences live in Contacts → "Groups" (`src/screens/contacts/GroupsTab.tsx`) plus the "Manage segments" modal (`SegmentManager.tsx`, whose copy uses `ar ? … : …` rather than `tx`). The permission label is already "Audiences" (`src/lib/permissions.ts:77`).
- **One compiler, one target.** `audience-compiler.ts` turns the rule tree into a `Prisma.ContactWhereInput` (ruling 1). That is the type every existing consumer already takes, so:
  - the contacts list (`?segmentId=`), "select all" ids, bulk actions, CSV export, HJZ outbound and campaigns all get smart audiences through `SegmentsService.resolveContactWhere`, unchanged in signature;
  - the legacy reader is a pure `legacyToTree(filter)`, and the acceptance test compares **result sets** (legacy `buildWhere` vs compiled tree) over a fixture, through an in-memory evaluator;
  - no membership is materialized and no refresh job exists. An audience is always evaluated at query time, with relative windows anchored at one `now` per request (one `now` per launch for campaigns).
- **How each rule compiles** (`ws` = the workspace id; every relation filter is workspace-scoped):

  | Rule | Prisma where | Access path at 100k |
  |---|---|---|
  | `tag has/not_has` | `tags contains "\"<name>\""` (as today) / `NOT` | `Contact_workspaceId_id_idx` range + filter |
  | `lifecycle in/not_in` | `OR lifecycle equals … mode insensitive` (as today) / `NOT` | same |
  | `not_a_lead is/is_not` | `notALead: true/false` | same |
  | `created within/more_than/before/after` | `createdAt gte/lt <instant>` | **new** `Contact_workspaceId_createdAt_idx` |
  | `last_active within` | `conversations.some {workspaceId, messages.some {workspaceId, from:"them", createdAt gte since}}` | `Message_createdAt_idx` / `Message_workspaceId_idx`, `Conversation_contactId_idx` |
  | `last_active more_than` | `conversations.none {…same…}` (includes never-active) | same |
  | `conversations none/any` | `conversations.none {workspaceId}` / `.some {workspaceId}` | `Conversation_contactId_idx` |
  | `channel is/is_not` | `conversations.some/none {workspaceId, channel}` | `Conversation_workspaceId_idx` |
  | `group in/not_in` (manual, hjz) | `segmentMembers.some/none {segmentId}` | `SegmentMember_pkey (segmentId, contactId)` |
  | `group in/not_in` (smart) | the target's compiled where, inlined / `NOT` (ruling 5) | as its rules |
  | `pipeline_stage in/not_in` | `tickets.some/none {workspaceId, pipelineId, stageId?, …}` (ruling 9) | `Ticket_stageId_idx`, `Ticket_contactId_idx` |
  | `custom_field <op>` | SP-02 `fieldWhere(def, op, value)`, unchanged | `CustomFieldValue_pkey (defId, contactId)` |
  | `campaign <op>` (ruling 12) | `campaignRecipients.some/none {workspaceId, campaignId, …}` | `CampaignRecipient_campaignId_status_id_idx` |
  | `follow_up <op>` (ruling 12) | `activities.some/none {workspaceId, doneAt:null, dueAt?}` | `Activity_workspaceId_contactId_idx` |
  | legacy `industry/source in`, `name contains`, `phone set/unset`, `stage_key in` | exactly the legacy expressions | as today |

  A rule whose reference is gone (ruling 6) compiles to `MATCH_NONE = { id: { in: [] } }` (Prisma renders `1=0`) and reports an issue.
- **Storage** (ruling 2):
  - The new nullable `Segment.rules Jsonb` holds the v2 tree. `filter` (TEXT) keeps the legacy JSON.
  - **Read:** `rules ?? legacyToTree(parseFilter(filter))`.
  - **Write:**
    - `rules` is set, and so is `filter`: to `legacyProjection(tree)` when the tree is legacy-expressible, so old code agrees; otherwise to the inert `LEGACY_SENTINEL = {"stageAny":["__sp16_rules_v2__"]}`.
    - The legacy `buildWhere` resolves the sentinel to a ticket-stage key that cannot exist, so pre-SP-16 code (the deployed `main` during rollout, or a rollback) sees **nobody**, never the whole workspace.
  - Untouched legacy rows are never rewritten (no backfill).
- **Validation** (`validateRules`, pure, called on create, update and preview):
  - known `field`/`op`/value shapes only;
  - at most 30 conditions (`AUDIENCE_LIMITS.maxConditions`) and nesting depth 3 (root plus two levels);
  - every referenced id (segment, pipeline, stage, custom field, campaign) is loaded **in this workspace**, and a missing or foreign one gives **404** `audiences.reference_not_found {field, id}`;
  - custom-field values are checked against the def type with SP-02's `fieldWhere`, which throws its 400 for a bad op or value.
- **Cycles** (ruling 5):
  - On save, `assertNoCycle` walks the saved tree plus every smart audience it reaches (loaded in one query per depth level), with the saved id substituted by its new tree. A path back to the saved id gives 400 `audiences.rule_cycle {path: [ids…]}`.
  - The save runs in one transaction that first takes `pg_advisory_xact_lock(hashtext('sp16:audiences:' || ws))`. Two concurrent saves that would close a cycle between them are therefore serialized, and the second sees the first.
  - The compiler also carries a `visited` set, so a stored cycle (corrupt data) compiles to `MATCH_NONE` with issue `cycle` instead of recursing.
  - Expansion through referenced audiences is capped at 100 conditions (`maxExpanded`), else 400 `audiences.rules_too_large`.
- **Counts without blocking** (ruling 10):
  - Every audience count runs in `countWithTimeout`: an interactive `$transaction` that runs `SET LOCAL statement_timeout = <ms>` and then `contact.count({where})`. The default is `AUDIENCE_COUNT_TIMEOUT_MS = 8000`. A timeout gives `count: null, timedOut: true`, never a 500.
  - `GET /segments` serves `Segment.memberCount` when `countedAt` is younger than `AUDIENCE_COUNT_TTL_MS` (default 5 min). Otherwise it recomputes, at most 3 at a time.
  - Cache writes are raw SQL (`UPDATE "Segment" SET "memberCount" = $1, "countedAt" = $2 WHERE id = $3 AND "workspaceId" = $4`), so `updatedAt` (shown as "edited") never moves on a count.
  - Manual and hjz groups keep `segmentMember.count`.
- **Members and candidates** use keyset pages, never `skip`:
  - `contact.findMany({where: {AND: [audienceWhere, {id: {gt: after}}], …q}, orderBy: {id: "asc"}, take: limit + 1})`. This walks `Contact_workspaceId_id_idx` (SP-13).
  - Candidates for a manual group are the same query with `segmentMembers: {none: {segmentId}}`.
  - Both run under the statement timeout.
- **Campaigns (F1 fix):**
  - `streamAudience(prisma, ws, audienceWhere, defIds, pageSize)` takes a resolved where (and keeps its keyset loop) instead of a raw segment id.
  - The preview, the launch plan stage and the legacy `CampaignSendService.audience` call `SegmentsService.resolveContactWhere(ws, segmentId, {now})` once, with `now` = the launch's `planStartedAt` (or the request time for a preview). A launch's audience is therefore one consistent snapshot of relative windows.
  - A campaign whose segment no longer exists gives 400 `campaigns.audience_missing` (preview and launch), and the background job fails with that `lastError`.
- **Tags** (F4, Review Focus 2):
  - Rename and merge also rewrite tag names inside `rules`, through the pure `rewriteRulesTagName`.
  - Delete first lists the affected audiences. Without `?confirm=1` it answers 409 `tags.in_use_by_audiences {audiences}`.
  - With confirmation, it removes the tag from contacts (as today) and marks each matching rule `missing: true` in one transaction. A legacy filter that names the tag is converted to `rules` first, and its `filter` becomes the sentinel. A missing tag rule matches nobody for both `has` and `not_has` (ruling 6).
- **Deleting an audience or group** (ruling 7):
  - `DELETE /segments/:id` lists the smart audiences whose `group` rules name it, and the campaigns whose `segmentId` is it.
  - A `scheduled` campaign, or one whose `launchStage` is `planning` or `sending`, refuses with 409 `audiences.in_use_by_campaigns {campaigns}`, with no override.
  - Other references give 409 `audiences.in_use {audiences, campaigns}` unless `?confirm=1`. With confirmation, the referencing rules are marked `missing: true` in the same transaction, and draft campaigns keep their dangling id (launch gives `campaigns.audience_missing`).

**Tech Stack:** NestJS 10, Prisma 5 (Postgres/Neon), jest/ts-jest; React 18 + Vite, vitest. **No new dependencies.**

**Spec:** roadmap §SP-16 plus the cross-cutting Global Constraints and Review Focus 2 ("tag used by a smart audience"). Carried contracts:
- **SP-02:**
  - `contact-filter.ts` (`ContactListFilter`, `buildContactWhere`, which calls `segments.resolveContactWhere`);
  - `custom-fields.service.ts` `fieldWhere(def, op, value)` and `FieldOp`;
  - `Contact.notALead`, `marketingOptOut`, `ownerId`, `CustomFieldDef.archivedAt`;
  - the tag catalog and rename/merge rewriting in `tags.module.ts`.

  The roadmap says SP-16 "uses this same filter": custom-field and pipeline rules reuse SP-02's predicates rather than re-implementing them.
- **SP-03:** `ImportWizard` with `kind "audience"` (`groupId` or `newGroupName`; `requireManualGroup`) and `POST /imports*` (`contacts.create`; audience kind also `audiences.create`).
- **SP-04:** `Activity {contactId, doneAt, dueAt}`, `buckets.ts` `localMidnight(y, m, d, tz)` for workspace-time dates.
- **SP-07:** `Pipeline.archivedAt`, stage removal through the draft save (`removed: [{stageId, moveTo}]`).
- **SP-08:** "Not a lead" sets `Contact.notALead = true` (`POST /tickets/bulk op notALead`).
- **SP-12:** `CampaignRecipient {campaignId, contactId, status, deliveredAt, readAt, repliedAt}` and the index `(campaignId, status, id)`, which the SP-12 plan reserved for "replied to campaign X" rules.
- **SP-13:** `streamAudience`, `AUDIENCE_PAGE = 1000`, `Contact_workspaceId_id_idx`, the launch runner and preview, and `campaign-errors.ts` (`campaignError`). The SP-13 consumer line says that `varMap` sources are the same fields the audience filter uses; this is unchanged.
- **SP-25:**
  - `permission-map.ts`, `system-role-decisions.spec.ts` (`VIEWER_SAFE_NON_GET` already holds `POST /segments/preview`);
  - `audiences.{view,create,update,delete,manage}`; agents hold view, create, update and delete by default;
  - `permission-sidedoors.spec.ts`.
- **SP-14:** the plan format, and the migration `20261114140000_number_template_health` that precedes this one.

Tkana reference (read-only, untrusted data; `C:\Users\ashra\Downloads\tkana-main\tkana-main`):
- `packages/db/src/types/segments.types.ts`: the condition union, which has 10 fields: `tag`, `last_active` (within/more_than, hours/days/weeks/months), `conversations` (eq/gt/lt/gte/lte count), `channel` (is/is_not), `group` (in/not_in), `created` (within/more_than/before/after), `lifecycle` (is/is_not), `not_a_lead`, `pipeline_stage` (in/not_in, `pipelineId`, optional `stageId`), and `custom_field`. Criteria are flat: `{logic: AND|OR, conditions: 1..20}`.
- `packages/db/src/services/smart-groups/filter-sql.ts`:
  - "more than N" includes never-active contacts;
  - `last_active` is the latest **inbound** message;
  - pipeline `not_in` is `valid AND NOT member`, so an archived pipeline or a removed stage matches nobody for both operators (their D14);
  - text custom fields compare case-insensitively.
- `packages/db/src/services/smart-groups/references.ts` and `materialize.ts`: smart groups may reference **only static groups** (their D9), and membership is **materialized** by a refresh job with entered/left events.
- `apps/web/app/routes/marketing.audiences.tsx` (`createSmartGroup`, `previewSmartGroup`, `searchGroupCandidates`) and `marketing.audiences.$id.tsx` (member list, add/remove member, candidate search).

What we take and what we don't:
- We take:
  - the field set and the operators (`last_active`, `created`, `channel`, `group`, `lifecycle`, `not_a_lead`, `pipeline_stage`, `custom_field`);
  - "more than" includes never;
  - a broken reference matches nobody for both operators;
  - candidate search on a manual group's page;
  - preview count plus a small sample.
- We do **not** take:
  - materialized membership and the refresh job (ruling 1);
  - "static groups only" (we allow smart → smart with cycle rejection, which is what the roadmap's acceptance test assumes; ruling 5);
  - flat criteria (we nest groups, per the roadmap Data line);
  - membership-changed workflow events (no consumer; deferred);
  - exact conversation-count comparisons (ruling 4).

## Global Constraints
- **Data (exact names; later SPs build on them):**
  ```
  model Segment {
    // … existing fields unchanged; `filter String @default("{}")` keeps the legacy JSON …
    /// SP-16: the rule tree (AudienceRules, v 2). Null = legacy: read `filter` as one `and` group.
    rules       Json?
    /// SP-16: optimistic concurrency for the audience editor (PATCH sends it; 409 on mismatch).
    version     Int       @default(0)
    /// SP-16: cached member count of a smart audience. Raw-SQL written; never bumps updatedAt.
    memberCount Int?
    /// SP-16: when memberCount was computed.
    countedAt   DateTime?
  }

  model Contact {
    // … existing fields and indexes unchanged …
    // SP-16: created-date audience rules; also serves the contacts list's createdAt desc order.
    @@index([workspaceId, createdAt])
  }
  ```
  - **Why the index:** `Contact(workspaceId, createdAt)` serves `created within/more_than/before/after` as a range inside one workspace. Keyset member pages reuse SP-13's `Contact_workspaceId_id_idx`.
  - **No new index on `Message`, `Conversation`, `Ticket`, `SegmentMember` or `CampaignRecipient`.** The existing ones serve the rules (table above). Prisma runs a migration file in a transaction, so `CREATE INDEX CONCURRENTLY` is unavailable, and a plain index build on `Message` (the largest table, written by every inbound webhook) would lock its writes. Task 4 measures `last_active` at 100k, and a `Message` index, if needed, is a follow-up with its own approval (ruling 10).
- **Rule tree (`AudienceRules`, `backend/src/segments/audience-rules.ts`; frontend mirror `src/screens/contacts/audiences/rulesModel.ts`):**
  ```
  type RelTime = { amount: number /* int 1..1000 */; unit: "hours" | "days" | "weeks" | "months" };
  type AudienceGroup = { op: "and" | "or"; rules: AudienceNode[] };          // 1..30 children
  type AudienceRules = AudienceGroup & { v: 2 };                             // the root
  type AudienceNode = AudienceGroup | AudienceRule;
  type AudienceRule = (
    | { field: "tag"; op: "has" | "not_has"; tag: string }
    | { field: "lifecycle"; op: "in" | "not_in"; values: string[] }        // 1..10
    | { field: "not_a_lead"; op: "is" | "is_not" }
    | { field: "last_active"; op: "within" | "more_than"; value: RelTime }
    | { field: "conversations"; op: "none" | "any" }                       // ruling 4
    | { field: "channel"; op: "is" | "is_not"; channel: string }           // ^[a-z_]{1,32}$
    | { field: "group"; op: "in" | "not_in"; segmentId: string }
    | { field: "created"; op: "within" | "more_than"; value: RelTime }
    | { field: "created"; op: "before" | "after"; date: string }           // YYYY-MM-DD, workspace time
    | { field: "pipeline_stage"; op: "in" | "not_in"; pipelineId: string; stageId?: string }
    | { field: "custom_field"; op: FieldOp; defId: string; value?: string } // SP-02 FieldOp
    | { field: "campaign"; op: "received" | "read" | "replied" | "not_replied" | "failed"; campaignId: string } // ruling 12
    | { field: "follow_up"; op: "open" | "overdue" | "none_open" }         // ruling 12
    // legacy fields (legacyToTree produces them; the editor shows and keeps them):
    | { field: "industry" | "source"; op: "in"; values: string[] }
    | { field: "name"; op: "contains"; value: string }
    | { field: "phone"; op: "set" | "unset" }
    | { field: "stage_key"; op: "in"; keys: string[] }
  ) & { missing?: true };   // set by a confirmed delete of the referenced thing (ruling 6)
  ```
  - **`legacyToTree(f)` → `{v:2, op:"and", rules:[…]}`.** Each legacy key, in `buildWhere`'s order:
    - `lifecycle` → `{lifecycle in}`;
    - `industry` / `source` → `{… in}`;
    - `search` (trimmed, non-empty) → `{name contains}`;
    - `hasPhone` → `{phone set|unset}`;
    - `stageAny` → `{stage_key in}`;
    - `tagsAll` → one `{tag has}` per name;
    - `tagsAny` → a nested `{op:"or", rules:[{tag has}…]}`.

    Empty arrays and unknown keys are dropped exactly as `buildWhere` drops them. `{}` gives `{v:2, op:"and", rules:[]}`, which matches the whole workspace, as today.
  - **Semantics:**
    - **`last_active`:** the latest message with `from = "them"` in any conversation of the contact (Tkana's definition; F3). `more_than` includes never-active contacts.
    - **Relative windows:** computed from the request's `now`, with calendar months in UTC (`setUTCMonth`).
    - **`created before/after`:** `before D` = `createdAt < localMidnight(D, ws.timezone)`; `after D` = `createdAt >= localMidnight(D + 1 day)`.
    - **`lifecycle not_in`:** `NOT (any insensitive match)`.
    - **`channel`:** compares `Conversation.channel` (`whatsapp | instagram | facebook | telegram | webchat | …`).
    - **`pipeline_stage`:** a live pipeline of the workspace (`archivedAt: null`) and, when given, a stage of that pipeline, checked at compile time. Otherwise the rule is `MATCH_NONE` with an issue, for both operators.
    - **`custom_field`:** a missing or archived def → `MATCH_NONE` plus issue `field_missing`.
    - **`missing: true`** → `MATCH_NONE` for every operator.
  - **Limits** (`AUDIENCE_LIMITS`): `maxConditions 30`, `maxDepth 3`, `maxExpanded 100` (after inlining referenced smart audiences), and `lifecycle`/`industry`/`source` value lists of at most 10.
- **Issues** (`RuleIssue = {path: number[], kind}`; `path` is the child-index path in the tree). Kinds:
  - `tag_deleted`
  - `group_missing`
  - `field_missing`
  - `pipeline_missing`
  - `pipeline_archived`
  - `stage_missing`
  - `campaign_missing`
  - `cycle`

  Each is worded in both languages on the frontend. An audience with issues still evaluates, and the issue rules match nobody.
- **DTO** (`AudienceRow`, backend `segments/audience-dto.ts`, frontend `Segment` in `src/lib/types.ts`):
  ```
  { id, name, nameAr, color, origin: "crm" | "manual" | "hjz",
    filter: SegmentFilter,                 // unchanged (legacy, or the sentinel)
    rules: AudienceRules | null,           // crm: always a tree (legacy converted); manual/hjz: null
    rulesSource: "rules" | "legacy" | null,
    count: number | null, countedAt: string | null, timedOut: boolean,
    issues: RuleIssue[], version: number, createdAt, updatedAt }
  ```
- **API** (all under the existing `/segments` controller; "audience" is the product word, `segment` the storage word; ruling 15):
  - **`GET /segments`** (`audiences.view`): rows as `AudienceRow`. Counts follow the cache rules (Architecture).
  - **`GET /segments/:id`** (`audiences.view`): `AudienceRow & {references: {audiences: {id, name, nameAr}[], campaigns: {id, name, status}[]}}`. Unknown or foreign id: 404 `audiences.not_found`.
  - **`POST /segments/preview`** (`audiences.view`, viewer-safe, writes nothing):
    - body `{filter}` (legacy, as today) **or** `{rules, excludeId?}`;
    - answers `{count: number | null, timedOut: boolean, sample: {id, name, phone}[] /* ≤ 5, newest first */, issues: RuleIssue[]}`;
    - `excludeId` is the audience being edited, so its own cycle check and self-reference work before the first save.
  - **`POST /segments`** (`audiences.create`): `{name, nameAr?, color?, origin?: "crm" | "manual", filter? | rules?}`. Both `filter` and `rules` → 400 `audiences.invalid_rules {path: [], reason: "filter_and_rules"}`. Answers 201 `AudienceRow`.
  - **`PATCH /segments/:id`** (`audiences.update`): `{name?, nameAr?, color?, filter? | rules?, version?}`.
    - A `version` that is sent and stale → 409 `audiences.version_conflict {current: AudienceRow}`.
    - `version` is optional only for older clients; the new UI always sends it (ruling 11).
    - `hjz` keeps today's 404 text.
    - Rules on a `manual` group → 400 `audiences.not_smart`.
  - **`DELETE /segments/:id`** (`audiences.delete`): `?confirm=1` (ruling 7). 409 `audiences.in_use_by_campaigns {campaigns}` or `audiences.in_use {audiences, campaigns}`. Answers `{ok: true, audiencesMarked: number}`.
  - **`GET /segments/:id/contacts`** (`audiences.view`): `?after=<contactId>&q=&limit=` (1..100, default 50), for **any** origin. Answers `{items: {id, name, phone, email, lifecycle}[], nextCursor: string | null, timedOut: boolean}`. `q` matches name, phone or email (as the contacts list does).
  - **`GET /segments/:id/count`** (`audiences.view`): recomputes when `countedAt` is older than 10 s, and answers `{count, countedAt, timedOut}`.
  - **`GET /segments/:id/candidates`** (`audiences.view`): manual groups only, else 400 `audiences.not_manual`. `?q=&after=&limit=` → contacts of the workspace **not** in the group, same page shape.
  - **`GET /segments/:id/members`** and **`POST/DELETE /segments/:id/members…`**: unchanged.
  - **`GET /tags/:id/references`** (`contacts.view`): `{audiences: {id, name, nameAr}[]}`, the smart audiences whose rules or legacy filter name the tag.
  - **`DELETE /tags/:id`** (`contacts.update`): `?confirm=1`. Without it, and with references, it answers 409 `tags.in_use_by_audiences {audiences}`. With it, `{ok: true, contactsUpdated, audiencesMarked}`. Unreferenced tags delete as today.
  - **`PATCH /tags/:id`, `POST /tags/merge`:** unchanged shape. `segmentsUpdated` now counts audiences whose `rules` or `filter` changed.
  - **Campaigns:** `POST /campaigns/preview` and launch answer 400 `campaigns.audience_missing {segmentId}` when the campaign's audience is gone.
- **Error keys** (same `{statusCode, message: key, …extra}` shape as `campaignError`):
  - New `segments/audience-errors.ts`:
    - `audiences.not_found` (404);
    - `audiences.reference_not_found {field, id}` (404);
    - `audiences.invalid_rules {path, reason}` (400);
    - `audiences.rule_cycle {path}` (400);
    - `audiences.rules_too_large {max}` (400);
    - `audiences.rule_too_deep {max}` (400);
    - `audiences.not_smart` (400);
    - `audiences.not_manual` (400);
    - `audiences.version_conflict {current}` (409);
    - `audiences.in_use {audiences, campaigns}` (409);
    - `audiences.in_use_by_campaigns {campaigns}` (409).
  - `tags/tag-errors.ts` (new): `tags.in_use_by_audiences {audiences}` (409).
  - `campaign-errors.ts`: `campaigns.audience_missing {segmentId}` (400).
  - Frontend copy: new `src/screens/contacts/audiences/audienceErrors.ts`; `campaignErrors.ts`; and the tag-delete dialog. Each has `tx` copy and a test covering every key.
- **Permissions (SP-25).** No catalogue change. `permission-map.ts` adds:
  - `GET /segments/:id`: `audiences.view`
  - `GET /segments/:id/contacts`: `audiences.view`
  - `GET /segments/:id/count`: `audiences.view`
  - `GET /segments/:id/candidates`: `audiences.view`
  - `GET /tags/:id/references`: `contacts.view`

  Existing entries stay. Query flags such as `?confirm=1` don't change the route key.

  `system-role-decisions.spec.ts` adds an `SP-16 audience routes` block:
  - viewer can read all four new segment GETs, preview, and the tag references;
  - viewer cannot create, update or delete;
  - agent can create, update and delete audiences (SP-25 default);
  - none is blocked for impersonation.

  Every handler loads its row by `(id, workspaceId)` first, so a foreign path id returns **404**. A foreign id inside a rule body also returns 404 (`audiences.reference_not_found`), the same answer as a missing one.
- **Migration:**
  - File: `backend/prisma/migrations/20261115130000_smart_audiences/migration.sql`.
    - The timestamp is after `20261114140000_number_template_health`. It sits between SP-15's `20261115120000` and SP-17's `20261115140000`, as the coordinator assigned. The three migrations touch disjoint tables, so they may be applied in any order.
    - **Every existing migration is applied in production and is never edited.**
    - Hand-written; apply with `npx prisma migrate deploy` only, never `migrate dev`.
  - **Additive and idempotent:**
    ```sql
    ALTER TABLE "Segment" ADD COLUMN IF NOT EXISTS "rules" JSONB,
                          ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 0,
                          ADD COLUMN IF NOT EXISTS "memberCount" INTEGER,
                          ADD COLUMN IF NOT EXISTS "countedAt" TIMESTAMP(3);
    CREATE INDEX IF NOT EXISTS "Contact_workspaceId_createdAt_idx" ON "Contact"("workspaceId", "createdAt");
    ```
  - **Prisma-conformant names:** `Contact_workspaceId_createdAt_idx`; columns camelCase quoted.
  - **Check with `prisma migrate diff --from-schema-datamodel <HEAD schema> --to-schema-datamodel prisma/schema.prisma --script`** (no DB). The output must equal the file, apart from `IF NOT EXISTS`, as in SP-13 T1 and SP-14 T1.
  - **Safe for the deployed `main`:**
    - Three nullable columns, plus one `NOT NULL DEFAULT 0` column, which is a metadata-only change on Postgres 11+ and rewrites no table.
    - `main`'s Prisma client never selects the new columns, its creates rely on the DB default, and its updates ignore them.
    - No existing column, constraint or index changes. The migration has no `UPDATE`, `DELETE`, `DROP` or `ALTER … TYPE`.
    - The `CREATE INDEX` on `Contact` locks Contact writes (inbound contact upserts) for the build. That is seconds at most at today's volume. Task 4 reads `reltuples` first and reports it before asking for approval (ruling 10).
    - `main` reading a row written by SP-16: `rules` is ignored, and `filter` is either the legacy projection (same audience) or the sentinel (nobody). `main`'s campaigns already resolve `crm` segments to nobody (F1).
  - **No backfill.** Legacy rows are read through `legacyToTree`. `memberCount` fills on the first list or count.
- **Copy and layout:**
  - Every string goes through `tx("English","العربية")` with real Arabic.
  - Logical CSS only (`margin-inline-start`, `padding-inline`, `text-align: start`, `inset-inline-end`).
  - Contact names, phones, tag names, dates and counts inside Arabic sentences go in `<bdi>` (phones and dates `dir="ltr"`).
  - Dialogs and sheets set `dir`.
  - Rule sentences are generated per language from the tree, for example "Last active within the last 7 days" / "آخر نشاط خلال آخر ٧ أيام", and "Member of group <bdi>VIP</bdi>" / "عضو في مجموعة <bdi>VIP</bdi>".
  - A timed-out count reads "Too large to count right now" / "العدد كبير جدًا لحسابه الآن". It is never 0, and never a blank.
- **Tests:**
  - backend: `npx jest src/segments src/tags src/contacts src/campaigns src/imports src/permissions` plus `npx tsc --noEmit -p tsconfig.json`; the full `npm test` once per task. The known unrelated failure is `hjz-client-sync › is inert when HJZ is not configured`.
  - frontend (repo root): `npx vitest run` plus `npm run typecheck`; `npm run build` once in Task 3.
  - **Named acceptance tests (exact names, from the roadmap):**
    - `legacy filter JSON evaluates identically` (backend jest, `src/segments/audience-compiler.spec.ts`)
    - `cyclic group membership rule rejected` (backend jest, `src/segments/audience-cycles.spec.ts`)
    - `delete-tag-in-rule warns with affected audiences` (backend jest, `src/tags/delete-tag-with-references.spec.ts`, Review Focus 2's `delete-<thing>-with-references` spec)
  - **In-memory evaluator:** `backend/src/segments/audience-test-db.ts` (not a runtime file) evaluates a `Prisma.ContactWhereInput` over fixture tables. It supports:
    - scalar ops incl. `mode: "insensitive"`, `contains`, `in: []`;
    - `AND`/`OR`/`NOT`;
    - `some`/`none` on `conversations` (→ `messages`), `tickets`, `segmentMembers`, `fieldValues`, `campaignRecipients`, `activities`;
    - SP-02's JSON `value` filters (`equals`, `string_contains`, `gt`, `lt`).

    It throws on any operator it does not know, so a compiler change cannot pass by being ignored.
  - **Optional DB spec:** `src/segments/audiences.db.spec.ts`, skipped unless `AUDIENCE_TEST_DATABASE_URL` points at a disposable, migrated database (same convention as `conversation-resolution.db.spec.ts`). It runs the acceptance fixture through real Postgres. Never point it at production.
  - No spec makes a network call.
- **Commits:** selective `git add <paths>`, never `-A`. Trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not stage `.playwright-mcp/` or any untracked file this plan did not create.

## Review Focus
1. **No audience silently widens.**
   - A legacy filter selects exactly the contacts it selected before.
   - Pre-SP-16 code that reads a v2 row sees nobody, never everyone.
   - A broken reference (deleted tag or group, archived pipeline, removed stage, archived field, deleted campaign) matches nobody for **every** operator, including `not_has` / `not_in`.
   - A confirmed delete marks rules missing; it never removes them.
   - Tests: `legacy filter JSON evaluates identically`, `pre-SP-16 reader sees nobody for a v2 audience`, `broken references match nobody for both operators`.
2. **Deleting something that is still referenced (Review Focus 2).**
   - A tag that a rule or a legacy filter uses → 409 with the audiences, then a confirmed delete marks the rules.
   - A group that another audience or a campaign uses → 409 with both lists.
   - A scheduled or running campaign blocks the delete outright.
   - No 500, and no orphaned rule.
   - Tests: `delete-tag-in-rule warns with affected audiences`, `delete-audience-with-references`.
3. **Cycles and runaway rules.**
   - Self, 2-cycles and 3-cycles through `in` or `not_in`, inside nested `or` groups, are rejected on save and on preview.
   - Concurrent saves are serialized by the workspace lock.
   - A stored cycle compiles to nobody.
   - Size and depth are capped.
   - Tests: `cyclic group membership rule rejected`, `concurrent saves cannot close a cycle`, `rules over the limits are rejected`.
4. **Large audiences never block.**
   - Count, preview, members and candidates use keyset pages with `take ≤ 101` and the statement timeout. A timeout gives `count: null`, never 500.
   - The campaign stream keeps its 1 000-row keyset pages.
   - `GET /segments` caches counts and recomputes at most 3 at a time.
   - Tests: `audience pages are keyset and bounded at 100k`, `count timeout returns null`, `segment list recomputes stale counts with bounded concurrency`; plus Task 4 timings.
5. **Campaigns reach the right people.**
   - A smart audience in a campaign preview and launch resolves through the same compiler as the contacts list, with one `now` per launch.
   - Manual and hjz groups are unchanged.
   - A deleted audience gives `campaigns.audience_missing`.
   - Tests: `campaign audience resolves smart segments like the contacts list`, `manual group campaign audience unchanged`, `missing audience refuses preview and launch`.
6. **Tenant isolation.**
   - Foreign path ids give 404 on every new route.
   - Foreign ids in rules (group, pipeline, stage, field, campaign) give 404 `audiences.reference_not_found`.
   - Every relation filter carries `workspaceId`.
   - Tests: `foreign ids return 404 on SP-16 routes`, `foreign ids inside rules are not found`.

## Architecture Rulings and Risks
Each item names the risk, then the recommended ruling. Items marked **(needs controller ruling)** are repeated under Controller rulings, where the controller fills in the decision.

1. **Evaluate live or materialize.**
   - Tkana materializes smart-group members with a refresh job. That gives cheap counts and arbitrary SQL, but it costs a job, freshness rules, entered/left bookkeeping, and up to 100k-row rewrites per refresh on the production Neon DB.
   - **Ruling:** evaluate live. One compiler targets `Prisma.ContactWhereInput`, which is what every consumer already takes (F2). Counts are cached for the list only, and pages are keyset.
   - Consequences:
     - membership is always current;
     - relative windows move with time;
     - the only rule Prisma cannot express is an exact conversation count (ruling 4);
     - the legacy-equivalence test can compare result sets in the DB-free suite (F5).
   - **Alternative:** materialize into a new `AudienceMember` table with a raw-SQL compiler and a refresh scheduler. That is a large M on its own. **(needs controller ruling)**
2. **Storage and backward compatibility.**
   - Rewriting `filter` in place as v2 would make pre-SP-16 code (the deployed `main` during rollout, or any rollback) parse an object with no legacy keys. `buildWhere` would then return `{workspaceId}`: **the whole workspace**.
   - **Ruling:** a new `rules Jsonb` column; read `rules ?? legacyToTree(filter)`. On save, write `filter` as the exact legacy projection when possible, else as the sentinel `{"stageAny":["__sp16_rules_v2__"]}`, which old code resolves to nobody. Legacy rows are never rewritten.
   - **Residual risk:** during the rollout window, an old client's PATCH of `filter` on a v2 row would leave `rules` stale. We accept that (`rules` wins, and the window is minutes). **(needs controller ruling)**
3. **Rule set and semantics.**
   - The Tkana set (Global Constraints), plus our legacy fields so legacy audiences open in the editor unchanged.
   - `last_active` = latest inbound message.
   - "more than" includes never-active.
   - `lifecycle not_in` = not any of them.
   - Absolute dates use the workspace timezone through `localMidnight`.
   - Relative months are calendar months.
   - Tags are referenced **by name**, like `Contact.tags` and the legacy filter, so tag rename and merge keep rewriting names. **(needs controller ruling, minor)**
4. **Conversation count.**
   - Prisma 5 cannot filter by a relation count, and `Contact.convs` is not maintained (F3). An exact "≥ N conversations" needs raw SQL (which breaks ruling 1), a maintained counter (DB triggers on main's write path, or app code at the ~15 `conversation.create`/`message.create` sites), or a sweep-refreshed side table plus a production backfill.
   - **Ruling:** SP-16 ships `conversations none` ("has no conversations") and `conversations any` ("has at least one conversation"). Channel-specific variants come through `channel is/is_not`.
   - Exact thresholds (`eq/gt/lt/gte/lte N`) are deferred to a follow-up: a `ContactStats` side table refreshed by a bounded sweep, which would also make `last_active` index-only. Record it in the roadmap.
   - **Alternative:** build `ContactStats` now (one more table, a scheduler, a rerunnable backfill, and stale-by-minutes semantics). **(needs controller ruling)**
5. **Group rules that name another smart audience.**
   - Tkana forbids this (static groups only). The roadmap's `cyclic group membership rule rejected` implies we allow it.
   - **Ruling:** allow it, with:
     - inline compilation of the target;
     - cycle rejection on save and preview (400 `audiences.rule_cycle {path}`);
     - a workspace advisory lock in the save transaction;
     - a `visited` guard at compile time;
     - caps of depth 3 and 100 expanded conditions.
   - An hjz group can be referenced (membership rows). Manual groups compile to `segmentMembers`.
   - **Alternative:** Tkana's D9, where only manual and hjz groups can be referenced. The cycle test would then assert the 400 for any smart reference. **(needs controller ruling)**
6. **Broken references.**
   - A deleted tag (marked on confirm), a missing group, an archived or missing custom field, an archived pipeline, a removed stage, or a deleted campaign makes that rule match **nobody**, for both operators, and adds an issue.
   - The detail page shows a banner, and the editor highlights the rule with "Fix" (choose a replacement) or "Remove".
   - Narrowing can never send a campaign to more people than the owner chose.
   - **Alternative:** drop the broken rule, which widens the audience. Rejected. **(needs controller ruling)**
7. **Delete with references.**
   - Tags: 409 `tags.in_use_by_audiences` lists the audiences; `?confirm=1` deletes and marks.
   - Audiences and groups:
     - a `scheduled` campaign, or one in `planning`/`sending`, refuses with no override (`audiences.in_use_by_campaigns`);
     - other references give 409 `audiences.in_use`, and `?confirm=1` marks the referencing rules;
     - draft campaigns keep the dangling id, and their launch refuses with `campaigns.audience_missing`.
   - Archiving a custom field (SP-02) and editing stages or archiving a pipeline (SP-07) are **not** blocked by SP-16. Their rules turn into issues (ruling 6). Extending SP-02's and SP-07's delete previews to list audiences is a small follow-up. **(needs controller ruling)**
8. **Campaigns start honouring smart audiences (F1).**
   - Today a campaign on a `crm` segment resolves to nobody. After SP-16 it resolves to the real audience.
   - Any existing **draft or scheduled** campaign pointing at a `crm` segment would start reaching people when it next runs.
   - **Ruling:** before the migration, Task 4 runs a read-only count of campaigns with `status in (draft, scheduled)` whose `segmentId` is a `crm` segment, and reports it to the user. A scheduled one needs the user's decision before deploy.
   - The campaign review step shows a "Smart audience: evaluated when the campaign starts" note. **(needs controller ruling)**
9. **Pipeline-stage semantics.**
   - The contacts-list filter (SP-02) matches **open** cards only (`closedAt: null`), even when a stage is given. That makes "in Won" match nobody, since won cards are closed.
   - **Ruling:** one shared helper, `pipelineStageWhere(ws, {pipelineId, stageId?}, op)`, in `contacts/pipeline-stage-where.ts`, used by both the list and the compiler:
     - with `stageId` → any card currently in that stage (open or closed);
     - pipeline only → open cards only.
   - This changes the contacts list for terminal stages (it fixes "in Won").
   - Legacy `stage_key` keeps its exact old behaviour, which is any ticket in a stage with that key.
   - **Alternative:** keep the list's `closedAt: null` everywhere. **(needs controller ruling, minor)**
10. **Indexes, timeouts and counts at 100k.**
    - **Ruling:**
      - add only `Contact_workspaceId_createdAt_idx`;
      - rely on the existing `Contact_workspaceId_id_idx` (keyset), `Conversation_contactId_idx`, `Conversation_workspaceId_idx`, `Message_createdAt_idx`, `Message_workspaceId_idx`, `Message_conversationId_createdAt_idx`, `SegmentMember_pkey`, `CustomFieldValue_pkey`, `Ticket_stageId_idx`, `CampaignRecipient_campaignId_status_id_idx` and `Activity_workspaceId_contactId_idx`;
      - count with `SET LOCAL statement_timeout` (8 s);
      - cache list counts for 5 min, written by raw SQL.
    - Task 4 measures every rule at 100k (ruling 18).
    - If `last_active` exceeds 3 s, a follow-up proposes `Message(workspaceId, createdAt)` in its own migration and with its own approval, because Prisma's transactional migrations rule out `CONCURRENTLY` and a plain build locks inbound message writes.
    - **Alternative:** drop the `Contact` index too, so the migration is columns only. **(needs controller ruling)**
11. **Concurrent edits (roadmap Review Focus 4 pattern).**
    - Two owners editing the same audience would otherwise silently lose one edit.
    - **Ruling:** `Segment.version`. PATCH with a stale `version` gives 409 `audiences.version_conflict {current}`, and the editor offers "Load theirs" / "Keep editing". `version` is optional on the wire for compatibility with older clients only. **(needs controller ruling, minor)**
12. **Engagement rules beyond Tkana.**
    - The brief points at SP-12 recipients and SP-04 activities.
    - **Recommended in SP-16, as a droppable section** (Task 2 section B6, Task 3 section F6):
      - `campaign received/read/replied/not_replied/failed` by `campaignId`, where:
        - received = `sentAt|deliveredAt|readAt|repliedAt` set;
        - read = `readAt|repliedAt` set;
        - replied = `repliedAt` set;
        - not_replied = received and no `repliedAt`;
        - failed = `status "failed"`;
      - `follow_up open/overdue/none_open`, where:
        - open = an `Activity` with `doneAt` null;
        - overdue = open and `dueAt < now`;
        - none_open = no open activity.
    - Both are Prisma-expressible and indexed.
    - If Task 2 grows beyond review size, drop B6/F6 to a follow-up. **(needs controller ruling)**
13. **Where the UI lives (F6).**
    - There is no Marketing nav. The Contacts tab "Groups" becomes "Audiences" / "الجماهير", with two sections: "Groups" (manual) and "Smart audiences".
    - The detail page opens in the same tab, keeping its state in the hash (`#/contacts?ct=audiences&aud=<id>`).
    - The old "Manage segments" modal (`SegmentManager.tsx`) is retired. Its header button opens the Audiences tab.
    - The Campaigns audience step marks smart audiences with a badge.
    - **Alternative:** a new top-level route. **(needs controller ruling, minor)**
14. **Visibility side door (Review Focus 1).**
    - Rules over conversation data (last active, channel, conversations) evaluate workspace-wide. An agent with `conversationVisibility = "assigned"` can therefore learn that "some contact has an unassigned WhatsApp conversation active in the last hour".
    - Only contact rows are returned, and contacts are visible to every member. No conversation content, id or assignee is exposed.
    - **Ruling:** accept. Per-viewer evaluation would make one audience differ per member, and campaigns would disagree with the editor. `permission-sidedoors.spec.ts` gains a case asserting that audience routes never return conversation ids or message text. **(needs controller ruling, minor)**
15. **API naming.**
    - Keep `/segments` (the SP-25 map, HJZ sync and campaigns all use it).
    - New routes are additive. `GET /segments/:id/members` keeps its shape, because the old Groups UI and SP-12 follow-up use it, and the new keyset list is `GET /segments/:id/contacts`. **(needs controller ruling, minor)**
16. **HJZ outbound.**
    - `emitSegmentUpserted` already resolves the audience through `resolveContactWhere`, so smart rules flow through. `summarizeFilter` gains a v2 summary in English (`ruleSummary`).
    - No HJZ call is made in verification: the test workspace has no `externalTenantId`, and `HJZ_OUTBOUND_URL` is empty.
    - The nightly resync's cost for large smart audiences is unchanged in kind and is noted. **(needs controller ruling, minor)**
17. **Time semantics.**
    - One `now` per request. The campaign launch uses the plan start for all pages, so a 7-day window cannot shift between page 1 and page 100.
    - The editor preview and the saved audience may differ by the seconds between them. That is acceptable and the UI shows "Counted at …". **(needs controller ruling, minor)**
18. **Verification touches production** (as SP-12 R14, SP-13 R20 and SP-14 R17).
    - Task 4 runs against the production DB in a throwaway workspace, with no provider and no HJZ reached.
    - The 100k scale check inserts 100 000 synthetic contacts plus about 30 000 conversations and 60 000 messages **into that workspace only**, with set-based `INSERT … SELECT generate_series`, and deletes them in 5 000-row batches before the workspace.
    - The migration needs the user's **explicit approval** before `migrate deploy`; earlier approvals do not carry over. The 100k seed also needs explicit approval.
    - **Fallback** if the seed is refused: 20 000 contacts, with the 100k behaviour shown by the jest keyset test and `EXPLAIN` plans only. **(needs controller ruling)**
19. **Size.** The roadmap says M. With F1 (campaign wiring), the safe-delete flows, the detail page and the optional engagement rules (ruling 12), it is a large M: 3 build tasks plus verification. Dropping ruling 12's section keeps it a firm M. **(needs controller ruling)**

### Controller rulings
*Decided 2026-11-10. Every recommended ruling (R1–R19) is accepted, with these specifics. **R8:** a read-only check on 2026-11-10 found 0 campaigns of any status using a rule-based segment (all 6 use plain groups). The switch changes no existing audience. Task 4 re-runs the count before deploy and stops for the user if it is non-zero. **R12:** engagement and follow-up rules are included only if Task 2 stays reviewable; otherwise they move to a follow-up. **R18:** do not seed 100k rows on production. The live check seeds at most 20k throwaway contacts (cleaned up), and 100k scale is covered by the in-memory spec plus EXPLAIN. Migration 20261115130000_smart_audiences needs explicit user approval before it is applied.*
- **R1** Pending. Recommended: live evaluation, one compiler to `Prisma.ContactWhereInput`, no materialization.
- **R2** Pending. Recommended: new `Segment.rules Jsonb`; `filter` keeps the legacy projection or the nobody-sentinel; legacy rows are never rewritten.
- **R3** Pending (minor). Recommended: the Tkana rule set plus the legacy fields, with the semantics as listed; tags by name.
- **R4** Pending. Recommended: `conversations none/any` only; exact counts deferred to a `ContactStats` follow-up.
- **R5** Pending. Recommended: allow smart → smart references with cycle rejection, the workspace lock, and caps of depth 3 and 100 expanded conditions.
- **R6** Pending. Recommended: a broken reference matches nobody for every operator and shows an issue; never drop the rule.
- **R7** Pending. Recommended: 409 plus confirm for tags and audiences; scheduled or running campaigns block with no override; field, stage and pipeline previews are a follow-up.
- **R8** Pending. Recommended: the read-only count of draft/scheduled campaigns on `crm` segments is reported to the user before deploy; scheduled ones need the user's decision.
- **R9** Pending (minor). Recommended: the shared `pipelineStageWhere`; a stage given matches open or closed cards; this fixes "in Won" in the contacts list too.
- **R10** Pending. Recommended: only `Contact_workspaceId_createdAt_idx`; the statement timeout; a 5-minute count cache; a `Message` index only after Task 4 measures a need, in its own approval.
- **R11** Pending (minor). Recommended: `Segment.version` with 409 `audiences.version_conflict`.
- **R12** Pending. Recommended: include the campaign-engagement and follow-up rules as the droppable B6/F6 sections.
- **R13** Pending (minor). Recommended: rename Contacts → Groups to "Audiences" / "الجماهير", put the detail page in the hash, and retire `SegmentManager`.
- **R14** Pending (minor). Recommended: workspace-wide evaluation; add the side-door assertion.
- **R15** Pending (minor). Recommended: keep `/segments`; add routes; leave `/members` unchanged.
- **R16** Pending (minor). Recommended: v2 `ruleSummary`; no HJZ calls in verification.
- **R17** Pending (minor). Recommended: one `now` per request, and per launch.
- **R18** Pending. Recommended: the production throwaway workspace with a 100k seed after explicit approval; the 20k fallback otherwise. The migration needs explicit user approval, and the user must not run `migrate deploy` on their own.
- **R19** Pending. Recommended: large M; drop R12's section first if a task outgrows review.

---

### Task 1: Backend — rule model, compiler, legacy reader, cycles, migration and the audience routes
**Owns:** `schema.prisma` and the migration for all of SP-16. Tasks 2 and 3 depend on this schema and do not edit it.

**Files:**
- `backend/prisma/schema.prisma`: the Global Constraints → Data changes.
- `backend/prisma/migrations/20261115130000_smart_audiences/migration.sql`.
- Create, in `backend/src/segments/`, each with a spec:
  - `audience-rules.ts` (pure):
    - the types in Global Constraints and `AUDIENCE_LIMITS`;
    - `LEGACY_SENTINEL`, `legacyToTree(filter)`, `legacyProjection(tree) → SegmentFilter | null`;
    - `readRules(row) → {tree, source: "rules" | "legacy"}`;
    - `validateRules(input) → AudienceRules`: shape, limits and depth; throws `audiences.invalid_rules` / `rules_too_large` / `rule_too_deep`;
    - `walkRules(tree, fn)`, `referencedIds(tree) → {segmentIds, pipelineIds, stageIds, defIds, campaignIds, tagNames}`;
    - `rewriteRulesTagName(tree, from, to) → tree | null`, `markRules(tree, predicate) → {tree, marked}`;
    - `relativeSince(now, value)`.
  - `audience-lookups.ts`: `loadLookups(prisma, ws, ids)`. It makes one `findMany` per kind, each with `workspaceId`: segments (`id, origin, rules, filter`), pipelines with stages (`archivedAt`), custom-field defs (`type, archivedAt`) and campaigns, plus `workspace.timezone`. `assertReferencesExist(lookups, ids)` → 404 `audiences.reference_not_found {field, id}`.
  - `audience-compiler.ts`: `compileAudience(ws, tree, ctx: {now, tz, lookups, visited, depth}) → {where: Prisma.ContactWhereInput, issues: RuleIssue[]}` and `MATCH_NONE`. It is pure: lookups come in, nothing is read. Custom fields go through SP-02's `fieldWhere`. Legacy fields reproduce `buildWhere`'s expressions exactly.
  - `audience-cycles.ts`: `assertNoCycle(ws, selfId | null, tree, loadSmart: (ids) => Promise<Map<id, tree>>)`, a breadth-first walk that loads one level per query and throws `audiences.rule_cycle {path}`.
  - `audience-count.ts`: `countWithTimeout(prisma, where, ms) → {count | null, timedOut}`, `writeCountCache(prisma, ws, id, count, at)` (raw SQL).
  - `audience-errors.ts`, `audience-dto.ts` (`toAudienceRow`).
  - `audience-test-db.ts` (test helper, the in-memory evaluator; see Global Constraints → Tests).
  - `__fixtures__/legacy-build-where.ts`: a **verbatim frozen copy** of today's `SegmentsService.buildWhere`, used only by the equivalence spec, so later edits to the live code cannot move the baseline.
- `backend/src/segments/segments.service.ts`:
  - `buildWhere` becomes a thin wrapper, `compileAudience(legacyToTree(f))`, kept for `countByFilter` callers.
  - `resolveContactWhere(ws, id, opts?: {now?})`:
    - `crm` → `readRules` → lookups → compile (issues ignored here);
    - manual and hjz unchanged;
    - missing → `audiences.not_found`, a 404 whose text stays compatible.
  - New: `compile(ws, tree, {now, selfId?})`, `preview(ws, body)`, `detail(ws, id)`, `pageContacts`, `candidates`, `count`, `listRows(ws)` (cache rules, `p-limit`-style local concurrency of 3 with no new dependency), and `save(ws, input, {id?, version?})`. `save` runs one `$transaction`: the advisory lock, then validate, the reference check (404), `assertNoCycle`, the version check (409), and the write of `rules`, `filter` (projection or sentinel) and `version + 1`.
- Move `SegmentsController` and its DTOs out of `segments.module.ts` into `segments.controller.ts` and `segments.dto.ts`. `CreateSegmentDto`, `UpdateSegmentDto` and `PreviewSegmentDto` gain `@IsOptional() @IsObject() rules?: Record<string, unknown>`, `excludeId?` and `version?` (`@IsInt`); the deep check is `validateRules`. Add the routes in Global Constraints → API (except the tag ones). `DELETE /segments/:id` with references comes in Task 2, and Task 1 keeps today's delete.
- `backend/src/permissions/permission-map.ts`: the four new segment GETs. Rows in `permission-map.spec.ts` and the `SP-16 audience routes` block in `system-role-decisions.spec.ts`.
- `backend/.env.example`: `AUDIENCE_COUNT_TIMEOUT_MS`, `AUDIENCE_COUNT_TTL_MS` (commented defaults).

**Produces (contract for Tasks 2–3):**
- `AudienceRules`, `RuleIssue`, `AudienceRow`: the exact shapes in Global Constraints.
- `SegmentsService.resolveContactWhere(ws, id, {now})`, `compile`, `save`, `listRows`, `detail`.
- `readRules`, `legacyToTree`, `rewriteRulesTagName`, `markRules`, `referencedIds`, `LEGACY_SENTINEL`.
- `audience-test-db.ts` for Task 2's specs.
- Routes: `GET /segments`, `GET /segments/:id`, `POST /segments/preview`, `POST /segments`, `PATCH /segments/:id`, `GET /segments/:id/contacts`, `/count`, `/candidates`.

- [ ] Write the failing tests:
  - `migration is additive, idempotent and Prisma-named (SP-16)` (reads the SQL):
    - every `ADD COLUMN` and `CREATE INDEX` has `IF NOT EXISTS`;
    - the names are exactly as listed;
    - there is no `DROP`, `UPDATE`, `DELETE`, `ALTER COLUMN`, `TYPE` or `CONCURRENTLY`;
    - the folder name is greater than `20261114140000`;
    - the sha256 values of `20261114130000_contact_workspace_id_index` and `20261114140000_number_template_health` are pinned (unchanged);
    - `prisma migrate diff` from the HEAD schema produces the same statements (recorded in the report).
  - **`legacy filter JSON evaluates identically`** (`audience-compiler.spec.ts`):
    - **Fixture:** about 60 contacts through `audience-test-db.ts`, covering:
      - lifecycles `lead`, `Lead`, `customer`, `churned`;
      - industries and sources;
      - names with Arabic and mixed case;
      - with and without phone;
      - tags `VIP`, `VIPER`, `Riyadh, KSA` and none, plus one malformed `tags` text;
      - tickets in stages with keys shared across two pipelines, some closed.
    - **Filters:** a table of at least 20 legacy filters:
      - each key alone, and combinations;
      - empty arrays, `{}`;
      - `search` with spaces only;
      - `hasPhone` true and false;
      - `tagsAll` + `tagsAny`, and VIP vs VIPER;
      - `stageAny` across pipelines;
      - unknown keys;
      - and the raw stored strings `"{}"`, `"not json"` and `"[]"`, through `parseFilter`.
    - **Assertion:** for every filter, the contact-id set from `legacy-build-where.ts` equals the set from `compileAudience(readRules({origin:"crm", filter, rules:null}).tree)`.
    - **Also:**
      - `readRules` reports `source: "legacy"`;
      - `legacyProjection(legacyToTree(f))` round-trips to an equivalent filter;
      - the compiled tree for `{}` matches every workspace contact and no other workspace's.
  - `pre-SP-16 reader sees nobody for a v2 audience`: saving a tree with `last_active` writes `filter = LEGACY_SENTINEL`, and the frozen legacy `buildWhere` over the stored `filter` matches 0 contacts. Saving a legacy-expressible tree writes its projection, and both readers agree.
  - `each rule compiles to its documented predicate`: one table row per rule and operator, run through the evaluator. It includes:
    - `last_active more_than` includes never-active;
    - `within` uses only `from:"them"` messages, and an AI or human reply does not count;
    - `created before/after` at the Riyadh midnight edges;
    - months across month ends (Jan 31 + 1 month);
    - `channel is_not` includes contacts without conversations;
    - `group in` for manual, hjz and smart;
    - `custom_field` for every type through `fieldWhere`;
    - `not_a_lead`;
    - `lifecycle not_in`.
  - `broken references match nobody for both operators`:
    - missing group, archived pipeline, a stage of another pipeline, an archived field, and `missing: true` → `MATCH_NONE` for `in` and `not_in`, `has` and `not_has`;
    - each gives one issue with the right `kind` and `path`;
    - siblings in an `or` group still match.
  - **`cyclic group membership rule rejected`** (`audience-cycles.spec.ts`):
    - A references B (smart); saving B with `group in A` → 400 `audiences.rule_cycle {path:[B, A, B]}`, and B is unchanged;
    - self-reference;
    - a 3-cycle A→B→C→A, where the reference sits inside a nested `or` group under `not_in`;
    - preview with `excludeId` detects the same cycle before the first save;
    - a diamond (A→B, A→C, B→D, C→D) is accepted;
    - a manual-group reference never triggers the walk;
    - a stored cycle (rows written directly) compiles to `MATCH_NONE` with issue `cycle`, with no recursion and no throw.
  - `concurrent saves cannot close a cycle`: `save` takes `pg_advisory_xact_lock` as its first statement (`$executeRaw` spy), and with a serialized fake transaction the second of two crossing saves gets 409/400, never both 200.
  - `rules over the limits are rejected`:
    - 31 conditions → `rules_too_large {max:30}`;
    - depth 4 → `rule_too_deep {max:3}`;
    - expansion through referenced audiences over 100 → `rules_too_large {max:100}`;
    - an unknown field or op, a bad `RelTime`, a bad date, or an empty group → `invalid_rules {path, reason}`;
    - `filter` and `rules` together → `invalid_rules`.
  - `foreign ids inside rules are not found`: a group, pipeline, stage, field or campaign id from workspace B, used in workspace A's rules → 404 `audiences.reference_not_found {field, id}` on create, update and preview.
  - `audience pages are keyset and bounded at 100k`:
    - 100 000 generated contacts in the evaluator; a smart audience matching every 7th contact;
    - `pageContacts` walks every page with `limit 100`;
    - every `contact.findMany` call has `take ≤ 101`, `orderBy {id:"asc"}` and an `id > after` clause, and none uses `skip`;
    - the union of pages equals the expected set, with no duplicate and no gap;
    - candidates for a manual group follow the same rules.
  - `count timeout returns null`: a fake `$transaction` whose count rejects with Postgres `57014` → `{count:null, timedOut:true}`, with HTTP 200 on `GET /segments/:id/count` and `POST /segments/preview`. The `SET LOCAL statement_timeout` statement precedes the count in the same transaction.
  - `segment list recomputes stale counts with bounded concurrency`:
    - 10 smart audiences with stale `countedAt` → at most 3 counts in flight at once;
    - fresh ones are served from the cache without a count;
    - the cache write is raw SQL and `updatedAt` is unchanged;
    - manual groups use `segmentMember.count`.
  - `version conflict returns current`: PATCH with `version` 3 when the row is at 4 → 409 `audiences.version_conflict {current}` and nothing is written. A correct version → `version` 5.
  - `preview returns count, sample and issues and writes nothing`: no `segment.update`/`create`/`$executeRaw` other than the timeout statement; the sample has at most 5 newest contacts.
  - `foreign ids return 404 on SP-16 routes` (part 1): `GET /segments/:id`, `/contacts`, `/count`, `/candidates`, `PATCH`, with workspace B's id from A.
  - `permission map covers SP-16 routes` (part 1) plus the system-role block (viewer reads, cannot mutate; agent can; impersonation not blocked).
- [ ] Implement until green.
- [ ] `npx tsc --noEmit -p tsconfig.json`, the listed jest paths, then the full `npm test` once. Run `npx prisma generate`. An EPERM on the engine DLL while the dev watcher runs is harmless, as in SP-12/13/14; restart the watcher. **Do not run `migrate`** (ruling 18).
- [ ] Commit `feat(segments): smart audience rules, compiler, legacy reader, cycle checks and audience routes`.

### Task 2: Backend — safe deletes, tag rewriting, campaigns and other consumers
**Depends on:** Task 1.

**Files:**
- **B1 Tags** (`backend/src/tags/tags.module.ts`, plus new `tag-errors.ts`):
  - `renameInSegments` also rewrites `rules` (`rewriteRulesTagName`) on every `crm` segment. When the result is legacy-expressible it rewrites `filter` too, and otherwise leaves the sentinel. It stays in the same transaction.
  - `references(ws, id)` → audiences whose `rules` name the tag (not `missing`) or whose legacy `filter` lists it in `tagsAll`/`tagsAny`.
  - `remove(ws, id, {confirm})`: with references and no confirmation → 409 `tags.in_use_by_audiences {audiences}`, with nothing written. With confirmation, in one transaction:
    - remove the tag from contacts (today's SQL);
    - for each referencing audience, convert a legacy filter with `legacyToTree`, mark the tag's rules `missing: true`, write `rules`, set `filter` to the sentinel and bump `version`;
    - delete the catalog row.

    It returns `{ok, contactsUpdated, audiencesMarked}`.
  - `TagsController`: `GET /tags/:id/references`; `DELETE /tags/:id` reads `@Query("confirm")`.
- **B2 Audience delete** (`segments.service.ts`, `segments.controller.ts`):
  - `references(ws, id)`: smart audiences whose `group` rules name it, and campaigns with `segmentId = id`.
  - `remove(ws, id, {confirm})` follows ruling 7. It marks the referencing rules `missing` in the same transaction as the delete, then calls `emitSegmentDeleted` as today.
- **B3 Campaigns (F1):**
  - `backend/src/campaigns/sending/audience-stream.ts`: `streamAudience(prisma, ws, audienceWhere: Prisma.ContactWhereInput, defIds, pageSize)`. It keeps the keyset loop and adds `id > cursor` inside an `AND` with `audienceWhere`.
  - `campaign-preview.service.ts`, `launch-plan.ts` and `campaign-launch-runner.service.ts`: resolve once through `SegmentsService.resolveContactWhere(ws, segmentId, {now: planStart})`. `null` segment → `{workspaceId}`. Not found → `campaigns.audience_missing`.
  - `campaign-send.service.ts` `audience()`: the same resolver.
  - `CampaignsModule` imports `SegmentsModule`; check that there is no cycle (SegmentsModule imports nothing from campaigns).
  - `campaign-errors.ts`: `audience_missing`.
  - `launch-test-world.ts`: inject a resolver stub, so existing SP-13 specs keep passing unchanged in substance.
- **B4 Shared pipeline predicate** (ruling 9): `backend/src/contacts/pipeline-stage-where.ts` → `pipelineStageWhere(ws, {pipelineId, stageId?}, op)`. `contact-filter.ts` and the compiler both use it.
- **B5 HJZ summary:** `marketing-outbound.service.ts` `summarizeFilter` accepts a tree (English sentence per rule, `AND`/`OR` joined, at most 500 chars). The legacy path is unchanged.
- **B6 Engagement rules** (only if ruling 12 stands): `campaign` and `follow_up` in `validateRules`, `loadLookups` (campaigns of the workspace) and `compileAudience`; issue `campaign_missing`.
- **Other files:**
  - `backend/src/permissions/permission-map.ts`: `GET /tags/:id/references`. Rows in `permission-map.spec.ts` and the system-role block.
  - `backend/src/permissions/permission-sidedoors.spec.ts`: the ruling 14 case.

**Produces:**
- `GET /tags/:id/references`, `DELETE /tags/:id?confirm=1`, `DELETE /segments/:id?confirm=1`, and their 409 keys.
- Campaigns resolve smart audiences; `campaigns.audience_missing`.
- `pipelineStageWhere` (shared).
- The optional `campaign` and `follow_up` rules.

- [ ] Write the failing tests:
  - **`delete-tag-in-rule warns with affected audiences`** (`src/tags/delete-tag-with-references.spec.ts`), over the evaluator:
    - Fixture: tag `VIP` used by:
      - smart audience A (`rules`: `tag has VIP` AND `lifecycle in lead`);
      - legacy audience B (`filter {"tagsAny":["VIP","Gold"]}`);
      - smart audience C (`tag not_has VIP`);
      - a manual group D, which is unaffected.
      - Plus a tag `VIPER` used by E.
    - `GET /tags/:id/references` → A, B, C (not D, not E).
    - `DELETE /tags/:id` → 409 `tags.in_use_by_audiences {audiences:[A,B,C]}`, and **nothing** changed: contacts still carry VIP, the catalog row exists, and the rules are unchanged.
    - `DELETE /tags/:id?confirm=1` → 200 `{audiencesMarked: 3}`, then:
      - contacts lose VIP and keep VIPER;
      - A's rule is `missing` and A matches nobody;
      - B is converted to `rules`, with the `Gold` rule intact and VIP marked; it now matches Gold holders only, never more than before;
      - C matches nobody (not everyone);
      - B's `filter` is the sentinel;
      - each gets issue `tag_deleted`;
      - `version` is bumped;
      - E is untouched.
    - A tag with no references deletes with no confirmation, as today.
    - A foreign tag id → 404.
    - A failure while marking rolls everything back.
  - `tag rename and merge rewrite rules`: rename VIP→Premium rewrites A's and B's rules and filters (exact elements; VIPER untouched). A merge of VIP and Gold into Premium dedupes inside an `or` group. `segmentsUpdated` counts each changed audience once.
  - `delete-audience-with-references` (`src/segments/delete-audience-with-references.spec.ts`):
    - manual group G is used by smart audience S (`group in G`) and a draft campaign → 409 `audiences.in_use {audiences:[S], campaigns:[draft]}`; with `confirm` → G is deleted, S's rule is `missing` (issue `group_missing`), and the draft keeps its `segmentId`;
    - with a `scheduled` campaign, or one whose `launchStage` is `sending` → 409 `audiences.in_use_by_campaigns` even with `confirm`, and nothing is deleted;
    - an hjz group keeps its 404 text;
    - a foreign id → 404.
  - `campaign audience resolves smart segments like the contacts list`: for a smart audience (`last_active within 7 days` AND `channel is whatsapp`), the ids streamed by `streamAudience` with the resolver's where equal the ids from `ContactsService.listIds({segmentId})`. Every page has at most 1 000 rows and ascending ids. Relative windows use the launch's `planStart`: advancing the fake clock between pages does not change membership.
  - `manual group campaign audience unchanged`: the existing SP-13 audience specs pass, and the manual-group stream equals its `SegmentMember` set.
  - `missing audience refuses preview and launch`: a deleted segment id → 400 `campaigns.audience_missing {segmentId}` on preview and launch; the background job fails with that `lastError`.
  - `pipeline stage helper is shared by the list and audiences` (ruling 9): for the same pipeline and stage, `buildContactWhere({pipelineId, stageId})` and `compileAudience(pipeline_stage in …)` select the same set, including a closed card in a terminal stage. Pipeline only → open cards only. An archived pipeline → nobody in the audience, with an issue.
  - `hjz summary describes rule trees` (English, at most 500 chars, legacy unchanged).
  - If B6: `engagement rules use recipient timestamps and open follow-ups`:
    - received / read / replied / not_replied / failed over SP-12 rows with each status and timestamp mix;
    - a recipient row with `contactId` null (deleted contact) never matches;
    - follow-up open, overdue at the `now` edge, and none_open;
    - a foreign campaign id → 404;
    - a deleted campaign → `campaign_missing`.
  - `audience routes expose no conversation data` (ruling 14; in `permission-sidedoors.spec.ts`): the JSON of `/segments/:id/contacts`, preview samples and the detail contains no conversation id, message text or assignee.
  - `foreign ids return 404 on SP-16 routes` (part 2): `GET /tags/:id/references`, `DELETE /tags/:id?confirm=1` and `DELETE /segments/:id?confirm=1`, with workspace B's ids from A.
  - `permission map covers SP-16 routes` (part 2).
- [ ] Implement until green. Review checklist for the PR:
  - every relation filter in the compiler carries `workspaceId`;
  - no delete path removes a rule (it marks it);
  - no consumer bypasses `resolveContactWhere`. Grep `segmentMembers: { some: { segmentId` under `src/campaigns`: zero hits.
- [ ] `npx tsc --noEmit -p tsconfig.json`, the jest paths, then the full `npm test` once. The SP-12/13/14 specs must stay green, extended only.
- [ ] Commit `feat(segments): safe tag and audience deletes, campaigns honour smart audiences, shared pipeline predicate`.

### Task 3: Frontend — rule editor, Audiences tab and detail page, safe-delete dialogs
**Depends on:** the contracts of Tasks 1–2. It can start from Task 1's contract while Task 2 is in review.

**Files:**
- **F1 Model:** `src/screens/contacts/audiences/rulesModel.ts` (pure):
  - types mirroring the backend, and `AUDIENCE_LIMITS`;
  - `legacyToTree` (the same mapping as the backend, for display only; the server stays authoritative);
  - `FIELD_DEFS`: per field, its ops, value kind and labels via `tx`;
  - `emptyRule(field)`;
  - `describeRule(rule, tx, lookups)` and `describeTree`: one sentence per rule, `AND`/`OR` worded "and" / "و", "or" / "أو";
  - `countConditions`, `depthOf`, `canAddRule(tree, path)`, `canAddGroup(tree, path)`;
  - `issueText(issue, tx)`, `relTimeLabel`;
  - `isLegacyExpressible(tree)`, used to explain why an audience edited here is no longer visible to older versions; shown only in dev tools, not to users.

  Tests in `rulesModel.test.ts`.
- **F2 Editor:** `src/screens/contacts/audiences/AudienceRulesEditor.tsx`:
  - The root group has a "Match all / any of the following" toggle: "تطابق جميع / أيٍّ من الشروط التالية".
  - Rules can be added, and groups added up to depth 3; "Add condition" is disabled at 30 with a reason.
  - **Per-field value inputs:**
    - tag picker (`GET /tags`);
    - lifecycle multi-select (existing lifecycle options from `lifecycle.ts`);
    - not-a-lead toggle;
    - relative time (amount plus unit);
    - date (native `type="date"`, labelled with the workspace timezone);
    - channel select;
    - group picker (`GET /segments`, excluding the audience itself; smart ones badged);
    - pipeline, then stage (`GET /pipelines`, archived hidden);
    - custom field, then the op per type, then the value (`GET /custom-fields`, reusing `fieldValue.ts` input helpers);
    - campaign picker and follow-up (F6).
  - A live preview (debounced 400 ms, stale answers dropped) shows the count, "Too large to count right now" on timeout, the 5-name sample, and inline issues.
  - Server 400/404 keys map to the offending rule by `path`.
- **F3 Audiences tab:** `src/screens/contacts/GroupsTab.tsx` is reworked into `AudiencesTab.tsx` (`GroupsTab` stays as a re-export only if other imports need it):
  - the tab label is "Audiences" / "الجماهير" (ruling 13);
  - sections "Groups" (manual) and "Smart audiences";
  - cards show count, `countedAt` and an issue dot;
  - "New smart audience" (`audiences.create`) opens a sheet with name, Arabic name, colour and `AudienceRulesEditor`;
  - "New group" and "Import file" are unchanged.

  `Contacts.tsx`:
  - the tab id `groups` becomes `audiences`, and `#/contacts?ct=groups` still opens it;
  - the "Manage segments" button opens this tab;
  - `SegmentManager.tsx` is deleted, and its imports removed.
- **F4 Detail page:** `src/screens/contacts/audiences/AudienceDetail.tsx`, opened by `?aud=<id>` (`hashState.ts`):
  - **Header:** name `<bdi>`, type badge, count with "Counted at …" and "Recount" (`GET /segments/:id/count`), "Edit" (`audiences.update`), "Delete" (`audiences.delete`).
  - **Issues banner:** each issue is worded via `issueText`, with "Fix rules".
  - **Smart audiences:** a rules summary (`describeTree`). Edit opens the editor with `version`. A 409 `version_conflict` shows "Someone else changed this audience" / "عدّل شخص آخر هذا الجمهور" with "Load their version" and "Keep mine".
  - **Members:** `GET /segments/:id/contacts` with search (debounced) and "Load more" (keyset `nextCursor`). Rows open the record sheet (`openRecord`).
  - **Manual groups:** "Add people" uses `GET /segments/:id/candidates` with search (keyset) and `POST /segments/:id/members`. Each row has "Remove" (`DELETE /segments/:id/members/:contactId`). "Import file" opens `ImportWizard` with `kind="audience"` and the group preset; this needs `initialGroupId` added to `ImportWizard` props.
  - **"Used by":** the audiences and campaigns from `GET /segments/:id`.
  - **Delete dialog:**
    - 409 `audiences.in_use` lists both, and "Delete anyway" sends `?confirm=1`, with copy saying the rules that use it will match nobody until fixed;
    - 409 `in_use_by_campaigns` lists the campaigns and offers no override.
- **F5 Tags:** `src/screens/contacts/TagsTab.tsx`: delete first calls `GET /tags/:id/references`.
  - With references, a dialog lists the audiences (each linking to `?aud=`) and says "Rules that use this tag will match nobody until you change them" / "الشروط التي تستخدم هذا الوسم لن تطابق أحدًا حتى تعدّلها". "Delete anyway" sends `?confirm=1`.
  - A 409 from a race shows the same dialog.
- **F6 Engagement rules** (only if ruling 12 stands): the campaign picker (`GET /campaigns`, launched ones only) and the follow-up ops in the editor.
- **F7 Campaigns:**
  - `src/screens/Campaigns.tsx` `AudienceStep`: smart audiences get a "Smart" / "ذكي" badge, and a null count reads "Counting…" / "جارٍ العدّ…".
  - The review step notes "Smart audience: members are worked out when the campaign starts" / "جمهور ذكي: يُحدَّد الأعضاء عند بدء الحملة" (ruling 8).
  - `campaignErrors.ts`: `audience_missing`.
- **F8 Types and copy:**
  - `src/lib/types.ts`: `AudienceRules`, `AudienceNode`, `AudienceRule`, `RuleIssue`, `AudienceDetail`, `AudienceContactsPage`, `TagReferences`. `Segment` gains `rules`, `rulesSource`, `count: number | null`, `countedAt`, `timedOut`, `issues`, `version`.
  - `src/screens/contacts/audiences/audienceErrors.ts` + test.
- **Permission gating** with `usePermissions().can(...)`:
  - create: `audiences.create`;
  - edit, add and remove members: `audiences.update`;
  - delete: `audiences.delete`;
  - import: as today;
  - tag delete: `contacts.update`.

  Hidden actions are not rendered. A 403 shows the shared no-permission toast.

**Produces:**
- The Audiences tab, the smart-audience editor with nested AND/OR and a live preview, and the detail page with members, candidates, import, issues and "Used by", in English and Arabic.
- The safe-delete dialogs for tags and audiences.
- Campaign badges and notes.

- [ ] Write the failing vitest tests:
  - `legacy filters open in the editor as an and group`: the same table as the backend (each key; `tagsAny` as a nested `or`; `{}` as an empty `and`). `describeTree` for `{"tagsAny":["VIP","Gold"],"lifecycle":["lead"]}` gives "Lifecycle is Lead and (has tag VIP or has tag Gold)" and the Arabic equivalent.
  - `rule sentences cover every field and operator in both languages`: no English leaks into the Arabic output, and tag, group and contact names are wrapped for `<bdi>`.
  - `editor limits depth and condition count`: `canAddGroup` is false at depth 3; `canAddRule` is false at 30.
  - `issues render in both languages and never as blank`: every `RuleIssue.kind`.
  - `timed-out count never renders as zero`.
  - `audience error copy covers every SP-16 key in both languages` (including `tags.in_use_by_audiences` and `campaigns.audience_missing`).
  - `contacts tab hash keeps the old groups link working` (`ct=groups` → `audiences`; `aud` round-trips).

  Then implement until they pass, then build the components.
- [ ] `npx vitest run`, `npm run typecheck` and `npm run build` clean. A read-only look at the pages on the dev server is optional; the real UI pass is in Task 4.
- [ ] Commit `feat(contacts): smart audience editor, audiences tab and detail page, safe tag and audience deletes`.

### Task 4: Verification
Apply `20261115130000_smart_audiences` with `npx prisma migrate deploy`, and only when the controller and the user explicitly approve it (ruling 18). It is safe for `main` (Global Constraints).

Record the results in `.superpowers/sdd/2026-11-15-sp16-smart-audiences/live-verification.md`, in the format of SP-13's `live-verification.md`:
- summary;
- a results table with evidence;
- DB-side checks;
- timings;
- findings;
- cleanup.

If the harness refuses the write, put the tables in the scratchpad and say so; do not reroute.

**Before approval (read-only, production):**
- `SELECT reltuples FROM pg_class WHERE relname IN ('Contact','Segment','Message','Conversation')`: the index-build size.
- The ruling 8 check: `SELECT c.status, count(*) FROM "Campaign" c JOIN "Segment" s ON s.id = c."segmentId" WHERE s.origin = 'crm' AND c.status IN ('draft','scheduled') GROUP BY 1`. Report the counts, and list **scheduled** ones by id and workspace id only, for the user's decision.
- Ask the user for approval of the migration and, separately, of the 100k seed.

**Isolation** (no repo code changed; scripts derived from SP-13's and SP-14's, in the session scratchpad `C:\Users\ashra\AppData\Local\Temp\claude\7b75a64029a712a6\ebb2057a-6300-4548-9aec-b98487880afb\scratchpad\`):
- **Own instance:** `launch-sp16.js`, derived from `launch-sp14.js`.
  - Backend on **:4240**, compiled with `tsc -p tsconfig.build.json` into a throwaway outDir (`backend/.verify-dist-sp16`, never `backend/dist`) and started with `node`. The user's :4100 process is not touched.
  - It records `perf_hooks.monitorEventLoopDelay` and prints p50, p99 and max per check.
- **Crons:** all `@nestjs/schedule` jobs are disabled (the SP-13 `lookupSchedulers` patch). SP-16 adds none.
- **Provider keys and outbound:** set to **empty strings**, not deleted (SP-19 finding E2), as in SP-14. `HJZ_OUTBOUND_URL=""`, so `emitSegmentUpserted` and `emitSegmentDeleted` return early, and the test workspace has no `externalTenantId` anyway.
- **No external send, ever:**
  - The campaign preview's template and sender reads go to `zernio-stub-sp16.js` on **:4239** (copied from `zernio-stub-sp13.js`; `ZERNIO_BASE_URL=http://127.0.0.1:4239/api/v1`, `ZERNIO_API_KEY=zz-verify-stub`).
  - **No campaign is launched.** The launch path is exercised only through `POST /campaigns/preview` and a direct call of the plan stage's `streamAudience` from the verification script, which writes nothing.
  - The SP-13 egress guard stays (fetch, http and https to any non-loopback host throws and is logged to `blocked-egress-sp16.jsonl`).
  - **The launcher refuses to start** unless `ZERNIO_BASE_URL` begins with `http://127.0.0.1`, `ZERNIO_API_KEY` equals `zz-verify-stub`, and `HJZ_OUTBOUND_URL` is empty.
  - Before cleanup, the script asserts that `blocked-egress-sp16.jsonl` is empty and that the stub log holds no `POST` to any broadcast or message endpoint.
- Test tag `zz-verify-<ts>` on every name and email.

**Setup** (writes only rows of the throwaway workspace; every id is recorded in `verify-created-sp16.json`):
1. Register an owner and a foreign owner (their own workspace). Invite an admin, an agent and a viewer.
2. **Fixture (about 200 contacts, handcrafted, with known expected memberships):**
   - lifecycles, including capitalised `Lead`;
   - `notALead`;
   - `createdAt` spread over 400 days (set explicitly);
   - tags `VIP`, `VIPER`, `Gold`;
   - conversations on whatsapp, instagram and webchat, with `them` messages at 1 h, 3 d, 40 d and 200 d, and `human`/`ai`-only threads;
   - two pipelines (one later archived), with open and closed cards in a won stage;
   - custom fields of every type with values;
   - a manual group G;
   - a launched-looking campaign row with `CampaignRecipient` rows in every status, inserted directly (no send);
   - open and overdue activities.
3. **Audiences:**
   - one legacy audience inserted **directly** with a legacy `filter` (as `main` would write it);
   - smart audiences through the API, one per rule kind plus nested `and`/`or` combinations;
   - S1 `group in G`;
   - S2 `group in S1`.
4. **Scale** (only with approval):
   - 100 000 synthetic contacts via one `INSERT … SELECT generate_series(1, 100000)`, with names `zz-verify-<ts>-<n>`, varied lifecycles and tags, and `createdAt` spread over 2 years;
   - about 30 000 conversations and about 60 000 `them` messages, spread over 365 days;
   - `ANALYZE` is **not** run (production statistics are left alone); the timings note this.

**Checks:**
- **Correctness (fixture):** for every audience, the API count and the full member list equal the expected set, which the script computes with an **independent** hand-written SQL query per rule (not the app's compiler). The legacy audience's API count equals the hand SQL of its old semantics.
- **`legacy filter JSON evaluates identically` (live):** for the directly inserted legacy audience, `GET /segments` shows `rulesSource:"legacy"` and the same count as before the SP-16 instance existed. The count is taken first with the frozen legacy `buildWhere` logic in the script, through Prisma read-only.
- **Old-reader safety:** a smart audience with `last_active` has `filter = LEGACY_SENTINEL`. Running the legacy `buildWhere` over it (script, read-only) returns 0.
- **`cyclic group membership rule rejected` (live):** `PATCH S1` with `group in S2` → 400 `audiences.rule_cycle {path}`, and S1 is unchanged. Two crossing PATCHes fired in parallel → at most one 200.
- **`delete-tag-in-rule warns with affected audiences` (live):** `DELETE /tags/<VIP>` → 409 listing exactly the affected audiences, with nothing changed (read before and after). `?confirm=1` → the rules are marked, the counts drop to the expected sets (never above the previous ones), the issues show, and VIPER audiences are unchanged.
- **Audience delete:** deleting G → 409 `in_use` (S1 and a draft campaign). With a campaign set to `scheduled` (status update on the test row) → 409 `in_use_by_campaigns` even with confirm. Restore the draft, then confirm → S1 is `group_missing` and matches nobody.
- **Broken references:** archive the test pipeline (`POST /pipelines/:id/archive`) → its rules match nobody with `pipeline_archived`. Archive a custom field → `field_missing`.
- **Campaigns (F1):** `POST /campaigns/preview` for a draft on a smart audience reports the expected `total`/`reachable`. A draft on G is unchanged from before. The script's `streamAudience` with the resolver gives the same ids as `/contacts/ids?segmentId=`. A deleted audience → 400 `campaigns.audience_missing`. The Zernio stub log shows only template and sender reads.
- **Contacts list:** `/contacts/page?segmentId=<smart>` totals equal the audience count. The pipeline filter with the won stage now includes closed cards (ruling 9).
- **Scale (100k, or 20k on the fallback):**
  - for each rule kind and for a 6-condition nested audience: `GET /segments/:id/count`, `POST /segments/preview`, the first `/contacts` page, and a page after the 50 000th id;
  - `/candidates` on G;
  - `GET /segments` with 10 stale smart audiences;
  - `POST /campaigns/preview` on the largest audience.

  Record each wall time and the event-loop delay. **Targets:** count and preview ≤ 3 s; a member page ≤ 1 s; event-loop p99 ≤ 100 ms; the campaign preview completes. Anything over the target is a finding, with the plan from `EXPLAIN` (no `ANALYZE` on writes; `EXPLAIN (ANALYZE, BUFFERS)` on the read-only `SELECT`s only).
- **Index use:** `EXPLAIN` of the created-rule count and of a keyset page inside `BEGIN; SET LOCAL enable_seqscan = off; … ROLLBACK;` uses `Contact_workspaceId_createdAt_idx` and `Contact_workspaceId_id_idx` respectively.
- **Timeout:** with `AUDIENCE_COUNT_TIMEOUT_MS=50` (a second short run of the instance), a large count returns `count:null, timedOut:true`, with HTTP 200, and the UI shows "Too large to count right now".
- **Version conflict:** two PATCHes with the same `version` → one 200 and one 409 with `current`.
- **Permissions and tenancy:**
  - the foreign owner gets 404 on every new route and on every rule that references a foreign id;
  - the viewer reads and previews but gets 403 on create, update and delete;
  - the agent can create;
  - an impersonated session can read.
- **No side effects:**
  - `Segment.updatedAt` is unchanged by counts and list calls;
  - no `SegmentMember` row is written for smart audiences;
  - no Notification is created;
  - `Contact` and `Tag` rows outside the workspace are unchanged (counts before and after).
- **Migration rerun:** execute the SP-16 migration SQL again inside a transaction that is always rolled back: no errors and 0 rows changed. If the tool safety layer refuses DDL even in a rolled-back transaction (as in SP-13), record it and ask the user; do not reroute.
- **UI through the `verify` skill:**
  - the Audiences tab, the editor (nested groups, every field, the live preview, the limit reasons, the timeout text), and the detail page (members, Load more, search, candidates, add and remove, import preset, issues banner, Used by, the version-conflict dialog);
  - the tag delete dialog;
  - the campaign badges and note;
  - English and Arabic (RTL) screenshots.

**Cleanup:**
- Delete the synthetic contacts in batches of 5 000 by id (keyset), then the recorded workspaces (the cascade covers contacts, conversations, messages, segments, members, tickets, pipelines, custom fields, campaigns, recipients, tags and activities), then the users.
- Run a residue sweep over every table with a `workspaceId` column, plus `SegmentMember`, `CustomFieldValue` and `Message` by recorded ids.
- Read-only counts before and after: `Workspace`, `User`, `Contact`, `Segment`, `SegmentMember`, `Conversation`, `Message`, `Ticket`, `Pipeline`, `CustomFieldDef`, `CustomFieldValue`, `Tag`, `Campaign`, `CampaignRecipient`, `Activity`, `WorkspaceMember`. Every count must be identical.
- Stop :4240, the stub and the second instance, and remove the outDir.

Then tick SP-16's "Detailed plan written" and "Shipped" boxes in the roadmap, noting the rulings taken and the deviations. Add the deferred items to the roadmap:
- exact conversation-count thresholds and a `ContactStats` table (ruling 4);
- a `Message(workspaceId, createdAt)` index if Task 4 found `last_active` over target (ruling 10);
- audience references in SP-02's field-delete and SP-07's stage and pipeline previews (ruling 7);
- membership-changed workflow triggers (Tkana's entered/left events);
- the engagement rules, if ruling 12 dropped them.
