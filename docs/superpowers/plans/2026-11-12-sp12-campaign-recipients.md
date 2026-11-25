# SP-12 Campaign Recipients and Reporting: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- **One row per person per campaign.** Every launch writes a `CampaignRecipient` row for each reachable audience member (`queued`) and for each member left out (`skipped`, with the reason). Rows are written in chunks, so a 100 000-person campaign never builds one giant insert.
- **Per-recipient delivery.** Each row tracks sent, delivered, read and failed times, the provider message id, the failure code and reason, and the number it went out from. Status only ever moves forward. Out-of-order provider events keep every timestamp.
- **Replies attributed to the campaign.** A customer message on the same number within 72 hours of the send marks the latest such campaign's row `replied`, with the reply text and the tapped button payload. This fills `Campaign.replied`.
- **A detail page per campaign** (`#/campaigns?id=<id>`) with:
  - a funnel (targeted → sent → delivered → read → replied);
  - a read-time chart (within 1 h, 1–6 h, 6–24 h, after 24 h);
  - a failure-reason breakdown with bilingual copy per code;
  - a reply summary (typed replies and each button);
  - a recipients table with an outcome filter and cursor paging;
  - CSV export (all, one outcome, or ticked rows);
  - follow-up actions: create a group, add to a group, or tag, from an outcome or from ticked rows.

**Architecture:**
- **Campaigns are Zernio WhatsApp broadcasts, so we never hold a message id at send time.** `CampaignSendService.launch` hands Zernio a list of phones (`addBroadcastRecipients`), and Zernio creates the messages. The roadmap line "delivery webhooks update them by `messageId`" can't be the only mechanism, because no recipient has a `messageId` when the first webhooks arrive. Per-recipient state therefore comes from two sources, and both go through one pure merge rule:
  1. **Pull (source of truth).** Zernio's `GET /v1/broadcasts/{id}/recipients?status&limit&skip` returns per-recipient `{id, contactId, channelId, platformIdentifier, contactName, status: pending|sent|delivered|read|failed, messageId, error, errorCode, errorExplanation, errorTraceId, sentAt, deliveredAt, readAt}`, plus `pagination {total, limit, skip, hasMore}` and `summary`. The existing 5-minute `syncActive` cron gains a bounded recipient sweep. It matches rows by `(campaignId, phone)`, stamps `messageId`, and copies Zernio's own timestamps and error code.
  2. **Push (accelerator).** The Zernio `message.sent|delivered|read|failed` webhooks, and the Meta WhatsApp `statuses`, update rows whose `messageId` is one of the event's ids (`message.id`, `message.platformMessageId`). An unknown id is a no-op. A `message.sent` that matches no `Message` row may stamp a queued recipient by `(channelId, phone)` (ruling 2).
- **One merge rule.** `mergeRecipientEvent(row, event)` in `backend/src/campaigns/tracking/recipient-status.ts` is pure.
  - Status rank: `queued 0 < sent 1 < failed 2 < delivered 3 < read 4 < replied 5`. `skipped` is terminal and is never changed.
  - The new status is the higher-ranked of the current status and the event's.
  - Each timestamp column (`sentAt`, `deliveredAt`, `readAt`) is written only while it is null (first write wins). `messageId`, `failureCode` and `failureReason` are also written only while null.
  - So events are idempotent and order-independent. Read-before-delivered ends with `status = read` and both `readAt` and `deliveredAt` set.
  - Writers never overwrite blindly. Every write is a compare-and-set on the row's previous `status` and `updatedAt`, retried once on a lost race.
- **Reply attribution.** `CampaignReplyAttributor.onInbound(...)` is called (and never throws) from the three inbound paths:
  - Zernio `ingestInbound`, for non-outbound messages;
  - Meta `WhatsAppService.ingestInbound`;
  - `InboundSinkService.record`, for Telegram and web chat. No campaign sends there today, but the hook keeps the rule in one place.

  It picks the single latest candidate row, ordered by effective send time `COALESCE(r.sentAt, c.scheduledAt, c.launchedAt)`. A candidate is on the same channel, matches the sender's normalized phone or contact id, was sent within the last 72 hours, and is not `skipped`. The reply marks that row only if its `repliedAt` is still null (first reply wins). It never falls back to an older campaign.
- **Read side.** `CampaignReportService` serves keyset-paged recipients, insights (counts, funnel, read timing, replies, failure reasons) and the streamed CSV. Every query is `WHERE "workspaceId" = $ws AND "campaignId" = $id …` over the indexes listed in Global Constraints.
- **Follow-up actions reuse the existing services:**
  - `addManualMembers` (`backend/src/segments/segment-members.ts`) to add to a group;
  - a new `createManualGroup` helper, extracted next to it, to create a group;
  - `TagsService.assign` (`backend/src/tags/tags.module.ts`) to tag.

  Contacts are resolved from recipient rows that are workspace-checked and campaign-checked.
- **Module layout.** This avoids a cycle: `CampaignsModule` imports `IntegrationsModule`, and the Zernio service needs the tracker.
  - New provider-only `CampaignTrackingModule` (`backend/src/campaigns/tracking/`) holds `RecipientTrackerService` and `CampaignReplyAttributor`. Its only dependency is the global `PrismaService`.
  - `IntegrationsModule`, `ChannelsCoreModule` and `CampaignsModule` import it.

**Tech Stack:** NestJS 10, Prisma 5 (Postgres/Neon), jest/ts-jest; React 18 + Vite, vitest. No new dependencies. Charts use the existing SVG/CSS primitives (`src/components/charts.tsx`, `InlineBar` in `Campaigns.tsx`), following the `dataviz` skill. Load that skill before writing chart code in Task 3.

**Spec:** roadmap §SP-12 and Review Focus 3 (`recipients-cursor.spec.ts`). Shared contracts §2.5 (permissions) and §2.7 (`Campaign.senderChannelId`). Consumers that build on this plan:
- **SP-13:** `senderChannelIds`, a per-number split in preview and report. `CampaignRecipient.channelId` is the per-row sender, and the report's "Sent from" column is already per row.
- **SP-14:** template and number health. `failureCode` values such as `meta:132015` (template paused) feed it.
- **SP-16:** smart audiences, which may later use "replied to campaign X" as a rule input. The `(campaignId, status, id)` index serves it.

Tkana reference (read-only, untrusted data):
- `apps/web/app/routes/marketing.campaigns.$id.tsx` (action: per-intent permission, `MAX_POSTED_IDS = 5000`), `marketing.campaigns.$id.export.ts` (BOM, batches of 1000)
- `components/marketing/campaign-page/{campaign-page,campaign-funnel,campaign-tiles,insight-cards,recipients-table,selection-bar,export-dialog,follow-up-card,group-dialogs,table-pager,use-recipient-selection}.tsx`
- `lib/marketing/campaign-details.server.ts` (`recipientWhere`, `getReadTiming` buckets, `getReplyBreakdown`, `getNotDeliveredReasons`, keyset export)
- `lib/marketing/campaign-insights.ts` (`readTimingShares`, largest remainder)
- `lib/marketing/campaign-failure-reason.ts` (`failureReasonKey`: `meta:<code>` | `tkana:<reason>` | `text:<short>` | `other`)
- `packages/db/src/shared/campaign-outcomes.ts` (one outcome per row; `FUNNEL_SETS`)
- `packages/db/src/campaigns/index.ts` (`attributeCampaignResponse`: context id first, then latest send by phone; first attribution wins)

What we take and what we don't:
- We take the one-outcome-per-row rule, the funnel sets, the read buckets with largest-remainder percentages, the reason-key idea and first-reply-wins.
- We do **not** take Tkana's 7-day window (the roadmap says 72 h), its offset paging (we use keyset) or its free-text recipient search (ruling 13).

