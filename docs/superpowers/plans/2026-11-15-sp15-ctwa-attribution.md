# SP-15 Click-to-WhatsApp Ad Attribution and Meta Ads Connect: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- **Capture the ad referral.** When a customer reaches a WhatsApp number from a Click-to-WhatsApp (CTWA) ad, Meta attaches a `referral` object to the first message after the click. We capture it on both WhatsApp paths, Zernio and Meta-direct. The ad is stored once per workspace (`AdSource`). Every referral-bearing message becomes one `AdReferral` touch. The conversation keeps its **first** ad as `Conversation.adSourceId`, which later messages never overwrite (roadmap acceptance `referral captured only on first inbound`). A field Meta does not send stays null (roadmap rule: never fake attribution data).
- **Ads tab.** A new "Ads" screen shows conversations started, spend, cost per conversation and a daily chart over a date range, plus one card per ad. A per-ad page lists the ad's conversations (permission-scoped) and links into the inbox. Spend comes only from a connected Meta ad account. Without one, spend and cost read **Unknown**, never 0. Cost per conversation is `spend / started`, and is null when nothing started (acceptance `cost per conversation = spend / started (0 started → null)`).
- **Inbox (carried from SP-01).** Each conversation row and the thread header show an attribution chip when the conversation came from an ad. The SP-01 filter menu gains the deferred **Ad source** filter (any ad, no ad, or specific ads), kept in the URL hash.
- **Meta Ads connect.** An owner or admin connects Meta Ads through Facebook Login for Business (OAuth), chooses one ad account and optionally one Page, checks the connection, and disconnects. The token is stored encrypted with `TOKEN_ENC_KEY` (acceptance `token stored encrypted (token-crypto.ts)`, SP-19 R5 pattern) and never logged or returned.
- **Spend sync.** An hourly, bounded, idempotent, re-entrancy-guarded scheduler reads daily ad-level spend from the Marketing API. The first sync covers 90 days; later syncs re-read the last 3 days. A token Meta refuses moves the connection to `needs_reconnect` and sends one `connector_needs_attention` notification.
- **Lead-form data on the contact (carried from SP-02; droppable section, ruling 9).** Leads from the connected Page's Instant Forms are imported hourly and shown on the contact. A contact is matched by phone, then by email, and otherwise created.

