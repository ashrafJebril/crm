# SP-13 Campaign Sending Options and Media Picker: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- **Send from several numbers.** A campaign names one or more WhatsApp numbers (`Campaign.senderChannelIds`). Reachable recipients are split round-robin across them, and each recipient row records the number it went out from. The review step shows the per-number split before launch, and the SP-12 report shows it after.
- **Template variables from any contact field.** Each `{{n}}` maps to a contact field, an SP-02 custom field, or a fixed value, with an optional fallback (`Campaign.varMap`). A missing value uses the fallback. With no fallback, that recipient is skipped with a reason that the report, the failure breakdown and the CSV label in English and Arabic. The review step renders the message for real contacts from the audience.
- **Clear "WhatsApp not connected" gating.** Every marketing action that would reach WhatsApp answers 409 `campaigns.whatsapp_not_connected` (code `WHATSAPP_NOT_CONNECTED`). The Campaigns and Templates screens show one bilingual banner and disable the actions, instead of an English provider message.
- **Media library picker** in the template editor header and in the campaign header, plus a **Gallery** tab on the Templates screen that replaces today's placeholder "Media" tab. The library accepts PDF (DOCUMENT headers) and checks every upload's real type from its bytes.
- **Launch in the background.** `POST /campaigns/:id/launch` validates, flips the draft to `launching` and returns at once. A DB-backed job does the rest. It survives a crash or deploy, resumes where it stopped, and never sends a message twice (carried from SP-12 ruling R10).