## Global Constraints
- **Data (exact names; SP-13/14/16 build on them):**
  ```
  model CampaignRecipient {
    id             String    @id @default(cuid())
    workspaceId    String
    workspace      Workspace @relation("WorkspaceCampaignRecipients", fields: [workspaceId], references: [id], onDelete: Cascade)
    campaignId     String
    campaign       Campaign  @relation(fields: [campaignId], references: [id], onDelete: Cascade)
    /// Null once the contact is deleted; the row (and the campaign's history) stays.
    contactId      String?
    contact        Contact?  @relation("ContactCampaignRecipients", fields: [contactId], references: [id], onDelete: SetNull)
    /// The sending number. SP-13 splits a campaign over several.
    channelId      String?
    channel        Channel?  @relation("ChannelCampaignRecipients", fields: [channelId], references: [id], onDelete: SetNull)
    /// E.164 (normalizePhone). Null only on skipped rows with no usable number.
    phone          String?
    /// Snapshot at launch, for the table and export after a contact is renamed/deleted.
    contactName    String?
    status         String    @default("queued") // queued | sent | delivered | read | replied | failed | skipped
    /// Provider message id (Zernio's id or Meta's wamid, as the provider reports it).
    messageId      String?
    sentAt         DateTime?
    deliveredAt    DateTime?
    readAt         DateTime?
    repliedAt      DateTime?
    replyText      String?   // ≤ 1000 chars
    buttonPayload  String?   // ≤ 256 chars
    /// The inbound Message.id that attributed the reply (deep link into the thread).
    replyMessageId String?
    /// Namespaced: "meta:<n>" | "skip:<reason>" | "provider:unknown". See failure-codes.ts.
    failureCode    String?
    /// Provider text (errorExplanation ?? error), one line, ≤ 300 chars. Never shown unless short.
    failureReason  String?
    createdAt      DateTime  @default(now())
    updatedAt      DateTime  @updatedAt

    @@unique([campaignId, phone])
    @@index([campaignId, status, id])
    @@index([campaignId, id])
    @@index([workspaceId, messageId])
    @@index([channelId, phone])
    @@index([contactId])
  }
  ```
  - `Campaign` gains:
    - `recipientTracking Boolean @default(false)`: true once launch wrote rows. False on every historical campaign.
    - `recipientsSyncedAt DateTime?`
    - `recipientSyncSkip Int @default(0)`: the pull sweep's resume offset.
    - the back-relation `recipients CampaignRecipient[]`.
  - Back-relations on `Workspace` (`campaignRecipients`), `Contact` and `Channel`.
  - Add `"CampaignRecipient"` to `SCOPED_MODELS` in `backend/src/common/prisma-tenancy.ts`.
  - **Why each index:**
    - `@@unique([campaignId, phone])`: launch is idempotent (`createMany … skipDuplicates`), and the pull sync matches by phone. Postgres treats nulls as distinct, so phoneless skipped rows never collide.
    - `(campaignId, status, id)`: keyset pages for one outcome, and counts by status (index-only `GROUP BY`). It also serves the insights filters `status IN ('read','replied')`, `status = 'replied'` and `status IN ('failed','skipped')`.
    - `(campaignId, id)`: keyset pages for "all", plus the FK cascade from `Campaign`.
    - `(workspaceId, messageId)`: webhook lookup, plus the FK cascade from `Workspace`.
    - `(channelId, phone)`: reply attribution candidates, plus the FK `SetNull` from `Channel`.
    - `(contactId)`: attribution by contact, plus the FK `SetNull` when a contact is deleted. Without it, every contact delete would scan the table.