**Architecture:**
- **Where the referral arrives (checked in public docs on 2026-11-10; read-only, no API call).**
  - **Meta-direct** (`developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/text.md`): `entry[].changes[].value.messages[].referral` = `{source_url, source_id, source_type: "ad"|"post", body, headline, media_type: "image"|"video", image_url (image ads), video_url, thumbnail_url (video ads), ctwa_clid (omitted for WhatsApp Status placements), welcome_message: {text}}`. It is "only included if message sent via a Click to WhatsApp ad". The same object appears on every message type (text, image, …).
  - **Zernio** (`docs.zernio.com/platforms/whatsapp/ctwa.mdx`, `webhooks/inbox/message-received.mdx`, `webhooks/inbox/referral-received.mdx`): "`message.received` carries it as `metadata.ad` next to the verbatim `metadata.referral`". `metadata.ad` is Zernio's `adAttribution` `{adId, name, synced, campaignId, campaignName, adSetId, adSetName, adAccountId, adAccountName, platformPostId, isExternal}`. "When the ad is not synced, `synced` is false and `name` falls back to Meta's headline." The same object arrives on `conversation.started`, which we already route to `ingestInbound`. `referral.received` (a referral without a message) is Instagram/Messenger only.
    - **Unverified:** the docs place `metadata` at the payload root, but SP-12 reads `message.metadata` for button payloads. The parser reads `evt.metadata ?? evt.message?.metadata` (ruling 2).

  | Attribution field | Meta-direct | Zernio | Stored as |
  |---|---|---|---|
  | Ad id | `referral.source_id` | `metadata.referral.source_id` (fallback `metadata.ad.adId`) | `AdSource.sourceId` (required; a referral without it is logged and dropped) |
  | Source type | `referral.source_type` | same | `AdSource.sourceType` (`ad` / `post`; other `^[a-z_]{1,32}$` values kept verbatim) |
  | Headline, body | `headline`, `body` | same | `AdSource.headline`, `body` (null when absent) |
  | Media | `media_type`, `image_url` / `thumbnail_url`, `video_url` | same | `mediaType`, `mediaUrl` (Meta's signed link, expires in days), `mediaId` (our re-hosted copy, ruling 6) |
  | Ad link | `source_url` | same | `AdSource.sourceUrl` |
  | Greeting | `welcome_message.text` | same | `AdSource.welcomeText` |
  | Click id | `ctwa_clid` (absent on Status placements) | same | `AdReferral.ctwaClid` (null when absent; never displayed) |
  | Ad, ad set and campaign names | **not sent** (Marketing API sync only) | `metadata.ad.name` etc. **only when `synced: true`** | `AdSource.adName`, `adSetName`, `campaignName` + `namesFrom: "zernio" \| "meta_sync"`; otherwise null (ruling 3) |
  | Ad account | **not sent** (sync only) | `metadata.ad.adAccountId` when `synced: true` | `AdSource.adAccountId` |
  | Spend | **never in a referral** | **never in a referral** | `AdSpendDaily`, from the Marketing API only |

- **Capture: one service, two callers** (`backend/src/ad-attribution/`).
  - `referral.ts` (pure) has `parseMetaReferral(raw)` and `parseZernioReferral(evt)`. Both return `NormalizedReferral | null`, validate types and caps (headline ≤ 512, body ≤ 4 000, URLs `https:` and ≤ 2 048, `ctwaClid` ≤ 512), and never invent a value.
  - `AdReferralService.capture({workspaceId, channelId, conversationId, contactId, messageId, provider, referral, at})` runs **after** the inbound `Message` row exists and **never throws** into the webhook path (errors are logged without the payload). It:
    1. upserts `AdSource` by `(workspaceId, sourceType, sourceId)`. It fills only null creative fields (never overwrites a known value with null) and moves `firstReferredAt`/`lastReferredAt`;
    2. inserts `AdReferral` with `messageId` unique, so a redelivery is a no-op (`ON CONFLICT DO NOTHING`);
    3. sets the conversation's first touch with `updateMany({where: {id, workspaceId, adSourceId: null}, data: {adSourceId, adReferredAt}})`. Only the first referral wins, also under a race. `AdReferral.firstTouch` records whether this touch set it;
    4. queues the creative re-host (ruling 6) without awaiting it.
  - Callers: `ZernioService.ingestInbound` (inbound only, not `message.sent` echoes) and `WhatsAppService.ingestInbound` (Meta-direct). `InboundSinkService` (Telegram, web chat) receives no referrals and is untouched. Instagram/Messenger ad referrals are deferred (ruling 4).
- **Metrics** (`ads-metrics.service.ts`, read-only SQL, workspace-scoped):
  - `started(ad, range)` = `COUNT(DISTINCT conversationId)` of `AdReferral` rows for the ad with `referredAt` in the range. A returning customer who clicks the same ad twice in the range counts once; one who clicks a different ad counts for both (ruling 1).
  - `spend(ad, range)` = `SUM(AdSpendDaily.spend)` over the range's days. It is **null** when no connection is `active`, or the ad is not in the connected ad account.
  - `costPerConversation = started > 0 && spend !== null ? round4(spend / started) : null`.
  - **Totals per currency, never summed across currencies.**
  - **Days:** referral days are bucketed in the ad account's timezone when connected, else the workspace timezone. Spend days are Meta's `date_start` (account-local) (ruling 8).
- **Meta Ads connect** (`backend/src/meta-ads/`):
  - **Start.** `GET /meta-ads/oauth/start` returns the Login for Business dialog URL (`https://www.facebook.com/<v>/dialog/oauth?client_id&redirect_uri&config_id&response_type=code&state`). `state` is a 10-minute JWT `{workspaceId, userId, nonce, purpose: "meta_ads_oauth"}`, as `FacebookController.oauthStart` builds it.
  - **Callback.** `GET /meta-ads/oauth/callback` (public):
    - It verifies `state`. Purpose, expiry and **that `userId` still holds `connectors.manage` in `workspaceId`** are checked through `PermissionService.effective`.
    - It exchanges the code through Graph (`/oauth/access_token`, base `metaGraphBase()`) and stores the token encrypted in `pendingTokenEnc` (it never touches `tokenEnc`, so cancelling a "Change" keeps the working connection).
    - It redirects to `${FRONTEND_PUBLIC_URL}/#/ads?tab=connection&metaAds=choose|error&code=<key>`. The redirect carries an error **key**, never Meta's text.
  - **Choose.** `GET /meta-ads/candidates` lists the ad accounts (`/me/adaccounts?fields=id,name,currency,timezone_name,account_status`) and Pages (`/me/accounts?fields=id,name`) the pending token reaches.
  - **Save.** `POST /meta-ads/connection {adAccountId, pageId|null}` checks both ids against a fresh candidates read (400 `meta_ads.unknown_asset {ids}`), promotes `pendingTokenEnc → tokenEnc` in one conditional update (409 `meta_ads.connection_changed` if the pending token changed meanwhile), sets `status = active`, and schedules the first sync.
  - **Check.** `POST /meta-ads/check` makes 2 Graph reads (`/me?fields=id`, `/<act>?fields=name,account_status,currency,timezone_name`). It is rate-limited to 1 per minute per workspace, DB-backed on `checkAttemptedAt`.
  - **Disconnect.** `DELETE /meta-ads/connection` nulls both token columns and sets `status = disconnected`. Stored spend and leads are kept but no longer shown as current (ruling 10). It makes no Graph call.
  - **Every Graph call** sends `appsecret_proof` (HMAC-SHA256 of the token with the app secret), uses `metaGraphBase()` (SP-14: only `graph.facebook.com` or loopback), a 15 s timeout, and the version `META_ADS_GRAPH_VERSION`, else `graphVersion()` (ruling 12). An error keeps only Graph's `code`, `error_subcode`, HTTP status and `fbtrace_id`. Message text that may echo a URL is never stored or logged, and a URL with `access_token=` is never logged.
- **Spend sync** (`meta-ads-sync.scheduler.ts`, `@Cron(EVERY_HOUR) sweep(now)`):
  - **Selection:** `status = 'active'` connections whose `syncAttemptedAt` is null or older than `META_ADS_SYNC_INTERVAL_MS` (default 55 min), at most `META_ADS_SYNC_BATCH` (default 20) per tick, sequentially; the tick stops after `META_ADS_SYNC_MAX_MS` (10 min).
  - **Claim:** a raw-SQL claim on `syncAttemptedAt`, plus an in-process `running` flag (SP-14 pattern).
  - **Read:** `GET /<act>/insights?level=ad&time_increment=1&fields=ad_id,ad_name,adset_name,campaign_name,spend,date_start&time_range={since,until}&limit=500`, following `paging.next` up to `META_ADS_MAX_PAGES` (default 40). A capped read is `partial` and writes nothing for the days it may be missing. Window: the first run covers 90 days in 7-day windows (`spendBackfilledAt` set when all windows finished); later runs cover the last 3 days (Meta restates recent days).
  - **Write:** upsert `AdSource` by `(workspaceId, "ad", ad_id)`. Only names (`namesFrom = "meta_sync"`) and `adAccountId` are set; creative fields stay as captured, or null. Then upsert `AdSpendDaily` by `(adSourceId, date)` with Meta's `spend` string parsed into `Decimal(14,4)` and the account's `currency`.
  - **Errors:** never retried within a run (failed calls count against Meta's access tier).
    - Graph 190 (or 102, 463, 467): `needs_reconnect` + one notification.
    - Rate limit (4, 17, 32, 613, 80000–80014, or HTTP 429): stop and resume next tick.
    - Permission or asset refusal (10, 200–299, 100 with an asset subcode): `needs_reconnect {reason: "account_refused"}` + one notification.
    - Anything else: `lastSyncError` key `sync_failed`, kept `active`.
- **Lead forms** (`meta-leads.sync.ts`, after spend in the same claimed run; only when `pageId` is set and ruling 9 keeps it):
  - **Reads:** the Page token comes from `GET /<page>?fields=access_token`. It is held in memory for the run only and never stored or logged. Then `GET /<page>/leadgen_forms?fields=id,name,status`, and for each form `GET /<form>/leads?fields=id,created_time,ad_id,form_id,field_data&filtering=[{field:"time_created",operator:"GREATER_THAN",value:<checkpoint>}]`.
  - **Bounds:** at most `META_LEADS_PAGE_BUDGET` (100) Graph pages per run. Checkpoints per form are kept in `MetaAdsConnection.leadCheckpoints`.
  - **Import:** `MetaLead` unique `(workspaceId, leadgenId)`. A lead is matched to a contact by `normalizePhone(phone_number)`, then by lowercased `email`. Otherwise a contact is created with `source: "meta_lead_form"`, the name from `full_name` or `first_name + last_name`, else the phone or email.
  - **Never invented:** consent, lifecycle beyond `lead`, or any field not in `field_data`. An existing contact's fields are never overwritten (ruling 9).
  - `adId` links to `AdSource` when one exists in the workspace.
  - `field_data` is personal data: it is never logged.
- **Notifications** (`meta-ads-notifier.ts`): on a transition `active → needs_reconnect` only (a conditional update returns the row; the winner notifies), type `connector_needs_attention`, title `meta_ads.needs_reconnect`, body `{reason: "token_refused" | "account_refused", adAccountName}`. Recipients come from `PermissionService.membersWith(ws, "connectors.manage")` (SP-14 Task 2). Deep link `#/ads?tab=connection` through SP-14's `notificationHref`.

**Tech Stack:** NestJS 10, Prisma 5 (Postgres/Neon), jest/ts-jest, `@nestjs/schedule`; React 18 + Vite, vitest. **No new dependencies** (the daily chart is hand-drawn SVG).

**Spec:** roadmap §SP-15, plus the cross-cutting Global Constraints. Carried scope:
- **SP-01:** "advanced filter menu (… ad source* …) … ad source with SP-15" → the Ad source filter in `src/screens/inbox/inboxFilters.ts`, `inboxHash.ts` and `InboxFilterMenu.tsx`; roadmap §4 "Inbox | number tabs, CTWA chip/filter | SP-19, SP-15".
- **SP-02:** "Meta lead-form data on the contact (visible once SP-15 captures it)" → the lead-forms card on `ContactDetailDrawer.tsx`.
- **SP-19 contracts:**
  - `ChannelResolver.forInbound`, `findOrAdoptConversation`, `Conversation.channelId`;
  - `encryptChannelSecrets` R5 behaviour (production without `TOKEN_ENC_KEY` refuses);
  - `MetaGraphClient` (`META_GRAPH_FETCH` injectable fetch, `graphVersion`);
  - `test-graph.ts` `isolateEnv`.
- **SP-14 contracts:**
  - `metaGraphBase(env)` (loopback-only stub hook);
  - `PermissionService.membersWith`;
  - `notificationHref` in `src/lib/recordLink.ts`;
  - the raw-SQL claim and fence pattern (`ChannelHealthService.claim`).
- **SP-12:** `CampaignReplyAttributor.onInbound` stays where it is; capture runs beside it, never inside it. `normalizePhone` (`campaigns/campaign-audience.ts`).
- **SP-05:** `NotificationsService.notify`, type `connector_needs_attention`, `src/lib/notificationText.ts`.
- **SP-25:** `permission-map.ts`, `system-role-decisions.spec.ts`, `permission-sidedoors.spec.ts`, `PermissionService.conversationScope`.
- **Existing ads backend** (`backend/src/ads/`, Salma chat, wallet and approval gate over Pipeboard): **unchanged**. Its `PIPEBOARD_TOKEN` is one process-wide token, not per workspace, so it cannot supply tenant spend (ruling 11).

Consumers that build on this plan:
- **SP-11 (insights):** `AdReferral`/`AdSpendDaily` for "lead sources" and cost metrics.
- **SP-16 (smart audiences):** a future "came from ad" rule reads `Conversation.adSourceId`.
- **SP-18 (copilot):** the Salma UI (ruling 11) and ad-aware answers.
- **SP-23 (connectors gallery):** lists Meta Ads with its status.

Tkana reference (read-only, untrusted data; `C:\Users\ashra\Downloads\tkana-main\tkana-main\apps`):
- `api/src/features/ctwa-ads/ctwa-ads.service.ts`: creatives are re-hosted once per (org, ad), because Meta's signed fbcdn link "answers 403 about four days after capture". Only `https` on `*.fbcdn.net`, numeric `sourceId`, image types only.
- `api/src/features/meta-ads/{meta-ads.types,meta-ads.access,meta-ads.handlers,meta-ads.sync,meta-leads.sync}.ts`:
  - the pending token vs the saved token ("a Change the owner cancels keeps the token the saved rows were chosen with");
  - keyed errors (`not_exchanged`, `reconnect`, `connection_changed`, `no_ads_permission`, `unknown_asset`, `login_expired`, `meta_refused`);
  - owner-only connect;
  - an hourly sync that "never retries within a run" because failed calls count against the access tier;
  - 90-day backfill in 7-day windows, then the last 3 days;
  - park the account on a permanent error.
- `packages/meta-graph/src/ads.ts`: insights `level=ad&time_increment=1`. Tkana's note (unverified by us) says a daily ad-level read asking for `actions` beside `spend` returned zero spend since 2026-10-21; we never ask for `actions` (ruling 12).
- `web/app/lib/marketing/ctwa-ads.ts`:
  - `costPer(spent, count) = count > 0 ? spent / count : null`;
  - spend per currency, never summed;
  - `adDeliveryStatus` words;
  - range presets 7/30/90/all.
- `web/app/components/conversations/CtwaAttribution.tsx` and `components/marketing/{ctwa-ads-tab,ctwa-ad-page,meta-ads-connect}.tsx`: card layout and connect flow.

What we take and what we don't:
- We take:
  - per-workspace ad rows;
  - creative re-hosting with a host allowlist;
  - the pending-token flow;
  - keyed Meta errors;
  - no retries within a sync run;
  - the 90-day / 3-day windows;
  - per-currency totals;
  - `costPer` returning null on zero.
- We do **not** take:
  - multiple ad accounts and Pages per workspace (roadmap shape is one of each; deferred, ruling 10);
  - plan entitlements (`ads.meta` in paid plans; we have no entitlement layer);
  - "new customers", "replied", "went quiet", "came back", tickets and bookings per ad (SP-11);
  - ad delivery status (`effective_status` needs a second `/ads` read; deferred);
  - Conversions API events back to Meta (Zernio's `POST /v1/whatsapp/conversions`; deferred);
  - Instagram/Messenger ad referrals (ruling 4);
  - the Salma chat UI (ruling 11).

## Global Constraints
- **Data (exact names; later SPs build on them):**
  ```
  /// SP-15: one ad (or boosted post) per workspace, from a referral or the spend sync.
  model AdSource {
    id              String    @id @default(cuid())
    workspaceId     String
    workspace       Workspace @relation("WorkspaceAdSources", fields: [workspaceId], references: [id], onDelete: Cascade)
    sourceId        String    // Meta ad id (referral.source_id / insights ad_id)
    sourceType      String    // "ad" | "post" (others verbatim)
    headline        String?
    body            String?
    mediaType       String?   // "image" | "video"
    mediaUrl        String?   // Meta's signed creative link as received (expires within days)
    mediaId         String?   // our re-hosted copy (ruling 6)
    media           Media?    @relation("AdSourceMedia", fields: [mediaId], references: [id], onDelete: SetNull)
    sourceUrl       String?
    welcomeText     String?
    adAccountId     String?   // "act_…" once known (Zernio synced attribution or the spend sync)
    adName          String?
    adSetName       String?
    campaignName    String?
    namesFrom       String?   // "zernio" | "meta_sync"; null = no names known
    firstReferredAt DateTime?
    lastReferredAt  DateTime?
    createdAt       DateTime  @default(now())
    updatedAt       DateTime  @updatedAt

    conversations Conversation[] @relation("ConversationAdSource")
    referrals     AdReferral[]
    spend         AdSpendDaily[]
    leads         MetaLead[]

    @@unique([workspaceId, sourceType, sourceId])
    @@index([workspaceId, lastReferredAt])
    @@index([workspaceId, adAccountId])
  }

  /// SP-15: one referral-bearing inbound message (a "conversation started" touch).
  model AdReferral {
    id             String       @id @default(cuid())
    workspaceId    String
    workspace      Workspace    @relation("WorkspaceAdReferrals", fields: [workspaceId], references: [id], onDelete: Cascade)
    adSourceId     String
    adSource       AdSource     @relation(fields: [adSourceId], references: [id], onDelete: Cascade)
    conversationId String
    conversation   Conversation @relation("ConversationAdReferrals", fields: [conversationId], references: [id], onDelete: Cascade)
    contactId      String
    channelId      String?
    messageId      String       @unique // our Message.id; redelivery-safe
    message        Message      @relation("MessageAdReferral", fields: [messageId], references: [id], onDelete: Cascade)
    provider       String       // "zernio" | "meta"
    ctwaClid       String?      // null when Meta omits it (WhatsApp Status placements)
    firstTouch     Boolean      @default(false)
    referredAt     DateTime

    @@index([workspaceId, adSourceId, referredAt])
    @@index([workspaceId, referredAt])
    @@index([conversationId])
  }

  /// SP-15: Meta-reported spend per ad per account-local day.
  model AdSpendDaily {
    id          String    @id @default(cuid())
    workspaceId String
    workspace   Workspace @relation("WorkspaceAdSpendDaily", fields: [workspaceId], references: [id], onDelete: Cascade)
    adSourceId  String
    adSource    AdSource  @relation(fields: [adSourceId], references: [id], onDelete: Cascade)
    adAccountId String
    date        DateTime  @db.Date
    spend       Decimal   @db.Decimal(14, 4)
    currency    String    // ISO 4217, the ad account's
    syncedAt    DateTime

    @@unique([adSourceId, date])
    @@index([workspaceId, adAccountId, date])
  }

  /// SP-15: one Meta Ads connection per workspace. Token columns never leave the backend.
  model MetaAdsConnection {
    id                String    @id @default(cuid())
    workspaceId       String    @unique
    workspace         Workspace @relation("WorkspaceMetaAdsConnection", fields: [workspaceId], references: [id], onDelete: Cascade)
    status            String    @default("pending") // pending | active | needs_reconnect | disconnected
    statusReason      String?   // key: token_refused | account_refused | …
    tokenEnc          String?   // encryptSecret(token); roadmap name
    tokenExpiresAt    DateTime? // null = non-expiring (system-user token)
    pendingTokenEnc   String?
    pendingExpiresAt  DateTime?
    scopes            String?   // CSV of granted permissions (from debug/permissions read)
    adAccountId       String?   // "act_…"; roadmap name
    adAccountName     String?
    currency          String?
    timezone          String?   // IANA, from timezone_name
    pageId            String?   // roadmap name
    pageName          String?
    connectedById     String?
    connectedBy       User?     @relation("MetaAdsConnectedBy", fields: [connectedById], references: [id], onDelete: SetNull)
    connectedAt       DateTime?
    lastSyncedAt      DateTime?
    lastSyncError     String?   // key only
    syncAttemptedAt   DateTime? // claim token + cadence (raw SQL)
    spendBackfilledAt DateTime?
    checkAttemptedAt  DateTime? // check cooldown (raw SQL)
    leadCheckpoints   Json?     // {formId: ISO created_time}
    createdAt         DateTime  @default(now())
    updatedAt         DateTime  @updatedAt

    @@index([status, syncAttemptedAt])
  }

  /// SP-15: one Instant Form submission (ruling 9).
  model MetaLead {
    id          String    @id @default(cuid())
    workspaceId String
    workspace   Workspace @relation("WorkspaceMetaLeads", fields: [workspaceId], references: [id], onDelete: Cascade)
    leadgenId   String
    formId      String
    formName    String?
    pageId      String
    adId        String?
    adSourceId  String?
    adSource    AdSource? @relation(fields: [adSourceId], references: [id], onDelete: SetNull)
    contactId   String?
    contact     Contact?  @relation("ContactMetaLeads", fields: [contactId], references: [id], onDelete: Cascade)
    fieldData   Json      // [{name, values: string[]}] verbatim
    createdTime DateTime  // Meta's created_time
    importedAt  DateTime  @default(now())

    @@unique([workspaceId, leadgenId])
    @@index([workspaceId, contactId])
  }

  model Conversation {
    // … existing fields unchanged …
    /// SP-15: the first ad that started this thread. Set once, never overwritten.
    adSourceId   String?
    adSource     AdSource?    @relation("ConversationAdSource", fields: [adSourceId], references: [id], onDelete: SetNull)
    adReferredAt DateTime?
    adReferrals  AdReferral[] @relation("ConversationAdReferrals")

    @@index([workspaceId, adSourceId])
  }
  ```
  - Back-relations are added on `Workspace`, `Media` (`adSources AdSource[] @relation("AdSourceMedia")`), `Message` (`adReferral AdReferral? @relation("MessageAdReferral")`), `Contact` (`metaLeads MetaLead[] @relation("ContactMetaLeads")`) and `User` (`metaAdsConnections MetaAdsConnection[] @relation("MetaAdsConnectedBy")`). These are Prisma-only and have no SQL.
  - **Roadmap names kept:** `AdSource {id, workspaceId, sourceId, sourceType, headline, body, mediaUrl, adAccountId?}`, `Conversation.adSourceId`, `AdSpendDaily {adSourceId, date, spend, currency}`, `MetaAdsConnection {workspaceId, tokenEnc, adAccountId, pageId}`. Everything else is additive (ruling 1).
  - **Why `AdSource` rows come from the sync too:** an ad that spent and never started a conversation still needs a row for `AdSpendDaily.adSourceId`. Such a row holds only what Meta's insights returned (names, account). Its creative fields stay null until a referral arrives.
- **DTOs:**
  - `ConversationDto` (the `GET /conversations` row, frontend `Conversation` in `src/lib/types.ts`) gains `adSourceId: string | null`, `adReferredAt: string | null` and `adSource: AdSourceChip | null`.
    - `AdSourceChip = {id, sourceType, headline, adName, mediaType, imageUrl}`.
    - `imageUrl` is `/api/media/<mediaId>/file` when re-hosted, else `mediaUrl` (it may have expired; the UI falls back to a placeholder), else null.
    - It is loaded with one `include: {adSource: {select: …}}` on the existing list query.
  - `AdCard` (Ads tab, `GET /ad-sources/overview`):
    ```
    { id, sourceId, sourceType, headline, body, adName, adSetName, campaignName, namesFrom,
      mediaType, imageUrl, sourceUrl, adAccountId,
      firstReferredAt, lastReferredAt,        // all time
      started: number,                        // in range
      spend: {amount: number, currency: string} | null,   // null = unknown (no active connection or other account)
      costPerConversation: number | null,     // null when started = 0 or spend unknown
      daily: {date: string, started: number, spend: number | null}[] }   // only on GET /ad-sources/:id
    ```
  - `MetaAdsConnectionDto`:
    ```
    { status: "not_connected" | "pending" | "active" | "needs_reconnect" | "disconnected",
      statusReason, adAccountId, adAccountName, currency, timezone, pageId, pageName,
      connectedAt, connectedBy: {id, name} | null, lastSyncedAt, lastSyncError,
      spendBackfilled: boolean, tokenExpiresAt, hasPendingLogin: boolean,
      config: {ready: boolean, missing?: string[]} }
    ```
    `missing` is present only for `connectors.manage`. It **never** contains a token or any part of one.
  - `MetaLeadDto` (`GET /contacts/:id/meta-leads`): `{id, formId, formName, adSourceId, adName, createdTime, fields: {name, values}[]}`.
- **API** (every route workspace-scoped; a foreign id gives **404**):
  - **`GET /ad-sources`** (`conversations.view`) → `{items: {id, label, sourceType, lastReferredAt}[]}` for the inbox filter. `label` = `adName ?? headline ?? sourceId`. At most 500 by `lastReferredAt desc`. No spend.
  - **`GET /ad-sources/overview?from&to`** (`reports.view`) → `{range: {from, to, tz}, connection: MetaAdsConnectionDto summary | null, totals: {started: number, byCurrency: {currency, spend, started, costPerConversation}[]}, daily: {date, started, spend: Record<currency, number> | null}[], ads: AdCard[] (≤ 200; sort: started desc, spend desc, lastReferredAt desc), totalAds}`.
    - `from`/`to` are `YYYY-MM-DD`, inclusive, with a span ≤ 366 days, else 400 `ads.range_invalid`. The default is the last 30 days.
    - `totals.byCurrency[].started` counts only conversations from ads whose spend is in that currency, so each cost is "spend over the conversations those same ads started" (Tkana rule).
  - **`GET /ad-sources/:id?from&to`** (`reports.view`) → `AdCard` with `daily`. 404 `ads.not_found`.
  - **`GET /ad-sources/:id/conversations?from&to&cursor&limit`** (`conversations.view`) → `{items: {conversationId, contactId, contactName, channelId, referredAt, firstTouch, status, assigneeId}[], nextCursor}`. It is **ANDed with `PermissionService.conversationScope`**, so an `assigned`-visibility agent sees only their threads (Review Focus 1). Cursor `(referredAt desc, id desc)`, `limit` ≤ 100.
  - **`GET /meta-ads/connection`** (`connectors.view`) → `MetaAdsConnectionDto`.
  - **`GET /meta-ads/oauth/start`** (`connectors.manage`) → `{url}`, or 400 `meta_ads.not_configured {missing}` / `meta_ads.encryption_unavailable`.
  - **`GET /meta-ads/oauth/callback`** (`public`) → 302 to the frontend with `metaAds=choose` or `metaAds=error&code=<key>`.
  - **`GET /meta-ads/candidates`** (`connectors.manage`) → `{adAccounts: {id, name, currency, timezone, accountStatus}[], pages: {id, name}[]}` from the pending token (or the active token when `?use=active`). Errors: 409 `meta_ads.not_exchanged`, 409 `meta_ads.reconnect {token: "pending"|"active"}`, 400 `meta_ads.no_ads_permission`.
  - **`POST /meta-ads/connection`** (`connectors.manage`) body `{adAccountId, pageId?: string | null}` → `MetaAdsConnectionDto`. Errors: 400 `meta_ads.unknown_asset {ids}`, 409 `meta_ads.connection_changed`, 409 `meta_ads.not_exchanged`.
  - **`POST /meta-ads/check`** (`connectors.manage`) → `MetaAdsConnectionDto`. Errors: 429 `meta_ads.check_cooldown {retryAfter, nextAt}`, 409 `meta_ads.not_connected`.
  - **`DELETE /meta-ads/connection`** (`connectors.manage`) → `MetaAdsConnectionDto` (`disconnected`). Idempotent.
  - **`GET /contacts/:id/meta-leads`** (`contacts.view`) → `{items: MetaLeadDto[]}`. A foreign or missing contact gives 404 (`contacts.not_found`, as the contact routes do today).
  - **Route order:** `overview` is declared before `:id` in `AdSourcesController`.
- **Error keys** (`{statusCode, message: key, …extra}`, same shape as `channelError`):
  - New `backend/src/meta-ads/meta-ads-errors.ts`:
    - 400: `meta_ads.not_configured`, `meta_ads.encryption_unavailable`, `meta_ads.no_ads_permission`, `meta_ads.unknown_asset`, `meta_ads.login_expired`;
    - 409: `meta_ads.not_exchanged`, `meta_ads.reconnect`, `meta_ads.connection_changed`, `meta_ads.not_connected`;
    - 429: `meta_ads.check_cooldown`;
    - 502: `meta_ads.meta_refused` (on an interactive read only, with `{graphCode}`).
  - New `backend/src/ad-attribution/ad-errors.ts`: `ads.not_found` (404), `ads.range_invalid` (400).
  - **Frontend copy:** `src/screens/ads/adsErrors.ts` with `tx` copy for every key and a test covering every key.
- **Provider calls:**
  - **Referral capture makes no provider call**, apart from the creative fetch (ruling 6): `https` only, the host must end in `.fbcdn.net`, no redirects followed, a 10 s timeout, ≤ 5 MB, `image/*` only (a video ad re-hosts its `thumbnail_url`), then `MediaService.ingestBuffer` (which sniffs the type).
    - It runs once per `AdSource` (skipped when `mediaId` is set), off the webhook path, at most 2 at a time per process.
    - A failure is logged as a key and retried on the next referral of the same ad.
    - The loopback test override `META_CDN_TEST_BASE` is accepted only when it matches `^http://127\.0\.0\.1:\d{2,5}$`. It rewrites `https://<host>/<path>` to `<base>/<host>/<path>`, for Task 4 only (ruling 6).
  - **Meta Marketing/Graph:** `MetaAdsGraphClient` (new, `backend/src/meta-ads/meta-ads-graph.client.ts`) reuses `META_GRAPH_FETCH` and `metaGraphBase()`. Methods: `exchangeCode(code, redirectUri)`, `exchangeLongLived(token)` (only for a user-token config), `me(token)`, `permissions(token)`, `adAccounts(token)`, `pages(token)`, `adAccount(act, token)`, `insights(act, token, {since, until, after?})`, `pageToken(pageId, token)`, `leadForms(pageId, pageToken, {after?})`, `leads(formId, pageToken, {since, after?})`. Each call is one request with no retry and `appsecret_proof`; `MetaAdsGraphError {code, subcode, httpStatus, fbtraceId, kind: "token"|"rate_limit"|"refused"|"transient"|"permanent"}`.
  - **Zernio:** no new Zernio call. The Zernio Ads add-on alternative is ruling 11.
  - Nothing logs a token, a Page token, `appsecret_proof`, `field_data`, or a Graph URL with its query string.
- **Notification copy** (`src/lib/notificationText.ts`, title `meta_ads.needs_reconnect`): "Meta Ads needs reconnecting: <adAccountName>" / "يحتاج حساب إعلانات Meta إلى إعادة ربط: <adAccountName>". The reason line: "Meta refused the login" / "رفضت Meta تسجيل الدخول", or "Meta refused access to the ad account" / "رفضت Meta الوصول إلى الحساب الإعلاني". `notificationHref` returns `#/ads?tab=connection` for this title.
- **Copy and layout:**
  - Every string goes through `tx("English","العربية")` with real Arabic.
  - Logical CSS only (`margin-inline-start`, `padding-inline`, `text-align: start`, `inset-inline-end`). The chart's x-axis runs from the inline start (it mirrors in RTL); the bars' values stay Latin digits.
  - Money: `Intl.NumberFormat(lang === "ar" ? "ar-SA-u-nu-latn" : "en-US", {style: "currency", currency})`. If the currency code is unknown, the amount plus the code. Two currencies are two figures, never one total.
  - Ad ids, `act_` ids, phone numbers, currency amounts and headlines inside Arabic sentences go in `<bdi>`. Headline and body use `dir="auto"`.
  - Dialogs and sheets set `dir`.
  - **Unknown is a first-class value (roadmap rule):**
    - Spend unknown is a muted "Unknown" / "غير معروف" with a reason tooltip: "Connect Meta Ads to see spend" / "اربط إعلانات Meta لعرض الإنفاق", or "This ad isn't in the connected ad account" / "هذا الإعلان ليس في الحساب الإعلاني المربوط".
    - Cost unknown when nothing started reads "No conversations yet" / "لا محادثات بعد".
    - Never 0, never blank, never a dash.
    - Names unknown fall back to the headline, then to "Ad <bdi>sourceId</bdi>" / "إعلان <bdi>sourceId</bdi>", labelled as an id.
- **Permissions (SP-25).** No catalogue change. `permission-map.ts` adds:
  - `GET /ad-sources`: `conversations.view`
  - `GET /ad-sources/overview`: `reports.view`
  - `GET /ad-sources/:id`: `reports.view`
  - `GET /ad-sources/:id/conversations`: `conversations.view`
  - `GET /meta-ads/connection`: `connectors.view`
  - `GET /meta-ads/oauth/start`: `connectors.manage`
  - `GET /meta-ads/oauth/callback`: `public` (state JWT + permission re-check)
  - `GET /meta-ads/candidates`: `connectors.manage`
  - `POST /meta-ads/connection`: `connectors.manage`
  - `POST /meta-ads/check`: `connectors.manage`
  - `DELETE /meta-ads/connection`: `connectors.manage`
  - `GET /contacts/:id/meta-leads`: `contacts.view`

  `system-role-decisions.spec.ts` adds an `SP-15 ads routes` block:
  - owner and admin can connect, check and disconnect;
  - agent and viewer cannot (agents hold no `connectors` action; viewers hold only `connectors.view`, so they can read the status);
  - owner, admin, agent and viewer can read the overview (`reports.view`) and the per-ad conversations (`conversations.view`, scoped);
  - impersonation is not blocked (ruling 7).

  `permission-sidedoors.spec.ts` adds the case `per-ad conversation list respects assigned visibility`. Every handler loads its row by `(id, workspaceId)` first; a foreign path id returns **404**.
- **Migration:**
  - File: `backend/prisma/migrations/20261115120000_ctwa_attribution/migration.sql`. The timestamp is after `20261114140000_number_template_health`. **Every existing migration is applied in production and is never edited.** Hand-written; apply with `npx prisma migrate deploy` only, never `migrate dev`.
  - **Additive and idempotent:** every `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE [UNIQUE] INDEX IF NOT EXISTS`, and every FK in `DO $$ BEGIN ALTER TABLE … ADD CONSTRAINT … ; EXCEPTION WHEN duplicate_object THEN NULL; END $$;` (the SP-12 pattern). Outline:
    ```sql
    CREATE TABLE IF NOT EXISTS "AdSource" (… "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "AdSource_pkey" PRIMARY KEY ("id"));
    CREATE TABLE IF NOT EXISTS "AdReferral" (…, "firstTouch" BOOLEAN NOT NULL DEFAULT false, …);
    CREATE TABLE IF NOT EXISTS "AdSpendDaily" (…, "date" DATE NOT NULL, "spend" DECIMAL(14,4) NOT NULL, …);
    CREATE TABLE IF NOT EXISTS "MetaAdsConnection" (…, "status" TEXT NOT NULL DEFAULT 'pending', "leadCheckpoints" JSONB, …);
    CREATE TABLE IF NOT EXISTS "MetaLead" (…, "fieldData" JSONB NOT NULL, "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, …);
    ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "adSourceId" TEXT,
                               ADD COLUMN IF NOT EXISTS "adReferredAt" TIMESTAMP(3);
    CREATE UNIQUE INDEX IF NOT EXISTS "AdSource_workspaceId_sourceType_sourceId_key" ON "AdSource"("workspaceId","sourceType","sourceId");
    CREATE INDEX IF NOT EXISTS "AdSource_workspaceId_lastReferredAt_idx" …; "AdSource_workspaceId_adAccountId_idx" …;
    CREATE UNIQUE INDEX IF NOT EXISTS "AdReferral_messageId_key" …; "AdReferral_workspaceId_adSourceId_referredAt_idx" …;
      "AdReferral_workspaceId_referredAt_idx" …; "AdReferral_conversationId_idx" …;
    CREATE UNIQUE INDEX IF NOT EXISTS "AdSpendDaily_adSourceId_date_key" …; "AdSpendDaily_workspaceId_adAccountId_date_idx" …;
    CREATE UNIQUE INDEX IF NOT EXISTS "MetaAdsConnection_workspaceId_key" …; "MetaAdsConnection_status_syncAttemptedAt_idx" …;
    CREATE UNIQUE INDEX IF NOT EXISTS "MetaLead_workspaceId_leadgenId_key" …; "MetaLead_workspaceId_contactId_idx" …;
    CREATE INDEX IF NOT EXISTS "Conversation_workspaceId_adSourceId_idx" ON "Conversation"("workspaceId","adSourceId");
    -- FKs (each in a DO … duplicate_object block):
    --  AdSource_workspaceId_fkey (CASCADE), AdSource_mediaId_fkey (SET NULL),
    --  AdReferral_workspaceId_fkey / _adSourceId_fkey / _conversationId_fkey / _messageId_fkey (CASCADE),
    --  AdSpendDaily_workspaceId_fkey / _adSourceId_fkey (CASCADE),
    --  MetaAdsConnection_workspaceId_fkey (CASCADE), MetaAdsConnection_connectedById_fkey (SET NULL),
    --  MetaLead_workspaceId_fkey (CASCADE), MetaLead_adSourceId_fkey (SET NULL), MetaLead_contactId_fkey (CASCADE),
    --  Conversation_adSourceId_fkey (SET NULL), all ON UPDATE CASCADE.
    ```
  - **Prisma-conformant names** as listed. Columns are camelCase quoted. `updatedAt` has no DB default (Prisma `@updatedAt`); raw-SQL writers set it.
  - **Check with `prisma migrate diff --from-schema-datamodel <HEAD schema> --to-schema-datamodel prisma/schema.prisma --script`** (no DB). The output must equal the file, apart from `IF NOT EXISTS` and the `DO` wrappers, as in SP-13/14.
  - **Safe for the deployed `main`:**
    - Five new tables `main` never reads.
    - Two nullable `Conversation` columns that `main`'s Prisma client never selects; its creates leave them null.
    - A `Conversation` delete from `main` cascades into `AdReferral`. A `Contact` delete cascades into `MetaLead` (ruling 9). A `Media` delete sets `AdSource.mediaId` null.
    - No existing column, constraint or index changes. No `UPDATE`, `DELETE`, `DROP` or `ALTER … TYPE`.
    - **Locks:** `Conversation_adSourceId_fkey` validates an all-null column (a short `SHARE ROW EXCLUSIVE` lock). `CREATE INDEX` on `Conversation` locks writes for its build (seconds at most at our size). It is recorded in Task 4 with a pre-apply row count.
  - **No backfill.** Referrals before SP-15 were never stored, so historical attribution is unknown, not reconstructed (ruling 5). Spend backfills 90 days from Meta on the first sync after connect.
- **Tests:**
  - backend: `npx jest src/ad-attribution src/meta-ads src/integrations src/conversations src/contacts src/permissions src/notifications` plus `npx tsc --noEmit -p tsconfig.json`; the full `npm test` once per task. The known unrelated failure is `hjz-client-sync › is inert when HJZ is not configured`.
  - frontend (repo root): `npx vitest run` plus `npm run typecheck`; `npm run build` once in Task 3.
  - **Named acceptance tests (exact names):**
    - `referral captured only on first inbound` (backend jest, `src/ad-attribution/ad-referral.service.spec.ts`, through both `ZernioService.handleEvent` and `WhatsAppService.handleWebhook` with the in-memory Prisma double)
    - `cost per conversation = spend / started (0 started → null)` (backend jest, `src/ad-attribution/ads-metrics.spec.ts`), with frontend companion `cost per conversation renders unknown when nothing started` (`src/screens/ads/adsModel.test.ts`)
    - `token stored encrypted (token-crypto.ts)` (backend jest, `src/meta-ads/meta-ads.service.spec.ts`)
  - All provider calls in specs are mocked (`META_GRAPH_FETCH` fake from `channels/whatsapp/test-graph.ts`, extended with Marketing API routes; an injectable creative fetcher). An unmocked call throws.
- **Commits:** selective `git add <paths>`, never `-A`. Trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not stage `.playwright-mcp/` or any untracked file this plan did not create.

## Review Focus
1. **Never fake attribution.**
   - Absent referral fields stay null.
   - Zernio names are used only when `synced: true`; its headline fallback is never stored as `adName`.
   - Spend is null (Unknown) without an active connection, or for an ad outside the connected account; never 0.
   - Historical conversations stay unattributed.
   - Tests: `absent referral fields stay null`, `zernio unsynced ad name is not stored`, `spend is unknown without an active connection`.
2. **First touch, exactly once.**
   - The first referral sets `Conversation.adSourceId`. Later messages, with or without a referral, never change it.
   - A redelivered webhook writes no second `AdReferral`. Two concurrent first messages set it once.
   - Tests: `referral captured only on first inbound`, `redelivered referral is a no-op`, `concurrent first referrals set one first touch`.
3. **Secrets.**
   - The Meta Ads token is in `tokenEnc`/`pendingTokenEnc` only, encrypted with `TOKEN_ENC_KEY`. Production without the key refuses (R5).
   - The token is never in a DTO, a log line, an error, a redirect URL or a notification. Page tokens are never stored. `appsecret_proof` is sent and never logged.
   - Tests: `token stored encrypted (token-crypto.ts)`, `production without TOKEN_ENC_KEY refuses to store a meta ads token`, `no token in dto, logs or errors`.
4. **Tenant isolation and side doors.**
   - Foreign ids give 404 on every SP-15 route.
   - The same Meta ad id in two workspaces is two `AdSource` rows.
   - Webhook capture writes only the workspace that owns the channel. The sync writes only its connection's workspace.
   - The per-ad conversation list honours `assigned` visibility. The OAuth callback re-checks `connectors.manage` for the user in `state`.
   - Tests: `foreign ids return 404 on SP-15 routes`, `same ad id in two workspaces stays separate`, `per-ad conversation list respects assigned visibility`, `oauth callback refuses a state whose user lost connectors.manage`.
5. **Meta budget.**
   - The sync never retries within a run, stops on a rate limit, parks on a refusal, and is bounded per tick and in time.
   - A check is rate-limited per workspace (DB-backed). One notification per transition to `needs_reconnect`.
   - Tests: `sync is bounded, idempotent and re-entrancy guarded`, `sync stops on rate limit without retry`, `token refusal notifies once`.

## Architecture Rulings and Risks
Each item names the risk, then the recommended ruling. Items marked **(needs controller ruling)** are repeated under Controller rulings, where the controller fills in the decision.

1. **Data shape beyond the roadmap.** The roadmap names `AdSource`, `Conversation.adSourceId`, `AdSpendDaily` and `MetaAdsConnection`. Our conversations are long-lived (one per contact and channel), so a returning customer who clicks a second ad does not start a new conversation row. "Conversations started" per ad then cannot be counted from `Conversation.adSourceId` alone.
   - **Ruling:** keep every roadmap name. Add `AdReferral` (one row per referral-bearing inbound message, unique per message), which is the counting source. Add `Conversation.adReferredAt`, and `MetaLead` (ruling 9).
   - `started` = distinct conversations with a touch for the ad in the range. `Conversation.adSourceId` is the first touch only, used by the chip and the filter.
   - **Alternative:** no `AdReferral`. Count conversations by `adReferredAt`, which loses re-engagement clicks and the click id. **(needs controller ruling)**
2. **Acceptance meaning of `referral captured only on first inbound`.** Meta emits `referral` only on the first message after a click. Zernio says "Capture is one-shot … later messages from the same person never overwrite it".
   - **Ruling:** the test asserts all of these:
     - (a) the first referral-bearing inbound sets `Conversation.adSourceId`/`adReferredAt`;
     - (b) later inbound messages without a referral change nothing;
     - (c) a later inbound **with** a different referral adds an `AdReferral` touch (`firstTouch: false`) but does not overwrite the conversation's first touch;
     - (d) an outbound echo (`message.sent`, `direction: outgoing`) never captures;
     - (e) a redelivery is a no-op.
   - The Zernio parser reads `evt.metadata ?? evt.message?.metadata` (location unverified; pending real check, ruling 13). **(needs controller ruling)**
3. **Zernio attribution names.** Zernio's `metadata.ad.name` "falls back to Meta's headline" when `synced: false`, which would look like an ad name and is not one.
   - **Ruling:** store `adName`, `adSetName`, `campaignName` and `adAccountId` from Zernio only when `synced === true` (`namesFrom: "zernio"`). The Meta spend sync overwrites names (`namesFrom: "meta_sync"`), because it is the account's own read. Otherwise names stay null and the UI labels the ad by headline or id. **(needs controller ruling, minor)**
4. **Scope of channels.** CTWA is WhatsApp. Instagram/Messenger ad clicks arrive as Zernio `referral.received` or Meta page `messaging_referrals`, with different fields (`ad_id`, `ads_context_data`).
   - **Ruling:** SP-15 captures WhatsApp referrals only (Zernio and Meta-direct). Messenger/IG ad referrals are recorded as deferred. Telegram and web chat never carry one. **(needs controller ruling, minor)**
5. **No historical backfill.** Messages stored before SP-15 kept no referral, and Zernio's stored `metadata.ctwa_*` on its conversations could be read through `GET /v1/inbox/conversations`.
   - **Ruling:** no backfill in SP-15. Old conversations show no chip, which is honest.
   - **Alternative:** a one-off, rerunnable backfill job reading Zernio conversation metadata (budgeted Zernio calls). That is real provider data, but it is extra scope and Zernio-only. **(needs controller ruling)**
6. **Creative images expire.** Meta's `image_url`/`thumbnail_url` are signed fbcdn links that stop loading after a few days (Tkana: about four).
   - **Ruling:** re-host once per `AdSource`, off the webhook path, into `Media` through `MediaService.ingestBuffer`, with the strict fetch rules in Global Constraints (https, `*.fbcdn.net`, no redirects, ≤ 5 MB, image only, 10 s). The re-hosted file appears in the workspace media library (it is the business's own ad creative). Videos re-host only the thumbnail.
   - Loopback test override `META_CDN_TEST_BASE` (loopback only, as `metaGraphBase`) for Task 4.
   - **Alternative:** show Meta's link only and accept broken images after a few days. **(needs controller ruling)**
7. **Who may connect, and impersonation.** Connecting hands us a token for the business's ad spend. Tkana restricts it to owners.
   - **Ruling:** `connectors.manage` (owner and admin by default; custom roles included). `connectors.view` (also viewers) reads the status. Viewing ads metrics uses `reports.view`; per-ad conversations use `conversations.view` with the visibility scope.
   - Admin impersonation is **not** blocked: `blockedForImpersonation` covers only `billing.*` and `campaigns.manage`, and changing it would affect other connector routes.
   - **Alternative:** owner-only (a new check in the service), and/or block impersonated sessions for `/meta-ads/*` writes. **(needs controller ruling)**
8. **Timezones and day buckets.** Meta reports spend per ad-account-local day. Referrals are instants.
   - **Ruling:** when a connection is active, bucket referral days in the ad account's timezone (`MetaAdsConnection.timezone`), so the daily chart and cost compare like with like. Otherwise use the workspace timezone. The range picker states the timezone used: "Days in <tz>" / "الأيام بتوقيت <tz>". **(needs controller ruling, minor)**
9. **Lead-form data (droppable).**
   - It needs Page access, `leads_retrieval` (App Review), an hourly poll of forms and leads, contact matching and creation, and personal-data handling.
   - **Ruling:** in scope as a self-contained section (Task 2 section B6, Task 3 section F6):
     - polling only (no `leadgen` webhook; that needs a Page subscription and an App Dashboard field, deferred);
     - match by normalized phone, then email; otherwise create a contact with `source: "meta_lead_form"`;
     - never overwrite an existing contact's fields;
     - `MetaLead.contactId` cascades on contact delete (privacy: deleting a person deletes their submissions);
     - `field_data` is never logged.
   - If it grows Task 2 beyond review size, or the app cannot get `leads_retrieval`, drop it to a follow-up and keep the `MetaLead` table (it is additive and harmless). **(needs controller ruling)**
10. **One ad account and one Page.** The roadmap shape is one connection with one `adAccountId` and one `pageId`; Tkana allows many.
    - **Ruling:** one each in SP-15. "Change" re-runs the picker with the pending-token flow.
    - **Disconnect** wipes both token columns and keeps stored `AdSpendDaily`/`MetaLead` rows. Spend shows only for the currently connected account (a previous account's ads read Unknown). Deleting stored ads data is deferred.
    - It makes no Graph revoke call (a system-user token cannot be revoked by us). The UI tells the owner to remove the app in Business Settings to revoke access fully. **(needs controller ruling)**
11. **Spend source; Pipeboard; Zernio Ads; the Salma UI.**
    - The existing `PipeboardProvider` runs on one process-wide `PIPEBOARD_TOKEN`. Using it for tenant spend would show one business's spend to every workspace, so it is **not** used.
    - Zernio offers ad-level daily metrics (`GET /v1/ads/timeline`, `/v1/ads/tree`) behind its paid **Ads add-on**, with ad accounts connected inside Zernio. That avoids our own App Review, but adds a paid dependency and a second connect flow.
    - **Ruling:** our own Meta OAuth (`MetaAdsConnection`, as the roadmap and the `token stored encrypted` acceptance require), with an internal `AdSpendSource` interface so Zernio Ads can be added later.
    - The roadmap line "The existing Salma/Pipeboard ads backend stays and gains a UI here": recommend **deferring the Salma chat UI to SP-18**, which turns Salma into a copilot persona (roadmap §SP-18 "Build on: the ads chat backend"). Building its UI twice wastes a sub-project. SP-15 leaves `backend/src/ads/` unchanged.
    - **Alternative:** a minimal Salma chat page in SP-15 (adds about a task). **(needs controller ruling)**
12. **Graph version and the insights quirk.** `graphVersion()` defaults to `v21.0`. Marketing API versions are retired on Meta's schedule, and v21 may be near or past its end by the time this ships. Tkana reports that asking for `actions` beside `spend` in a daily ad-level read returned zero spend.
    - **Ruling:** a new `META_ADS_GRAPH_VERSION` (default `graphVersion()`), set to a current version at deploy after checking Meta's changelog. We request `spend` only, never `actions` (Meta's own conversation count is not used; our referral count is the source).
    - **`META_GRAPH_BASE_URL`** stays loopback-or-graph only (SP-14 R13). **(needs controller ruling)**
13. **Unverified provider behaviour** (to record as pending real checks, as SP-13/14 did):
    - where Zernio puts `metadata` (root vs `message.metadata`) and whether `metadata.referral` is verbatim on WhatsApp;
    - whether Zernio sends the referral on `conversation.started` and `message.received` both (our dedupe by message id covers it);
    - the real fbcdn host suffixes of creative links;
    - Login for Business with a system-user token configuration on our app;
    - the Marketing API access tier our app holds (Development vs Standard), and its rate limits;
    - `leads_retrieval` Page token behaviour.

    The parsers and the sync are defensive (null or Unknown on any surprise). **(needs controller ruling, minor)**
14. **Shared files and ordering with SP-14.** SP-14 Task 2/3 is in progress on this branch. They touch `schema.prisma`, `permission-map.ts`, `zernio.service.ts` (`handleEvent`), `whatsapp.service.ts` (`handleWebhook`), `notificationText.ts`, `recordLink.ts`, `NotificationsBell.tsx`, `src/lib/types.ts` and `test-prisma.ts`.
    - **Ruling:** SP-15 starts from the commit that ships SP-14 (its roadmap "Shipped" tick), and records that SHA as its base. SP-15 depends on SP-14's `PermissionService.membersWith`, `notificationHref` and `metaGraphBase`.
    - Task 1 owns `schema.prisma` and the migration for all of SP-15. **(needs controller ruling)**
15. **Verification touches production** (as SP-12 R14, SP-13 R20 and SP-14 R17).
    - Task 4 runs against the production DB in throwaway test workspaces, with local stubs for Meta Graph, the fbcdn creative host and Zernio. No provider is reached.
    - The migration needs the user's **explicit approval** before `migrate deploy`; earlier approvals do not carry over.
    - The deployed app is unaffected: it has no SP-15 code, and the test connection rows carry fake ad account ids that no deployed cron reads. **(needs controller ruling)**
16. **Size.** The roadmap says L. With lead forms (ruling 9), the plan has 3 build tasks plus verification. Dropping lead forms and the creative re-host keeps it a firm L; adding the Salma UI (ruling 11) makes it XL. **(needs controller ruling)**

### Meta app setup the user must supply (outside the code)
None of these can be done by an agent. They are listed in the PR and the runbook.
- **App:** a Meta app of type **Business**, owned by a **business-verified** Business portfolio. Business verification is required for Advanced Access.
- **Products:** **Facebook Login for Business** and **Marketing API**. Webhooks need nothing new for CTWA, because the referral arrives on the existing WhatsApp `messages` field.
- **Permissions, with Advanced Access through App Review** (each needs a screencast and use-case text; verify the exact list at review time, because Meta revises it):
  - `ads_read`: daily spend per ad;
  - `business_management`: list ad accounts and Pages owned through the business;
  - `pages_show_list` and `pages_read_engagement`: choose a Page;
  - `leads_retrieval` and `pages_manage_ads`: only if ruling 9 keeps lead forms (Meta lists both for reading Instant Form leads).
- **Marketing API access tier:** request **Ads Management Standard Access**. The Development tier has very low rate limits and only works for app-role users' ad accounts.
- **Login for Business configuration:** create a configuration (token type **System-user access token** recommended: it does not expire; otherwise a 60-day user token, which the UI shows with its expiry), with assets *Ad accounts* (+ *Pages* for leads) and the permissions above. Supply its id as `META_ADS_LOGIN_CONFIG_ID`.
- **Valid OAuth redirect URI:** `${BACKEND_PUBLIC_URL}/api/meta-ads/oauth/callback`.
- **Env on Fly:**
  - `META_ADS_APP_ID` and `META_ADS_APP_SECRET` (fall back to `META_APP_ID`/`META_APP_SECRET` when one app serves both);
  - `META_ADS_LOGIN_CONFIG_ID`;
  - `META_ADS_GRAPH_VERSION` (ruling 12);
  - `TOKEN_ENC_KEY` (≥ 32 chars, **required in production**; already a SP-19 pre-release item);
  - `BACKEND_PUBLIC_URL`, `FRONTEND_PUBLIC_URL`.
- **App Review prerequisites:** a privacy policy URL, a data-deletion instructions URL or callback, an app icon, and a business contact. If any is missing, App Review cannot be submitted.
- **No change** to the WhatsApp app, Zernio, or the existing `META_APP_SECRET_WA` webhook signature.
- **Optional (deferred):** Zernio Ads add-on (ruling 11); the `leadgen` Page webhook subscription (ruling 9).

### Controller rulings
*Decided 2026-11-10. Every recommended ruling (R1–R16) is accepted; R9 lead forms stay droppable. R15: migration 20261115120000_ctwa_attribution needs explicit user approval before it is applied. Migration order across SPs: SP-15 20261115120000, SP-16 20261115130000, SP-17 20261115140000.*
- **R1** (data shape: `AdReferral` + `Conversation.adReferredAt` + `MetaLead` beside the roadmap names). Recommend: accept.
- **R2** (first-touch semantics (a)–(e); Zernio `metadata` read at root or under `message`). Recommend: accept.
- **R3** (Zernio names only when `synced: true`; the Meta sync wins). Recommend: accept.
- **R4** (WhatsApp only; Messenger/IG ad referrals deferred). Recommend: accept.
- **R5** (no historical backfill). Recommend: accept; Zernio metadata backfill as a follow-up.
- **R6** (re-host creatives into `Media` with strict fetch rules; loopback test override). Recommend: accept.
- **R7** (`connectors.manage` connects; impersonation not blocked). Recommend: accept.
- **R8** (day buckets in the ad account's timezone when connected). Recommend: accept.
- **R9** (lead forms in scope by polling, droppable; contact cascade). Recommend: accept, droppable.
- **R10** (one ad account and one Page; disconnect keeps data and makes no revoke call). Recommend: accept.
- **R11** (own Meta OAuth; no Pipeboard for spend; Zernio Ads later; Salma UI deferred to SP-18). Recommend: accept.
- **R12** (`META_ADS_GRAPH_VERSION`; never request `actions`). Recommend: accept.
- **R13** (unverified provider behaviours listed in the PR as Accepted real checks). Recommend: accept.
- **R14** (SP-15 bases on the SP-14 ship commit; Task 1 owns the schema). Recommend: accept.
- **R15** (verification on the production DB with throwaway workspaces and stubs; migration `20261115120000_ctwa_attribution` only with the user's explicit approval). Recommend: accept.
- **R16** (size L; 3 build tasks + verification). Recommend: accept.

---

### Task 1: Backend — schema, migration, referral capture, creative re-host, inbox DTO and ad-source routes
**Owns:** `schema.prisma` and the migration for all of SP-15 (every table in Global Constraints, including `MetaAdsConnection` and `MetaLead`). Tasks 2 and 3 depend on this schema and do not edit it.

**Files:**
- `backend/prisma/schema.prisma`: Global Constraints → Data.
- `backend/prisma/migrations/20261115120000_ctwa_attribution/migration.sql`.
- Create `backend/src/ad-attribution/`, each with a spec:
  - `referral.ts` (pure): `NormalizedReferral {sourceId, sourceType, headline, body, mediaType, mediaUrl, videoUrl, sourceUrl, welcomeText, ctwaClid, names: {adName, adSetName, campaignName, adAccountId} | null}`, `parseMetaReferral(raw)`, `parseZernioReferral(evt)` (reads `evt.metadata ?? evt.message?.metadata`; `names` only when `metadata.ad.synced === true`), `creativeLink(ref)` (image → `image_url`, video → `thumbnail_url`), and the caps.
  - `ad-referral.service.ts`: `capture(input)` (Architecture); `AdReferralService` provided by a new `AdAttributionModule`, exported to `IntegrationsModule`.
  - `creative-rehost.ts`: `rehostCreative(adSource, deps)` with an injectable `fetchCreative` (strict rules), a per-process concurrency of 2, and `META_CDN_TEST_BASE` handling.
  - `ad-sources.service.ts`: `listForFilter(ws)` (`GET /ad-sources`), `conversations(ws, id, viewer, q)` (scoped).
  - `ad-sources.controller.ts`: `GET /ad-sources`, `GET /ad-sources/:id/conversations` (the metrics routes come in Task 2).
  - `ad-errors.ts`.
- `backend/src/integrations/zernio.service.ts`:
  - `ZernioWebhookEvent` gains root `metadata?: {referral?: unknown; ad?: unknown; …} | null`, and `message.metadata` gains `referral?`/`ad?`;
  - `ingestInbound` calls `adReferrals.capture(...)` after the message is created, inbound only, beside `attributor.onInbound`.
- `backend/src/integrations/whatsapp.service.ts`: `WebhookEntryChangeValue.messages[]` gains `referral?: MetaReferral`; `ingestInbound` calls `capture` after `message.create`.
- `backend/src/integrations/integrations.module.ts`: import `AdAttributionModule`.
- `backend/src/conversations/conversations.service.ts`: `list` includes `adSource: {select: {id, sourceType, headline, adName, mediaType, mediaId, mediaUrl}}` and maps it to `AdSourceChip`; `get` the same.
- `backend/src/channels/test-prisma.ts`: the new models (`adSource`, `adReferral`, `adSpendDaily`, `metaAdsConnection`, `metaLead`), `conversation.updateMany` with `adSourceId: null` in `where`, `createMany … skipDuplicates`, and the `include` on conversations.
- `backend/src/permissions/permission-map.ts`: `GET /ad-sources`, `GET /ad-sources/:id/conversations`, plus spec rows; `permission-sidedoors.spec.ts` case.

**Produces (contract for Tasks 2–3):**
- `AdReferralService.capture(input): Promise<{adSourceId, firstTouch} | null>` (never throws).
- `AdSource` / `AdReferral` / `Conversation.adSourceId` populated per Global Constraints. `AdSourceChip` on the conversation DTO.
- `GET /ad-sources`, `GET /ad-sources/:id/conversations`.
- `upsertAdSourceFromSync(ws, {sourceId, adAccountId, adName, adSetName, campaignName})` (exported helper in `ad-referral.service.ts`, used by Task 2's sync).

- [ ] Write the failing tests:
  - `migration is additive, idempotent and Prisma-named (SP-15)` (reads the SQL):
    - every `CREATE TABLE`, `ADD COLUMN` and `CREATE INDEX` has `IF NOT EXISTS`; every FK is in a `duplicate_object` block;
    - the names are exactly as listed;
    - there is no `DROP`, `UPDATE`, `DELETE`, `ALTER COLUMN` or `TYPE`;
    - the folder name is greater than `20261114140000`;
    - the sha256 values of `20261114130000_contact_workspace_id_index` and `20261114140000_number_template_health` are pinned (unchanged);
    - `prisma migrate diff` from the HEAD schema produces the same statements (recorded as SP-13/14 did).
  - **`referral captured only on first inbound`** (both providers, table-driven over `zernio` and `meta`):
    - message 1 with referral A → `AdSource` A created with headline, body, mediaType and sourceUrl exactly as sent; one `AdReferral` (`firstTouch: true`, `ctwaClid` as sent); `Conversation.adSourceId = A`, `adReferredAt = message time`;
    - message 2 without a referral → nothing changes;
    - message 3 with referral B → `AdSource` B, one `AdReferral` (`firstTouch: false`), and `Conversation.adSourceId` still A;
    - a Zernio `message.sent` / `direction: outgoing` echo carrying a referral captures nothing;
    - a redelivery of message 1 (same wamid / Zernio id) → still exactly one `AdReferral` for it.
  - `absent referral fields stay null`: a Status-placement referral without `ctwa_clid`, `image_url` or `welcome_message` stores nulls. A referral without `source_id` stores nothing and logs `referral_missing_source_id` (no payload in the log). Over-long or `http:` values are dropped to null, never truncated into a wrong URL.
  - `zernio unsynced ad name is not stored`: `metadata.ad {synced:false, name:"<headline>"}` → `adName` null, `namesFrom` null. `synced:true` → names and `adAccountId` stored, `namesFrom: "zernio"`. The parser accepts root `metadata` and `message.metadata`.
  - `concurrent first referrals set one first touch`: two captures for two different messages of one conversation, interleaved → exactly one `firstTouch: true`, and `adSourceId` equals that touch's ad.
  - `capture never throws into the webhook`: a Prisma error inside `capture` → the message is still stored and the handler returns `{ok:true}`.
  - `same ad id in two workspaces stays separate`: two channels in workspaces A and B, the same `source_id` → two `AdSource` rows, each touch in its own workspace.
  - `creative is re-hosted once with strict fetch rules`:
    - an fbcdn `https` image → one fetch, `ingestBuffer` called, `mediaId` set;
    - a second referral for the same ad → no fetch;
    - an `http:` link, a non-fbcdn host, a redirect, `text/html`, > 5 MB, or a timeout → no Media, `mediaId` null, a logged key, and the inbound unaffected;
    - a video ad fetches `thumbnail_url`;
    - `META_CDN_TEST_BASE` is honoured only for `http://127.0.0.1:<port>`.
  - `conversation dto carries the ad chip`: `GET /conversations` rows include `adSource` with `imageUrl` = `/api/media/<id>/file` after re-hosting, Meta's link before, null for unattributed rows. No `ctwaClid` anywhere in the DTO.
  - `per-ad conversation list respects assigned visibility` (permission-sidedoors): an agent with `assigned` visibility sees only their assigned conversations of the ad; the owner sees all; cursor paging is stable under a new touch.
  - `foreign ids return 404 on SP-15 routes` (part 1): `GET /ad-sources/:id/conversations` with workspace B's id from A.
  - `permission map covers SP-15 routes` (part 1).
- [ ] Implement until green.
- [ ] `npx tsc --noEmit -p tsconfig.json`, the listed jest paths, then the full `npm test` once. Run `npx prisma generate`. An EPERM on the engine DLL while the dev watcher runs is harmless, as in SP-12/13/14; restart the watcher. **Do not run `migrate`** (ruling 15). The existing Zernio/Meta inbound specs (`zernio.service.*.spec.ts`, `whatsapp-legacy-fixes.spec.ts`, `campaign-tracking-webhooks.spec.ts`, `channel-routing.spec.ts`) must stay green, extended only.
- [ ] Commit `feat(ads): ctwa referral capture, ad sources and inbox attribution data`.

### Task 2: Backend — Meta Ads connect, spend sync, metrics, reconnect notification and lead forms
**Depends on:** Task 1.

**Files:**
- **B1 Config and errors:**
  - `backend/src/meta-ads/meta-ads.config.ts`: `metaAdsApp(env) → {appId, appSecret, configId, graphVersion}`, `missing[]`, `redirectUri()`.
  - `meta-ads-errors.ts`.
- **B2 Graph client:** `meta-ads-graph.client.ts` (Global Constraints → Provider calls). Error classification is `classifyGraphError(code, subcode, status)`, pure, with a table spec. `test-graph.ts` gains the Marketing API routes for specs.
- **B3 Connect:** `meta-ads.service.ts` and `meta-ads.controller.ts`:
  - `start(ws, userId)`;
  - `callback(code, state)`: state verify, permission re-check, exchange, `encryptMetaAdsToken`, `pendingTokenEnc`;
  - `candidates(ws, {use})`;
  - `save(ws, userId, {adAccountId, pageId})`: a conditional promote, `UPDATE … SET "tokenEnc" = "pendingTokenEnc", "pendingTokenEnc" = NULL … WHERE "workspaceId" = $ws AND "pendingTokenEnc" = $seen`;
  - `check(ws)` with a raw-SQL claim on `checkAttemptedAt` (60 s);
  - `disconnect(ws)`;
  - `toDto(row, viewerCanManage)`.

  `encryptMetaAdsToken(plain)` follows `encryptChannelSecrets`: production without `TOKEN_ENC_KEY` throws `meta_ads.encryption_unavailable`; dev stores plaintext and warns once, without the secret.
- **B4 Sync:** `meta-ads-sync.scheduler.ts` (`@Cron(EVERY_HOUR) sweep(now)`), `meta-ads-sync.ts` (`syncConnection(row, token, now)`: windows, insights paging, `upsertAdSourceFromSync`, `AdSpendDaily` upsert with `Prisma.Decimal`, error handling per Architecture). Claim on `syncAttemptedAt` is raw SQL. The env tunables `META_ADS_SYNC_BATCH`, `META_ADS_SYNC_INTERVAL_MS`, `META_ADS_SYNC_MAX_MS`, `META_ADS_MAX_PAGES` are documented in `backend/.env.example`.
- **B5 Metrics:** `backend/src/ad-attribution/ads-metrics.service.ts` (pure `costPerConversation(spend, started)`, `round4`, range parsing and tz bucketing in `ads-metrics.ts`) and `AdSourcesController` `GET /ad-sources/overview`, `GET /ad-sources/:id` (declared before `:id/conversations` order-wise as needed).
- **B6 Lead forms** (only if ruling 9 stands):
  - `backend/src/meta-ads/meta-leads.sync.ts`: Page token per run, forms, leads with checkpoint, budget 100 pages, contact match and create, `MetaLead` upsert;
  - `backend/src/contacts/contacts.controller.ts` → `GET /contacts/:id/meta-leads` through a `MetaLeadsService.forContact(ws, contactId)`.
- **B7 Notifications:** `meta-ads-notifier.ts` (transition-only; `membersWith(ws, "connectors.manage")`; title `meta_ads.needs_reconnect`).
- **Other files:**
  - `backend/src/app.module.ts`: `MetaAdsModule`;
  - `permission-map.ts`: the remaining SP-15 routes with spec rows and the `SP-15 ads routes` system-role block;
  - `backend/.env.example`: `META_ADS_APP_ID`, `META_ADS_APP_SECRET`, `META_ADS_LOGIN_CONFIG_ID`, `META_ADS_GRAPH_VERSION`, `META_CDN_TEST_BASE` (commented, empty), plus the tunables.

**Produces:**
- The `/meta-ads/*` routes and `MetaAdsConnectionDto`.
- `MetaAdsSyncScheduler.sweep(now)` (the verifier drives it through its control port).
- `GET /ad-sources/overview`, `GET /ad-sources/:id` with `AdCard`.
- `GET /contacts/:id/meta-leads` (if B6).
- `connector_needs_attention` notifications with title `meta_ads.needs_reconnect`.

- [ ] Write the failing tests:
  - **`token stored encrypted (token-crypto.ts)`**:
    - with `TOKEN_ENC_KEY` set, the callback stores `pendingTokenEnc` starting `enc:v1:`, not equal to the token, and `decryptSecret` returns the token;
    - save promotes it to `tokenEnc`, still encrypted;
    - the sync and the check read it through `decryptSecret` and send `Authorization: Bearer <token>` plus `appsecret_proof` = HMAC-SHA256(token, appSecret) to the fake Graph;
    - the raw row, `GET /meta-ads/connection`, every thrown error and every `Logger` call (spied) contain neither the token nor the proof.
  - `production without TOKEN_ENC_KEY refuses to store a meta ads token`: `NODE_ENV=production`, no key → `oauth/start` gives 400 `meta_ads.encryption_unavailable`, and the callback redirects with `code=encryption_unavailable` with nothing written. In dev it stores plaintext with one warning that has no token.
  - `oauth state is bound to workspace, user and purpose`:
    - an expired state, a wrong purpose, a state signed with another secret, or **a user who lost `connectors.manage` since start** (`oauth callback refuses a state whose user lost connectors.manage`) → redirect `metaAds=error`, nothing stored;
    - a valid state → `pendingTokenEnc` set, and the active `tokenEnc` untouched.
  - `save checks assets against a fresh candidates read`:
    - an `adAccountId` or `pageId` not in the read → 400 `meta_ads.unknown_asset {ids}`;
    - a pending token replaced between read and promote → 409 `meta_ads.connection_changed`;
    - no pending token → 409 `meta_ads.not_exchanged`;
    - a login without `ads_read` (permissions read) → 400 `meta_ads.no_ads_permission`.
  - `check is rate-limited per workspace and survives restart` (DB-backed `checkAttemptedAt`): the second check within 60 s → 429 `meta_ads.check_cooldown {retryAfter, nextAt}` with no Graph call.
  - `disconnect wipes tokens and keeps history`: both token columns null, `status: disconnected`, `AdSpendDaily` rows remain, and the overview shows spend Unknown afterwards. Idempotent.
  - **`cost per conversation = spend / started (0 started → null)`** (pure plus through `GET /ad-sources/overview`):
    - spend 120.5 / 4 started → 30.125;
    - spend 50 / 0 started → null;
    - spend unknown (no active connection) / 3 started → null, with `spend: null`;
    - two currencies → two `byCurrency` entries, never summed;
    - rounding to 4 dp.
  - `spend is unknown without an active connection`: `needs_reconnect`, `disconnected`, no row, or an ad whose `adAccountId` differs from the connected one → `spend: null`, never `{amount: 0}`. An ad of the connected account with no spend rows in range → `{amount: 0, currency}` (Meta reported nothing spent).
  - `started counts distinct conversations per ad in range`: two touches by one conversation on the same ad count 1; touches outside the range are excluded; day buckets in the account timezone vs the workspace timezone (ruling 8); a range > 366 days or malformed → 400 `ads.range_invalid`.
  - `sync is bounded, idempotent and re-entrancy guarded`:
    - 30 due connections with batch 20 → 20 synced;
    - an immediate second tick syncs the other 10;
    - a tick while one runs returns `{synced:0}`;
    - `META_ADS_SYNC_MAX_MS` stops early;
    - `pending`/`needs_reconnect`/`disconnected` are never selected;
    - the first run reads 13 seven-day windows (90 days) and sets `spendBackfilledAt`; the next run reads 3 days;
    - a re-read of a day replaces that day's spend (upsert).
  - `sync stops on rate limit without retry`: Graph code 17 on window 2 → exactly 2 insights calls, `lastSyncError: "rate_limited"`, still `active`, and the next tick resumes.
  - `token refusal notifies once`:
    - Graph 190 → `needs_reconnect {statusReason:"token_refused"}`;
    - one `notify` to the `connectors.manage` holders (owner, admin, custom role; not agent or viewer), type `connector_needs_attention`, title `meta_ads.needs_reconnect`;
    - a second sweep or a second 190 → no further notification;
    - a reconnect (save) re-arms it.
  - `account refusal parks the connection` (Graph 200/10 on the account): `needs_reconnect {account_refused}`, one notification.
  - `sync upserts ads it has never seen with names only`: an insights row for an ad with no referral creates an `AdSource` with `adName`/`adSetName`/`campaignName`/`adAccountId`, `namesFrom: "meta_sync"`, and **null** headline, body and media; a later referral fills the creative fields without clearing the names.
  - If B6: `lead import matches or creates contacts and never overwrites`:
    - a lead whose phone matches an existing contact (format differs) → linked, contact fields unchanged;
    - an email match → linked;
    - no match → a new contact `source: "meta_lead_form"` with the name from `full_name`;
    - a re-run imports nothing twice (`leadgenId` unique);
    - the checkpoint advances per form;
    - the Page token is never stored or logged; `field_data` never appears in a log line;
    - a contact delete cascades its leads.
  - `meta leads route returns only this workspace's contact leads` (404 for a foreign contact).
  - `foreign ids return 404 on SP-15 routes` (part 2): `GET /ad-sources/:id` (404 `ads.not_found`), `GET /contacts/:id/meta-leads`.
  - `permission map covers SP-15 routes` (part 2), plus the system-role block `SP-15 ads routes`.
- [ ] Implement until green. Review checklist for the PR:
  - every Graph call in `meta-ads/` goes through `MetaAdsGraphClient` (one place for `appsecret_proof`, `metaGraphBase`, timeout and error stripping);
  - every token read goes through `decryptSecret`;
  - no `console.log`.
- [ ] `npx tsc --noEmit -p tsconfig.json`, the jest paths, then the full `npm test` once. The existing `src/ads/*` specs (Salma, wallet, Pipeboard allowlist) must stay green and unmodified.
- [ ] Commit `feat(ads): meta ads connect, hourly spend sync, ad metrics, reconnect alerts and lead forms`.

### Task 3: Frontend — Ads screen, per-ad page, Meta Ads connect, inbox chip and ad-source filter, contact leads
**Depends on:** the contracts of Tasks 1–2. It can start from Task 1's contract while Task 2 is in review.

**Files:**
- **F1 Model:** `src/screens/ads/adsModel.ts` (pure):
  - range presets (`7d`, `30d`, `90d`, `custom`) with `parseRange`/`rangeToQuery`;
  - `costPerConversationView(card, tx)`;
  - `spendView(spend, tx)`: Unknown with a reason;
  - `formatAdMoney(amount, currency, lang)`;
  - `adLabel(card, tx)`: adName → headline → "Ad <id>";
  - `dailySeries(daily, maxBars = 31)`;
  - `connectionView(dto, tx)`: status words and tone for `not_connected | pending | active | needs_reconnect | disconnected`;
  - `oauthReturn(hash)`: reads `metaAds=choose|error&code`.

  Tests in `adsModel.test.ts`.
- **F2 Ads page:**
  - `src/screens/ads/AdsPage.tsx`: route `ads` (`RouteId` in `src/lib/types.ts`, lazy in `src/router.tsx`, entry in `src/shell/nav.ts` under marketing, shown with `reports.view`).
  - Tabs "Overview | Connection" / "نظرة عامة | الربط", kept in the hash (`#/ads?tab=…&from=…&to=…`).
  - Overview: range picker, the totals strip per currency (spend, conversations started, cost per conversation), `AdsDailyChart.tsx`, ad cards (`AdCard.tsx`: creative thumbnail with a placeholder on error, label, headline `dir="auto"`, started, spend, cost, "View conversations").
  - Empty state when no ad ever referred: "No conversations from ads yet" / "لا محادثات من الإعلانات بعد".
  - A not-connected banner offering Connect (`connectors.manage` only).
- **F3 Per-ad page:** `src/screens/ads/AdDetail.tsx` (`#/ads?ad=<id>`):
  - the card, a daily chart, and the full body text;
  - "Open ad" (`sourceUrl`, `rel="noopener noreferrer"`);
  - the conversation list from `GET /ad-sources/:id/conversations` (cursor "Load more"), each row opening `#/inbox?c=<conversationId>`.
- **F4 Connect:** `src/screens/ads/MetaAdsConnect.tsx`:
  - status card with the last sync and its error key;
  - "Connect" / "Change" → `GET /meta-ads/oauth/start` → `window.location.assign(url)`;
  - on return (`metaAds=choose`) a picker dialog (`dir` set) from `GET /meta-ads/candidates`: one ad account (radio; shows currency and timezone), an optional Page (radio, "None");
  - "Check now" with a countdown on 429;
  - "Disconnect" with a confirm dialog that explains the kept data and how to revoke access in Meta Business Settings;
  - `config.missing` shown to managers as a setup checklist.

  `src/screens/ads/adsErrors.ts` + test.
- **F5 Inbox:**
  - `src/screens/inbox/CtwaChip.tsx`: a compact chip in list and table rows ("Ad" / "إعلان" + label); a thread-header attribution card (creative, headline, "From ad · <date>" / "من إعلان · <date>", a link to `#/ads?ad=<id>` for `reports.view`).
  - `inboxFilters.ts`: `InboxFilter` gains `adFilter: "any" | "none" | null` and `adSourceIds: string[]`; `EMPTY_FILTER` defaults; `matchesFilter` and `activeFilterCount`.
  - `inboxHash.ts`: `decodeFilter` reads both defensively, so old hashes still decode.
  - `InboxFilterMenu.tsx`: an "Ad source" / "مصدر الإعلان" section (Any ad / No ad / specific ads from `GET /ad-sources`).
  - `Inbox.tsx`, `InboxTable.tsx`: render the chip.
- **F6 Contact leads** (only if ruling 9 stands): `src/screens/contacts/MetaLeadsCard.tsx` in `ContactDetailDrawer.tsx`:
  - each submission: form name, ad label, date, and question → answer pairs (`dir="auto"`, `<bdi>` for phone and email);
  - hidden when empty;
  - `contacts.view`.
- **F7 Notifications:**
  - `src/lib/notificationText.ts`: case `meta_ads.needs_reconnect`;
  - `src/lib/recordLink.ts` `notificationHref`: `#/ads?tab=connection` for that title.
- **F8 Types:** `src/lib/types.ts`: `AdSourceChip`, `AdCard`, `AdsOverview`, `MetaAdsConnectionDto`, `MetaAdsCandidates`, `MetaLeadDto`, `AdSourceOption`; `Conversation` gains `adSourceId`, `adReferredAt`, `adSource`; `RouteId` gains `"ads"`.
- **Permission gating** with `usePermissions().can(...)`:
  - Ads page: `reports.view`;
  - Connection tab: `connectors.view`; its buttons: `connectors.manage`;
  - per-ad conversation list and inbox filter: `conversations.view`;
  - leads card: `contacts.view`.

  Hidden actions are not rendered. A 403 shows the shared no-permission toast.

**Produces:**
- The Ads screen and per-ad page, in English and Arabic (RTL).
- The Meta Ads connect flow.
- The inbox chip, header card and Ad source filter.
- The contact leads card.
- The reconnect notification text and deep link.

- [ ] Write the failing vitest tests:
  - **`cost per conversation renders unknown when nothing started`**:
    - started 0 → "No conversations yet" / "لا محادثات بعد", never "0" or a currency amount;
    - spend null → spend "Unknown" / "غير معروف" with the right reason (not connected / other account), cost Unknown;
    - spend 120.5 SAR / 4 → "SAR 30.13" in Latin digits in both languages;
    - two currencies render two figures.
  - `ad label falls back from name to headline to id` (no label is ever blank).
  - `range presets and custom dates round-trip through the hash`.
  - `daily series fills idle days and folds long ranges` (sums preserved).
  - `connection status words and tones cover every status in both languages`.
  - `oauth return reads choose and error codes`.
  - `ads error copy covers every SP-15 key in both languages`.
  - `inbox ad-source filter round-trips through the hash`: old hashes without the keys decode to `adFilter: null, adSourceIds: []`; malformed values are ignored.
  - `matchesFilter keeps only conversations from the chosen ads`: `any` keeps attributed rows, `none` keeps the others, ids keep matching `adSourceId`, and it combines with the number tab and other filters; `activeFilterCount` counts it once.
  - `meta ads reconnect notification text and deep link` (`notificationHref` → `#/ads?tab=connection`; other titles unchanged).

  Then implement until they pass, then build the components.
- [ ] `npx vitest run`, `npm run typecheck` and `npm run build` clean. A read-only look at the pages on the dev server is optional; the real UI pass is in Task 4.
- [ ] Commit `feat(ads): ads screen, per-ad page, meta ads connect, inbox ad chip and filter, contact lead forms`.

### Task 4: Verification
Apply `20261115120000_ctwa_attribution` with `npx prisma migrate deploy`, and only when the controller and the user explicitly approve it (ruling 15). It is safe for `main` (Global Constraints). Record the results in `.superpowers/sdd/2026-11-15-sp15-ctwa-attribution/live-verification.md`, in the format of SP-19's `live-verification.md`: summary, a results table with evidence, DB-side checks, findings, cleanup, and the pending real-provider items. If the harness refuses the write, put the tables in the scratchpad and say so, as SP-13 did; do not reroute.

**Isolation** (no repo code changed; scripts derived from SP-13/14's in the session scratchpad `C:\Users\ashra\AppData\Local\Temp\claude\7b75a64029a712a6\ebb2057a-6300-4548-9aec-b98487880afb\scratchpad\`):
- **Own instance:** `launch-sp15.js`, derived from `launch-sp13.js` / `launch-sp14.js`.
  - Backend on **:4240**, compiled with `tsc -p tsconfig.build.json` into a throwaway outDir (`backend/.verify-dist-sp15`, never `backend/dist`) and started with `node`. The user's :4100 process is not touched.
  - A loopback-only control port **:4241** calls `MetaAdsSyncScheduler.sweep(now)` and awaits pending creative re-hosts.
- **Crons:** all `@nestjs/schedule` jobs are disabled (the SP-13 `lookupSchedulers` patch). `MetaAdsSyncScheduler` is driven only through the control port. Its `prisma` gets a scoped proxy that confines `metaAdsConnection.findMany/findFirst/updateMany/count` to the test workspaces recorded in `verify-created-sp15.json`. With nothing recorded, it matches nothing, so the sweep can never read a real connection. The claim is raw SQL by id, taken only from those confined reads.
- **Provider keys:** set to **empty strings**, not deleted (SP-19 finding E2), the same list as SP-13/14. `TOKEN_ENC_KEY` is a test-only value. `META_ADS_APP_ID=zz-verify-app`, `META_ADS_APP_SECRET=zz-verify-secret-<ts>`, `META_ADS_LOGIN_CONFIG_ID=zz-verify-config`, `BACKEND_PUBLIC_URL=http://127.0.0.1:4240`, `FRONTEND_PUBLIC_URL=http://127.0.0.1:5199`.
- **No real provider call, ever:**
  - **Meta Graph:** `META_GRAPH_BASE_URL=http://127.0.0.1:4238`, pointing at `meta-graph-stub-sp15.js` (derived from SP-14's). It binds 127.0.0.1 only, requires `Authorization: Bearer zz-verify-meta-ads-token-*` and a correct `appsecret_proof`, and logs every call with the query string **redacted** of tokens. It serves:
    - `GET /<v>/oauth/access_token?code=zz-verify-code-*` → a token (`zz-verify-code-bad` → OAuth error #100 → `login_expired`);
    - `GET /<v>/me`, `GET /<v>/me/permissions` (scriptable: with and without `ads_read`), `GET /<v>/me/adaccounts`, `GET /<v>/me/accounts`;
    - `GET /<v>/act_<id>` (name, currency `SAR`, `timezone_name` `Asia/Riyadh`, `account_status`), and a second account in `USD`;
    - `GET /<v>/act_<id>/insights` with paging and scripted rows per window, including an ad with no referral;
    - `GET /<v>/<page>?fields=access_token` (a Page token `zz-verify-page-token-*`), `/<page>/leadgen_forms`, `/<form>/leads` (paged, with `field_data`);
    - fault rules via `POST /__control/faults` (190, 17, 200, 500, delay).

    Anything else gives 404, logged as UNEXPECTED.
  - **Creative host:** `META_CDN_TEST_BASE=http://127.0.0.1:4237`, pointing at `fbcdn-stub-sp15.js`. It serves `/<host>/<path>` as a small PNG, an HTML page (refused), a 6 MB file (refused) and a 302 (refused).
  - **Zernio:** `ZERNIO_BASE_URL=http://127.0.0.1:4239/api/v1` and `ZERNIO_API_KEY=zz-verify-stub` (the SP-14 stub; SP-15 makes no Zernio call, so the stub log must show **zero** calls from the capture path).
  - **The launcher refuses to start** unless all of these hold:
    - `ZERNIO_BASE_URL` begins with `http://127.0.0.1`;
    - `ZERNIO_API_KEY` equals `zz-verify-stub`;
    - `META_GRAPH_BASE_URL` begins with `http://127.0.0.1`;
    - `META_CDN_TEST_BASE` begins with `http://127.0.0.1`.

    The SP-13 egress guard (fetch, http and https to any non-loopback host throws and is logged to `blocked-egress-sp15.jsonl`) stays. Before cleanup, the script asserts that `blocked-egress-sp15.jsonl` is empty and that each stub's log holds every provider call the run made.
- `ZERNIO_WEBHOOK_SECRET`, `META_APP_SECRET_WA`, `META_APP_SECRET` and `META_VERIFY_TOKEN` are test values, so replayed webhooks can be signed.
- Tunables for test scale: `META_ADS_SYNC_BATCH=2`, `META_ADS_SYNC_INTERVAL_MS=5000`, `META_ADS_MAX_PAGES=3` (recorded in the notes).
- Test tag `zz-verify-<ts>` on every name and email.

**Setup** (writes only rows tagged with the test tag):
1. Register an owner and a foreign owner. Invite an admin, an agent (`assigned` visibility through a custom role) and a viewer.
2. Insert channels, all `kind whatsapp`:
   - Zernio Z1 (`externalId zz-verify-acc-z1-<ts>`, active);
   - Meta M1 (`externalId zz-verify-phone-<ts>`, `config.wabaId`, token encrypted with the test key).

   The foreign workspace has its own Zernio channel.
3. Record the read-only `Conversation` row count (for the lock note) and the counts listed under Cleanup.

**Checks:**
- **`referral captured only on first inbound` (live):**
  - a signed Meta webhook (M1) text message with referral A (image ad, `ctwa_clid`) → a new contact, conversation, message; `AdSource` A with the exact fields; one `AdReferral` `firstTouch`; `Conversation.adSourceId = A`;
  - a second message without a referral → unchanged;
  - a third with referral B → a second touch, first touch unchanged;
  - the same wamid replayed → no new rows;
  - a Status-placement referral without `ctwa_clid` → `ctwaClid` null.
- **Zernio path:**
  - a signed `message.received` (Z1) with root `metadata.referral` + `metadata.ad {synced:false}` → `adName` null;
  - a second Zernio contact with `metadata.ad {synced:true, name, campaignName, adAccountId}` → names stored, `namesFrom: "zernio"`;
  - the same payload with `message.metadata` instead of root → captured;
  - a `message.sent` echo with a referral → nothing captured;
  - `conversation.started` + `message.received` for one message → one touch.
- **Isolation:** the same `source_id` to the foreign workspace's channel → a separate `AdSource`; this workspace's rows are untouched.
- **Creatives:**
  - the image ad → one stub CDN call, a `Media` row, `AdSource.mediaId` set, and the inbox chip image loads from `/api/media/<id>/file`;
  - a second referral of the same ad → no CDN call;
  - HTML, oversized and redirect links → no Media, and the inbound unaffected.
- **Connect:**
  - `GET /meta-ads/oauth/start` as the owner → a URL to `www.facebook.com/<v>/dialog/oauth` with `config_id=zz-verify-config` and `state`. The verifier extracts `state` and calls the callback with a stub code; the browser is never sent to Facebook.
  - The callback → `pendingTokenEnc` starts `enc:v1:` (DB read) and the redirect has `metaAds=choose`.
  - Candidates list both accounts. Save with an unknown id → 400 `unknown_asset`. Save `act_<SAR>` + Page → `active`.
  - The token appears in no response body, no log line of :4240, and no stub log (grep).
  - A state replayed after the admin's role is changed to viewer → `metaAds=error`.
  - An agent or viewer gets 403 on start, candidates, save, check and disconnect. The viewer reads `GET /meta-ads/connection` and the agent gets 403 on it (no `connectors` action).
- **Sync:**
  - sweep → 13 insights windows, `AdSpendDaily` rows in SAR, `spendBackfilledAt` set; an ad with spend and no referral appears with names and Unknown creative;
  - a second sweep after 5 s → 3-day window only;
  - batch 2 with 3 due connections (two extra throwaway workspaces) → 2 then 1;
  - fault 17 → stop with no retry (stub log), still `active`;
  - fault 190 → `needs_reconnect`, **exactly one** `Notification` per `connectors.manage` holder (owner, admin), none for the agent or viewer, title `meta_ads.needs_reconnect`; a second sweep → no new notification;
  - re-save → `active` again.
- **Metrics:**
  - `GET /ad-sources/overview` for the range → started counts equal the touches made (distinct conversations), spend equals the stub's sum, cost = spend / started; an ad with spend and 0 started → cost null;
  - after disconnect → spend `null` everywhere, not 0;
  - a range of 400 days → 400 `ads.range_invalid`.
- **Per-ad conversations:** the owner sees all; the `assigned` agent sees only the conversation assigned to them; the foreign owner gets 404 on `GET /ad-sources/<id>` and `/conversations`.
- **Lead forms** (if ruled in):
  - sweep → leads imported; a lead with a phone matching the M1 contact links to it with no field changed; a new email-only lead creates a contact `source: "meta_lead_form"`;
  - a re-sweep imports nothing new;
  - `GET /contacts/:id/meta-leads` shows the submissions;
  - the Page token never appears in the DB or logs;
  - a contact delete removes its leads.
- **Disconnect:** both token columns null (DB), `AdSpendDaily` kept, the Connection tab shows Disconnected.
- **Index use:** `EXPLAIN` (no `ANALYZE`) of the overview's touch query and of the per-ad conversation page inside `BEGIN; SET LOCAL enable_seqscan = off; … ROLLBACK;` uses `AdReferral_workspaceId_adSourceId_referredAt_idx`.
- **Migration rerun:** execute the SP-15 migration SQL again inside a transaction that is always rolled back: no errors and 0 rows changed. If the tool safety layer refuses DDL even in a rolled-back transaction (as in SP-13/14), record it and ask the user; do not reroute.
- **UI through the `verify` skill:**
  - the Ads overview and per-ad page in English and Arabic (RTL): Unknown spend with its reason, "No conversations yet", the daily chart, two currencies;
  - the connect flow (status, picker dialog, check countdown, disconnect dialog);
  - the inbox chip, the header card and the Ad source filter (any / none / specific), with the hash surviving a reload;
  - the contact leads card;
  - the reconnect notification and its deep link;
  - screenshots.

**Cleanup:**
- Delete only the recorded test rows: the workspaces (the cascade covers channels, conversations, messages, `AdSource`, `AdReferral`, `AdSpendDaily`, `MetaAdsConnection`, `MetaLead`, media, notifications and roles), then the users. Delete the re-hosted media files from storage by their recorded `storedPath`.
- Run a residue sweep over every table with a `workspaceId` column, including the five new ones.
- Read-only counts before and after: `Workspace`, `User`, `Channel`, `Conversation`, `Message`, `Contact`, `Media`, `Notification`, `Role`, `WorkspaceMember`, `AdSource`, `AdReferral`, `AdSpendDaily`, `MetaAdsConnection`, `MetaLead`. Every count must be identical (the new tables: 0 before and after).
- Stop :4240, the three stubs and the control port, and remove the outDir.

Then tick SP-15's "Detailed plan written" and "Shipped" boxes in the roadmap, noting the rulings taken and the deviations. Add the deferred items to the roadmap:
- Messenger/Instagram ad referrals (ruling 4);
- the Zernio conversation-metadata backfill (ruling 5);
- multiple ad accounts and Pages, deleting stored ads data (ruling 10);
- the Salma chat UI (to SP-18) and Zernio Ads as a spend source (ruling 11);
- ad delivery status, Conversions API events to Meta, and the `leadgen` webhook;
- the Meta app setup the user must supply (the section above);
- the pending real-provider checks (ruling 13).