**Architecture:**
- **What Zernio can and cannot personalize (checked in Zernio's public docs on 2026-11-09, `docs.zernio.com/platforms/whatsapp/broadcasts.mdx` and `messages/create-inbox-conversation.mdx`; read-only, no API call):**
  - A broadcast's `variableMapping` resolves each `{{n}}` per recipient from Zernio's **own** contact record (`name`, `phone`, `email`, `company`), or takes one literal `customValue` that is the same for everyone. Zernio contact custom fields exist, but broadcasts cannot read them, and setting one is a per-contact call.
  - `POST /contacts/bulk` skips contacts Zernio already has, so a name or email we push does not update an existing Zernio contact.
  - `POST /v1/inbox/conversations` sends one approved template to one phone with its own `templateParams` and `headerMedia`. It accepts an `Idempotency-Key` header (kept for 24 h).
  - The Zernio API limit is 60/600/1 200 requests per minute **per team**, and this CRM uses one key for every workspace.
  - So a value that only our DB knows (a custom field, first name, email) cannot ride on a single broadcast. SP-13 resolves every value in our DB, then picks a transport (ruling 1):
    1. **Partitioned broadcasts (default).** Recipients are grouped by `(sender, the values of every non-native slot)`. Each group becomes one Zernio broadcast, with those values passed as literal `customValue`s. Native slots are `static`, `field.phone` and `field.name` (ruling 2); they keep Zernio's per-recipient resolution. A campaign with no per-recipient fields is one broadcast per sender.
    2. **Direct sends (bounded).** When the groups exceed `CAMPAIGN_MAX_PARTITIONS` (default 25), and the campaign has at most `CAMPAIGN_DIRECT_MAX` reachable recipients (default 5 000), every recipient is sent one message through `POST /inbox/conversations`. The `Idempotency-Key` is the recipient row id, and sends are throttled to `CAMPAIGN_DIRECT_RPM` (default 120).
    3. Otherwise the preview warns and launch refuses with 400 `campaigns.var_map_too_varied {partitions, limit, directLimit, reachable}`.
- **One pure resolver.** `resolveVarMap(varMap, contact, customValues, ctx) → {ok: true, values: string[]} | {ok: false, missing: {slot, source, key}}` in `backend/src/campaigns/sending/var-map.ts`. Preview, launch planning and both transports all call it, so the review step, the rows and what is sent always agree. The frontend mirrors only its labelling and rendering, not the decision.
- **One pure split.** `assignSenders(index, senders) = senders[index % senders.length]` is applied to the reachable recipients in contact-id order (the audience query gains `orderBy: {id: "asc"}`). Skipped rows take the primary sender (`senderChannelIds[0]`). The preview counts per sender with the closed form `ceil((n - i) / k)` for sender `i` of `k` with `n` reachable recipients. A spec proves the closed form equals the per-row assignment.
- **Background launch** (`backend/src/campaigns/sending/`). It follows the SP-03 `ImportRunnerService` and `ImportResumeScheduler` lease pattern: heartbeat compare-and-set, `inFlight` set, transient-error retry, `workspaceContext.run`, and `setImmediate` yields.
  - `POST /campaigns/:id/launch` runs every synchronous check (below). It then claims the draft with `updateMany where {id, workspaceId, status: "draft", zernioBroadcastId: null}` → `status "launching"`, `launchStage "planning"`, `launchHeartbeatAt now`, `launchedById`, the mode and `scheduledAt`. It kicks the runner and answers **202** with the campaign. A second click loses the compare-and-set and gets 409 `campaigns.already_launched`.
  - **Stage 1, plan (no external call, so it restarts from scratch when interrupted):** delete this campaign's `CampaignRecipient` and `CampaignBroadcast` rows (nothing was sent: no stage past planning exists). Stream the audience in keyset pages of 1 000 contacts (`id > cursor`). Load the mapped custom-field values for each page in one query. Apply `buildRecipients` (opted out, then no phone, then duplicate phone through an in-memory `Set`), then `resolveVarMap` (missing value), then `assignSenders`. Write rows with chunked `createMany … skipDuplicates`, and upsert one `CampaignBroadcast` per partition key. Then choose the transport (Architecture above), store the counts, and set `planCompletedAt` and `launchStage "sending"`. A 100 000-member audience is 100 pages and 100–200 inserts. It never holds all contacts in memory at once; the phone `Set` holds at most 100 000 strings.
  - **Stage 2, send.** Each partition carries a persisted `stage`. Every external call is preceded by a heartbeat compare-and-set (lease fencing), and its result is written before the next call.
    - **Broadcast partition:** `pending → contacts_imported → created → recipients_added → sent | scheduled`.
      - Contact import is keyset-paged by recipient id (`importedThroughId`), 1 000 per `bulkCreateContacts`. Zernio skips duplicates, so a repeat is harmless.
      - Create is guarded by adoption. The broadcast name ends with ` · crm:<partitionId>`. Before creating, the runner sets `createAttemptedAt`. On resume, when `createAttemptedAt` is set but `zernioBroadcastId` is null, it lists the profile's draft broadcasts (`GET /broadcasts?profileId&status=draft`) and adopts the one whose name carries the marker, so no second draft is created.
      - Recipients are added 100 phones per call, keyset-paged by recipient id (`addedThroughId`). Zernio counts a re-added phone as `skipped`.
      - Send or schedule is guarded by Zernio's own status. The runner first calls `GET /broadcasts/{id}`. If the broadcast is no longer `draft`, Zernio has already accepted the send, so the runner records `sent`/`scheduled` and does not call send again. A broadcast is only ever sent from `draft`, which is the no-double-send invariant for broadcasts.
    - **Direct partition:** queued rows are claimed one page at a time with `updateMany where {id IN page, status: "queued", messageId: null, sendAttemptedAt: null} → sendAttemptedAt = now`. Each claimed row is sent with `Idempotency-Key: crm-cr-<rowId>`, and the returned message id is stamped as `messageId` (SP-12's tracker then matches webhooks immediately). On resume, a row with `sendAttemptedAt` set and `messageId` null is re-sent with the **same** key while the attempt is under 23 h old, and Zernio replays the original response. Past 23 h the row is marked `failed` with `failureCode "launch:unconfirmed"` and is never re-sent.
  - **Stage 3, finish.** Broadcast transport: `status` becomes `scheduled` or `running`, and `launchedAt`, the counters and `Campaign.zernioBroadcastId` (the first partition's broadcast, for SP-12 code paths and `main` compatibility) are set. Direct transport: `running`, then `completed` when no queued row is left. A scheduled direct campaign waits as `scheduled`, and the scheduler starts it at `scheduledAt`.
  - **Resume.** `CampaignLaunchScheduler` runs every minute. It claims `launching` campaigns whose heartbeat is older than `CAMPAIGN_LAUNCH_STALE_MS` (default 2 min) with a compare-and-set on the old heartbeat, and kicks the runner. It also starts due scheduled direct campaigns. Transient DB errors and Zernio 429/5xx leave the job `launching` for the next resume, up to `MAX_LAUNCH_ATTEMPTS = 5`. Any other error fails the campaign, stores a keyed `lastError`, and notifies `launchedById` (SP-05 type `campaign_finished`).
  - **Cancel** (`POST /campaigns/:id/cancel`, now also valid while `launching`) sets `cancelRequestedAt`. The runner checks it before every external call. Partitions not yet sent are deleted in Zernio when they exist as drafts (`DELETE /broadcasts/{id}`). Partitions already sent or scheduled are cancelled (`cancelBroadcast`). Queued direct rows stay queued and show as "Not sent". The campaign becomes `cancelled`.
  - **Zernio budget.** Campaign launch calls go through a process-wide token bucket, `ZERNIO_CAMPAIGN_RPM` (default 300). That is half the documented 600/min team limit, so inbox replies and syncs keep headroom. A 100 000-recipient broadcast launch is about 1 100 calls, roughly 4 minutes. A 429 honours `Retry-After` and keeps the lease.
- **Tracking stays SP-12's.** `CampaignRecipient` rows, `mergeRecipientEvent`, webhooks and reply attribution are unchanged.
  - The pull sweep becomes per broadcast. For a campaign with `CampaignBroadcast` rows, it pages each broadcast from that broadcast's own `recipientSyncSkip`, with the same shared round-robin budget, matching rows by `(campaignId, phone)` exactly as today. It aggregates Zernio status and counters across broadcasts with a pure `aggregateBroadcastStatus`.
  - Campaigns launched before SP-13 have no `CampaignBroadcast` rows and keep today's single-broadcast path unchanged.
  - Direct campaigns have no broadcast to sweep. Webhooks carry them (their rows hold `messageId`), and the runner and a light per-tick recount keep the counters current.
- **Templates per sender number (ruling 4).** `Template` stays workspace-level, synced from the default number (SP-19 R8 unchanged). Before preview and launch, `templateOnSenders(senders, template)` reads each sender's approved templates through the existing `ZernioClient.whatsappTemplates(accountId)` (read-only GET, cached per call). The copy must be `APPROVED` with the same name and language, and the same message as the primary sender's copy (`sameTemplateCopy`: body text, header format, footer, button types and texts; ported from Tkana). Senders without it are reported in the preview (`templateMissing`), and launch refuses with 400 `campaigns.template_missing_on_number {channelIds}`. Submitting a template to another number's WABA stays out of scope (SP-14).
- **Media.** `MediaService` gains PDF, magic-byte sniffing, a `kind` filter and safe serving. `resolveTemplateHeader` gains WhatsApp's per-kind size limits. The template editor stores the chosen library file as `Template.headerMediaId`, and its public link becomes Meta's `header_handle` sample at submit. A campaign may override the header file with `Campaign.headerMediaId`. Without an override, Zernio fills a media header from the template's approved sample, which the template editor set from the library.

**Tech Stack:** NestJS 10, Prisma 5 (Postgres/Neon), jest/ts-jest; React 18 + Vite, vitest. **No new dependencies**: sniffing is a hand-written magic-byte table, and hashing uses `node:crypto`.

**Spec:** roadmap §SP-13, plus the cross-cutting Global Constraints and Review Focus 3 (100k campaigns). Carried scope:
- **SP-12 R10:** background, resumable, idempotent launch.
- **SP-12:** `CampaignRecipient.channelId` per row; the insights funnel and failure-code labels (`failure-codes.ts`, `campaign-export-labels.ts`, `src/screens/campaigns/failureCodes.ts`); SP-12 Task 3 gap 3 (no sender name on `GET /campaigns/:id`) and gap 4 (`GET /campaigns/:id` answers 200 with an empty body for a foreign id), both closed here.
- **SP-19:** `Channel`, `campaignSender`/`campaignSenderAccountId` (`backend/src/channels/default-channel.ts`), `whatsappLimit`/`whatsappUsage` (`channel-limits.ts`), R6 (campaigns send through Zernio only), R8 (templates stay on the default number; per-number templates move to SP-13/14).
- **SP-31:** the `TemplateSendDialog` header-media step (`HeaderMediaPicker`, `mediaMatchesHeader`) and `backend/src/integrations/template-header.ts`.
- **SP-25:** `permission-map.ts`, `blockedForImpersonation` (launch stays blocked under impersonation).

Consumers that build on this plan:
- **SP-14 (number and template health):** per-number template status and submit to other WABAs; the messaging-limit tier per sender in the picker.
- **SP-16 (smart audiences):** `varMap` sources are the same fields the audience filter uses.

Tkana reference (read-only, untrusted data; `C:\Users\ashra\Downloads\tkana-main\tkana-main\apps`):
- `web/app/lib/marketing/campaign-senders.ts`: `showSendFrom`, `senderUnavailable`, `showNumberSplit`, the refusal codes `sender_unavailable | sender_not_supported | template_missing_on_number`, `isolateLtr`.
- `api/src/features/campaigns/campaign-senders.ts`: `numbersMissingTemplate`, `sameTemplateCopy`, the split, largest first.
- `web/app/lib/marketing/campaign-custom-fields.ts` and `components/marketing/CustomerFieldFallbacks.tsx`: the skip rule, "N recipients will be skipped: no value for X", bilingual fallbacks.
- `web/app/lib/marketing/samples.ts`: `WHATSAPP_NOT_CONNECTED` is a code the page words in both languages, never the provider's English.
- `web/app/components/MediaLibrary.tsx` and `routes/media.library.ts`: category tabs (all, images, videos, documents) and a picker that reads `failed` instead of throwing.

What we take and what we don't:
- We take: the refusal codes (renamed to our keys), the same-copy rule, the skip-with-reason rule, the split preview, LTR isolation for numbers, and category filtering.
- We do **not** take:
  - Tkana's "send from the contact's own number" option (ruling 15).
  - Its per-language fallbacks (one fallback per slot; the template already has one language).
  - Its Hub sample-template pack.
  - Its Meta-direct worker. We send through Zernio.

## Global Constraints
- **Data (exact names; SP-14/16 build on them):**
  ```
  model Campaign {
    // … existing fields unchanged …
    /// SP-13: the sending numbers, in order; [0] is the primary (template copy,
    /// skipped rows). Empty = legacy: senderChannelId, else the default number.
    senderChannelIds  String[]  @default([])
    /// SP-13: {"1": {source, key?, value?, fallback?}, …}. Null on campaigns
    /// launched before SP-13 (they keep variableMapping).
    varMap            Json?
    /// SP-13: optional header file override (library media). Null = the template's sample.
    headerMediaId     String?
    headerMedia       Media?    @relation("CampaignHeaderMedia", fields: [headerMediaId], references: [id], onDelete: SetNull)
    /// SP-13 background launch.
    launchStage       String?   // planning | sending | done | failed
    launchHeartbeatAt DateTime?
    launchAttempts    Int       @default(0)
    launchedById      String?   // audit string, not a FK (survives the member leaving)
    planCompletedAt   DateTime?
    cancelRequestedAt DateTime?
    sendTransport     String?   // broadcast | direct
    broadcasts        CampaignBroadcast[]

    @@index([status, launchHeartbeatAt])
  }

  /// SP-13: one Zernio broadcast (or one direct-send batch) of a campaign:
  /// recipients sharing a sender and the same non-native variable values.
  model CampaignBroadcast {
    id                 String    @id @default(cuid())
    workspaceId        String
    workspace          Workspace @relation("WorkspaceCampaignBroadcasts", fields: [workspaceId], references: [id], onDelete: Cascade)
    campaignId         String
    campaign           Campaign  @relation(fields: [campaignId], references: [id], onDelete: Cascade)
    channelId          String?
    channel            Channel?  @relation("ChannelCampaignBroadcasts", fields: [channelId], references: [id], onDelete: SetNull)
    /// Zernio account id at plan time (the channel may be renamed or re-pointed later).
    accountId          String
    /// sha256 hex of [channelId, ...non-native values]; unique per campaign.
    partitionKey       String
    /// Zernio variableMapping for this partition ({"1": {field|custom, customValue?}}).
    variables          Json
    transport          String    // broadcast | direct
    stage              String    @default("pending") // pending | contacts_imported | created | recipients_added | sent | scheduled | cancelled | failed
    recipientCount     Int       @default(0)
    importedThroughId  String?
    addedThroughId     String?
    createAttemptedAt  DateTime?
    zernioBroadcastId  String?
    recipientSyncSkip  Int       @default(0)
    recipientsSyncedAt DateTime?
    lastError          String?
    createdAt          DateTime  @default(now())
    updatedAt          DateTime  @updatedAt
    recipients         CampaignRecipient[]

    @@unique([campaignId, partitionKey])
    @@index([workspaceId])
    @@index([zernioBroadcastId])
    @@index([channelId])
  }
  ```
  - `CampaignRecipient` (SP-12 model; its migration is not edited) gains:
    - `broadcastId String?` with the relation `broadcast CampaignBroadcast? @relation(fields: [broadcastId], references: [id], onDelete: SetNull)`;
    - `templateParams Json?`: the resolved values, as a `string[]`, on queued rows only;
    - `sendAttemptedAt DateTime?`: direct transport only;
    - `@@index([broadcastId, status, id])` and `@@index([campaignId, channelId, status])`.
  - `Template` gains `headerMediaId String?` with the relation `headerMedia Media? @relation("TemplateHeaderMedia", …, onDelete: SetNull)`.
  - Back-relations: `Workspace.campaignBroadcasts`, `Channel.campaignBroadcasts`, `Media.campaignHeaders`, `Media.templateHeaders`.
  - Add `"CampaignBroadcast"` to `SCOPED_MODELS` in `backend/src/common/prisma-tenancy.ts`.
  - **`Campaign.status`** gains the value `launching`. The column is a free string, so no DB change is needed.
  - **Why each index:**
    - `Campaign(status, launchHeartbeatAt)`: the resume scheduler's stale-launch query.
    - `CampaignBroadcast(campaignId, partitionKey)`: idempotent partition upsert, plus the Campaign FK cascade.
    - `(zernioBroadcastId)`: the sweep and webhook lookups by broadcast.
    - `(channelId)`: the Channel FK `SetNull`.
    - `(workspaceId)`: the Workspace FK cascade.
    - `CampaignRecipient(broadcastId, status, id)`: keyset paging of one partition's queued rows (import, add, direct send), plus the new FK.
    - `CampaignRecipient(campaignId, channelId, status)`: the per-number insights `GROUP BY` (index-only).
- **varMap contract** (`backend/src/campaigns/sending/var-map.ts`; frontend mirror `src/screens/campaigns/varMap.ts`):
  - Shape: `Record<"1".."n", {source: "field", key: "name"|"firstName"|"lastName"|"phone"|"email", fallback?: string} | {source: "custom", key: <CustomFieldDef.key>, fallback?: string} | {source: "static", value: string}>`. Static slots carry `value`, not `key` (a small extension of the roadmap's `{source, key, fallback}`, ruling 16).
  - **Validation** (400 `campaigns.var_map_invalid {slot, reason}` with reason `missing_slot | extra_slot | bad_source | bad_key | unknown_custom_field | empty_value | too_long`):
    - The slots are exactly `"1"`…`"n"` for the template body.
    - The key is in the field list, or is a non-archived `CustomFieldDef` of **this workspace** (`entity "contact"`).
    - `value` and `fallback` are each at most 1 024 characters after trimming. `value` is non-empty.
    - PATCH on a draft checks the shape only, because the template may still change. Preview and launch check everything.
  - **Missing:** `null`, `undefined`, or blank after trimming. A missing value uses the trimmed fallback. If there is no fallback, the recipient is skipped.
  - **Formatting** (ruling 17):
    - text: as stored;
    - number: `String(n)`;
    - date: `yyyy-mm-dd`;
    - boolean: "Yes"/"No", or "نعم"/"لا" when the template's `lang` is `ar`;
    - select: the option's label in the template language when `options` carries one, else the raw value.
    - Every value is then made Meta-safe: newlines and tabs become a space, runs of more than 3 spaces collapse to 3 (Meta rejects them in parameters), and the result is cut to 1 024 characters.
  - **Skip code:** `skip:missing_value:<source>.<key>`, for example `skip:missing_value:custom.service_due` or `skip:missing_value:field.email`. When several slots are missing, the lowest-numbered one names the reason.
    - Order of skip reasons: opted out, then no phone, then duplicate phone (no row; counted in `Campaign.skipped`, as SP-12 ruling 11), then missing value.
  - **Legacy:** a launch body `variables` (the current `[{field: "name"|"phone"|"email"|"company"|"custom", customValue?}]`) is still accepted when the campaign has no `varMap`. `legacyToVarMap` converts it:
    - `name` → `field.name`; `phone` → `field.phone`; `email` → `field.email`;
    - `company` → 400 `campaigns.var_map_invalid {reason: "bad_key"}`, because `Contact` has no company column. Nothing in our frontend sends it;
    - `custom` → `static`.

    The converted map is stored. `Campaign.variableMapping` keeps being written for history.
  - **Native slots** for broadcast partitions: `static` → `{field: "custom", customValue: value}`; `field.phone` → `{field: "phone"}`; `field.name` → `{field: "name"}` (ruling 2). For `field.name`, we import the resolved name (with fallback) in `bulkCreateContacts`. Every other slot is non-native and becomes part of the partition key, passed as a literal `customValue`.
- **Senders** (`backend/src/channels/default-channel.ts`, `backend/src/campaigns/sending/senders.ts`):
  - **Effective senders:** `senderChannelIds` when non-empty; else `[senderChannelId]` when set; else the default Zernio WhatsApp channel (through `campaignSender`, which keeps its legacy-mirror behaviour).
  - **Writes:**
    - The create and update DTOs accept `senderChannelIds?: string[]` (1..10, unique) and/or the legacy `senderChannelId?: string | null`.
    - When only `senderChannelId` is given, `senderChannelIds = id ? [id] : []`.
    - When both are given, they must agree (`senderChannelIds[0] === senderChannelId`), else 400 `campaigns.sender_conflict`.
    - `senderChannelId` is always written as `senderChannelIds[0] ?? null`, so `main` and the SP-12 code read the primary sender.
  - **Validation** (`campaignSenders(prisma, ws, ids) → {accountId, channelId, displayName, phoneNumber}[]`):
    - Each id must be an `active` Zernio WhatsApp channel of the workspace, else 400 `channels.sender_invalid {channelId}`. This is SP-19's key; a foreign id gets the same answer as a missing one (ruling 11).
    - At most `min(10, whatsappLimit(plan))` senders, else 400 `campaigns.too_many_senders {limit}`.
    - Meta-direct numbers are refused (SP-19 R6 reaffirmed, ruling 5).
    - Duplicates are removed, keeping the first.
  - **`GET /campaigns/senders`** (`campaigns.view`) returns:
    ```
    { connected: boolean, limit: number,
      senders: {channelId, displayName, phoneNumber, isDefault, provider,
                eligible: boolean, reason: null | "provider_meta" | "not_active"}[] }
    ```
    `connected` is true when at least one eligible sender exists. It needs no `channels.view`, which closes SP-12 gap 3. Declare it before `:id`.
- **WhatsApp gating** (ruling 6):
  - **Key:** `campaigns.whatsapp_not_connected`, HTTP **409**, body `{statusCode: 409, message: "campaigns.whatsapp_not_connected", code: "WHATSAPP_NOT_CONNECTED"}`. The `message` follows the repo's key convention (`campaignError`, `channelError`), and `code` carries the roadmap's name.
  - **Thrown by:**
    - `POST /campaigns/:id/launch` (no eligible sender, or no `zernioProfileId`);
    - `POST /templates` (create or library import);
    - `PATCH /templates/:id` when it resubmits content;
    - `GET /templates/library`.

    These replace the three English "WhatsApp is not connected via Zernio…" messages in `templates.service.ts` and "Connect a WhatsApp number in Channels before sending a campaign." in `campaign-send.service.ts`.
  - **Not thrown by** reads (the campaign and template lists), draft create and edit, or preview. Preview returns `connected: false` and the page shows the banner.
  - `DELETE /templates/:id` keeps deleting the local row when not connected, as today.
- **Preview:** `POST /campaigns/preview` (`campaigns.view`). It is new; `GET /campaigns/preview?segmentId` stays, unchanged, for compatibility.
  - **Body:** `{segmentId?, templateId?, senderChannelIds?, senderChannelId?, varMap?, headerMediaId?}`.
  - **Response:**
    ```
    { connected, total, reachable,
      skipped: {noPhone, optedOut, duplicate, missingValue},
      missingByKey: {source, key, label, labelAr, count}[],
      split: {channelId, displayName, phoneNumber, recipients}[],   // largest first
      transport: {kind: "broadcast"|"direct"|"too_varied", partitions, limit, directLimit},
      templateMissing: string[],                                    // channel ids
      samples: {contactId, name, rendered, values: string[], usedFallback: number[], skippedFor: {source,key}|null}[],
      estimate: {usd, unpriced} }
    ```
  - It streams the audience in keyset pages of 1 000, through the same `buildRecipients → resolveVarMap → assignSenders` pipeline as the plan stage, and writes nothing.
  - **Samples** are up to 3 **real contacts** from the audience: the first reachable one; the first that used a fallback; the first skipped for a missing value. They are rendered with the template body. Samples are returned only when the caller holds `contacts.view` (read from `req.permissions`); otherwise they are `[]` (ruling 18).
- **Launch** (`POST /campaigns/:id/launch`, `campaigns.manage`, impersonation-blocked as today):
  - **Body:** `{mode: "now"|"schedule", scheduledAt?, variables?}`. `variables` is legacy only.
  - **Synchronous checks, in order:**
    1. payment lock (unchanged message);
    2. 404 `campaigns.not_found`;
    3. 409 `campaigns.already_launched` unless `draft` with no `zernioBroadcastId`;
    4. schedule in the future, else 400 `campaigns.schedule_invalid`;
    5. template approved, else 400 `campaigns.template_not_approved`;
    6. the template has no text-header variables and no dynamic URL button parameter, else 400 `campaigns.template_unsupported` (ruling 12);
    7. connected, else 409 `campaigns.whatsapp_not_connected`;
    8. senders valid;
    9. template on every sender, else 400 `campaigns.template_missing_on_number {channelIds}`, or 502 `campaigns.template_check_failed {channelIds}` when Zernio can't be read;
    10. `varMap` valid;
    11. header media: workspace-scoped (404), matching the template header kind (`templates.header_media_mismatch`), within the WhatsApp size limit (`templates.header_media_too_large {limit}`), and with `scheduledAt` at most 6 days ahead (`campaigns.header_media_schedule_too_far {days: 6}`, ruling 9).
  - The audience-size and partition checks happen in the plan stage, because they need the full audience. A plan that ends with zero reachable recipients fails the job with `campaigns.no_reachable_recipients`. A plan over both caps fails it with `campaigns.var_map_too_varied`. Both are stored in `lastError` and shown by the page. The review step's preview warns about both before launch.
  - **Response:** 202 `{…campaign, status: "launching", launchStage: "planning"}`.
- **`GET /campaigns/:id`:**
  - A foreign or unknown id returns **404 `campaigns.not_found`** (closes SP-12 gap 4).
  - It adds `senders: {channelId, displayName, phoneNumber}[]` and, while launching, `launch: {stage, planned, partitionsTotal, partitionsDone, directSent}`. Both are computed with two indexed queries.
- **Insights** (`GET /campaigns/:id/insights`) adds:
  - `byNumber: {channelId: string|null, displayName, phoneNumber, unknown: boolean, total, sent, delivered, read, replied, failed, skipped}[]`, largest first, from one `GROUP BY "channelId", status` over `(campaignId, channelId, status)`.
  - Row sums use SP-12's one-outcome-per-row sets: `sent` = sent + delivered + read + replied + failed (attempted); `delivered` = delivered + read + replied; `read` = read + replied.
  - `unknown` marks a null `channelId` on a tracked campaign (the channel was deleted).
  - Untracked campaigns return `[]`.
- **Failure codes** (backend `tracking/failure-codes.ts` and `campaign-export-labels.ts`; frontend `failureCodes.ts`, mirrored word for word):
  - `skip:missing_value:<source>.<key>`: "No value for <label>" / "لا توجد قيمة لـ <label>". The label is the custom field's `label`/`labelAr`, or the built-in field name in both languages; an unknown key shows the raw key in `<bdi dir="ltr">`.
  - `launch:unconfirmed`: "Send not confirmed; not retried" / "لم يتأكد الإرسال؛ لم تتم إعادة المحاولة".
  - Insights groups failures by code, so each missing field gets its own line with its count.
- **Media** (`backend/src/media/`):
  - **Library types:**
    - images `jpeg/png/gif/webp` ≤ 20 MB (unchanged);
    - video `mp4/quicktime` ≤ 300 MB (unchanged);
    - **new** `application/pdf` ≤ 100 MB (`MAX_PDF_BYTES`).

    CSV and XLSX stay import-only and stay hidden from the library (ruling 7).
  - **Sniffing** (`media/sniff.ts`, pure): the first 16 bytes of the staged temp file, or of the buffer, must match the declared type's family:
    - JPEG `FF D8 FF`
    - PNG `89 50 4E 47 0D 0A 1A 0A`
    - GIF `GIF87a`/`GIF89a`
    - WEBP `RIFF....WEBP`
    - MP4/MOV `....ftyp`
    - PDF `%PDF-`

    A mismatch returns 400 `media.type_mismatch`. A type outside the list returns 400 `media.unsupported_type {allowed}`, and a file over its cap returns 400 `media.too_large {limit}`. These keys replace today's English messages. `ingestBuffer` (inbound attachments) also sniffs.
  - **`GET /media?kind=image|video|document&before=<id>&limit=<1..200>`:** the default response is unchanged (an array, 200 rows, newest first). `kind` filters by mime family. `before` is a keyset on `(createdAt, id)` for the Gallery's "Load more".
  - **Serving:** `GET /media/:id/file` and `/public` send `X-Content-Type-Options: nosniff`. Anything that is not an image or video is sent with `Content-Disposition: attachment` and `Content-Security-Policy: sandbox`.
  - **Delete guard:** deleting media used as `headerMediaId` by a template, or by a campaign in `draft|launching|scheduled|running`, returns 409 `media.in_use {templates, campaigns}`. The FKs are `SetNull` as a backstop.
  - **External links:** `resolveExternalUrl(ws, id, ttlSeconds)` stays. For local storage, `mintPublicToken` becomes extend-only: it reuses an unexpired token, and only ever moves `publicTokenExpiresAt` later. Two campaigns using one file therefore never invalidate each other's link. Spaces presigned URLs are capped at 7 days, which is why ruling 9 limits scheduling.
  - **WhatsApp header limits** (`template-header.ts`, `HEADER_LIMITS`): image `jpeg/png` ≤ 5 MB; video `mp4` ≤ 16 MB; document `pdf` ≤ 100 MB. Above the limit, 400 `templates.header_media_too_large {limit}`. The inbox `TemplateSendDialog` path gets the same check.
- **Template header in the editor:**
  - `POST /templates` and `PATCH /templates/:id` accept `headerType: "none"|"text"|"image"|"video"|"document"`, `headerContent` (text only) and `headerMediaId` (media kinds).
  - The service resolves `headerMediaId` (workspace-scoped, matching kind, header limits) to `resolveExternalUrl(…, 3600)` and passes it as `header_handle`. Zernio downloads it, as the existing comment in `buildComponents` says. It stores `headerMediaId`, and keeps `headerContent` null for media headers.
  - `TemplateRow` gains `headerMediaId`.
- **Permissions (SP-25).** No catalogue change. `permission-map.ts` adds:
  - `GET /campaigns/senders`: `campaigns.view`
  - `POST /campaigns/preview`: `campaigns.view`

  Unchanged and re-asserted in the spec:
  - `POST /campaigns/:id/launch` and `POST /campaigns/:id/cancel`: `campaigns.manage`, blocked under impersonation;
  - `POST|PATCH /templates`: `templates.create|update`;
  - `GET /media` and `POST /media/upload`: `conversations.view|create`.

  The runner and scheduler are not routes. Every handler loads its campaign by `(id, workspaceId)` first, and a foreign id returns **404 `campaigns.not_found`**. Media ids go through `MediaService.get` (404 across workspaces). Custom-field keys are resolved only within the workspace.
- **Error keys** (backend `campaign-errors.ts`, which gains 409 and 502 in its STATUS map; frontend `campaignErrors.ts` with `tx` copy for each):
  - `campaigns.whatsapp_not_connected` (409)
  - `campaigns.already_launched` (409)
  - `campaigns.sender_conflict` (400)
  - `campaigns.too_many_senders` (400)
  - `campaigns.template_missing_on_number` (400)
  - `campaigns.template_check_failed` (502)
  - `campaigns.template_not_approved` (400)
  - `campaigns.template_unsupported` (400)
  - `campaigns.schedule_invalid` (400)
  - `campaigns.var_map_invalid` (400)
  - `campaigns.var_map_too_varied` (400, as a launch failure in `lastError`)
  - `campaigns.no_reachable_recipients` (as a launch failure)
  - `campaigns.header_media_schedule_too_far` (400)
  - `campaigns.not_cancellable` (400)
  - `media.type_mismatch`, `media.unsupported_type`, `media.too_large`, `media.in_use`
  - `templates.header_media_too_large`
  - the existing `channels.sender_invalid` and `templates.header_media_mismatch`
- **Migration:**
  - File: `backend/prisma/migrations/20261114120000_campaign_sending/migration.sql`. The timestamp is after `20261113120000_campaign_recipients`. That migration is **not** applied yet, will be applied in the same `migrate deploy` run, and is **never edited**. Every migration through `20261112120000_channels` is applied in production. Hand-written; apply with `npx prisma migrate deploy` only, never `migrate dev`.
  - **Ordering dependency.** It alters `"CampaignRecipient"`, which `20261113120000` creates. `migrate deploy` applies pending folders in name order, so both apply together, in order. `fly.toml`'s `release_command` runs `migrate deploy` on every deploy.
  - **Additive and idempotent:**
    - `ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS …`:
      - `"senderChannelIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]`
      - `"varMap" JSONB`
      - `"headerMediaId" TEXT`
      - `"launchStage" TEXT`
      - `"launchHeartbeatAt" TIMESTAMP(3)`
      - `"launchAttempts" INTEGER NOT NULL DEFAULT 0`
      - `"launchedById" TEXT`
      - `"planCompletedAt" TIMESTAMP(3)`
      - `"cancelRequestedAt" TIMESTAMP(3)`
      - `"sendTransport" TEXT`
    - `CREATE TABLE IF NOT EXISTS "CampaignBroadcast" (… CONSTRAINT "CampaignBroadcast_pkey" PRIMARY KEY ("id"))`, with `"variables" JSONB NOT NULL` and `"updatedAt" TIMESTAMP(3) NOT NULL` (no DB default, matching `@updatedAt`; raw writers set it themselves).
    - `ALTER TABLE "CampaignRecipient" ADD COLUMN IF NOT EXISTS "broadcastId" TEXT, ADD COLUMN IF NOT EXISTS "templateParams" JSONB, ADD COLUMN IF NOT EXISTS "sendAttemptedAt" TIMESTAMP(3)`
    - `ALTER TABLE "Template" ADD COLUMN IF NOT EXISTS "headerMediaId" TEXT`
    - `CREATE [UNIQUE] INDEX IF NOT EXISTS` for every index
    - every FK inside `DO $$ BEGIN ALTER TABLE … ADD CONSTRAINT …; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`
  - **Prisma-conformant names:**
    - `CampaignBroadcast_pkey`
    - `CampaignBroadcast_workspaceId_fkey` (→ Workspace CASCADE), `CampaignBroadcast_campaignId_fkey` (→ Campaign CASCADE), `CampaignBroadcast_channelId_fkey` (→ Channel SET NULL)
    - `CampaignBroadcast_campaignId_partitionKey_key`
    - `CampaignBroadcast_workspaceId_idx`, `CampaignBroadcast_zernioBroadcastId_idx`, `CampaignBroadcast_channelId_idx`
    - `CampaignRecipient_broadcastId_fkey` (→ CampaignBroadcast SET NULL)
    - `CampaignRecipient_broadcastId_status_id_idx`, `CampaignRecipient_campaignId_channelId_status_idx`
    - `Campaign_headerMediaId_fkey` (→ Media SET NULL), `Campaign_status_launchHeartbeatAt_idx`
    - `Template_headerMediaId_fkey` (→ Media SET NULL)

    All FKs are ON UPDATE CASCADE.
  - **Safe for the deployed `main`.**
    - Every new column is nullable or defaulted. `main`'s Prisma client never selects them, and its `campaign.create`/`template.create` get the defaults.
    - New FKs are `SET NULL` or cascade only from new rows. A `main` media delete nulls a header reference; it never fails.
    - No existing column, constraint or index changes. The migration contains no `UPDATE`, `DELETE`, `DROP` or `ALTER … TYPE`.
    - `launching` rows only exist once SP-13 code runs (ruling 14 covers a rollback).
  - **No backfill.** Existing campaigns have `senderChannelIds = {}`, so the legacy `senderChannelId` rule applies. Their `varMap` is null and they keep `variableMapping`.
- **Copy and layout:**
  - Every user-facing string goes through `tx("English","العربية")` with real Arabic.
  - Use logical CSS: `margin-inline-start`, `padding-inline`, `text-align: start`, `inset-inline-end`.
  - Phone numbers, codes, counts and `{{n}}` tokens inside Arabic sentences go in `<bdi dir="ltr">`; inside an `<option>`, use Tkana's `isolateLtr` (U+2066 … U+2069).
  - Dialogs set `dir`. Sample previews render with `dir="auto"`.
- **Tests:**
  - backend: `npx jest src/campaigns src/channels src/integrations src/templates src/media src/permissions src/common` plus `npx tsc --noEmit -p tsconfig.json`; the full `npm test` once per task. The known unrelated failure is `hjz-client-sync › is inert when HJZ is not configured`.
  - frontend: `npx vitest run` plus `npm run typecheck`; `npm run build` once in Task 4.
  - Named acceptance tests (exact names):
    - `missing field uses fallback, missing fallback skips recipient with reason`
    - `split sends round-robin across senders`
    - `launch job resumes after crash without double send`
- **Commits:** selective `git add <paths>`, never `-A`. Trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not stage `.playwright-mcp/` or any untracked file this plan did not create.

## Review Focus
1. **No message is ever sent twice.**
   - Two launch clicks start one job.
   - A crash at every step boundary resumes without a second send:
     - after contacts are imported;
     - after the broadcast is created but before its id is stored (adoption by marker);
     - after recipients are added;
     - after Zernio accepted `send` but before `stage = sent` (the status check);
     - after a direct send but before `messageId` is stored (same idempotency key).
   - A stale runner whose lease was taken writes nothing further.
   - Cancel during launch sends nothing further.
   - Tests: `launch job resumes after crash without double send` (table-driven over every boundary), `concurrent launch requests start one job`, `cancel during launch sends nothing further`.
2. **Exact, isolated variable values.**
   - Every member of a broadcast partition resolves to exactly that partition's literal values (an invariant over generated audiences).
   - Missing values follow fallback-then-skip, and the reason is stored.
   - Arabic values, newlines, tabs and runs of spaces are sanitized identically in preview and launch.
   - Custom-field keys never resolve across workspaces.
   - Tests: `missing field uses fallback, missing fallback skips recipient with reason`, `partitions never mix resolved values`.
3. **The split is exact and reported consistently.**
   - Round-robin over reachable recipients in id order.
   - The preview's closed-form counts equal the rows written.
   - `byNumber` sums equal the funnel totals.
   - A deleted channel shows as "Unknown number".
   - Tests: `split sends round-robin across senders`, `insights byNumber sums to totals`.
4. **100k without blocking or exhausting Zernio.**
   - The plan streams the audience in pages of 1 000. Inserts are at most 1 000 rows per call.
   - The runner yields between pages.
   - The Zernio token bucket caps launch calls at `ZERNIO_CAMPAIGN_RPM`, and a 429 waits for `Retry-After`.
   - The HTTP launch call returns in well under a second, whatever the audience size.
   - Test: `launch of 100k plans in pages and never inserts more than 1000 rows per call` (mocked).
5. **Tenant isolation and media safety.**
   - A foreign campaign, media or custom-field key returns 404 (or 400 `var_map_invalid` for a key).
   - A foreign sender returns 400 `channels.sender_invalid` (ruling 11).
   - A PNG renamed `.pdf` is rejected (`media.type_mismatch`).
   - A PDF is served as an attachment with `nosniff` and a sandbox CSP.
   - Media in use by a scheduled campaign can't be deleted.
   - Tests: `foreign ids return 404 on SP-13 routes`, `media upload sniffs type and accepts PDF`.

## Architecture Rulings and Risks
Each item names the risk, then the recommended ruling. Items marked **(needs controller ruling)** are repeated under Controller rulings, where the controller fills in the decision.

1. **Per-recipient values are infeasible through one Zernio broadcast.** Zernio broadcasts read only Zernio's own contact `name/phone/email/company`, or one literal for everyone (docs, 2026-11-09). Custom fields and first or last names live only in our DB. Writing them into Zernio is one call per contact, and bulk import does not update existing contacts.
   - **Ruling:** resolve every value in our DB, then:
     - **(a)** partition into broadcasts by `(sender, non-native values)`, up to `CAMPAIGN_MAX_PARTITIONS = 25`;
     - **(b)** above that, use per-recipient direct sends (`POST /inbox/conversations`, `Idempotency-Key`), up to `CAMPAIGN_DIRECT_MAX = 5 000` reachable recipients, throttled to `CAMPAIGN_DIRECT_RPM = 120` (about 42 minutes for 5 000);
     - **(c)** otherwise refuse with `campaigns.var_map_too_varied`. The preview warns first.
   - A 100 000-recipient campaign therefore works when it personalizes by name, phone or a low-cardinality field (city, plan, branch). One with a unique value per person (an appointment date, an order number) works up to 5 000 recipients.
   - **Alternatives:** drop (b), so only (a) and (c), which is simpler and removes the per-message path entirely; or raise the caps, which spends more of the team-wide Zernio limit.
   - All three env values are overridable. **(needs controller ruling)**
2. **`{{n}} = name` stays Zernio-native.** Mapping `field.name` through a partition key would make nearly every personalized campaign "too varied". So `field.name` uses Zernio's `{field: "name"}`, and we import the resolved name (with its fallback) through `bulkCreateContacts`. The limitation, unchanged from today: a person Zernio already knows keeps Zernio's stored name, and Zernio says "there" when its name is empty.
   - Our skip rule still applies: a contact whose name is blank with no fallback is skipped.
   - `firstName`/`lastName` are non-native (exact), because Zernio has no such field.
   - **Alternative:** make `name` non-native too, which is exact but pushes most campaigns to direct sends or a refusal. **(needs controller ruling)**
3. **Background launch replaces the synchronous launch (SP-12 R10).**
   - The HTTP contract changes from 200 with the final campaign to **202** with `status "launching"`. The frontend polls the campaign (every 5 s while launching).
   - `launching` is a new status value. Its list label is "Preparing" / "قيد التحضير", shown with progress.
   - Launches that fail before anything is sent end as `failed` with a keyed `lastError`. Unlike today, they are not left as a relaunchable draft. A "Duplicate as draft" action is out of scope; the user creates a new campaign. **(needs controller ruling)**
4. **Templates per sender number (carried from SP-19 R8).** A sender on another WABA may lack the template, or hold a different copy.
   - **Ruling:** no schema change and no per-number template store in SP-13. Preview and launch read each sender's approved templates live through `ZernioClient.whatsappTemplates(accountId)` (read-only), and require the same approved copy (`sameTemplateCopy`, from Tkana).
   - A missing copy is a preview warning and a launch refusal (`campaigns.template_missing_on_number {channelIds}`). A Zernio read failure fails closed at launch (502 `campaigns.template_check_failed`).
   - Template sync, listing and submission stay on the default number. Submitting to another number's WABA and per-number template status move to SP-14. Record this in SP-14's roadmap entry. **(needs controller ruling)**
5. **Meta-direct numbers can't be campaign senders** (SP-19 R6). Sending through Meta's Cloud API directly would need our own per-message worker, Meta's throughput handling and a tier check.
   - **Ruling:** reaffirm R6. The picker lists Meta numbers disabled, with "Campaigns send through Zernio numbers only" / "ترسل الحملات عبر أرقام Zernio فقط". **(needs controller ruling, minor)**
6. **Error key for "not connected".** The roadmap names the code `WHATSAPP_NOT_CONNECTED`. The repo's convention is a dotted key in `message` (`campaigns.*`, `channels.*`).
   - **Ruling:** `message: "campaigns.whatsapp_not_connected"`, plus `code: "WHATSAPP_NOT_CONNECTED"` in the body, HTTP 409 (like `channels.not_connected`). It covers campaign launch and every template action that reaches Meta (one key, one banner, both screens).
   - Reads, drafts and preview never throw it. They report `connected:false`.
   - The inbox keeps `channels.not_connected` for conversation sends. **(needs controller ruling)**
7. **Media library scope.** Today the library takes images and video. Inbound documents are not stored, and PDF uploads are refused (the SP-31 DOCUMENT gap).
   - **Ruling:** accept `application/pdf` up to 100 MB in the library (WhatsApp's document maximum), with magic-byte sniffing on every upload and attachment serving.
   - Keep video at 300 MB for social posts. WhatsApp's tighter header limits (image 5 MB, video 16 MB) are enforced where a file is used as a header, not at upload.
   - No Office documents and no audio in SP-13.
   - Storage uses the existing `MediaStorage` (DO Spaces in production, local in dev) unchanged. **(needs controller ruling)**
8. **Campaign header media on broadcasts is unverified.** Zernio documents `headerMedia` for direct sends, and says media headers are otherwise filled from the template's approved sample. Its broadcast page documents body components only.
   - **Ruling:**
     - With no campaign override (the default), send no header component, and Zernio uses the template's sample. That sample is the file chosen in the template editor.
     - With an override, direct sends pass `headerMedia: {link}`. Broadcast partitions add Meta's header component `{type: "header", parameters: [{type, [type]: {link}}]}` to `template.components`, which Zernio forwards verbatim for message sends.
     - The stub verifies the request shape only. Without sending a real message (forbidden in verification), the real behaviour can't be proven.
   - **Alternative:** force direct transport whenever an override is set, which is verified by the docs but capped at 5 000. **(needs controller ruling)**
9. **Header links must live until the send.** Spaces presigned URLs last at most 7 days, and Zernio may fetch the file at send time.
   - **Ruling:** the link TTL is `(scheduledAt ?? now) − now + 72 h`, at most 7 days. A campaign with a header override can be scheduled at most 6 days ahead (`campaigns.header_media_schedule_too_far`).
   - Local storage uses the extend-only public token.
   - Templates need the link only for submission (1 h). **(needs controller ruling, minor)**
10. **Media in use.** Deleting a file that a scheduled campaign or a template header uses would break the send, or the next resubmission.
    - **Ruling:** 409 `media.in_use`, plus `SetNull` FKs as a backstop. **(needs controller ruling, minor)**
11. **Foreign sender ids return 400, not 404.** The roadmap's "foreign ids return 404" applies to path ids. A sender id in a request body is a reference: SP-19 already answers `channels.sender_invalid` (400) for missing and foreign ids alike, which leaks nothing. The same applies to `varMap` custom keys (400 `var_map_invalid`). Path ids (`/campaigns/:id`) and media ids return 404. **(needs controller ruling, minor)**
12. **Text-header variables and dynamic URL buttons.** Broadcasts in our client fill body parameters only, and SP-13's `varMap` covers body slots.
    - **Ruling:** templates whose text header has `{{n}}`, or with a dynamic URL button, are refused for campaigns (`campaigns.template_unsupported`). The picker marks them "Not supported for campaigns yet". They still work in the inbox's TemplateSendDialog. **(needs controller ruling, minor)**
13. **Size.** The roadmap sizes SP-13 at M. Background launch (carried), multi-broadcast tracking and direct sends make it **L**. It is split into 5 tasks below. **(needs controller ruling: accept the size, or move the direct transport in ruling 1(b) to a follow-up)**
14. **Rollback with `launching` rows.** If production is rolled back to pre-SP-13 code while a campaign is `launching`:
    - `main` ignores it, because its sync selects only `scheduled|running` with a broadcast id;
    - `main` allows deleting it;
    - `main` never resumes it.

    Nothing double-sends, but the campaign stalls. **Ruling:** document it in the PR, and in the runbook: "before rolling back, wait until no campaign is `launching` (`SELECT count(*) FROM "Campaign" WHERE status='launching'`)". **(needs controller ruling, minor)**
15. **"Send from the contact's own number"** (Tkana's `contact` option, which keeps a customer on the number they chat with) is out of scope. Round-robin and single-number are the only modes. Record it as a follow-up. **(needs controller ruling, minor)**
16. **Static slots use `value`, not `key`.** The roadmap's single shape `{source, key, fallback}` doesn't fit a literal. **Ruling:** `{source: "static", value}`, documented in the varMap contract. **(minor; no ruling needed unless the controller objects)**
17. **Value formatting** (dates as `yyyy-mm-dd`, booleans as localized Yes/No, select labels, Meta-safe whitespace, 1 024 characters) is our choice. Meta's exact parameter limits (newline, tab and 4+ spaces rejected, error 132018) come from its docs and must be re-checked by the implementer. **(needs controller ruling, minor)**
18. **Preview samples show real contacts.** A `campaigns.view` holder without `contacts.view` must not see contact names through the preview. **Ruling:** samples only with `contacts.view`. Otherwise the review shows the template with `{{n}}` labels such as "Name" or "City", and no real data. **(needs controller ruling, minor)**
19. **One Zernio key for all tenants.** The team limit is 600 requests per minute, and a 429 affects every workspace's inbox. Today's synchronous launch already makes about 1 100 calls for 100k recipients without any throttle.
    - **Ruling:** a process-wide token bucket for campaign launch calls (`ZERNIO_CAMPAIGN_RPM = 300`), plus `Retry-After` handling, plus the 120 rpm direct-send cap within it. It is per machine, like SP-19's rate limits (`min_machines_running = 1`). **(needs controller ruling)**
20. **Verification touches production** (same as SP-12 R14). The deployed app's 5-minute sync may make read-only GETs to the real Zernio for stub broadcast ids. The script drives test campaigns to `completed` within seconds. Both pending migrations (`20261113120000` and `20261114120000`) need the user's explicit approval before `migrate deploy`. Recommendation: run SP-12 Task 4 first, then this plan's Task 5, on one approval. **(needs controller ruling)**

### Controller rulings
*Decided 2026-11-09.*
- **R1** Accepted: partitioned broadcasts (at most 25), then direct sends for campaigns of at most 5 000 recipients, throttled; anything larger is refused with `campaigns.var_map_too_varied`. The review step warns before the refusal.
- **R2** Accepted. `{{n}}` mapped to the contact name keeps using the name Zernio has stored. This limitation is shown in the mapping UI.
- **R3** Accepted.
- **R4** Accepted. All Zernio calls in the code are mocked; the live check happens only in Task 5, against the stub.
- **R5** Accepted.
- **R6** Accepted.
- **R7** Accepted.
- **R8** **Force direct sends when a campaign-level header file is set.** That is the verified path, so we never rely on unverified broadcast header overrides. A campaign with a header file is therefore capped at 5 000 recipients; the review step says so. Revisit after a live check in a later SP.
- **R9** Accepted.
- **R10** Accepted.
- **R11** Accepted.
- **R12** Accepted.
- **R13** Accepted: size L, 5 tasks.
- **R14** Accepted. Add the rollback note to the PR and runbook.
- **R15** Accepted (deferred).
- **R17** Accepted.
- **R18** Accepted.
- **R19** Accepted: 300 rpm token bucket, configurable through env.
- **R20** The SP-12 migration is already applied and SP-12 Task 4 is running. The SP-13 migration (`20261114120000_campaign_sending`) needs a **new, explicit approval from the user** before it is applied. Earlier approvals do not carry over.

---

### Task 1: Backend — schema, migration, varMap, senders, gating and preview
**Owns:** `schema.prisma` and the migration for all of SP-13. Tasks 2 and 3 depend on this schema and do not edit it.

**Files:**
- `backend/prisma/schema.prisma`: everything in Global Constraints → Data.
- `backend/prisma/migrations/20261114120000_campaign_sending/migration.sql`.
- `backend/src/common/prisma-tenancy.ts` (`SCOPED_MODELS` += `"CampaignBroadcast"`); `backend/src/prisma/prisma.service.ts` (the `campaignBroadcast` delegate, if delegates are listed there as in SP-12).
- Create `backend/src/campaigns/sending/`, each with a spec:
  - `var-map.ts`:
    - `VAR_FIELDS`
    - `validateVarMapShape(map)`
    - `validateVarMap(map, {slotCount, customDefs})`
    - `resolveVarMap(map, contact, customValues, {lang, defs})`
    - `formatCustomValue(def, value, lang)`
    - `metaSafe(text)`
    - `legacyToVarMap(variables)`
    - `isNativeSlot(slot)`
    - `zernioVariableFor(slot, value)`
    - `missingSkipCode(source, key)`
  - `senders.ts`:
    - `effectiveSenderIds(campaign)`
    - `assignSender(index, senders)`
    - `splitCounts(n, senders)`
    - `sameTemplateCopy(a, b)`
    - `templateOnSenders(zernio, senders, template) → {missing: string[], failed: string[]}`
    - `normalizeSenderWrite(dto)`
  - `partition.ts`: `partitionKey(channelId, values, slots)` (sha256 hex), `planTransport({partitions, reachable}, env) → "broadcast"|"direct"|"too_varied"`, `CAMPAIGN_MAX_PARTITIONS`, `CAMPAIGN_DIRECT_MAX` (env-overridable).
  - `audience-stream.ts`: `streamAudience(prisma, ws, segmentId, defIds, pageSize = 1000)`, an async generator over keyset pages, each with its custom values. Used by the preview here and the plan stage in Task 2.
  - `campaign-preview.service.ts`: `preview(ws, body, {canViewContacts})`.
- `backend/src/channels/default-channel.ts`: `campaignSenders(prisma, ws, ids)`. The existing three functions are unchanged.
- `backend/src/campaigns/campaign-errors.ts`: the new keys, and 409/502 in `STATUS`.
- `backend/src/campaigns/campaigns.module.ts`:
  - DTOs: `senderChannelIds` (`IsArray`, `ArrayMaxSize(10)`, `IsString({each})`), `varMap` (`IsObject`, then `validateVarMapShape` in the service), `headerMediaId`; the launch DTO's `variables` becomes optional.
  - Routes: `GET senders` and `POST preview`, declared before `:id`.
  - `GET :id` returns 404 and `senders`.
  - create/update go through `normalizeSenderWrite` and `campaignSenders`.
- `backend/src/templates/templates.service.ts`: the three not-connected throws become `campaignError("campaigns.whatsapp_not_connected")`.
- `backend/src/campaigns/campaign-send.service.ts`: the launch-time not-connected throw likewise. The launch body is otherwise unchanged in this task; Task 2 replaces it.
- `backend/src/permissions/permission-map.ts` (+2 routes). The `permission-map.spec.ts` and `system-role-decisions.spec.ts` tables gain the rows.
- `backend/src/channels/test-prisma.ts`: a `campaignBroadcast` model, `customFieldDef`/`customFieldValue` if missing, and array columns.
- Specs:
  - `backend/src/campaigns/campaign-sending-migration.spec.ts`
  - `sending/*.spec.ts`
  - `campaign-preview.service.spec.ts`
  - extend `campaign-sender.spec.ts` and `templates.service.spec.ts`

**Produces (contract for Tasks 2–4):**
- `resolveVarMap`, `assignSender`, `splitCounts`, `partitionKey`, `planTransport`, `streamAudience`, `campaignSenders`, `templateOnSenders`: the exact signatures above.
- `GET /campaigns/senders` and `POST /campaigns/preview`: the response shapes in Global Constraints.
- `GET /campaigns/:id`: 404 for foreign ids; `senders[]`.
- Campaign create/update accept `senderChannelIds`, `varMap` and `headerMediaId`, keeping `senderChannelId === senderChannelIds[0]`.

- [ ] Write the failing tests:
  - `migration is additive, idempotent and Prisma-named (SP-13)` (reads the SQL):
    - every `CREATE` and `ADD COLUMN` has `IF NOT EXISTS`;
    - every FK sits in a `DO $$ … duplicate_object` block;
    - all names appear exactly as listed;
    - there is no `DROP`, `UPDATE`, `DELETE`, `ALTER COLUMN` or `TYPE`;
    - new non-null columns have defaults;
    - the folder name is greater than `20261113120000`;
    - the SP-12 migration file is byte-identical to `git show HEAD:<path>`.
  - `resolveVarMap uses fallback for missing values and reports the first missing slot`: pure; blank and whitespace-only values count as missing; Arabic values pass through unchanged; `metaSafe` collapses newlines, tabs and 4+ spaces; 1 024-character cut.
  - `formatCustomValue formats number, date, boolean and select per language`.
  - `validateVarMap rejects missing or extra slots, unknown or foreign custom keys and empty static values`: a key defined only in workspace B fails in A.
  - `legacy variables convert to varMap` (`company` → 400).
  - `splitCounts equals round-robin assignment` (property test over n ∈ [0, 1000], k ∈ [1, 10]).
  - `sameTemplateCopy compares body, header format, footer and buttons`.
  - `templateOnSenders reports senders missing the template or holding a different copy` (mocked `whatsappTemplates`; one read per account).
  - `campaignSenders validates every sender and caps at the plan limit`: a foreign id gives `channels.sender_invalid`; a Meta channel is refused; duplicates are removed; `too_many_senders` at limit + 1.
  - `sender write keeps senderChannelId equal to the primary` (only legacy; only the array; both agreeing; both conflicting → `sender_conflict`).
  - `preview splits, counts missing values and samples real contacts`:
    - 10 contacts, 3 senders → split 4/3/3;
    - 2 missing a custom value with no fallback → `missingByKey` and `skipped.missingValue = 2`;
    - samples are real contact names rendered with fallbacks;
    - no samples without `contacts.view`;
    - `templateMissing` lists a sender without the template;
    - `transport.kind` is `too_varied` above both caps.
  - `whatsapp not connected returns campaigns.whatsapp_not_connected on every marketing action`: launch, template create, library import, content update and library lookup each give 409 with `code: "WHATSAPP_NOT_CONNECTED"`; preview gives `connected:false` with 200.
  - `foreign ids return 404 on SP-13 routes` (part 1): `GET /campaigns/:id`, `PATCH`, `launch`, `cancel` with workspace B's id from A; a foreign `headerMediaId` on PATCH gives 404.
  - `permission map covers SP-13 routes`: senders and preview are `campaigns.view`; launch and cancel are still `campaigns.manage` and blocked under impersonation (system-role decisions: agent can preview; viewer can view senders; an impersonated owner cannot launch).
- [ ] Implement until green.
- [ ] `npx tsc --noEmit -p tsconfig.json`, the listed jest paths, then the full `npm test` once. Run `npx prisma generate` (an EPERM on the engine DLL while the dev watcher runs is harmless, as in SP-12; restart the watcher).
- [ ] Commit `feat(campaigns): sender split, variable mapping with fallbacks, WhatsApp gating and campaign preview`.

### Task 2: Backend — background launch job, partitioned sending, tracking and insights
**Depends on:** Task 1.

**Files:**
- Create in `backend/src/campaigns/sending/`, each with a spec:
  - `campaign-launch-runner.service.ts`: `kick(id)`, `run(id)`, the stages; lease fencing (`nextBeat`, compare-and-set on `launchHeartbeatAt`); `MAX_LAUNCH_ATTEMPTS`; `yieldTick`; `workspaceContext.run`.
  - `campaign-launch.scheduler.ts`: `@Cron(EVERY_MINUTE) sweep(now)` (stale `launching` claims; due scheduled direct campaigns); `CAMPAIGN_LAUNCH_STALE_MS`.
  - `launch-plan.ts`: the plan stage, which writes rows and partitions.
  - `broadcast-transport.ts`: one partition through Zernio broadcasts (import → create with adoption → add → send/schedule with status check).
  - `direct-transport.ts`: claimed pages, `Idempotency-Key`, the 23 h give-up rule.
  - `zernio-budget.ts`: the token bucket (`ZERNIO_CAMPAIGN_RPM`, `CAMPAIGN_DIRECT_RPM`); `withRetryAfter`.
  - `broadcast-status.ts`: `aggregateBroadcastStatus(stats[]) → {status, sent, delivered, read, failed}` (pure).
- `backend/src/integrations/zernio.client.ts`:
  - `listBroadcasts({profileId, status, limit})`
  - `deleteBroadcast(id)`
  - `createWhatsAppBroadcast` takes an optional `headerComponent`
  - `sendTemplateToPhone({accountId, phone, templateName, templateLanguage, templateParams, headerMedia?, idempotencyKey}) → {messageId, conversationId}`, which is `POST /inbox/conversations` with the `Idempotency-Key` header
  - `request()` exposes 429 `Retry-After` as a typed error

  Paths per docs.zernio.com. Each new method gets a spec with a mocked fetch.
- `backend/src/campaigns/campaign-send.service.ts`:
  - `launch` becomes validate + claim + kick, returning 202 (use `@HttpCode(202)` on the route);
  - `cancel` handles `launching`;
  - `syncActive`, `refresh` and `sweepAll` gain the per-`CampaignBroadcast` path (campaigns with broadcast rows), keeping the legacy single-broadcast path byte-for-byte for campaigns without rows;
  - `writeRecipientRows` is removed (replaced by `launch-plan.ts`).
- `backend/src/campaigns/tracking/failure-codes.ts`: `missingValueCode`, `LAUNCH_UNCONFIRMED`. `campaign-export-labels.ts`: labels, including field-label lookup through custom field defs.
- `backend/src/campaigns/campaign-report.service.ts`: `insights.byNumber`; export labels for `skip:missing_value:*`.
- `backend/src/campaigns/campaigns.module.ts`: providers (runner, scheduler); `GET :id` adds `launch` progress. `NotificationsModule` import if it is not global.
- Specs:
  - `backend/src/campaigns/sending/campaign-launch.spec.ts` (acceptance)
  - extend `campaign-sweep.spec.ts`, `campaign-send.service.spec.ts`, `campaign-report.service.spec.ts`, `zernio.broadcasts.spec.ts`

**Produces:**
- A launched campaign moves `draft → launching → scheduled|running → …`, with one `CampaignBroadcast` per partition and one `CampaignRecipient` per member. Queued rows carry `channelId`, `broadcastId` and `templateParams`. Skipped rows carry `skip:*` codes, including `skip:missing_value:<source>.<key>`.
- `GET /campaigns/:id` → `launch: {stage, planned, partitionsTotal, partitionsDone, directSent}` while launching.
- `GET /campaigns/:id/insights` → `byNumber[]`.

- [ ] Write the failing tests:
  - **`missing field uses fallback, missing fallback skips recipient with reason`** (through the runner, against the in-memory Prisma double and a mocked Zernio):
    - varMap `{1: field.name, 2: custom.city (fallback "your city"), 3: custom.service_due (no fallback)}`;
    - a contact without `city` gets "your city";
    - a contact without `service_due` gets a `skipped` row with `failureCode "skip:missing_value:custom.service_due"`, no Zernio call carries their phone, and `Campaign.skipped` counts them;
    - insights' `failures` has a line for that code;
    - the CSV labels it "No value for Service due" / "لا توجد قيمة لـ موعد الخدمة".
  - **`split sends round-robin across senders`**:
    - 3 senders A, B, C and 7 reachable contacts (ids c1…c7) plus 1 opted-out;
    - rows c1→A, c2→B, c3→C, c4→A, c5→B, c6→C, c7→A;
    - the skipped row → A (the primary);
    - three Zernio broadcasts, each created with its own sender's `accountId`, and each receiving exactly its own phones (the `addBroadcastRecipients` call arguments);
    - `byNumber` reports 3/2/2;
    - the preview's `split` for the same draft equals it.
  - **`launch job resumes after crash without double send`** (table-driven; each case injects a throw at one boundary, makes the lease stale, runs `scheduler.sweep(now + 3 min)`, and lets the run finish):
    - (a) during plan, after half the pages: the rows are rebuilt with no duplicates;
    - (b) after `bulkCreateContacts`, before `stage = contacts_imported`;
    - (c) after `createWhatsAppBroadcast` returned, before `zernioBroadcastId` is stored: resume adopts the draft through `listBroadcasts` (marker), and `createWhatsAppBroadcast` is called once in total;
    - (d) after `addBroadcastRecipients` for 2 of 3 pages: re-adding is deduped by the mock, which mirrors Zernio's `skipped`;
    - (e) after `sendBroadcast` succeeded, before `stage = sent`: resume reads `GET /broadcasts/{id}` → `sending`, and `sendBroadcast` is called **exactly once**;
    - (f) direct: after `sendTemplateToPhone`, before `messageId` is stored: resume re-sends with the **same** `Idempotency-Key`, and the mock (which replays by key) records one message per phone;
    - (g) direct: an attempt older than 23 h is marked `failed` `launch:unconfirmed` and not re-sent.

    In every case, at the end each reachable phone received exactly one message (the mock's delivery log), and the campaign is `running` or `scheduled`.
  - `concurrent launch requests start one job`: two `launch` calls in parallel → one 202 and one 409 `campaigns.already_launched`; one runner run.
  - `a stale runner stops after its lease is taken`: runner 1 paused mid-partition while the scheduler claims it; runner 1's next compare-and-set matches nothing, and it makes no further Zernio call.
  - `cancel during launch sends nothing further`: cancel after partition 1 is sent → partition 1 is cancelled, partition 2's draft is deleted, no further sends happen, and the campaign is `cancelled`.
  - `partitions never mix resolved values`: a generated audience of 2 000 with 3 senders and a 4-value custom field gives 12 partitions; every row's `templateParams` equals its partition's `variables` literals on non-native slots. With 40 values: 120 partitions > 25 → direct (≤ 5 000); with 6 000 reachable → `too_varied` failure with `lastError "campaigns.var_map_too_varied"` and zero Zernio send calls.
  - `launch of 100k plans in pages and never inserts more than 1000 rows per call` (mocked): 100 audience pages; maximum `createMany` length 1 000; the runner yields between pages; the HTTP `launch` resolves before planning starts.
  - `zernio budget throttles campaign calls and honours Retry-After`.
  - `transient errors keep the job launching; permanent errors fail it and notify the launcher` (attempts cap).
  - `scheduled direct campaign starts at scheduledAt`.
  - `sweep pages every broadcast of a multi-broadcast campaign and aggregates status`: legacy campaigns without broadcast rows still follow the old path (the existing sweep specs stay green unchanged); `aggregateBroadcastStatus` table test.
  - `direct campaign completes when no queued rows remain, and counters recount from rows`.
  - `insights byNumber sums to totals` (including a null `channelId` shown as `unknown`).
  - `header override is passed as headerMedia on direct sends and as a header component on broadcasts` (ruling 8), with a TTL per ruling 9.
- [ ] Implement until green. Check that every Zernio call in the runner sits behind a lease compare-and-set (a review checklist item in the PR).
- [ ] `npx tsc --noEmit -p tsconfig.json`, the jest paths, then the full `npm test` once.
- [ ] Commit `feat(campaigns): resumable background launch with partitioned broadcasts, direct sends and per-number insights`.

### Task 3: Backend — media library (PDF, sniffing, gallery paging) and template header media
**Depends on:** Task 1 (schema only). It can run in parallel with Task 2: no shared files except `template-header.ts`, which Task 2 only imports.

**Files:**
- `backend/src/media/sniff.ts` (pure; `sniffFamily(head: Buffer) → "jpeg"|"png"|"gif"|"webp"|"mp4"|"pdf"|null`, `familyOfMime`), with a spec.
- `backend/src/media/media.service.ts`:
  - PDF allowed, with the caps;
  - `finalizeUpload` and `ingestBuffer` sniff (read 16 bytes from `file.path` or the buffer);
  - keyed errors (`media.*`) through a new `media-errors.ts` with the same `{statusCode, message: key}` shape;
  - `list(ws, viewer, {kind, before, limit})`;
  - extend-only `mintPublicToken`;
  - `remove` checks in-use (`media.in_use`).
- `backend/src/media/media.controller.ts`: query parsing for `kind`, `before` and `limit`; serving headers (`nosniff`; attachment and `sandbox` CSP for non-image, non-video). The multer `fileSize` limit stays 300 MB.
- `backend/src/integrations/template-header.ts`: `HEADER_LIMITS`, `templates.header_media_too_large`.
- `backend/src/templates/templates.service.ts` and `templates.module.ts` DTO: `headerType`, including `"none"`; `headerMediaId` → `header_handle` URL; store `headerMediaId`. `TemplateRow.headerMediaId`.
- Specs: `media.service.spec.ts`, `media.controller.spec.ts` (new if absent), `template-header.spec.ts`, `templates.service.spec.ts`.

**Produces:**
- `GET /media?kind&before&limit`.
- `Media` rows for PDFs.
- `Template.headerMediaId` set by the editor.
- WhatsApp header limits enforced for inbox template sends and campaigns.

- [ ] Write the failing tests:
  - `media upload sniffs type and accepts PDF`:
    - a real PDF header gives 201 with `mimeType application/pdf`;
    - PNG bytes declared as `application/pdf` give 400 `media.type_mismatch`;
    - a PDF declared as `image/png` gives 400;
    - a 101 MB PDF gives `media.too_large {limit}`;
    - `text/html` gives `media.unsupported_type`;
    - the temp file is deleted on every path.
  - `ingestBuffer sniffs inbound images`.
  - `media list filters by kind and pages by before`: CSV and XLSX import files never appear; restricted-viewer visibility is unchanged (the existing specs stay green).
  - `pdf is served as attachment with nosniff and sandbox CSP`; images stay inline.
  - `public token is extend-only`: a second mint with a shorter TTL keeps the longer expiry and the same token.
  - `media in use cannot be deleted`: referenced by a template header, or by a scheduled campaign → 409 `media.in_use`; a completed campaign does not block.
  - `header media over the WhatsApp limit is refused`: a 6 MB JPEG image header gives `templates.header_media_too_large {limit: 5242880}`; a 17 MB MP4 likewise; a 90 MB PDF passes. Through both `resolveTemplateHeader` callers.
  - `template create with headerMediaId submits header_handle from the library file`: a foreign media id gives 404; a kind mismatch gives `templates.header_media_mismatch`; `headerMediaId` is stored; `headerType "none"` sends no header.
- [ ] Implement until green. Run tsc, the jest paths, and the full `npm test` once.
- [ ] Commit `feat(media): PDF library files, type sniffing, gallery paging and template header media`.

### Task 4: Frontend — sender picker, variable mapping, gating, media picker, Gallery, launch progress and per-number report
**Depends on:** the contracts of Tasks 1–3. It can start from Task 1's contract while Tasks 2 and 3 are in review.

**Files:**
- Create `src/components/media/`:
  - `MediaPicker.tsx`: extracted from `TemplateSendDialog`'s `HeaderMediaPicker`, with no behaviour change there. It adds kind filtering, "Load more" (`before`), and greying out files over the WhatsApp header limit, with the reason.
  - `mediaKinds.ts` (pure): `HEADER_MIMES`, `HEADER_LIMITS`, `mediaMatchesHeader`, `headerIneligibleReason`, `kindOfMime`, `MEDIA_CATEGORIES`.
  - `mediaErrors.ts`: copy for the `media.*` keys and `templates.header_media_too_large`.
  - Tests: `mediaKinds.test.ts`, `mediaErrors.test.ts`.
- `src/screens/inbox/TemplateSendDialog.tsx`: import `MediaPicker` and `mediaKinds`. Its exported `mediaMatchesHeader` and `headerKind` are re-exported for existing imports.
- `src/screens/templates/GalleryTab.tsx`: replaces the placeholder `tab === "media"` block and `MEDIA_ASSETS` in `src/screens/Templates.tsx`. The tab is renamed "Gallery" / "المعرض". It has category chips (all, images, videos, documents), a grid with thumbnails (images), a video or PDF icon with the file name and size, upload (`uploadMedia`), delete (permission-gated, `media.in_use` copy) and "Load more". The `/media` screen (`Media.tsx`) stays.
- `src/screens/templates/TemplateEditor.tsx`: a header section with type none/text/image/video/document; text input with a character counter (60, Meta's limit); `MediaPicker` for media kinds; save sends `headerType`, `headerContent` and `headerMediaId`. Error keys are mapped.
- `src/components/WhatsAppGate.tsx` + `whatsAppGate.ts` (pure copy): a banner, "WhatsApp isn't connected. Connect a number in Channels to send campaigns and submit templates." / "واتساب غير متصل. اربط رقمًا من القنوات لإرسال الحملات وإرسال القوالب للاعتماد.", with a link to `#/channels` when the role has `channels.view`. It is used on Campaigns (list and builder) and Templates (list, editor, library import). Actions that would reach WhatsApp are disabled with the same reason as their `title`. `isWhatsAppNotConnected(err)` maps the 409.
- `src/screens/campaigns/`:
  - `varMap.ts` (pure, replaces `campaignVars.ts`; re-export for any remaining imports): `VarMap` types, `FIELD_SOURCES` with bilingual labels, `defaultVarMap(count)`, `varMapComplete`, `legacyToVarMap`, `renderTemplate(body, values)`, `slotLabel`.
  - `senderModel.ts` (pure): `eligibleSenders`, `showSendFrom` (≥ 2 eligible, or a saved non-default choice), `splitCounts` (the same closed form as the backend), `senderUnavailable`, `isolateLtr`.
  - `SendFromField.tsx`: checkbox list of eligible senders (primary first, re-orderable by "Make primary"); ineligible ones disabled with their reason; the plan limit shown.
  - `VariableMappingField.tsx`: per slot, a source select (Contact field / Custom field / Fixed value), a key select (`/custom-fields` when the role has `contacts.view`, else contact fields and fixed only), and a fallback input. Under it: "N recipients will be skipped: no value for X" from the preview's `missingByKey`.
  - `HeaderMediaField.tsx`: shown when the template has a media header. "Use the template's file" (default) or "Choose another" (`MediaPicker`).
  - `ReviewSamples.tsx`: up to 3 real-contact samples in phone bubbles (fallback values underlined, with a "fallback" tooltip; a skipped sample shows its reason); `templateMissing` and `too_varied` warnings; the per-number split table (largest first; `<bdi>` numbers).
  - `NumberSplitCard.tsx`: the report's per-number table from `insights.byNumber`. It is shown when there is more than one number, or when the campaign's sender is not the default (Tkana's `showNumberTable` rule).
  - `LaunchProgress.tsx`: a "Preparing" state with stage and counts (planned recipients, partitions done/total, direct sent), polling the campaign every 5 s while `launching`, and the stored `lastError` copy on failure.
  - `campaignErrors.ts`: copy for every new `campaigns.*` key, including `template_missing_on_number` naming numbers via `isolateLtr`. `failureCodes.ts`: `skip:missing_value:*` (with field labels passed in), `launch:unconfirmed`.
  - Tests: `varMap.test.ts`, `senderModel.test.ts`, extend `campaignErrors.test.ts`, `failureCodes.test.ts`, `campaignDetailModel.test.ts`.
- `src/screens/Campaigns.tsx`:
  - the builder's Message step uses `VariableMappingField` and `HeaderMediaField`; a new "Send from" field sits in the Audience step;
  - draft save PATCHes `senderChannelIds`, `varMap` and `headerMediaId`;
  - Review uses `POST /campaigns/preview` and `ReviewSamples`;
  - launch handles 202 → "Preparing your campaign…" / "جارٍ تجهيز حملتك…";
  - the list shows `launching` with its label and progress;
  - `canLaunch` also requires `connected`, no `templateMissing`, and a transport other than `too_varied`.
- `src/screens/campaigns/CampaignDetail.tsx`: `NumberSplitCard`, `LaunchProgress`, and the sender name from `campaign.senders` (gap 3 closed; no `/channels` call).
- `src/lib/types.ts`: `VarMap`, `VarSlot`, `CampaignSender`, `SendersResponse`, `CampaignPreviewV2`, `CampaignLaunchProgress`, `NumberTotals`. `Campaign` gains `senderChannelIds`, `varMap`, `headerMediaId`, `launchStage`, `senders`, `launch`. `Template` gains `headerMediaId`. `CampaignInsights` gains `byNumber`.
- Permission gating with `usePermissions().can(...)`:
  - launch: `campaigns.manage`;
  - draft: `campaigns.create|update`;
  - the custom-field picker: `contacts.view`;
  - Gallery upload: `conversations.create`; delete: `conversations.update` (as the existing map);
  - template header: `templates.create|update`.

  Hidden actions are not rendered. A 403 shows the shared no-permission toast.

**Produces:**
- The full flow in English and Arabic: pick numbers → map variables with fallbacks → optional header file → review real samples and the split → launch → progress → report with the per-number table.
- The Templates screen: Gallery tab, and header media in the editor.

- [ ] Write the failing vitest tests:
  - `varMap resolves preview from sample contact with fallback` (the rendering helper only; the decision stays on the backend)
  - `legacy variables convert to varMap`
  - `round-robin split counts match backend formula` (the same table as the backend spec)
  - `showSendFrom hides the picker for one number unless a non-default choice is saved`
  - `failureLabel renders missing value with field label in both languages`
  - `whatsapp gate copy for every marketing action`
  - `mediaMatchesHeader enforces WhatsApp header limits`
  - `campaign error copy covers every SP-13 key in both languages`
  - `launching campaigns poll every 5 seconds and stop when launched`

  Then implement until they pass, then build the components.
- [ ] `npx vitest run`, `npm run typecheck` and `npm run build` clean.
- [ ] Commit `feat(campaigns): send-from numbers, variable fallbacks, WhatsApp gating, media picker, gallery and launch progress`.

### Task 5: Verification
Apply `20261113120000_campaign_recipients` and `20261114120000_campaign_sending` with `npx prisma migrate deploy`, and only when the controller and the user approve (ruling 20). Both are safe for `main` (Global Constraints). Record results in `.superpowers/sdd/2026-11-13-sp13-campaign-sending/live-verification.md`, in the format of SP-19's `live-verification.md`: summary, a results table with evidence, DB-side checks, findings and cleanup.

**Isolation** (as in SP-12 Task 4; no repo code changed):
- **Own instance:** backend on **:4220**, compiled with `tsc -p tsconfig.build.json` into a throwaway outDir in the scratchpad and started with `node`. The user's :4100 process is not touched.
- **Crons:** all `@nestjs/schedule` jobs are disabled. The launch scheduler and the sweep are driven explicitly: a script boots a Nest application context from the outDir and calls `CampaignLaunchScheduler.sweep(now)` and `POST /campaigns/:id/refresh`.
- **Provider keys:** set to **empty strings**, not deleted (SP-19 finding E2). This covers Meta, HJZ, Kewy, L, the AI keys, Pipeboard and Stripe. DO Spaces is empty too, so media uses local storage under the throwaway outDir's `uploads`.
- **No real WhatsApp send, ever:**
  - `ZERNIO_BASE_URL=http://127.0.0.1:<stubPort>` and `ZERNIO_API_KEY=zz-verify-stub`, pointing at a stub HTTP server in the scratchpad (`zernio-stub.js`).
  - The stub implements SP-12's endpoints, plus:
    - `GET /broadcasts?profileId&status`
    - `DELETE /broadcasts/:id`
    - `GET /whatsapp/templates?accountId` (per-account lists; one account deliberately lacks the template, and one holds a different copy)
    - `POST /inbox/conversations`, which **replays by `Idempotency-Key`** and keeps a delivery log keyed by phone
  - Every send-like call is logged.
  - The launcher script refuses to start unless `ZERNIO_BASE_URL` begins with `http://127.0.0.1` and `ZERNIO_API_KEY` equals `zz-verify-stub`. Before cleanup, it asserts that the stub's log holds every Zernio call the run made.
- `ZERNIO_WEBHOOK_SECRET` is a test value, so replayed webhooks can be signed.
- For the crash test: `CAMPAIGN_LAUNCH_STALE_MS=5000`, `ZERNIO_CAMPAIGN_RPM=6000`, and `CAMPAIGN_MAX_PARTITIONS` / `CAMPAIGN_DIRECT_MAX` lowered so both transports run at test scale (recorded in the notes).
- Test tag: `zz-verify-<ts>` on every name and email.

**Setup** (writes only rows tagged with the test tag):
1. Register an owner and a foreign owner, then invite an agent and a viewer.
2. Insert three `Channel`s (`kind whatsapp`, `provider zernio`, `externalId zz-verify-acc-{a,b,c}-<ts>`, `status active`, A `isDefault`), plus one Meta channel (ineligible).
3. Set the workspace's `zernioProfileId`.
4. Insert an approved `Template` with `{{1}} {{2}} {{3}}` and an IMAGE header.
5. Insert `CustomFieldDef` rows `city` (text) and `service_due` (date, with an Arabic label).
6. Create 1 210 contacts:
   - 1 200 reachable, with a mix of cities (4 values), some without `city`, some without `service_due`, and Arabic names;
   - 4 opted out;
   - 3 with no phone;
   - 3 that repeat a phone.
7. Create a segment holding everyone.
8. Upload through `POST /media/upload` a real PNG, a real PDF, and a PNG renamed `.pdf`.

**Checks:**
- **Gating:** before the channels exist, launch, template create and the library lookup each return 409 `campaigns.whatsapp_not_connected` with `code`; preview returns `connected:false`; `GET /campaigns/senders` returns `connected:false`.
- **Senders:** `GET /campaigns/senders` lists A, B and C as eligible and the Meta channel as `provider_meta`. A foreign channel id gives 400 `channels.sender_invalid`. Over the plan limit gives `too_many_senders`.
- **Template per number:** with sender C lacking the template, the preview's `templateMissing` is `[C]` and launch returns 400 `template_missing_on_number`. Drop C.
- **Preview:** the split equals `splitCounts`; `missingByKey` counts `service_due`; the samples are real contacts with a fallback used; an agent without `contacts.view` (role adjusted for the test) gets no samples.
- **Broadcast launch** (`city` with fallback; `service_due` without one):
  - 202 in under 1 s;
  - `launching`, then `running`;
  - rows: queued = reachable minus missing-value; skipped with `skip:opted_out`, `skip:no_phone` and `skip:missing_value:custom.service_due`; no row for duplicates;
  - round-robin A/B by id order;
  - partitions = senders × distinct cities (plus the fallback value);
  - the stub shows each phone added to exactly one broadcast, with that partition's literals;
  - `sendBroadcast` once per broadcast.
- **Crash and resume (live):** launch a second campaign; kill the :4220 process when the stub has logged `sendBroadcast` for partition 1 but before partition 2 starts; restart; wait more than 5 s; run `scheduler.sweep`. The stub log shows **no second `sendBroadcast`** for partition 1, no second `createWhatsAppBroadcast` for any partition, and every phone sent once. Repeat with the kill right after a `POST /broadcasts` returns (adoption path).
- **Direct transport:** a third campaign with a high-cardinality custom value (lowered caps). Kill mid-sends, restart and resume. The stub's delivery log has exactly one message per phone, and the replayed `Idempotency-Key`s are logged. Rows carry `messageId`. A replayed `message.delivered` webhook moves one row to `delivered`.
- **Concurrency and cancel:** two parallel launch calls give one 202 and one 409. Cancel during launching: partition 2 is deleted in the stub, and no further sends happen.
- **Report:** `insights.byNumber` sums equal the funnel; the failure lines include the missing-value code with its Arabic label in an `ar` CSV export; the "Sending number" column is correct.
- **Media:** the PNG renamed `.pdf` gives 400 `media.type_mismatch`; the PDF gives 201 and is served as an attachment with `nosniff`; `GET /media?kind=document` lists it; a 6 MB image as a header gives `header_media_too_large`; deleting the header image of a scheduled test campaign gives 409 `media.in_use`.
- **Template header:** create a template with an image header from the library. The stub receives `header_handle` with a fetchable local public URL, and `headerMediaId` is stored.
- **Permissions and tenancy:**
  - the foreign owner gets 404 on `GET/PATCH/launch/cancel` for the test campaign and on its media;
  - an agent can preview and view senders;
  - a viewer cannot launch;
  - an impersonated session cannot launch (403 `impersonation`).
- **Index use:** `EXPLAIN` (no `ANALYZE` writes), each inside `BEGIN; SET LOCAL enable_seqscan = off; … ROLLBACK;`, for:
  - the stale-launch query (`Campaign_status_launchHeartbeatAt_idx`);
  - partition keyset paging (`CampaignRecipient_broadcastId_status_id_idx`);
  - the `byNumber` group-by (`CampaignRecipient_campaignId_channelId_status_idx`);
  - the broadcast lookup (`CampaignBroadcast_zernioBroadcastId_idx`).
- **Migration rerun:** execute both migration SQL files again inside a transaction that is always rolled back. 0 rows changed; no errors.
- **UI through the `verify` skill:**
  - the builder in English and Arabic (RTL): send-from with the split, variable mapping with fallbacks and the skip notice, header file choice, review samples, the gating banner (on a second test workspace with no channel);
  - launch progress;
  - the report's per-number card;
  - the Templates Gallery tab (filter, upload PDF, load more) and the template editor header picker;
  - screenshots.
- **Cron window (SP-12 R14):** the stub reports each broadcast `completed` right after send, and `refresh` moves test campaigns out of `running` within seconds.

**Cleanup:**
- Delete only the recorded test rows: the workspaces (cascade covers campaigns, broadcasts, recipients, contacts, channels, custom fields, templates and media rows), then the users. Remove the throwaway `uploads` directory.
- Run a residue sweep over every table with a `workspaceId` column, including `CampaignBroadcast` and `CampaignRecipient`.
- Read-only counts before and after: `Workspace`, `Campaign`, `CampaignBroadcast`, `CampaignRecipient`, `Contact`, `CustomFieldDef`, `Channel`, `Template`, `Media`, `Message`, `Conversation`, `User`.
- Stop the :4220 process and the stub, and remove the outDir.

Then tick SP-13's "Detailed plan written" and "Shipped" boxes in the roadmap, noting the deviations and rulings taken. Add the deferred items to the roadmap: per-number template management (SP-14), the contact-number sender mode (ruling 15), and per-number tier in the picker (SP-14).