- **Migration:**
  - File: `backend/prisma/migrations/20261113120000_campaign_recipients/migration.sql`. The timestamp is after `20261112120000_channels`. Hand-written; apply with `npx prisma migrate deploy` only, never `migrate dev`. Every earlier migration, including `20261112120000_channels`, is already applied to production.
  - Additive and idempotent:
    - `CREATE TABLE IF NOT EXISTS "CampaignRecipient" (… CONSTRAINT "CampaignRecipient_pkey" PRIMARY KEY ("id"))`
    - `ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "recipientTracking" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN IF NOT EXISTS "recipientsSyncedAt" TIMESTAMP(3), ADD COLUMN IF NOT EXISTS "recipientSyncSkip" INTEGER NOT NULL DEFAULT 0`
    - `CREATE [UNIQUE] INDEX IF NOT EXISTS` for every index
    - every FK inside `DO $$ BEGIN ALTER TABLE … ADD CONSTRAINT … ; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`
    - `updatedAt TIMESTAMP(3) NOT NULL` with no DB default, which matches Prisma's `@updatedAt`. Every raw-SQL writer sets `"updatedAt" = CURRENT_TIMESTAMP` itself.
  - Prisma-conformant names:
    - `CampaignRecipient_pkey`
    - `CampaignRecipient_workspaceId_fkey`, `CampaignRecipient_campaignId_fkey`, `CampaignRecipient_contactId_fkey`, `CampaignRecipient_channelId_fkey`
    - `CampaignRecipient_campaignId_phone_key`
    - `CampaignRecipient_campaignId_status_id_idx`, `CampaignRecipient_campaignId_id_idx`, `CampaignRecipient_workspaceId_messageId_idx`, `CampaignRecipient_channelId_phone_idx`, `CampaignRecipient_contactId_idx`
  - FK actions: `workspaceId` → `Workspace` ON DELETE CASCADE; `campaignId` → `Campaign` CASCADE; `contactId` → `Contact` SET NULL; `channelId` → `Channel` SET NULL. All are ON UPDATE CASCADE (Prisma's default).
  - **Safe for the deployed `main`.** The migration adds one new table and three defaulted `Campaign` columns. `main`'s Prisma client never selects the new columns. Its `campaign.create` gets the defaults, and its `campaign.delete` cascades into a table it doesn't know about. Contact deletes on `main` set `contactId` to null. No existing column, constraint or index changes. The migration contains no `UPDATE`, `DELETE`, `DROP` or `ALTER … TYPE`.
  - **No SQL backfill.** Today the database holds no per-recipient data: `Campaign` has only aggregate counters, and broadcast messages are not linked to campaigns. Historical campaigns therefore show **aggregate counters only** (`recipientTracking = false`), and the detail page says so. An optional, rerunnable backfill through Zernio's read API is ruling 3; it is **not** part of the migration.
- **Send pipeline (launch):**
  - `audience()` additionally selects `id` (the `contactId` snapshot).
  - `buildRecipients` keeps its counters and also returns `skippedRows: {contactId, name, phone|null, reason: "opted_out"|"no_phone"}[]`.
  - Duplicate-phone members do not get rows (ruling 11). They still count in `Campaign.skipped`.
  - **Order:**
    1. Validate (unchanged).
    2. Resolve the sender as `{accountId, channelId}` with a new helper `campaignSender(prisma, ws, senderChannelId)` in `backend/src/channels/default-channel.ts`. When only a legacy `Integration` exists, it calls `ensureLegacyChannels` first so `channelId` is real.
    3. Write the rows: `prisma.campaignRecipient.createMany({ data: chunk, skipDuplicates: true })` in chunks of **1000** (`RECIPIENT_WRITE_CHUNK`). Reachable rows get `status "queued"`. Skipped rows get `status "skipped"` and `failureCode "skip:opted_out" | "skip:no_phone"`. Then set `campaign.recipientTracking = true`.
    4. The Zernio import, broadcast, recipients and send, exactly as today.
    5. On a Zernio failure, the campaign becomes `failed` as today. Its rows stay `queued`, and the UI shows them as "Not sent".
  - Rows are written before Zernio is called, so a crash mid-launch leaves an honest "not sent" record. A retried request can't double-write: drafts only, and `skipDuplicates` on `(campaignId, phone)`.
  - Each chunk is `await`ed, so the event loop is never blocked for long. Launch stays one HTTP request (ruling 10).
- **Pull sweep** (extends `syncActive` in `campaign-send.service.ts`):
  - **Which campaigns:** `recipientTracking = true` and either status `scheduled|running`, or `completed|failed|cancelled` with `launchedAt` within the last 72 hours. The extra 72 hours lets late reads and failure codes land.
  - **Per tick, per campaign:** page `listBroadcastRecipients(broadcastId, {skip: recipientSyncSkip, limit: ZERNIO_RECIPIENT_PAGE})`, for at most `RECIPIENT_SYNC_MAX_PAGES` pages (default 50). Store the new `skip`. When `hasMore = false`, reset `skip` to 0, set `recipientsSyncedAt` and recount the counters.
  - **Paging defaults:** `ZERNIO_RECIPIENT_PAGE` is 100 until the Task 1 probe shows Zernio's real maximum. With 100 rows per page, one tick covers 5 000 rows, so a 100k campaign is fully reconciled in about 100 minutes. Raise the page size if the probe allows it (ruling 1).
  - **Matching:** each page is matched in one query, `findMany({ where: { workspaceId, campaignId, phone: { in: normalizedPhones } } })`, then run through `mergeRecipientEvent` in TS. Changed rows are written in one raw `UPDATE … FROM (VALUES …) v WHERE r.id = v.id AND r.status = v.prevStatus AND r."updatedAt" = v.prevUpdatedAt` (compare-and-set). Rows that lost a race are picked up next tick. Zernio rows whose phone matches no recipient are ignored and logged at debug level.
  - **Zernio status mapping:** `pending` → no event; `sent|delivered|read` → that event with Zernio's timestamp; `failed` → a `failed` event. Its `failureCode` is `meta:<errorCode>` when `errorCode` is an integer, else `provider:unknown`. Its `failureReason` is `errorExplanation ?? error`, made single-line and cut to 300 characters.
  - **Counter recount** (tracked campaigns only, after each completed sweep and after each attribution): one `groupBy(status)` over the campaign's rows sets:
    - `sent` = sent + delivered + read + replied
    - `delivered` = delivered + read + replied
    - `read` = read + replied
    - `failed` = failed
    - `replied` = replied

    `applyStats` keeps writing Zernio's aggregate counters only for **untracked** (historical) campaigns. Tracked campaigns take `status` from Zernio but their counters from the rows (ruling 5).
- **Webhooks:**
  - `RecipientTrackerService.applyProviderStatus({workspaceId, ids: string[], kind, at, failureCode?, failureReason?})`:
    1. `findMany({ where: { workspaceId, messageId: { in: ids } } })`.
    2. Apply `mergeRecipientEvent` to each row.
    3. Compare-and-set `updateMany({ where: { id, status: prev.status, updatedAt: prev.updatedAt }, data })`, retrying once.
    4. Return the number of changed rows. Unknown ids return 0, with no write and no error.
  - **Zernio** (`zernio.service.ts` `handleEvent`): after `applyStatus`, call `applyProviderStatus` with `[message.id, message.platformMessageId]` and the channel's workspace. `at` is the event's `message.sentAt` when parseable, else now. For `message.sent` where no `Message` row matched, `stampByPhone` (ruling 2) runs before the existing `ingestInbound` fallback.
  - **Meta** (`whatsapp.service.ts` statuses loop): call `applyProviderStatus` for each status with `ids = [s.id]` and `at = timestamp`. Meta numbers are not campaign senders today (SP-19 ruling 6), so this is a no-op until SP-13. It keeps one rule for both providers.
  - The tracker never throws into a webhook. Errors are logged without the payload body, and the webhook still returns 200.
  - **No realtime fan-out per recipient.** A 100k campaign would emit 100k events. The detail page polls insights every 30 s while the campaign is `scheduled|running`, or less than 72 h old.
- **Reply attribution (exact rule):**
  - **Input:** `{workspaceId, channelId, contactId, phone (any shape), text, buttonPayload?, inboundMessageId, at}`.
  - **Candidates:** rows `r` joined to campaign `c` where all of these hold:
    - `r.workspaceId = ws` and `r.channelId = channelId`;
    - `r.phone = normalizePhone(phone)` or `r.contactId = contactId`;
    - `r.status <> 'skipped'`;
    - `eff = COALESCE(r.sentAt, c.scheduledAt, c.launchedAt)` is not null;
    - `eff <= at` and `at - eff <= interval '72 hours'` (exactly 72 h is inside the window).
  - **Pick** the single row with the greatest `eff`, then the greatest `r.id`. If its `repliedAt` is null, run `UPDATE … SET status='replied', repliedAt=at, replyText=left(text,1000), buttonPayload=left(payload,256), replyMessageId=… WHERE id=… AND "repliedAt" IS NULL`. On one row updated, recount that campaign's counters.
  - If the latest candidate already has a reply, nothing happens: there is no fallback to an older campaign, and the first reply's text is kept.
  - `failed` rows can be marked replied, because a reply proves the message arrived. They keep `failureCode` for the audit trail.
  - **Effective send time.** The `COALESCE` covers the gap before the pull sweep stamps `sentAt`. A reply 3 minutes after launch must still count (ruling 6).
  - **Button payload:**
    - Meta `type:"button"` → `button.payload`, with text `button.text`.
    - Meta `type:"interactive"` → `button_reply.id` / `list_reply.id`, with text from the `title`.
    - Zernio: only when the webhook carries it, read from the optional `message.metadata.buttonPayload ?? message.metadata.postbackPayload` (ruling 7).
    - Otherwise null.
- **Keyset paging:**
  - **Request:** `GET /campaigns/:id/recipients?status=<status>&cursor=<c>&limit=<n>`. `limit` is 1–200 (default 50). `status` is one of the seven status values, or absent for all.
  - **Query:** `where {workspaceId, campaignId, status?, id: {gt: cursorId}}`, `orderBy {id: "asc"}`, `take limit + 1`. `nextCursor` is null when `take` returned `limit` rows or fewer.
  - **Cursor:** base64url of `{"v":1,"id":"<last id>","s":"<status|null>"}`. A malformed cursor, or one whose `s` doesn't match `status`, returns 400 `campaigns.invalid_cursor`.
  - A filter is a single status, so `(campaignId, status, id)` returns rows already in order with no sort.
  - Under concurrent updates a row may change status mid-scan and leave the filter. Ids strictly increase, so no row is ever returned twice.
- **Insights queries** (all scoped `"workspaceId" = $1 AND "campaignId" = $2`):
  - **Counts:** `groupBy(status)`, index-only on `(campaignId, status, id)`.
  - **Read timing:** `count(*) FILTER (WHERE "readAt" - "sentAt" < interval '1 hour')`, then `>= 1h and < 6h`, `>= 6h and < 24h`, and `>= 24h`, with `status IN ('read','replied') AND "sentAt" IS NOT NULL AND "readAt" IS NOT NULL`. A read stamped before its send (clock skew) counts in the first bucket.
  - **Replies:** `status = 'replied' GROUP BY "buttonPayload"`. The label is the latest `replyText` for that payload, taken with `(array_agg("replyText" ORDER BY "repliedAt" DESC))[1]`. The typed-reply line has no label.
  - **Failures:** `status IN ('failed','skipped') GROUP BY "failureCode"`. Rows with a null code go into `unrecorded`.
  - All four run in parallel. Task 4 records `EXPLAIN` for each with `SET LOCAL enable_seqscan = off` inside a rolled-back transaction.
- **Failure codes** (`backend/src/campaigns/tracking/failure-codes.ts`, with the frontend mirror `src/screens/campaigns/failureCodes.ts`):
  - **Our skips:** `skip:opted_out`, `skip:no_phone`.
  - **Provider fallback:** `provider:unknown`.
  - **Known Meta codes with bilingual copy:**

    | Code | Meaning |
    |---|---|
    | `meta:131026` | message undeliverable |
    | `meta:131047` | more than 24 h since the customer replied |
    | `meta:131049` | Meta held the message for ecosystem engagement / the per-user marketing limit |
    | `meta:131050` | the customer stopped marketing messages |
    | `meta:131056` | pair rate limit |
    | `meta:131048` | spam rate limit |
    | `meta:131042` | business payment issue |
    | `meta:131031` | account locked |
    | `meta:131051` | unsupported message type |
    | `meta:131052` | media download error |
    | `meta:131053` | media upload error |
    | `meta:132000` | template parameter count mismatch |
    | `meta:132001` | template does not exist |
    | `meta:132015` | template paused |
    | `meta:132016` | template disabled |
    | `meta:130472` | the customer's number is in a Meta experiment |
    | `meta:131000` | something went wrong |
    | `meta:368` | temporarily blocked for policy violations |

    The implementer checks each against Meta's current error-code reference before writing the copy.
  - Any other `meta:<n>` shows "WhatsApp error <n>" / "خطأ واتساب <n>", plus `failureReason` when it is short: one line, at most 120 characters, no `{`, which is Tkana's `isShortTitle`. `failureReason` is never rendered raw otherwise.
- **CSV export:**
  - **Routes:**
    - `GET /campaigns/:id/export?status=<s>&lang=en|ar` streams the whole campaign, or one outcome.
    - `POST /campaigns/:id/export {status?, ids?, lang?}` takes the ticked rows in a JSON body, so a large selection doesn't hit URL limits. This matches SP-03's GET/POST pair and the frontend `api.postBlob`.
  - **Limits:** `ids` holds at most 10 000 entries (`EXPORT_IDS_CAP`), else 400 `campaigns.ids_too_many`. Ids outside the campaign are silently absent, because the scope is `workspaceId` + `campaignId` + `id IN ids`.
  - **Format:**
    - The file starts with a UTF-8 BOM, then the header in `lang` (default: the workspace `lang`).
    - Columns: name, phone, status (localized), sent at, delivered at, read at, replied at, reply, button, failure code, failure reason (the localized label from the code table), sending number (channel `displayName` and `phoneNumber`).
    - Times are ISO 8601 UTC.
    - Every cell goes through the SP-03 `csvCell`, which already applies `escapeFormulaCell` (`= + - @ \t \r` get a leading `'`) and RFC 4180 quoting.
  - **Streaming:** keyset batches of 1000 on `(campaignId, id)`, plus `status` when filtered. Backpressure and abort handling move into `backend/src/common/csv-stream.ts` (`streamCsv(res, job)`), extracted from `ContactsController.stream`; the contacts controller then uses it unchanged.
  - **Filename:** `campaign-<slug(name) or id>-<status|all>-<yyyy-mm-dd>.csv`, ASCII only, so an Arabic name never breaks `Content-Disposition`.
- **Follow-up actions:**
  - **Routes** (ruling 8; split from the roadmap's single route):
    - `POST /campaigns/:id/follow-up/create-group {status?|ids?, name, nameAr?}`
    - `POST /campaigns/:id/follow-up/add-to-group {status?|ids?, groupId}`
    - `POST /campaigns/:id/follow-up/tag {status?|ids?, tagId}`
  - **Target:** exactly one of `status` (a whole outcome) or `ids` (ticked rows) is required, else 400 `campaigns.follow_up_target`.
  - **Limits:**
    - `ids` holds at most 5 000 (`FOLLOW_UP_IDS_CAP`), else 400 `campaigns.ids_too_many`.
    - An outcome resolves to at most 10 000 distinct contacts (`FOLLOW_UP_CONTACTS_CAP`, which equals `BULK_IDS_CAP`). Past that it returns 400 `campaigns.follow_up_too_large {limit, count}` and changes nothing (ruling 9).
  - **Per-row workspace check:**
    1. Load the campaign by `(id, workspaceId)`; missing → 404.
    2. Load the target rows with `where {workspaceId, campaignId, …}`. Explicit `ids` that are not rows of this campaign return 404 `campaigns.recipient_not_found`, and nothing is applied.
    3. Collect the distinct non-null `contactId`s, then re-read the contacts with `where {workspaceId, id: {in}}`.
    4. Rows whose contact is gone are counted as `leftOut`.
  - **Group and tag lookups:** `groupId`/`tagId` are loaded by `(id, workspaceId)`. A foreign or missing id returns 404. A non-manual group returns 400, through `requireManualGroup`.
  - **Execution:**
    - `create-group`: `createManualGroup` (new helper in `segment-members.ts`; `name` 1–120 characters, trimmed), then `addManualMembers` in chunks of 1000.
    - `add-to-group`: `addManualMembers` in chunks of 1000.
    - `tag`: resolve the tag name from `tagId`, then `TagsService.assign(ws, {contactIds: chunk, add: [name]})` in chunks of 1000.
  - **Response:** `{added, already?, leftOut, groupId?}`.
- **Permissions (SP-25).** The `campaigns`, `audiences` and `contacts` resources already exist in `catalog.ts`, so no catalogue change, seed or role migration is needed. Every route goes in `permission-map.ts`:
  - `campaigns.view`: `GET /campaigns/:id/recipients`, `GET /campaigns/:id/insights`
  - `contacts.manage`: `GET /campaigns/:id/export`, `POST /campaigns/:id/export`. This is bulk personal-data export, which follows SP-03's "export is owner/admin only" ruling. The service also asserts `campaigns.view` through `req.permissions` (ruling 8).
  - `audiences.create`: `POST /campaigns/:id/follow-up/create-group`
  - `audiences.update`: `POST /campaigns/:id/follow-up/add-to-group`
  - `contacts.update`: `POST /campaigns/:id/follow-up/tag`
  - **Why not `campaigns.manage`:** impersonation is blocked for it (`blockedForImpersonation`), because it means spending the tenant's money (launch, ads approvals). Exports and follow-ups don't spend, and a support session should be able to read a report. Launch and cancel keep `campaigns.manage` unchanged.
  - Every handler loads the campaign scoped by `workspaceId` first. A foreign id returns **404 `campaigns.not_found`**, never 403.
  - **System roles today:**
    - Agents: view, recipients and insights; tag; create group; add to group. Agents hold `audiences` view/create/update and `contacts` update.
    - Agents: no export. That needs `contacts.manage`.
    - Viewers: view only.
- **Error keys** (the frontend maps them through `tx`):
  - `campaigns.not_found` (404)
  - `campaigns.recipient_not_found` (404)
  - `campaigns.invalid_cursor` (400)
  - `campaigns.invalid_status` (400)
  - `campaigns.ids_too_many` (400)
  - `campaigns.follow_up_target` (400)
  - `campaigns.follow_up_too_large` (400)
  - `campaigns.group_name_required` (400)
  - the existing segments/tags 404 and 400 responses, passed through
- **Copy and layout:** every user-facing string goes through `tx("English","العربية")` with real Arabic. Use logical CSS (`margin-inline-start`, `padding-inline`, `text-align: start`, `inset-inline-end`). `dir="auto"` on reply text and names. `<bdi dir="ltr">` around phone numbers, codes and percentages inside Arabic sentences. Dialogs set `dir`. Dates are formatted in the workspace timezone through the existing date helpers.
- **Tests:**
  - backend: `npx jest src/campaigns src/integrations src/channels src/segments src/tags src/contacts src/permissions src/common` plus `npx tsc --noEmit -p tsconfig.json`; the full `npm test` once per task
  - frontend: `npx vitest run` plus `npm run typecheck`; `npm run build` once in Task 3
  - Named acceptance tests (exact names):
    - `backend/src/campaigns/recipients-cursor.spec.ts`
    - `delivery webhook out of order (read before delivered) keeps both timestamps`
    - `reply attribution window 72h`
- **Commits:** selective `git add <paths>`, never `-A`. Trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not stage `.playwright-mcp/` or any untracked file this plan did not create.

## Review Focus
1. **100k recipients without timeouts or skipped rows.**
   - Launch writes 100 000 rows in 100 `createMany` calls of 1000 (`skipDuplicates`). It never makes a single call with all of them.
   - Paging 100 000 rows at `limit=200`, with and without a status filter, visits every row exactly once in id order. Rows inserted mid-scan with higher ids are picked up; nothing repeats.
   - Export streams in batches of 1000, and stops when the client disconnects.
   - Test: `recipients-cursor.spec.ts`. It uses an in-memory table of 100 000 generated rows through the `test-prisma.ts` pattern, and asserts the exact `where`/`orderBy`/`take` shape the indexes serve.
2. **Monotonic, idempotent delivery state.**
   - Replaying any permutation of `sent`, `delivered`, `read` and `failed` events, each twice, ends in the same row.
   - Read-before-delivered keeps both timestamps, with status `read`.
   - `failed` after `delivered` is ignored. `delivered` after `failed` wins, and the failure code is kept.
   - `skipped` never changes. An unknown `messageId` writes nothing.
   - Test: `delivery webhook out of order (read before delivered) keeps both timestamps`, plus a table-driven `mergeRecipientEvent` spec over all orderings.
3. **Reply attribution is exact.**
   - A reply at 72 h exactly attributes; at 72 h + 1 s it does not.
   - A reply on another number does not attribute.
   - Two campaigns to the same phone within 72 h: only the later one gets the reply, and a second reply changes nothing.
   - A reply before `sentAt` is stamped, but after launch, attributes through the effective send time.
   - A reply to a skipped row does not attribute.
   - Test: `reply attribution window 72h`.
4. **Tenant isolation on every new route and webhook.**
   - A foreign campaign id returns 404 on recipients, insights, export and all three follow-ups.
   - A foreign group or tag id returns 404.
   - Ticked ids from another campaign return 404, and nothing is applied.
   - A webhook `messageId` that exists only in workspace A, arriving on B's channel, updates nothing.
   - Test: `foreign ids return 404 on every SP-12 route`, plus `status webhook is scoped to the channel's workspace`.
5. **CSV safety.**
   - The output starts with the BOM, `EF BB BF`.
   - A contact named `=HYPERLINK("x")` exports as `'=HYPERLINK(""x"")`, quoted.
   - Arabic names round-trip.
   - An `ids` filter exports exactly those rows.
   - A disconnect mid-stream stops the batch loop.
   - Test: `campaign export escapes formulas and starts with BOM`.

## Architecture Rulings and Risks
Each item names the risk, then the recommended ruling. Items marked **(needs controller ruling)** are repeated under Controller rulings, where the controller fills in the decision.

1. **Per-recipient truth comes from Zernio's recipients endpoint, not from webhooks alone.** The roadmap says "delivery webhooks update them by `messageId`". That is infeasible as the only mechanism: Zernio creates the messages inside the broadcast, so no row has a `messageId` when the first `message.sent` and `message.delivered` webhooks arrive. Several properties are also unverified:
   - which id scheme the recipient `messageId` uses (Zernio's id or Meta's wamid);
   - the maximum `limit`;
   - whether `skip` ordering is stable while a broadcast is sending;
   - Zernio's rate limits.
   - **Ruling:** the pull sweep (Global Constraints) is the source of truth, and webhooks are the accelerator. Task 1 includes a **read-only** live probe: one `GET /broadcasts/{id}/recipients?limit=…` on an existing completed broadcast. It records the id scheme, the largest accepted `limit`, and whether two reads return the same order. Then set `ZERNIO_RECIPIENT_PAGE` and `RECIPIENT_SYNC_MAX_PAGES` from the result. Matching webhooks on both ids covers either scheme. **(needs controller ruling)**
2. **Phone-stamping on `message.sent`.** Before the first pull, a `message.sent` for a broadcast message matches no `Message` row (today it falls through to `ingestInbound`). It could also stamp the queued recipient with the same channel and phone, which makes delivered and read webhooks match within seconds instead of after the next sweep. The risk is a mis-stamp: a staff member typing to the same customer from the WhatsApp phone app during a broadcast. App-composed sends create a `Message` row first, so they match and are excluded.
   - **Ruling:** stamp only when all of these hold:
     - no `Message` row matched the event;
     - the direction is outgoing;
     - the row is `queued` with `messageId` null on that `channelId` and phone;
     - its campaign is `running`, or was launched within the last 24 h.

     If several campaigns qualify, pick the latest `launchedAt`. The pull sweep later overwrites nothing, because `messageId` is first-write. A mis-stamp only affects timestamps and never crosses workspaces. **(needs controller ruling)**
3. **Historical campaigns.** No per-recipient data exists in our DB for campaigns launched before SP-12, so a SQL backfill is impossible.
   - **Ruling:** historical campaigns show aggregate counters only: the funnel from `Campaign` counters, the table replaced by an explanatory empty state, and no insights cards.
   - Optional: `backend/scripts/backfill-campaign-recipients.ts`. It is a dry run by default (`--apply` to write) and can be rerun. For campaigns with `zernioBroadcastId` and `recipientTracking = false`, it pages Zernio's recipients endpoint (read-only GETs) and upserts rows on `(campaignId, phone)` with `skipDuplicates`. It matches `contactId` by normalized phone within the workspace, and never backfills replies. It runs only with explicit approval, after Task 4. **(needs controller ruling: ship the script or not)**
4. **"Conversions" has no definition in our data.** Nothing writes `Campaign.conversions` today.
   - **Ruling:** SP-12 does **not** compute conversions. The column is untouched and the detail page omits it; the funnel ends at Replied.
   - Proposed definition for SP-11 Insights: a replied recipient whose contact gets a ticket moved to a won stage, or a booking created, within 7 days of `repliedAt`, credited to that single attributed campaign. **(needs controller ruling)**
5. **Which counters are true.** Zernio's broadcast counters and our recipient counts can disagree, for example around webhook-only updates.
   - **Ruling:** for `recipientTracking` campaigns, `sent/delivered/read/failed/replied` are recomputed from rows (Global Constraints), so the list page and the detail page always agree. Historical campaigns keep Zernio's counters through `applyStats`. **(needs controller ruling)**
6. **Effective send time for attribution.** Before the sweep stamps `sentAt`, the 72 h window is measured from `COALESCE(sentAt, scheduledAt, launchedAt)`.
   - **Ruling:** accept it. The error is at most the broadcast's sending duration, and `sentAt`, once known, takes over for later replies. The roadmap's "only the latest campaign within the window gets the reply" is implemented as: the single latest candidate; first reply wins; no fallback to older campaigns. **(needs controller ruling)**
7. **Button payloads through Zernio are unverified.** Our `ZernioWebhookEvent` type has no button field. Zernio documents `metadata.postbackPayload` for Messenger, not for WhatsApp quick replies.
   - **Ruling:** fill `buttonPayload` from Meta-direct `button` and `interactive` messages now. For Zernio, read `message.metadata?.buttonPayload ?? message.metadata?.postbackPayload` when present (typed optional), else null. That means typed text only until a real Zernio button-reply payload is captured. The reply summary then shows only "Typed replies" for Zernio campaigns. **(needs controller ruling)**
8. **Permissions deviate from the roadmap's single follow-up route.** `@RequirePermission` and `permission-map.ts` give one permission per route, but each follow-up needs a different resource: create group needs `audiences.create`, add to group needs `audiences.update`, tag needs `contacts.update`.
   - **Ruling:**
     - Split into three literal routes, each fully declarative and covered by `permission-map.spec.ts`.
     - Export maps to `contacts.manage`, matching SP-03, plus an in-service `campaigns.view` check.
     - Neither uses `campaigns.manage`, which is impersonation-blocked and means spending.
   - The alternative is to keep one route mapped to `campaigns.view` with in-service per-action checks, which is less safe. **(needs controller ruling)**
9. **Follow-up volume.** "Read" on a 100k campaign can be 60k contacts. `TagsService.assign` runs a 30 s transaction per call.
   - **Ruling:** synchronous with chunks of 1000. Above 10 000 distinct contacts, return 400 `campaigns.follow_up_too_large`, and the UI explains how to narrow the selection. A background job for larger sets is deferred, possibly reusing the SP-03 `ImportJob` poller. **(needs controller ruling)**
10. **Launch is still one HTTP request.** Review Focus 3 says a 100k campaign must not time out. Launch already loads the whole audience into memory and makes about 1 100 sequential Zernio calls: 100 `bulkCreateContacts` of 1000 contacts, plus 1000 `addBroadcastRecipients` of 100 phones. SP-12 adds 100 chunked inserts, roughly 10–30 s more against Neon. The Fly proxy or the browser could time out first.
    - **Ruling:** in SP-12, write rows chunked and awaited, and add a mocked 100k launch test that asserts the chunking. Measure a real 1 200-row launch in Task 4 against the stub provider. Moving launch to a background job (`status "launching"` plus a poller) is an SP-13 item, unless the controller wants it here. **(needs controller ruling)**
11. **Duplicate phones in an audience** (two contacts, one number) get one row, not two: `@@unique([campaignId, phone])`. The duplicate still counts in `Campaign.skipped`, as today. Its contact id is not recorded. **(needs controller ruling, minor)**
12. **Existing behaviour, not changed by SP-12.** When Zernio emits `message.sent` for broadcast messages, the current `handleEvent` path (`updated === 0` → `ingestInbound`) stores each one as an outbound `human` message in the customer's conversation, creating conversations as needed. It also runs `pipelineAutomation.onOutboundReply` for every recipient. At 100k that is 100k messages plus automation calls.
    - **Ruling:** leave it unchanged. A campaign message in the thread is useful, and changing it touches SP-01/SP-31 behaviour. Record whether it happens in the Task 1 probe and the Task 4 notes, and raise a follow-up if it causes load. **(needs controller ruling)**
13. **No free-text search in the recipients table.** Tkana has one. Phone-variant search across 100k rows needs a canonical-phone or trigram index we don't have.
    - **Ruling:** the outcome filter plus paging only. Search is deferred. **(needs controller ruling, minor)**
14. **Verification touches production.** The Task 4 instance points Zernio at a local stub, so nothing is sent. But the **deployed** app shares the DB, and its 5-minute `syncActive` cron may call the real Zernio `GET /broadcasts/<stub id>` for the test campaign while it is `running`. That is read-only and returns 404.
    - **Ruling:** acceptable. The script drives the test campaign to `completed` through the stub within seconds of launch, which keeps the window to under one cron tick. **(needs controller ruling)**
15. **Per-recipient realtime is out.** A 100k campaign would flood `inbox.activity`. The page polls instead (Global Constraints). The existing `inbox.activity` emits for `Message` updates are unchanged.

### Controller rulings
*Decided 2026-11-09.*
- **R1** Accepted. The pull sweep is the source of truth. In Task 1, the live Zernio probe is not run at all; the code is written defensively, tolerating either id scheme, small page sizes and unstable ordering, with idempotent upserts. The single read-only probe runs in Task 4 as part of verification.
- **R2** Accepted, with a guard. Stamp a row only when exactly one queued recipient of a sending campaign matches the channel and normalized phone. Otherwise do nothing and leave it to the pull sweep.
- **R3** Aggregate-only. No backfill script in SP-12.
- **R4** Accepted. Conversions are not computed here; the definition moves to SP-11.
- **R5** Accepted.
- **R6** Accepted.
- **R7** Accepted.
- **R8** Accepted: three follow-up routes, and export requires `contacts.manage`, matching SP-03. This is a documented deviation from the roadmap's single route.
- **R9** Accepted.
- **R10** Accepted for SP-12. Background launch is added to SP-13's scope. Task 1 must still avoid per-recipient round-trips in launch (chunked `createMany` only).
- **R11** Accepted.
- **R12** Accepted.
- **R13** Accepted.
- **R14** Accepted. The new migration still needs the user's explicit approval before it is applied; earlier approvals do not carry over.

---

### Task 1: Backend — schema, migration, send pipeline, delivery tracking, reply attribution
**Files:**
- `backend/prisma/schema.prisma`: the `CampaignRecipient` model; the `Campaign` columns and back-relation; back-relations on `Workspace`, `Contact` and `Channel`.
- `backend/prisma/migrations/20261113120000_campaign_recipients/migration.sql`, as specified in Global Constraints.
- `backend/src/common/prisma-tenancy.ts` (`SCOPED_MODELS` += `"CampaignRecipient"`).
- Create `backend/src/campaigns/tracking/`, each with a spec:
  - `recipient-status.ts`: `RECIPIENT_STATUSES`, `STATUS_RANK`, `mergeRecipientEvent(row, event) → {next, changed}`, `markRepliedPatch(row, reply)`.
  - `failure-codes.ts`: `metaFailureCode(errorCode)`, `providerFailure(error, errorCode, explanation) → {failureCode, failureReason}`, `isShortTitle`.
  - `recipient-tracker.service.ts`: `applyProviderStatus`, `stampByPhone`, `applyBroadcastPage(campaign, page)`, `recountCampaign(campaignId)`.
  - `reply-attributor.service.ts`: `onInbound(input)`; never throws.
  - `inbound-reply.ts`: `metaReplyParts(msg) → {text, buttonPayload}`, `zernioReplyParts(evt)`.
  - `campaign-tracking.module.ts`
- `backend/src/campaigns/campaign-audience.ts`: `AudienceContact` gains `id`; `buildRecipients` also returns `skippedRows`.
- `backend/src/campaigns/campaign-send.service.ts`:
  - `launch` writes rows (Global Constraints order) and sets `recipientTracking`;
  - `syncActive` runs the recipient sweep;
  - `applyStats` keeps aggregate counters only for untracked campaigns.
- `backend/src/channels/default-channel.ts`: `campaignSender(prisma, ws, senderChannelId) → {accountId, channelId}`. The existing two functions stay.
- `backend/src/integrations/zernio.client.ts`: `listBroadcastRecipients(broadcastId, {skip, limit, status?}) → {recipients, pagination, summary}`, typed from the documented fields.
- `backend/src/integrations/zernio.service.ts`:
  - `handleEvent` status branch → `applyProviderStatus`, plus `stampByPhone` (ruling 2);
  - `ingestInbound` (non-outbound) → `attributor.onInbound` after the message is created;
  - `ZernioWebhookEvent.message.metadata?` (optional `buttonPayload`, `postbackPayload`).
- `backend/src/integrations/whatsapp.service.ts`: the statuses loop → `applyProviderStatus`; `ingestInbound` → `attributor.onInbound` with `metaReplyParts`. `extractBody` also renders `button.text` and `interactive` titles instead of `[button message]`.
- `backend/src/channels/inbound-sink.service.ts`: `attributor.onInbound` after a non-duplicate record.
- `backend/src/integrations/integrations.module.ts`, `backend/src/channels/channels-core.module.ts`, `backend/src/campaigns/campaigns.module.ts`: import `CampaignTrackingModule`.
- Specs:
  - `backend/src/campaigns/campaign-recipients-migration.spec.ts`
  - extend `campaign-send.service.spec.ts`, `campaign-audience.spec.ts`, `zernio.broadcasts.spec.ts`
  - `backend/src/campaigns/tracking/*.spec.ts`

**Produces:**
- `mergeRecipientEvent`: the single rule (Architecture). Exported for Tasks 2 and 3, and mirrored as the read-only `outcomeOf(status)` on the frontend.
- `RecipientTrackerService.applyProviderStatus({workspaceId, ids, kind:"sent"|"delivered"|"read"|"failed", at, failureCode?, failureReason?}) → Promise<number>`.
- `CampaignReplyAttributor.onInbound({workspaceId, channelId, contactId, phone, text, buttonPayload?, inboundMessageId, at}) → Promise<{recipientId, campaignId} | null>`.
- `ZernioClient.listBroadcastRecipients`.
- A launched campaign has `recipientTracking = true` and one row per reachable phone plus one per opted-out or phoneless member.

- [ ] Write the failing tests:
  - `migration is additive, idempotent and Prisma-named` (reads the SQL file):
    - every `CREATE` has `IF NOT EXISTS`;
    - every FK sits in a `DO $$ … duplicate_object` block;
    - all index and constraint names appear exactly as listed;
    - there is no `DROP`, `UPDATE`, `DELETE`, `ALTER COLUMN` or `TYPE`;
    - the `Campaign` columns are `ADD COLUMN IF NOT EXISTS` with defaults;
    - the timestamp folder name is greater than `20261112120000`.
  - `launch writes recipients in chunks of 1000 before calling Zernio`:
    - 2 500 reachable contacts plus 3 opted-out plus 2 phoneless gives `createMany` 3 calls of 1000/1000/500 queued rows and one call with 5 skipped rows, all with `skipDuplicates: true`;
    - the rows were written before `createWhatsAppBroadcast` (invocation order);
    - `recipientTracking` is true.
  - `launch with 100k recipients never inserts more than 1000 rows per call` (mocked; asserts the call count and maximum length).
  - `launch failure leaves recipients queued and campaign failed`.
  - `opted-out contact is skipped by campaign send` (existing SP-02 test) also asserts a `skipped` row with `failureCode "skip:opted_out"`.
  - `mergeRecipientEvent` table test: every permutation of `[sent, delivered, read, failed]`, each applied twice, ends in the same status and timestamps; `skipped` is immutable; `failed` after `delivered` is ignored; `delivered` after `failed` wins and keeps the failure code.
  - `delivery webhook out of order (read before delivered) keeps both timestamps`. Through `ZernioService.handleEvent`:
    1. send `message.read` (t2), then `message.delivered` (t1), for a row whose `messageId` matches `message.platformMessageId`;
    2. the row ends with `status = read`, `readAt = t2` and `deliveredAt = t1`;
    3. replaying both changes nothing;
    4. the same through the Meta `statuses` path.
  - `unknown messageId is ignored`: no write, no throw, and the webhook returns `{ok:true}`.
  - `status webhook is scoped to the channel's workspace`: the same `messageId` in workspace A, with the event on B's account, updates nothing in A.
  - `message.sent stamps a queued recipient by phone only when no Message matched` (ruling 2): stamped once; a second campaign older than 24 h is never stamped; an app-composed message (a `Message` row matched) does not stamp.
  - `broadcast sweep maps Zernio recipients monotonically and resumes from skip`:
    - a page with pending, sent, delivered, read and failed rows (with `errorCode` 131026) gives the right statuses, timestamps, `failureCode meta:131026` and a single-line `failureReason`;
    - `skip` advances by the page count and resets on `hasMore:false`;
    - counters are recomputed;
    - an untracked campaign still gets Zernio's aggregate counters.
  - `reply attribution window 72h`:
    - sentAt T: a reply at T+72h attributes; T+72h+1s does not;
    - a reply on another channel does not attribute;
    - campaigns C1 (T) and C2 (T+1h) to the same phone: a reply at T+2h marks only C2, and a second reply leaves C2's text unchanged and C1 untouched;
    - a row with `sentAt` null and `launchedAt` T−5min attributes;
    - a skipped row never attributes;
    - matching works by phone when the inbound contact differs from the audience contact (Zernio-created contact versus imported contact);
    - `Campaign.replied` is recounted.
  - `button replies store payload and text` (Meta `button` and `interactive`; Zernio metadata when present, null otherwise).
  - `attributor never throws into inbound` (a DB error is logged; the message is still stored).
- [ ] Implement until green.
- [ ] Read-only live probe (ruling 1; no writes, no sends). With the existing `ZERNIO_API_KEY`, call `GET /broadcasts/{id}/recipients?limit=500` on one existing completed broadcast from a production campaign row (`SELECT "zernioBroadcastId" FROM "Campaign" WHERE … LIMIT 1`, read-only). Record:
  - the accepted maximum `limit`;
  - whether `messageId` looks like a wamid (`wamid.`) or a Zernio id;
  - whether two consecutive reads return the same order;
  - whether broadcast messages appear as `Message` rows (ruling 12).

  Put the results in the PR description, then set `ZERNIO_RECIPIENT_PAGE`.
- [ ] `npx tsc --noEmit -p tsconfig.json`, the listed jest paths, then the full `npm test` once. All green.
- [ ] Commit `feat(campaigns): per-recipient tracking, monotonic delivery status and 72h reply attribution`.

### Task 2: Backend — recipients, insights, export and follow-up APIs
**Files:**
- Create in `backend/src/campaigns/`, each with a spec:
  - `campaign-report.service.ts`: `recipients`, `insights`, `prepareExport`.
  - `recipient-cursor.ts`: `encodeCursor`, `decodeCursor` (400 on invalid or mismatched).
  - `campaign-follow-up.service.ts`: `createGroup`, `addToGroup`, `tag`.
  - `campaign-report.controller.ts`: the routes below, inside `CampaignsModule`. `:id` routes are declared after the existing literal `preview`.
  - `campaign-report.dto.ts`: class-validator DTOs. `status` uses `IsIn(RECIPIENT_STATUSES)`. `ids` uses `ArrayMaxSize` (the caps). `lang` uses `IsIn(["en","ar"])`. `name` uses `Length(1,120)`.
  - `recipients-cursor.spec.ts`: Review Focus 1.
- Create `backend/src/common/csv-stream.ts` (`streamCsv(res, job)`, moved from `ContactsController.stream`), with a spec. Modify `backend/src/contacts/contacts.controller.ts` to use it, with no behaviour change; the existing export specs must stay green.
- `backend/src/segments/segment-members.ts`: `createManualGroup(prisma, outbound, ws, {name, nameAr?}) → Segment` (`origin "manual"`, `filter "{}"`, `emitSegmentUpserted`). Optionally switch `SegmentsController.create` to it when `origin === "manual"`.
- `CampaignsModule` imports `SegmentsModule` (for `MarketingOutboundService`) and `TagsModule` (for `TagsService`). Check both export them, and add the export if missing.
- `backend/src/permissions/permission-map.ts`: the 7 routes. The `permission-map.spec.ts` and `system-role-decisions.spec.ts` tables gain the new rows.

**Produces:**
- `GET /campaigns/:id/recipients?status&cursor&limit` returns `{ tracked: boolean, items: RecipientDto[], nextCursor: string | null }`.
  - `RecipientDto = {id, contactId, name, phone, status, sentAt, deliveredAt, readAt, repliedAt, replyText, buttonPayload, replyMessageId, failureCode, failureTitle (short failureReason or null), channel: {id, displayName, phoneNumber} | null}`.
  - `name` is the contact's current name, else the `contactName` snapshot.
  - Channel names are fetched once per page.
- `GET /campaigns/:id/insights` returns `{ tracked, total, counts: Record<RecipientStatus, number>, funnel: {targeted, sent, delivered, read, replied}, readTiming: {withinHour, oneToSix, sixToDay, afterDay}, replies: {payload: string|null, label: string|null, count}[], failures: {code: string, title: string|null, count}[], unrecorded: number, recipientsSyncedAt, statsSyncedAt }`.
  - **Funnel sets** (one outcome per row):
    - `targeted` = all rows except `skipped`
    - `sent` = sent + delivered + read + replied + failed (attempted)
    - `delivered` = delivered + read + replied
    - `read` = read + replied
    - `replied` = replied
  - **Untracked campaigns** return `tracked:false`, a funnel built from the `Campaign` counters, and empty lists.
- `GET|POST /campaigns/:id/export` returns a `text/csv; charset=utf-8` attachment, streamed (Global Constraints).
- `POST /campaigns/:id/follow-up/{create-group|add-to-group|tag}` returns `{added, already?, leftOut, groupId?}`.

- [ ] Write the failing tests:
  - `recipients-cursor.spec.ts`:
    - 100 000 generated rows in the in-memory double, with mixed statuses;
    - `limit=200` pages over all rows and over `status=read` visit each matching row exactly once, in ascending id order, and the final `nextCursor` is null;
    - rows inserted mid-scan with higher ids appear, and nothing repeats;
    - every query has the shape `{where:{workspaceId, campaignId, status?, id:{gt}}, orderBy:{id:"asc"}, take: limit+1}`;
    - a malformed cursor, or a cursor from another status, returns 400 `campaigns.invalid_cursor`;
    - `limit=500` returns 400.
  - `foreign ids return 404 on every SP-12 route`: recipients, insights, export GET and POST, and the three follow-ups, with a campaign of workspace B requested from A. Also a foreign `groupId`/`tagId`, and ticked ids from another campaign: 404, nothing applied.
  - `insights buckets read times and groups replies and failures`:
    - read timing at the 59 min, 1 h, 5 h 59 min, 6 h, 23 h 59 min and 24 h boundaries;
    - a read before its send falls into the first bucket;
    - reply lines sort largest first with typed replies last, and each label is the latest text;
    - failure lines group by code, and null codes go to `unrecorded`;
    - the lines add up to failed + skipped.
  - `campaign export escapes formulas and starts with BOM`:
    - the first bytes are `EF BB BF`;
    - the header is in `lang=ar`;
    - `=HYPERLINK("x")` comes out as `"'=HYPERLINK(""x"")"`;
    - an Arabic name survives;
    - `status=failed` exports only failed rows, and `ids` exports exactly those rows;
    - more than 10 000 ids returns 400;
    - a mid-stream abort stops after the current batch;
    - the filename is ASCII.
  - `follow-up resolves contacts per workspace and reuses group and tag services`:
    - `create-group` from `status=read` creates one manual group and adds the distinct contacts in chunks of 1000;
    - rows with deleted contacts count as `leftOut`;
    - `tag` resolves the tag name and calls `TagsService.assign`;
    - a non-manual group returns 400;
    - more than 10 000 contacts returns 400 `campaigns.follow_up_too_large` and writes nothing;
    - more than 5 000 `ids` returns 400.
  - `permission map covers SP-12 routes`, plus system-role decisions:
    - agent: recipients and insights 200; export 403; tag, create-group and add-to-group 200;
    - viewer: follow-ups 403;
    - impersonation: export and follow-ups allowed, and launch still blocked.
  - `contacts export unchanged after csv-stream extraction`: the existing specs pass.
- [ ] Implement until green. Run tsc, the jest paths, and the full `npm test` once.
- [ ] Commit `feat(campaigns): recipient pages, insights, CSV export and follow-up actions`.

### Task 3: Frontend — campaign detail page
**Files:**
- Create in `src/screens/campaigns/`:
  - `CampaignDetail.tsx`: header with back, name, status and sender; the Refresh action (existing `POST /campaigns/:id/refresh`); the untracked notice.
  - `CampaignFunnel.tsx`: horizontal bars, each with its count and its percentage of `targeted`.
  - `ReadTimeCard.tsx`: four horizontal bars with percentages.
  - `FailureReasonsCard.tsx`: lines with bilingual labels. Each line opens the table filtered to failed or skipped.
  - `ReplySummaryCard.tsx`: the typed replies line, plus one line per button label or payload.
  - `RecipientsTable.tsx`:
    - outcome chips with counts;
    - cursor "Load more" paging, keeping the loaded pages;
    - row tick boxes, plus a "tick all loaded" box;
    - columns: name, phone, status, sent, delivered, read, replied, reply/button, failure, sending number;
    - empty and loading states;
    - a horizontal scroll container with the first column sticky using `inset-inline-start`.
  - `SelectionBar.tsx`: export ticked, create group, add to group, tag.
  - `ExportDialog.tsx`: scope (all, the current outcome, ticked) and language. Downloads with `api.postBlob`.
  - `FollowUpDialog.tsx`: three modes. Create group takes a name, defaulting to `<campaign> · <outcome>`. Add to group picks a manual group from `/segments`, filtered to `origin === "manual"`. Tag picks a tag from `/tags`. The error keys are mapped.
  - `campaignDetailModel.ts` (pure):
    - `RECIPIENT_STATUSES`
    - `OUTCOME_ORDER` (display order: delivered "Not read", read, replied, sent "Waiting", failed, skipped, queued "Not sent")
    - `statusLabel(status, tx)`
    - `funnelSteps(insights)`
    - `readTimingShares(timing)` (largest remainder, summing to exactly 100, null when the total is 0; ported from Tkana)
    - `mergePages(prev, next)` (dedupe by id, keep order)
    - `selectionState`
    - `insightsPollMs(campaign, now)` (30 000 while `scheduled|running` or under 72 h since launch, else null)
  - `failureCodes.ts`: `failureLabel(code, title, tx)` with the full bilingual table from Global Constraints. Unknown `meta:<n>` → "WhatsApp error <n>" / "خطأ واتساب <n>". `skip:*` and `provider:unknown` are covered.
  - Tests: `campaignDetailModel.test.ts`, `failureCodes.test.ts`.
- Move `useHashParam` from `src/screens/channels/channelUi.tsx` to `src/lib/useHashParam.ts`, and re-export it from `channelUi.tsx` so SP-19 imports keep working.
- `src/screens/Campaigns.tsx`:
  - `const [openId, setOpenId] = useHashParam("id")`; when set, render `<CampaignDetail id={openId} onBack={() => setOpenId(null)} />` in place of the list;
  - each list row's name, plus a "View report" action, opens it;
  - extract `InlineBar`/`MiniStat` into `src/screens/campaigns/ui.tsx` for reuse.
- `src/lib/types.ts`: `RecipientStatus`, `CampaignRecipientRow`, `CampaignInsights`, `RecipientsPage`.
- Permission gating with `usePermissions().can(...)`:
  - export: `contacts.manage`;
  - create group: `audiences.create`;
  - add to group: `audiences.update`;
  - tag: `contacts.update`.

  Hidden actions are not rendered. A 403 shows the shared "no permission" toast.

**Produces:**
- `#/campaigns?id=<id>` opens the report directly, and browser Back returns to the list (hash history through `useHashParam`).
- **Charts follow the `dataviz` skill.** Load it before building the bars:
  - horizontal bars with direct value labels, and no legend;
  - one accent hue for the funnel. Read time uses the same hue (it is one series). Failure lines use a neutral or warning token. All colours come from existing CSS variables, so light and dark themes both work.
  - each chart has `role="img"` and an `aria-label` that reads the numbers, plus a visually hidden table;
  - percentages are wrapped in `<bdi dir="ltr">`.

  No chart library is added. Reuse `InlineBar`, or extend it with a label slot.
- The untracked (historical) campaign shows the funnel from the aggregate counters, plus a notice: "Per-recipient details are available for campaigns sent after <date>" / "تفاصيل كل مستلم متاحة للحملات المرسلة بعد <date>". No table and no insights cards.
- The detail page polls insights at `insightsPollMs`. The table reloads its first page on Refresh only, so paging never jumps under the reader.

- [ ] Write the failing vitest tests:
  - `readTimingShares sums to 100 and is null when empty`
  - `funnel steps use one outcome per row`
  - `mergePages dedupes by id`
  - `failureLabel covers skip, provider and known meta codes in both languages and falls back for unknown`
  - `insightsPollMs stops 72h after launch`
  - `status chips follow OUTCOME_ORDER`

  Then implement until they pass, then build the components.
- [ ] `npx vitest run`, `npm run typecheck` and `npm run build` clean.
- [ ] Commit `feat(campaigns): campaign report page with funnel, read time, failures, replies, recipients, export and follow-ups`.

### Task 4: Verification
Apply `20261113120000_campaign_recipients` with `npx prisma migrate deploy`, and only when the controller approves. It is safe for `main` (Global Constraints). Record results in `.superpowers/sdd/2026-11-12-sp12-campaign-recipients/live-verification.md`, in the same format as SP-19's `live-verification.md`: summary, a results table with evidence, DB-side checks, findings and cleanup.

**Isolation** (as in SP-19; no repo code changed):
- **Own instance:** backend on **:4210**, compiled with `tsc -p tsconfig.build.json` into a throwaway outDir and started with `node`. The user's :4100 process is not touched.
- **Crons:** all `@nestjs/schedule` jobs are disabled. The sweep is driven explicitly through `POST /campaigns/:id/refresh`, plus a direct call of the sweep in the script.
- **Provider keys:** set to **empty strings**, not deleted (SP-19 finding E2). This covers Meta, HJZ, Kewy, L, the AI keys, DO Spaces, Pipeboard and Stripe.
- **No real WhatsApp send, ever:**
  - `ZERNIO_BASE_URL=http://127.0.0.1:<stubPort>` and `ZERNIO_API_KEY=zz-verify-stub`, pointing at a stub HTTP server in the scratchpad (`zernio-stub.js`).
  - The stub implements `POST /contacts/bulk`, `POST /broadcasts`, `POST /broadcasts/:id/recipients`, `POST /broadcasts/:id/send|schedule|cancel`, `GET /broadcasts/:id` and `GET /broadcasts/:id/recipients`. It returns scripted per-recipient states.
  - The launcher script refuses to start unless `ZERNIO_BASE_URL` begins with `http://127.0.0.1`. It also asserts the stub logged every call the run made.
- `ZERNIO_WEBHOOK_SECRET` is a test value, so replayed webhooks can be signed.
- Test tag: `zz-verify-<ts>` on every name and email.

**Setup** (writes only rows tagged with the test tag):
1. Register an owner and a foreign owner, then invite an agent and a viewer.
2. Insert a `Channel` (`kind whatsapp`, `provider zernio`, `externalId zz-verify-acc-<ts>`, `status active`, `isDefault`).
3. Set the test workspace's `zernioProfileId` to `zz-verify-prof-<ts>`.
4. Insert an approved `Template`.
5. Create 1 206 contacts: 1 200 reachable (one of them named `=HYPERLINK("x")` and several with Arabic names); 3 opted out; 2 with no phone; and 1 that repeats a reachable contact's phone.
6. Create a manual group, plus a segment holding everyone.

**Checks:**
- **Launch through the stub:**
  - 1 205 rows are written: 1 200 `queued`, plus 5 `skipped` (3 `skip:opted_out` and 2 `skip:no_phone`). `Campaign.recipients` is 1 200.
  - The duplicate-phone contact gets no row (ruling 11), and `Campaign.skipped` is 6.
  - `recipientTracking` is true.
  - Record the launch duration.
- **Sweep via refresh:** the stub reports a mix of sent, delivered, read and failed (`errorCode` 131026, 132001). Statuses, timestamps and failure codes land; the counters are recomputed; the list page and the insights agree.
- **Webhooks, replayed with a signature:**
  - read before delivered on one row: both timestamps are kept, and the status is read;
  - a duplicate replay: no change;
  - an unknown `messageId`: 200, and nothing changes;
  - the same `messageId` sent to the foreign workspace's channel: no change.
- **Reply attribution:**
  - A replayed `message.received` from a recipient phone marks the row replied, with its text, and increments `Campaign.replied`.
  - Then move one row's `sentAt` (and its campaign's `launchedAt`/`scheduledAt`) to 73 h ago with SQL on the **test rows only**. A reply from that phone is not attributed.
  - Two test campaigns to the same phone: only the later one gets the reply.
- **Paging:** all 1 205 rows through `limit=200` with no duplicates, plus `status=read`; a bad cursor returns 400; a foreign campaign returns 404 on every SP-12 route.
- **Export:** BOM present; the formula cell escaped; Arabic names intact; the `ids` and `status` scopes; agent 403, owner 200.
- **Follow-ups:** create a group from `read`; add `failed` to the manual group; tag the ticked rows. The group, membership and tag are visible through `/segments` and `/contacts`. A foreign group or tag returns 404; viewer 403.
- **Index use:** `EXPLAIN` (no `ANALYZE` writes) for the recipients page with and without status, counts, read timing, replies, failures, the webhook lookup and the attribution lookup. Each runs inside `BEGIN; SET LOCAL enable_seqscan = off; … ROLLBACK;` and must show the named indexes.
- **Migration rerun:** execute the migration SQL again inside a transaction that is always rolled back. 0 rows changed; the objects already exist; no errors.
- **UI through the `verify` skill:**
  - the report page in English and Arabic (RTL): funnel, read time, failures, replies, the table with chips and load-more, export and the follow-up dialogs;
  - `#/campaigns?id=` deep link, plus Back;
  - the untracked-campaign notice, using a test campaign row with counters only;
  - screenshots.
- **Cron window (ruling 14):** the stub reports the broadcast `completed` immediately after launch, and `refresh` moves the test campaign out of `running` within seconds.

**Cleanup:**
- Delete only the recorded test rows: the workspaces (cascade covers campaigns, recipients, contacts, channels, segments and tags), then the users.
- Run a residue sweep over every table with a `workspaceId` column, including `CampaignRecipient`.
- Read-only counts before and after: `Workspace`, `Campaign`, `CampaignRecipient`, `Contact`, `Channel`, `Segment`, `Tag`, `Message`, `Conversation`, `User`.
- Stop the 4210 process and the stub, and remove the throwaway outDir.

Then tick SP-12's "Detailed plan written" and "Shipped" boxes in the roadmap, noting any deviations and the rulings taken.
