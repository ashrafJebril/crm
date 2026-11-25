# SP-14 Number and Template Health: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- **Number health.** Each WhatsApp number (Zernio or Meta-direct) shows its quality rating, messaging-limit tier, display-name status, business verification, two-step (code) verification, messaging availability (blocked / limited), the Meta phone status, the account review status, and a summary of its templates. Every value names when it was checked. A field the provider cannot supply reads **Unknown**, never a guess (roadmap rule).
- **Live check.** `POST /channels/:id/health/check` reads the provider now, at most once per minute per number. Zernio calls go through the shared SP-13 budget.
- **Daily sweep.** Every number is re-checked about once a day by a bounded, idempotent, re-entrancy-guarded scheduler.
- **Downgrade alerts.** When a number gets worse (quality drops, tier drops, messaging becomes limited or blocked, the name is declined, the account review is rejected, a template is paused or disabled), the people who manage channels get one `connector_needs_attention` notification per downgrade, not one per sweep.
- **Template health.** `Template.status` gains `paused` and `disabled`, and `Template.quality` holds Meta's template quality where a provider supplies it. The Templates screen shows the new badges and a per-template health sheet listing the template's status on every number. Campaign launch refuses a paused or disabled template with keyed errors, in line with SP-13's `template_not_approved` and `template_missing_on_number`.
- **Per-number templates (carried from SP-13 R4 and SP-19 R8).** Read-only per-number template status from each number's health snapshot, plus (subject to ruling 11) "Copy to number" for Zernio numbers.

**Architecture:**
- **What each provider can supply (checked in public docs on 2026-11-09; read-only, no API call).** Sources:
  - Zernio: `docs.zernio.com/whatsapp/get-whatsapp-number-info.mdx` (`GET /v1/whatsapp/number-info?accountId`), `accounts/get-account-health.mdx`, `whatsapp/get-whatsapp-templates.mdx`, `webhooks/whatsapp/whatsapp-template-status-updated.mdx`, `whatsapp/list-whatsapp-account-events.mdx`, and the index `docs.zernio.com/llms.txt`.
  - Meta: `developers.facebook.com/documentation/business-messaging/whatsapp/` pages `reference/whatsapp-business-phone-number/whatsapp-business-account-phone-number-api.md` (PhoneNumberInfo, status enum), `reference/whatsapp-business-account/whatsapp-business-account-api.md` (`account_review_status`, `business_verification_status`), `reference/whatsapp-business-account/message-template-api.md` (status enum, `quality_score`), `templates/template-quality.md`, `messaging-limits.md` (`messaging_limit_tier` deprecated; use `whatsapp_business_manager_messaging_limit`), `support/health-status.md` (`health_status.can_send_message`), `webhooks/reference/{phone_number_quality_update,message_template_quality_update,message_template_status_update}.md`.

  | Health field | Meta-direct number (Graph) | Zernio number |
  |---|---|---|
  | Quality rating | **Available.** Phone `quality_rating`: `GREEN`/`YELLOW`/`RED`/`NA` | **Available.** number-info `phone.quality_rating`: `GREEN`/`YELLOW`/`RED`/`UNKNOWN` |
  | Messaging-limit tier | **Available.** Phone `whatsapp_business_manager_messaging_limit` (new), with the deprecated `messaging_limit_tier` as fallback. Meta sets the limit per business portfolio. | **Available.** `phone.messaging_limit_tier` (the docs give examples only: `TIER_250`, `TIER_1K`, `TIER_UNLIMITED`) |
  | Display-name status | **Available.** Phone `name_status`: `APPROVED`/`AVAILABLE_WITHOUT_REVIEW`/`PENDING_REVIEW`/`DECLINED`/`EXPIRED`/`NONE` | **Available.** `phone.name_status`, same enum |
  | Business verification (`verified`) | **Available.** WABA `business_verification_status`: `VERIFIED`, `NOT_VERIFIED`, `PENDING*`, `REJECTED`, `EXPIRED`, `FAILED`, `INELIGIBLE`, `REVOKED` | **Unknown.** number-info has a `waba` object, but its sub-fields are undocumented |
  | Code (two-step) verification | **Available.** Phone `code_verification_status`: `VERIFIED`/`UNVERIFIED` | **Unknown.** Not in the number-info schema |
  | Messaging availability (blocked/limited) | **Available.** Phone `health_status.can_send_message`: `AVAILABLE`/`LIMITED`/`BLOCKED` | **Available (passthrough).** `phone.health_status` is documented as Meta's `can_send_message` object, with no further fields. We parse `can_send_message` only when it is one of the three Meta values; otherwise Unknown |
  | Phone status (`CONNECTED`, `FLAGGED`, `RESTRICTED`, …) | **Available.** Phone `status`, enum in WhatsAppBusinessAccountToNumberStatus | **Available.** `phone.status` (example `CONNECTED`); account-health says `BANNED` is possible |
  | Account review | **Available.** WABA `account_review_status`: `APPROVED`/`DEFERRED`/`PENDING`/`REJECTED` | **Unknown.** Not documented |
  | Template status incl. PAUSED/DISABLED | **Available.** `/{waba}/message_templates?fields=…,status`, enum incl. `PAUSED`, `DISABLED`; plus the `message_template_status_update` webhook | **Available via webhook.** `whatsapp.template.status_updated` lists `APPROVED, REJECTED, PENDING, PAUSED, DISABLED, IN_APPEAL, PENDING_DELETION`. The list endpoint documents only `APPROVED, PENDING, REJECTED`, but says it reads the Cloud API directly, so other values are mapped verbatim when they appear (unverified, ruling 1) |
  | Template quality | **Available.** Template `quality_score.score`: `GREEN`/`YELLOW`/`RED`/`UNKNOWN`; plus the `message_template_quality_update` webhook | **Unknown.** Not documented. Read `quality_score.score` only if Zernio passes it through (ruling 1) |

- **One normalized shape, two readers** (`backend/src/channels/health/`):
  - `zernio-health.reader.ts` makes 2 calls per check: `ZernioClient.whatsappNumberInfo(accountId)` (new; `GET /whatsapp/number-info`) and the existing `whatsappTemplates(accountId)`. Each goes through the shared budget (below).
  - `meta-health.reader.ts` reads **one Graph field per call**, as Tkana's `packages/whatsapp/src/health.ts` does, so a field one Graph version does not know fails alone instead of failing the whole check:
    - phone: `quality_rating`, `whatsapp_business_manager_messaging_limit` (then `messaging_limit_tier` on error), `name_status`, `code_verification_status`, `health_status`, `status`;
    - WABA: `business_verification_status`, `account_review_status`;
    - templates: `/{waba}/message_templates?fields=id,name,language,status,quality_score,category,rejected_reason&limit=100`, at most 5 pages.

    Credentials come from `credentialsFor` (SP-19). The WABA id comes from `Channel.config.wabaId`, or `Integration.raw.wabaId` for a legacy-linked number. Without a token or WABA id, the affected fields are Unknown with error `missing_credentials`.
  - Both produce a `RawHealthRead`. The pure `health-model.ts` turns it into the stored `ChannelHealth` (Global Constraints), computes `overall` and `issues`, and runs the downgrade evaluator.
- **Writes never bump `Channel.updatedAt`.** SP-19 uses `updatedAt` as the routing tie-break (SP-19 T1 M3, `stampLastInbound`). So every health write is raw SQL:
  - **Claim:** `UPDATE "Channel" SET "healthAttemptedAt" = $now WHERE id = $id AND "workspaceId" = $ws AND ("healthAttemptedAt" IS NULL OR "healthAttemptedAt" < $now - cooldown) RETURNING …`. This is the cooldown and the cross-machine lease in one statement.
  - **Write:** `UPDATE "Channel" SET health = $json, "healthCheckedAt" = $now WHERE id = $id AND "healthAttemptedAt" = $claimToken`. A check whose claim was superseded writes nothing (fencing).
- **Live check** (`POST /channels/:id/health/check`): load by `(id, workspaceId)` (404 `channels.not_found`); refuse a non-WhatsApp channel or a provider other than `zernio`/`meta` with 400 `channels.health_unsupported {provider}`; refuse `disconnected` with 409 `channels.disconnected`. Then claim; a lost claim gives 429 `channels.health_check_cooldown {retryAfter, nextAt}`. Read, normalize, write, notify on downgrade, and return the channel DTO with its health. A provider failure never gives a 5xx: the failing fields become Unknown with `error: "check_failed"`, and `lastKnown` keeps their previous value and time.
- **Daily sweep** (`ChannelHealthScheduler`): `@Cron(EVERY_HOUR) sweep(now)`.
  - **Re-entrancy:** an in-process `running` flag, plus the per-row claim, so overlapping ticks or two machines check a number once.
  - **Selection:** due numbers through `prisma.channel.findMany` (so the verifier can confine it): `kind "whatsapp"`, provider in `zernio|meta`, status in `active|needs_attention`, and `healthAttemptedAt` null or older than `HEALTH_SWEEP_INTERVAL_MS` (default 24 h), ordered `healthAttemptedAt asc nulls first, id asc`.
  - **Bounds:** at most `HEALTH_SWEEP_BATCH` (default 50) per tick, checked sequentially, and the tick stops after `HEALTH_SWEEP_MAX_MS` (default 10 min).
  - **Idempotent:** a second tick right after finds nothing due.
  - For each workspace's default Zernio number, the sweep reuses the templates list it just read to reconcile the workspace's `Template` rows (no extra call).
- **Downgrade notifications** (`health-alerts.ts`, pure):
  - Each signal has a severity level; `ChannelHealth.alerts` stores the level last notified per signal. A check notifies only when some signal's **known** level is worse than its stored alert level. It then raises the stored level.
  - An improvement lowers the stored level silently, so a later drop notifies again. An Unknown value neither raises nor lowers it. The first check of a number sets the baseline silently (ruling 8).
  - The notification is sent only by the writer that won the fenced write, after the write: at most once per downgrade (ruling 8).
  - **Recipients:** members whose effective role grants `channels.update` (owner and admin by default; custom roles included).
  - **Payload:** type `connector_needs_attention`; title key `channel.health_downgraded`; body `{channelId, name, phone, changes: [{signal, from, to}]}`; no `recordKind` (`channel` is not a `RecordKind`). The frontend deep-links it to `#/channels?id=<channelId>`.
- **Templates:**
  - `TemplatesService.mapStatus` gains `PAUSED → paused` and `DISABLED → disabled` (today both fall to `pending`, so a paused template looks pending). `Template.status` is a free `String`, so no DB change is needed. The values stay lowercase like the existing ones.
  - `reconcile` also writes `quality` from `quality_score.score`, when the provider sends it.
  - The Meta webhook's `mapTemplateEvent` is corrected: `FLAGGED` no longer becomes `paused` (Meta: flagged templates are still sendable); `DISABLED → disabled`; `REINSTATED → approved`. A new `message_template_quality_update` handler sets `Template.quality` by `metaTemplateId`.
  - Zernio's `whatsapp.template.status_updated` is new in `ZernioService.handleEvent`. It is unhandled today and falls to "Unhandled Zernio event".
- **Per-number templates.** Each number's health holds a template snapshot (`templates.items`, at most 500, `truncated` flag). `GET /channels/:id/templates` lists it. `GET /templates/:id/health` gives one template's status on every number. The snapshot is for display only: launch keeps SP-13's live per-sender read, which stays authoritative.
- **Campaign launch** (SP-13 check 5 and check 9):
  - Template stored as `paused` → 400 `campaigns.template_paused`; `disabled` → 400 `campaigns.template_disabled` (both before `template_not_approved`).
  - `templateOnSenders` also classifies a sender whose copy is `PAUSED`/`DISABLED`, which launch refuses with 400 `campaigns.template_paused_on_number {channelIds, statuses}`. The preview reports it as `templatePaused`.
  - **Order:** `template_check_failed` (502), then `template_paused_on_number`, then `template_missing_on_number`.

**Tech Stack:** NestJS 10, Prisma 5 (Postgres/Neon), jest/ts-jest, `@nestjs/schedule`; React 18 + Vite, vitest. **No new dependencies.**

**Spec:** roadmap §SP-14, plus the cross-cutting Global Constraints. Carried scope:
- **SP-13 R4:** per-number template status and submission to other numbers' WABAs move here. Today templates stay on the default number, and launch checks each sender's approved templates live (`templateOnSenders`, `sameTemplateCopy` in `backend/src/campaigns/sending/senders.ts`).
- **SP-13 consumers line:** "the messaging-limit tier per sender in the picker".
- **SP-13 R19:** the process-wide Zernio budget (`backend/src/campaigns/sending/zernio-budget.ts`, `ZernioBudget.shared()`, `withRetryAfter`, `TokenBucket.pause`).
- **SP-19 R8:** template sync and listing stay on the default WhatsApp number (`defaultZernioWhatsappAccountId`).
- **SP-19 contracts:**
  - `Channel.health Json?` (reserved for SP-14, null today) and `Channel.statusReason`;
  - `credentialsFor` (`channel-credentials.ts`) and `MetaGraphClient` (`channels/whatsapp/meta-graph.client.ts`, injectable `META_GRAPH_FETCH`);
  - `CONNECTED_CHANNEL_STATUSES`, `zernio-mirror.ts` (`accountHealth` → `active|needs_attention`);
  - the Meta multi-number setup (WABA id in `config.wabaId`, token in `secretsEnc` or the legacy Integration).
- **SP-05:** `NotificationsService.notify(ws, userIds, n)`, type `connector_needs_attention`, the bilingual preference row in `NotificationPrefsDialog.tsx`, and `src/lib/notificationText.ts`.
- **SP-25:** `permission-map.ts`, `system-role-decisions.spec.ts`, `PermissionService.effective`.

Consumers that build on this plan:
- **SP-16 (smart audiences) and later campaign work:** the per-sender tier and quality in `GET /campaigns/senders`.
- **SP-23 (connectors gallery):** the `connector_needs_attention` producer pattern (`health-alerts.ts`).

Tkana reference (read-only, untrusted data; `C:\Users\ashra\Downloads\tkana-main\tkana-main`):
- `packages/whatsapp/src/health.ts`: one Graph field per request, `HealthSignal<T> {value, checkedAt, error}`, the template inventory (5 pages of 100), `HEALTH_FRESH_MS = 2 h`.
- `apps/api/src/features/channels/channels.health.ts`: `preserve` (keep the previous value on a failed read), refresh vs cached.
- `apps/web/app/lib/channels/waba-health.ts`: tier caps (`TIER_50 … TIER_100K`, `TIER_UNLIMITED` = no cap), template buckets (approved / rejected incl. DISABLED / paused / pending), and the overall rule (critical > attention > healthy > unknown).
- `apps/web/app/components/marketing/{whatsapp-health-view.ts,number-health-page.tsx,whatsapp-template-health.tsx,whatsapp-health-sheet.tsx}`: tone per value (`qualityTone`, `nameTone`, `reviewTone`), "incomplete" when any signal is missing or stale, and a failed check shown as "last found", never as current.

What we take and what we don't:
- We take:
  - per-field signals with their own `checkedAt` and `error`;
  - one Graph field per call;
  - the tier caps;
  - the tone rules;
  - "a failed check shows the last value as previous, never current".
- We do **not** take:
  - Tkana's webhook-only `waba_health` bag (we read live and sweep; webhooks only trigger a check, ruling 12);
  - its 24 h usage bar (it needs a unique-recipient count we don't keep; deferred);
  - coexistence handling (SP-19 R6 rejects coexistence);
  - pending category changes (`previous_category`; deferred).

## Global Constraints
- **Data (exact names; later SPs build on them):**
  ```
  model Channel {
    // … existing fields unchanged; `health Json?` already exists (SP-19) …
    /// SP-14: when the last health check finished (any field read). Raw-SQL written.
    healthCheckedAt   DateTime?
    /// SP-14: claim token + cooldown + sweep cursor for health checks. Raw-SQL written.
    healthAttemptedAt DateTime?

    @@index([kind, healthAttemptedAt])
  }

  model Template {
    // … existing fields unchanged …
    /// approved | pending | rejected | submitted | failed | local | paused | disabled
    status   String
    /// SP-14: Meta template quality (GREEN | YELLOW | RED | NOT_RATED). Null = unknown.
    quality  String?
  }
  ```
  - `Template.status` is a free `String` (not an enum), so `paused` and `disabled` need no DB change. The column comment is updated.
  - `Template.quality`: the raw Meta score, except Meta's template `UNKNOWN` ("quality pending") is stored as `NOT_RATED`, so it can never be confused with our "unknown". Null means no provider supplied it.
  - **Why the index:** `Channel(kind, healthAttemptedAt)` serves the sweep's due-number query.
- **`ChannelHealth` (the `Channel.health` JSON, v1; `backend/src/channels/health/health-model.ts`; frontend mirror `src/screens/channels/health/healthModel.ts`):**
  ```
  type Unknown = "unknown";                      // the only sentinel; lowercase
  type SignalError = null | "unsupported"        // the provider can't supply it (permanent)
                   | "check_failed" | "permission_denied" | "missing_data" | "missing_credentials";
  interface Signal { value: string | Unknown; checkedAt: string | null; error: SignalError }
  interface ChannelHealth {
    v: 1;
    provider: "zernio" | "meta";
    checkedAt: string | null;                    // roadmap name; = healthCheckedAt
    trigger: "manual" | "sweep" | "webhook";
    overall: "healthy" | "attention" | "critical" | "unknown";
    quality: Signal;          // GREEN | YELLOW | RED | NOT_RATED (Meta NA)
    tier: Signal;             // TIER_50 | TIER_250 | TIER_1K | TIER_2K | TIER_10K | TIER_100K | TIER_UNLIMITED | TIER_NOT_SET | <digits>
    nameStatus: Signal;       // Meta name_status enum
    verified: Signal;         // business_verification_status (roadmap name)
    codeVerification: Signal; // VERIFIED | UNVERIFIED
    messaging: Signal;        // AVAILABLE | LIMITED | BLOCKED
    phoneStatus: Signal;      // CONNECTED | FLAGGED | RESTRICTED | BANNED | …
    accountReview: Signal;    // APPROVED | DEFERRED | PENDING | REJECTED
    templates: { value: TemplateSummary | Unknown; checkedAt: string | null; error: SignalError };
    issues: string[];         // keyed, see below
    lastKnown: Partial<Record<SignalName, { value: string; checkedAt: string }>>;
    alerts: { baselineAt: string; levels: Partial<Record<AlertSignal, number | string>> };
  }
  interface TemplateSummary {
    total: number; approved: number; pending: number; rejected: number;
    paused: number; disabled: number; lowQuality: number;   // YELLOW or RED
    items: { id: string | null; name: string; language: string; status: string;
             quality: string | Unknown; category: string | null }[];   // ≤ 500
    truncated: boolean;
  }
  ```
  - **Unknown rules (the roadmap rule, enforced in one place, `toSignal`):**
    - A field the provider documents no source for → `{value: "unknown", error: "unsupported"}`. Per the table: Zernio's `verified`, `codeVerification` and `accountReview`, and Zernio template `quality` when absent.
    - A value outside the field's known set is stored verbatim **only** for `phoneStatus`, `tier` (digits allowed) and template `status`, which are open-ended. For the other fields it is `unknown` with `missing_data`.
    - Zernio `quality_rating: "UNKNOWN"` → `unknown` (Zernio does not say whether it means "not rated" or "not read"). Meta `NA` → `NOT_RATED`.
    - A failed read → `unknown` with `check_failed` (or `permission_denied` on Graph 10/200/190). The previous known value moves to `lastKnown`, so the UI can show "last seen GREEN on …" as **previous**, never as current.
  - **`issues`** (keys, each worded in both languages on the frontend):
    - `quality_red`, `quality_yellow`;
    - `messaging_blocked`, `messaging_limited`;
    - `phone_status_<lower>` for any phone status other than `CONNECTED`;
    - `name_declined`, `name_expired`, `name_pending`;
    - `account_review_rejected`, `verification_<lower>` for business verification other than `VERIFIED`;
    - `templates_paused`, `templates_disabled`, `templates_low_quality`;
    - `check_incomplete` when any non-`unsupported` field is unknown.
  - **`overall`:**
    - `critical`: messaging `BLOCKED`, quality `RED`, phone status `RESTRICTED|BANNED|DISCONNECTED`, account review `REJECTED`, or name `DECLINED`.
    - else `attention`: any other issue except `check_incomplete`.
    - else `healthy` when at least quality and messaging are known.
    - else `unknown`.
  - **Alert levels** (`health-alerts.ts`):
    - `quality`: GREEN 0, YELLOW 1, RED 2.
    - `messaging`: AVAILABLE 0, LIMITED 1, BLOCKED 2.
    - `phoneStatus`: CONNECTED 0, FLAGGED / RATE_LIMITED / MESSAGING_LIMIT_* 1, RESTRICTED / DISCONNECTED / BANNED 2.
    - `nameStatus`: DECLINED / EXPIRED 2, else 0.
    - `accountReview`: REJECTED 2, else 0.
    - `tier`: the tier's cap; a lower cap is worse, and `TIER_UNLIMITED` counts as infinite. `TIER_NOT_SET` and unknown are ignored.
    - `templatesBad`: `paused + disabled` count.
- **DTOs:**
  - `ChannelDto` (backend `channel-dto.ts`, frontend `src/lib/types.ts`) gains:
    - `health: ChannelHealthPublic | null`: `ChannelHealth` without `alerts` and with `templates.value.items` removed;
    - `healthCheckedAt: string | null`;
    - `healthNextCheckAt: string | null`: `healthAttemptedAt + cooldown`, or null when no cooldown is running.

    Health holds no secrets. Graph and Zernio error text is never stored, only the error keys.
  - `TemplateRow` and the frontend `Template` type gain `quality: string | null`. The frontend `TemplateFull.status` union adds `paused | disabled`, and `toFull` stops collapsing unknown values into `pending` for these two.
- **API:**
  - **`POST /channels/:id/health/check`** (`channels.update`, ruling 4) answers 200 `ChannelDto`. Errors:
    - 404 `channels.not_found` (unknown or foreign id);
    - 400 `channels.health_unsupported {provider}`;
    - 409 `channels.disconnected {channelId}`;
    - 429 `channels.health_check_cooldown {retryAfter (s), nextAt (ISO)}`;
    - 429 `channels.health_check_busy {retryAfter}`: the per-workspace cap of `HEALTH_CHECK_WS_PER_MIN` = 10 checks per minute, in memory.
  - **`GET /channels/:id/templates`** (`templates.view`) answers `{channelId, checkedAt, error, truncated, items: TemplateSummary["items"]}` from the snapshot, with no provider call. A foreign id gives 404.
  - **`GET /templates/:id/health`** (`templates.view`) answers:
    ```
    { template: {id, name, lang, status, quality, reviewedAt},
      numbers: {channelId, displayName, phoneNumber, provider, isDefault,
                status: string | "missing" | "unknown", quality: string | "unknown",
                checkedAt: string | null}[] }
    ```
    - Built from every non-disconnected WhatsApp channel's snapshot, matching name and base language as `TemplatesService.key` does.
    - `missing`: the snapshot is known and lacks the template. `unknown`: no snapshot, or the snapshot's templates are unknown.
    - No provider call. A foreign id gives 404 `templates.not_found` (new key, in place of today's English NotFound text on this route only).
  - **`POST /templates/:id/copy-to-number`** (`templates.create`; **only if ruling 11 accepts it**):
    - Body `{channelId}`. The target must be an `active` Zernio WhatsApp channel of the workspace that is not the default, else 400 `templates.number_invalid {channelId}`. As in SP-13 R11, a foreign id gets the same answer as a missing one.
    - The template must be `approved` on the default number, else 400 `templates.copy_requires_approved`.
    - **Calls** (2, both budgeted): it reads the target's templates. The same name and base language already there gives 409 `templates.already_on_number {status}`. Otherwise it submits `createWhatsAppTemplate({accountId: target, …buildComponents(row)})`. A media header resolves `headerMediaId` as the template editor does, else 400 `templates.header_media_required`. A library template is resubmitted by `libraryTemplateName` when the row came from the library.
    - Answers 201 `{channelId, status}` (Meta's verdict arrives later on the Zernio webhook).
    - Writes no `Template` row (rows stay default-number rows, SP-19 R8).
    - Meta-direct targets give 400 `templates.copy_unsupported {provider:"meta"}` (deferred).
  - **`GET /campaigns/senders`** (SP-13) adds per sender `tier: string | "unknown"`, `quality: string | "unknown"` and `healthCheckedAt`, read from the snapshot.
  - **`POST /campaigns/preview`** adds `templatePaused: {channelId, status}[]`.
- **Error keys:**
  - `channel-errors.ts`: `channels.health_unsupported` (400), `channels.health_check_cooldown` (429), `channels.health_check_busy` (429).
  - New `templates/template-errors.ts` (same `{statusCode, message: key, …extra}` shape as `campaignError`): `templates.not_found` (404), `templates.number_invalid` (400), `templates.copy_requires_approved` (400), `templates.already_on_number` (409), `templates.copy_unsupported` (400). `templates.header_media_required` already exists.
  - `campaign-errors.ts`: `campaigns.template_paused` (400), `campaigns.template_disabled` (400), `campaigns.template_paused_on_number` (400).
  - Frontend copy: `channelErrors.ts`, `campaignErrors.ts` and a new `src/screens/templates/templateErrors.ts`, each with `tx` copy and a test that covers every key.
- **Provider calls:**
  - **Zernio:** every health call (number-info, templates list, copy-to-number reads and submit) runs inside `withRetryAfter`. Its `before` takes `ZernioBudget.shared().campaign` and then a new `ZernioBudget.shared().health` bucket (`ZERNIO_HEALTH_RPM`, default 30). Its `onRateLimit` pauses the shared campaign bucket (`TokenBucket.pause`). Health therefore never starves a campaign launch and always counts against the team-wide limit (ruling 6).
  - **Meta:** `MetaGraphClient` gains `getField(nodeId, field, token)` and `listTemplates(wabaId, token, {after})`.
    - The base URL becomes `metaGraphBase(env)`: `META_GRAPH_BASE_URL` when it is exactly `https://graph.facebook.com` or matches `^http://127\.0\.0\.1:\d{2,5}$`; otherwise the default, with a one-time warning. This is the stub hook for Task 4, and no other host can receive a token (ruling 13).
    - Health uses its own `AbortSignal.timeout(10_000)` per call.
  - Neither reader ever logs a token, and errors keep only Graph's code and HTTP status.
- **Notification copy** (`src/lib/notificationText.ts`, case `channel.health_downgraded`): "<name> needs attention: <first change>" / "<name> يحتاج إلى انتباه: <first change>".
  - Each change is worded per signal, for example "quality dropped to Medium" / "انخفضت الجودة إلى متوسطة", "messaging is blocked" / "المراسلة محظورة", "2 templates paused" / "تم إيقاف قالبين مؤقتًا".
  - A new `notificationHref(n)` in `src/lib/recordLink.ts` returns `#/channels?id=<body.channelId>` for this title, and `recordHref` for everything else. `NotificationsBell.tsx` uses it in its three call sites.
- **Permissions (SP-25).** No catalogue change. `permission-map.ts` adds:
  - `POST /channels/:id/health/check`: `channels.update`
  - `GET /channels/:id/templates`: `templates.view`
  - `GET /templates/:id/health`: `templates.view`
  - `POST /templates/:id/copy-to-number`: `templates.create` (if ruled in)

  `system-role-decisions.spec.ts` adds an `SP-14 health routes` block:
  - owner and admin can check;
  - agent and viewer cannot check (with ruling 4 as recommended);
  - agent and viewer can read both template-health routes;
  - agent can copy, viewer cannot;
  - none of them is blocked for impersonation (`blockedForImpersonation` covers only billing and `campaigns.manage`).

  Every handler loads its row by `(id, workspaceId)` first. A foreign path id returns **404**.
- **Migration:**
  - File: `backend/prisma/migrations/20261114140000_number_template_health/migration.sql`. The timestamp is after `20261114130000_contact_workspace_id_index`. **Every existing migration is applied in production and is never edited.** Hand-written; apply with `npx prisma migrate deploy` only, never `migrate dev`.
  - **Additive and idempotent:**
    ```sql
    ALTER TABLE "Template" ADD COLUMN IF NOT EXISTS "quality" TEXT;
    ALTER TABLE "Channel"  ADD COLUMN IF NOT EXISTS "healthCheckedAt" TIMESTAMP(3),
                           ADD COLUMN IF NOT EXISTS "healthAttemptedAt" TIMESTAMP(3);
    CREATE INDEX IF NOT EXISTS "Channel_kind_healthAttemptedAt_idx" ON "Channel"("kind", "healthAttemptedAt");
    ```
  - **Prisma-conformant names:** `Channel_kind_healthAttemptedAt_idx`. Columns are camelCase quoted, as Prisma generates them.
  - **Check with `prisma migrate diff --from-schema-datamodel <HEAD schema> --to-schema-datamodel prisma/schema.prisma --script`** (no DB). The output must equal the file, apart from `IF NOT EXISTS`, as in SP-13 T1.
  - **Safe for the deployed `main`:**
    - Two nullable columns and one nullable column. `main`'s Prisma client never selects them, and its creates and updates ignore them.
    - No existing column, constraint or index changes. The migration has no `UPDATE`, `DELETE`, `DROP` or `ALTER … TYPE`. The `CREATE INDEX` on `Channel` (tens of rows) locks writes for milliseconds.
    - `main` already writes `Template.status = "paused"` from the Meta webhook and treats any status other than `approved` as not launchable. `disabled` rows written by SP-14 are refused by `main` the same way, and its UI shows them as pending.
    - `main` never reads `Channel.health`.
  - **No backfill.** Health fills on the first check or sweep. `Template.quality` fills on the next reconcile. Old `paused` rows that came from a Meta `FLAGGED` event are corrected by the next reconcile, which reads the provider's real status.
- **Copy and layout:**
  - Every string goes through `tx("English","العربية")` with real Arabic.
  - Logical CSS only (`margin-inline-start`, `padding-inline`, `text-align: start`, `inset-inline-end`).
  - Phone numbers, tier labels (`TIER_2K` → "2,000 / day" / "2,000 / يوم"), counts and template names inside Arabic sentences go in `<bdi dir="ltr">`.
  - Dialogs and sheets set `dir`.
  - **Unknown is a first-class value:** muted "Unknown" / "غير معروف", plus a reason tooltip: "This provider doesn't report it" / "هذا المزوّد لا يوفّر هذه المعلومة" for `unsupported`, and "Couldn't check — last seen …" / "تعذّر الفحص — آخر قيمة …" for `check_failed`. It is never blank, never a dash, and never green.
- **Tests:**
  - backend: `npx jest src/channels src/templates src/campaigns src/integrations src/notifications src/permissions` plus `npx tsc --noEmit -p tsconfig.json`; the full `npm test` once per task. The known unrelated failure is `hjz-client-sync › is inert when HJZ is not configured`.
  - frontend (repo root): `npx vitest run` plus `npm run typecheck`; `npm run build` once in Task 3.
  - **Named acceptance tests (exact names):**
    - `quality drop emits one notification` (backend jest, `src/channels/health/health-alerts.spec.ts`, through the service with the in-memory Prisma double)
    - `unknown fields render as unknown` (frontend vitest, `src/screens/channels/health/healthModel.test.ts`), with backend companion `providers that cannot supply a field return unknown`
  - All provider calls in specs are mocked (`ZernioClient` methods; `META_GRAPH_FETCH` fake from `channels/whatsapp/test-graph.ts`). An unmocked call throws.
- **Commits:** selective `git add <paths>`, never `-A`. Trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not stage `.playwright-mcp/` or any untracked file this plan did not create.

## Review Focus
1. **Never fake data.**
   - Every field the provider table marks Unknown is `unknown` with `unsupported`, from both the check and the sweep.
   - A failed read is `unknown` with `check_failed`, and the old value appears only in `lastKnown`.
   - Unknown never renders green, blank or as a dash.
   - Tests: `providers that cannot supply a field return unknown`, `unknown fields render as unknown`, `a failed read keeps the last value as previous only`.
2. **One notification per downgrade.**
   - The same bad state across many sweeps gives one notification.
   - A further drop gives one more. A recovery then a new drop gives one more.
   - Unknown in between does not re-arm.
   - Two concurrent checks of one number give one notification (fenced write).
   - Test: `quality drop emits one notification` (table-driven), `concurrent checks notify once`.
3. **Provider budgets.**
   - The live check is rate-limited per number (1 per minute, DB-backed, so restarts and two machines agree) and per workspace.
   - Every Zernio health call takes a token from the shared budget, and a 429 pauses the shared bucket.
   - The sweep is bounded per tick and in time.
   - Tests: `live check cooldown is per channel and survives restart`, `every zernio health call takes the shared budget`, `sweep is bounded, idempotent and re-entrancy guarded`.
4. **Paused and disabled templates never launch.**
   - A stored `paused`/`disabled` template, or a sender's live copy that is paused or disabled, refuses launch with its key.
   - The snapshot never allows a launch that the live read refuses.
   - Tests: `paused or disabled template refuses launch with its key`, `sender copy paused refuses launch`.
5. **Tenant isolation and no side doors.**
   - Foreign ids give 404 on all four routes.
   - The Zernio template webhook updates only the workspace that owns the account.
   - `GET /templates/:id/health` lists only this workspace's channels.
   - Health writes never bump `Channel.updatedAt` (routing tie-break).
   - Tests: `foreign ids return 404 on SP-14 routes`, `template webhook is scoped to the owning workspace`, `health writes do not touch updatedAt`.

## Architecture Rulings and Risks
Each item names the risk, then the recommended ruling. Items marked **(needs controller ruling)** are repeated under Controller rulings, where the controller fills in the decision.

1. **Provider field coverage and undocumented passthroughs.** Zernio documents quality, tier, name status, phone status and Meta's `health_status` object on `GET /whatsapp/number-info`. It does not document the `waba` sub-fields (business verification), code verification, account review, or template `quality_score`. Its template list documents only three statuses, while its webhook documents `PAUSED`/`DISABLED`.
   - **Ruling:** follow the table exactly. For Zernio, `verified`, `codeVerification` and `accountReview` are always Unknown (`unsupported`).
   - Values Meta itself defines and Zernio passes through unchanged (template `PAUSED`/`DISABLED` in the list, template `quality_score.score`, `health_status.can_send_message`) are read **only when present and within Meta's enum**; otherwise Unknown. That is real provider data, never a guess.
   - The Task 4 stub covers both shapes. A read-only probe against the real Zernio stays on the pending list (ruling 19). **(needs controller ruling)**
2. **Health JSON shape.** The roadmap names `{quality, tier, nameStatus, verified, checkedAt, issues[]}`. A flat string per field cannot say *why* a value is unknown, or keep the previous value honestly.
   - **Ruling:** keep the roadmap's top-level names, each holding a `Signal {value, checkedAt, error}`. Add `codeVerification`, `messaging`, `phoneStatus`, `accountReview`, `templates`, `overall`, `lastKnown` and `alerts`, versioned `v: 1`. `"unknown"` (lowercase) is the only sentinel. Meta's `NA` and template `UNKNOWN` become `NOT_RATED`. **(needs controller ruling, minor)**
3. **Where the claim and cooldown live.** The cooldown must hold across restarts and machines, and health writes must not bump `Channel.updatedAt`, which SP-19 routing uses as a tie-break.
   - **Ruling:** two new nullable columns, `healthAttemptedAt` (claim token, cooldown, sweep cursor) and `healthCheckedAt`, plus one index. Every health write is raw SQL, fenced on the claim token.
   - **Alternative:** keep everything inside the JSON with `jsonb` compare-and-set. That needs no migration, but the sweep query cannot use an index and the SQL is harder to review. **(needs controller ruling)**
4. **Who may run a live check.** It spends shared Zernio budget and Meta Graph quota, and writes health. Agents hold only `channels.view`.
   - **Ruling:** `channels.update` (owner and admin by default). Everyone with `channels.view` sees the cached health and the last check time.
   - **Alternative:** `channels.view` (in `VIEWER_SAFE_NON_GET`) with the same rate limits. **(needs controller ruling)**
5. **Rate limits.** 1 check per number per 60 s (`HEALTH_CHECK_COOLDOWN_MS`, DB-backed), and at most 10 per workspace per minute (`HEALTH_CHECK_WS_PER_MIN`, in memory per machine, as SP-19's limits with `min_machines_running = 1`). The sweep honours the same per-number cooldown. **(needs controller ruling, minor)**
6. **Zernio budget.** SP-13's bucket is named `campaign`, but it is the only process-wide Zernio budget. Health calls take a `campaign` token, then a `health` token (`ZERNIO_HEALTH_RPM = 30`). Health is therefore capped well below launch traffic, and every call counts against the team-wide 600 rpm (SP-13 R19). A check is 2 Zernio calls; a sweep of 1 000 Zernio numbers is 2 000 calls spread over 20 hourly ticks.
   - **Alternative:** a separate bucket outside `campaign`, which risks the team limit during a launch. **(needs controller ruling)**
7. **"Daily" sweep cadence.** One run at a fixed hour would burst every number at once.
   - **Ruling:** `@Cron(EVERY_HOUR)`. Each tick checks up to 50 numbers whose last attempt is more than 24 h old, sequentially, stopping after 10 minutes. Each number is therefore checked about once a day, and the load is spread.
   - It is re-entrancy guarded (in-process flag plus per-row claim) and idempotent (a second tick finds nothing due).
   - **Alternative:** `EVERY_DAY_AT_5AM` with a batch of 500. **(needs controller ruling)**
8. **What counts as a downgrade, and who hears it.**
   - **Ruling:** the levels in Global Constraints. Notify when any known level is worse than the last-notified level. Improvements re-arm silently, Unknown is ignored, and the first check sets a silent baseline (the page shows the state anyway).
   - One notification per check lists every dropped signal. It goes to every member whose effective role grants `channels.update`, through `NotificationsService.notify`, which honours `inApp` preferences.
   - Delivery is at most once: notify after the fenced write, and a crash between the two loses that alert (logged).
   - No `recordKind`, because `channel` is not a `RecordKind` and adding one would change SP-06's contract. Deep-link through `notificationHref`.
   - **Alternatives:** also notify `templates.update` holders on template pauses, which reaches every agent by default; or notify on a bad first baseline. **(needs controller ruling)**
9. **Template status values and existing mappings.**
   - Status stays lowercase: `paused`, `disabled`.
   - `TemplatesService.mapStatus` maps `PAUSED`/`DISABLED` (today both are `pending`, which hides pauses). `IN_APPEAL` and `PENDING_DELETION` stay `pending`. Other unknown values keep today's `pending` default.
   - The Meta webhook's `FLAGGED → paused` is wrong per Meta's docs (a flagged template is still sendable): `FLAGGED` changes no status. `DISABLED → disabled`; `REINSTATED → approved`.
   - **Ruling:** accept. Existing rows self-correct on the next reconcile. The frontend's `toFull` stops collapsing `paused` into `pending`. **(needs controller ruling)**
10. **Launch and preview with paused or disabled templates.**
    - **Ruling:**
      - check 5 gains `campaigns.template_paused` / `campaigns.template_disabled` before `template_not_approved`;
      - check 9's live per-sender read classifies `PAUSED`/`DISABLED` copies as `campaigns.template_paused_on_number {channelIds, statuses}`, ordered after `template_check_failed` and before `template_missing_on_number`;
      - the preview adds `templatePaused`.
    - The stored snapshot never authorizes a send. The live read stays the authority, as in SP-13 R4.
    - A template paused **during** a background launch is already an account-wide rejection in SP-13's runner (fix round 1 m1), and the job fails with `campaigns.launch_failed`. Mapping that `lastError` to `campaigns.template_paused` is a small optional refinement in Task 2. **(needs controller ruling)**
11. **Per-number template management scope (carried from SP-13 R4).**
    - **Recommended for SP-14:**
      - **(a) read-only per-number status:** each number's health keeps a template snapshot. `GET /channels/:id/templates` and `GET /templates/:id/health` list it, and the template health sheet shows the template on every number (approved / paused / disabled / rejected / missing / unknown).
      - **(b) "Copy to number" for Zernio numbers:** resubmit an approved default-number template to another Zernio number's WABA. It is one route, with an existence check first (409 when already there). Meta reviews it, and the status arrives by webhook and the next check. No `Template` row is created for the copy.
    - **Defer:**
      - submission to Meta-direct numbers (templates are submitted through Zernio today, R8);
      - per-number editing and deleting;
      - a per-number template table (`ChannelTemplate`);
      - choosing which number's templates the Templates screen lists.
    - (b) is self-contained (Task 2 backend section B6, Task 3 frontend section F5). If the controller prefers to keep SP-14 at size M, drop (b) and record it as a follow-up. **(needs controller ruling)**
12. **Meta quality webhooks as triggers.** Meta sends `phone_number_quality_update` (tier and throughput changes) and `message_template_quality_update`, but only if the app subscribes to those fields in the Meta App Dashboard. That is a user action outside the code.
    - **Ruling:** add handlers in `WhatsAppService.handleWebhook`:
      - the phone event schedules a check of the matching Meta channel (by `entry.id` = WABA and `display_phone_number`), with `trigger: "webhook"` and the cooldown respected;
      - the template event sets `Template.quality` by `metaTemplateId`.
    - The payload is a trigger, not a source of field values. Document the subscription step in the PR. **(needs controller ruling, minor)**
13. **Meta Graph version and deprecated fields.** We call `v21.0` by default. Meta's docs now show v27 and mark `messaging_limit_tier` deprecated in favour of `whatsapp_business_manager_messaging_limit`, which v21 may not know.
    - **Ruling:** one field per call, trying the new limit field and then the deprecated one; Unknown if neither answers. No version bump in SP-14.
    - `META_GRAPH_BASE_URL` accepts only `https://graph.facebook.com` or a loopback `http://127.0.0.1:<port>` (for the verification stub); anything else falls back to the default, so a mistyped env can never send a token elsewhere. **(needs controller ruling)**
14. **The messaging limit is per business portfolio.** Meta's messaging-limits page says the limit is set for the portfolio and shared by all its numbers. The page labels the tier "Daily limit (shared by numbers in this business)" / "الحد اليومي (مشترك بين أرقام هذا النشاط)". **(needs controller ruling, minor)**
15. **Zernio template webhook** (`whatsapp.template.status_updated`) is new.
    - Scope: resolve the workspace through the Zernio channel with `externalId = account.accountId` (non-disconnected, most recent), then update `Template` rows in that workspace only, by `metaTemplateId = template.templateId`, else by name and base language.
    - It also schedules a check of that channel (`trigger: "webhook"`, cooldown respected), so a pause on any number reaches the snapshot and the alert evaluator.
    - Unknown accounts are logged and ignored. **(needs controller ruling, minor)**
16. **Sender picker tier (SP-13 consumer).** `GET /campaigns/senders` adds `tier`, `quality` and `healthCheckedAt` from the snapshot, shown as chips in the picker. It is display only and never gates selection. **(needs controller ruling, minor)**
17. **Verification touches production** (as SP-12 R14 and SP-13 R20).
    - Task 4 runs against the production DB in throwaway test workspaces, with local stubs for both Zernio and Meta Graph. No provider is reached.
    - The migration needs the user's **explicit approval** before `migrate deploy`; earlier approvals do not carry over.
    - The deployed app is unaffected: it has no health code, and test channels carry fake account ids that no deployed cron reads. **(needs controller ruling)**
18. **Size.** The roadmap says M. With the template status fixes, the campaign keys, the webhooks and (b) copy-to-number, it is a large M. The plan has 3 build tasks plus verification. Dropping (b) (ruling 11) keeps it a firm M. **(needs controller ruling)**
19. **Unverified provider behaviour** (to record as pending real checks, as SP-13 did):
    - Zernio number-info's real shape: the field names under `phone`, the content of `waba`, the shape of `health_status`;
    - whether Zernio's template list carries `PAUSED`/`DISABLED`, and whether it passes `quality_score` through;
    - the `whatsapp.template.status_updated` delivery and signature;
    - whether Graph v21 serves `whatsapp_business_manager_messaging_limit`.

    The readers are defensive (Unknown on any surprise). **(needs controller ruling, minor)**

### Controller rulings
*Decided 2026-11-09.*
- **R1** Accept the coverage table. A Zernio field Zernio doesn't document is read only when Zernio actually passes the real Meta value through. Then it is shown with its source. Otherwise it is `unknown`. Never infer or default a value.
- **R2** Accepted.
- **R3** Accepted. The two new Channel columns get raw-SQL writes that never touch `updatedAt`, because SP-19 uses it for routing ties.
- **R4** A live check requires `channels.update`. Viewing health requires `channels.view`.
- **R5** Accepted.
- **R6** Accepted.
- **R7** Accepted.
- **R8** Accepted. The first check is a silent baseline. Notifications go to `channels.update` holders, once per downgrade, and re-arm after a recovery.
- **R9** Accepted, including the `FLAGGED` fix (still sendable, so it is not mapped to `paused`).
- **R10** Accepted.
- **R11** Accepted as recommended. Per-number template status is read-only, and copy-to-number between Zernio numbers lives in its own droppable section. Defer Meta-direct submission, per-number edit/delete and a per-number template table. If copy-to-number grows Task 2 beyond review size, drop it to a follow-up.
- **R12** Accepted. The Meta App Dashboard subscription to the template quality fields is a **user action**, documented in the runbook and the PR.
- **R13** Accepted.
- **R14** Accepted.
- **R15** Accepted.
- **R16** Accepted.
- **R17** The migration `20261114140000_number_template_health` needs the user's explicit approval before it is applied. The user must not run `migrate deploy` on their own.
- **R18** Accepted (large M).
- **R19** Accepted. List these behaviours in the PR as pending a real check.

---

### Task 1: Backend — schema, migration, provider readers, health model and the live check
**Owns:** `schema.prisma` and the migration for all of SP-14. Tasks 2 and 3 depend on this schema and do not edit it.

**Files:**
- `backend/prisma/schema.prisma`: the Global Constraints → Data changes.
- `backend/prisma/migrations/20261114140000_number_template_health/migration.sql`.
- Create `backend/src/channels/health/`, each with a spec:
  - `health-model.ts` (pure):
    - types (`ChannelHealth`, `Signal`, `TemplateSummary`, `RawHealthRead`);
    - `UNKNOWN`;
    - `toSignal(raw, field, {provider, now})`;
    - `normalizeQuality`, `normalizeTier`, `tierCap`;
    - `summarizeTemplates(items, {max: 500})`;
    - `computeIssues`, `computeOverall`;
    - `mergeHealth(previous, read, {now, trigger})`: carries `lastKnown` and `alerts`;
    - `publicHealth(health)`: drops `alerts` and `items`.
  - `health-alerts.ts` (pure): `ALERT_LEVELS`, `alertLevel(signal, value)`, `evaluateAlerts(previousAlerts, health, now) → {changes: {signal, from, to}[], alerts}`. This is the baseline, re-arm and unknown-ignored logic. Task 2 wires it to notifications, but the pure function and its table spec live here.
  - `zernio-health.reader.ts`: `readZernioHealth(zernio, budget, accountId) → RawHealthRead`. It makes 2 budgeted calls; a 404 or "account not found" makes every field `check_failed`, and the channel status stays the sync's job.
  - `meta-health.reader.ts`: `readMetaHealth(graph, creds, wabaId) → RawHealthRead`. One field per call; the limit fallback; templates at most 5 pages of 100; Graph codes 10/200/190 → `permission_denied`; missing token or WABA → `missing_credentials`.
  - `health-budget.ts`: `zernioHealthCall(fn, budget)`, which is `withRetryAfter` with `before` taking the `campaign` then the `health` token, and `onRateLimit` pausing `campaign`. `ZernioBudget` gains the `health` bucket (`ZERNIO_HEALTH_RPM`, default 30) in `zernio-budget.ts`.
  - `channel-health.service.ts`:
    - `check(ws, channelId, {trigger, now}) → ChannelDto`: load, guard, claim (raw SQL), read, merge, fenced write (raw SQL), return. It calls an optional `onDowngrade` hook that Task 2 binds.
    - `claim(...)`, `write(...)`;
    - `wsLimiter` (10 per minute).
  - `channel-health.controller.ts`: `POST /channels/:id/health/check`. It is in `ChannelsModule` (imports `ChannelsCoreModule`; `MetaGraphClient` is global there).
- `backend/src/integrations/zernio.client.ts`: `whatsappNumberInfo(accountId) → ZernioNumberInfo` (`GET /whatsapp/number-info?accountId`), typed defensively (`phone?`, `waba?`, all optional). `ZernioWhatsAppTemplate` gains optional `quality_score?: {score?: string}`. Spec with a mocked fetch.
- `backend/src/channels/whatsapp/meta-graph.client.ts`: `metaGraphBase(env)`, `getField(nodeId, field, token)`, `listTemplates(wabaId, token, {after?})`. Specs through `test-graph.ts`.
- `backend/src/channels/channel-dto.ts`: `health` (public), `healthCheckedAt`, `healthNextCheckAt`.
- `backend/src/channels/channel-errors.ts`: the three new keys.
- `backend/src/channels/test-prisma.ts`: the new columns; the raw-SQL claim and fenced write patterns (as with `stampLastInbound`); `updatedAt` left untouched by them.
- `backend/src/permissions/permission-map.ts`: `POST /channels/:id/health/check`. Rows in `permission-map.spec.ts` and `system-role-decisions.spec.ts`.
- `backend/.env.example`: `ZERNIO_HEALTH_RPM`, `HEALTH_CHECK_COOLDOWN_MS`, `HEALTH_CHECK_WS_PER_MIN`, `META_GRAPH_BASE_URL` (commented, empty).

**Produces (contract for Tasks 2–3):**
- `ChannelHealthService.check(ws, id, {trigger, now})`, and `ChannelHealthService.checkClaimed(row, token, trigger)` for the scheduler.
- `ChannelHealth` / `publicHealth` / `evaluateAlerts`: the exact shapes in Global Constraints.
- `ChannelDto.health`, `healthCheckedAt`, `healthNextCheckAt`.
- `ZernioBudget.shared().health`, `zernioHealthCall`.
- `ZernioClient.whatsappNumberInfo`, `MetaGraphClient.getField` / `listTemplates`.

- [ ] Write the failing tests:
  - `migration is additive, idempotent and Prisma-named (SP-14)` (reads the SQL):
    - every `ADD COLUMN` and `CREATE INDEX` has `IF NOT EXISTS`;
    - the names are exactly as listed;
    - there is no `DROP`, `UPDATE`, `DELETE`, `ALTER COLUMN` or `TYPE`;
    - the folder name is greater than `20261114130000`;
    - the sha256 values of `20261114120000_campaign_sending` and `20261114130000_contact_workspace_id_index` are pinned (unchanged);
    - `prisma migrate diff` from the HEAD schema produces the same statements (as SP-13 T1 recorded).
  - **`providers that cannot supply a field return unknown`**:
    - a Zernio read with every documented field set gives known values for quality, tier, nameStatus, messaging and phoneStatus, and `{value:"unknown", error:"unsupported"}` for `verified`, `codeVerification` and `accountReview`;
    - Zernio template quality is unknown when `quality_score` is absent and `GREEN` when present;
    - Zernio `quality_rating: "UNKNOWN"` gives unknown; Meta `NA` gives `NOT_RATED`;
    - a `can_send_message` outside the Meta enum gives unknown with `missing_data`;
    - a Meta read with every field gives no unknowns.
  - `a failed read keeps the last value as previous only`: a Meta read where `quality_rating` throws gives quality `unknown` with `check_failed`, `lastKnown.quality = {value:"GREEN", checkedAt}`; `overall` does not count the old value.
  - `meta reader reads one field per call and falls back for the messaging limit`: `whatsapp_business_manager_messaging_limit` → #100 → `messaging_limit_tier` → `TIER_2K`; both failing → unknown. A 190 → `permission_denied`. No token → `missing_credentials` with **zero** Graph calls. The token never appears in a thrown error or a log line (spy on `Logger`).
  - `meta graph base url accepts only graph.facebook.com or loopback`.
  - `template summary counts buckets, caps at 500 and flags truncation`: DISABLED counts as disabled, not rejected; YELLOW and RED count as `lowQuality`.
  - `overall and issues follow the severity rules` (table).
  - `evaluateAlerts table` (pure; the detailed notification test lives in Task 2):
    - baseline silent;
    - GREEN→YELLOW is one change;
    - YELLOW→YELLOW none;
    - YELLOW→RED one;
    - RED→unknown none, and alerts unchanged;
    - RED→GREEN none, and re-armed;
    - GREEN→YELLOW one again;
    - tier 10K→2K one; 2K→UNLIMITED none;
    - templatesBad 0→2 one, 2→1 none, 1→3 one.
  - `live check cooldown is per channel and survives restart`:
    - two checks within 60 s → the second gives 429 `channels.health_check_cooldown {retryAfter, nextAt}` with no provider call;
    - a new service instance (restart) still refuses, because the cooldown lives in the DB;
    - another channel is unaffected;
    - after 60 s the check passes.
  - `workspace check cap`: the 11th check in a minute across different channels gives 429 `channels.health_check_busy`.
  - `concurrent checks write once`: two claims race; the loser gets 429 and writes nothing. A check whose claim was superseded mid-read writes nothing (fenced).
  - `health writes do not touch updatedAt`: `Channel.updatedAt` is identical before and after a check.
  - `every zernio health call takes the shared budget`: with a fake clock, tokens taken equal calls made for both buckets; a 429 with Retry-After pauses the shared `campaign` bucket and is retried.
  - `check refuses non-whatsapp, unsupported provider and disconnected channels`: 400 `health_unsupported {provider:"telegram"}` / webchat; 409 `channels.disconnected`.
  - `foreign ids return 404 on SP-14 routes` (part 1): `POST /channels/:id/health/check` with workspace B's id from A.
  - `channel dto exposes public health without alerts or template items`.
  - `permission map covers SP-14 routes` (part 1): `POST /channels/:id/health/check` is `channels.update`. System-role decisions: owner and admin yes; agent and viewer no; impersonation not blocked.
- [ ] Implement until green.
- [ ] `npx tsc --noEmit -p tsconfig.json`, the listed jest paths, then the full `npm test` once. Run `npx prisma generate`. An EPERM on the engine DLL while the dev watcher runs is harmless, as in SP-12/13; restart the watcher. **Do not run `migrate`** (ruling 17).
- [ ] Commit `feat(channels): number health model, provider readers and rate-limited live check`.

### Task 2: Backend — downgrade notifications, daily sweep, template status and quality, per-number templates, campaign refusals
**Depends on:** Task 1.

**Files:**
- **B1 Notifications:**
  - `backend/src/channels/health/health-notifier.ts`: `HealthNotifier.onDowngrade(ws, channel, changes)`. It sends title `channel.health_downgraded` and body `{channelId, name, phone, changes}`.
  - `PermissionService.membersWith(ws, permission) → userIds`: one query over `WorkspaceMember` with roles, filtered through `effective`. It goes in `permission.service.ts`, with a spec.
  - Bind `HealthNotifier` as the `onDowngrade` hook of `ChannelHealthService`. `ChannelsModule` imports `NotificationsModule` if it is not global.
- **B2 Sweep:** `backend/src/channels/health/channel-health.scheduler.ts`: `@Cron(EVERY_HOUR) sweep(now)`, with:
  - `running` guard;
  - due selection through `prisma.channel.findMany` (Architecture);
  - per-row claim (Task 1's `claim`);
  - `HEALTH_SWEEP_BATCH = 50`, `HEALTH_SWEEP_INTERVAL_MS = 24 h`, `HEALTH_SWEEP_MAX_MS = 10 min` (env-overridable);
  - `workspaceContext.run` per row;
  - one row's error is logged and does not stop the tick;
  - it returns `{checked, skipped, failed}`.
- **B3 Templates:**
  - `backend/src/templates/templates.service.ts`:
    - `mapStatus` gains `paused`/`disabled`;
    - `reconcile` writes `quality` (`quality_score.score`, with `UNKNOWN` → `NOT_RATED`; absent → leave null);
    - new `reconcileFromList(ws, metaTemplates)` used by the sweep for the default Zernio number;
    - new `healthFor(ws, id)`;
    - `TemplateRow.quality`.
  - `backend/src/templates/template-errors.ts` (new).
  - `templates.module.ts`: `GET :id/health` (declared before `:id` where it matters) and, if ruling 11(b) stands, `POST :id/copy-to-number`.
- **B4 Webhooks:**
  - `backend/src/integrations/zernio.service.ts` `handleEvent`: `whatsapp.template.status_updated` → `TemplatesService.applyProviderStatus(ws, {templateId, name, language, status, reason})`, workspace resolved through the account's channel (ruling 15), then `ChannelHealthService.check(…, {trigger:"webhook"})`. A cooldown refusal is swallowed and logged at debug level.
  - Add the event's type to `ZernioWebhookEvent`.
  - `backend/src/integrations/whatsapp.service.ts`: `mapTemplateEvent` fix (ruling 9); `message_template_quality_update` → `Template.quality` by `metaTemplateId`; `phone_number_quality_update` → check of the Meta channel found by WABA and display number (ruling 12).
- **B5 Per-number templates:** `GET /channels/:id/templates` in `channel-health.controller.ts`.
- **B6 Copy to number** (only if ruling 11(b) stands): `TemplatesService.copyToNumber(ws, id, channelId, viewer)`. Both Zernio calls go through `zernioHealthCall`. It reuses `buildComponents`, `submittable` and the header-media lock path (`writeWithHeaderLock` is not needed; it writes no row).
- **B7 Campaigns:**
  - `backend/src/campaigns/sending/senders.ts`: `templateOnSenders` returns `{missing, failed, paused: {channelId, status}[]}`.
  - `campaign-send.service.ts`: launch checks 5 and 9 per ruling 10.
  - `campaign-preview.service.ts`: `templatePaused`.
  - `campaign-errors.ts`: the three keys.
  - `channels/default-channel.ts` `campaignSenderOptions`: `tier`, `quality`, `healthCheckedAt` from the snapshot.
  - Optional: map a runner `lastError` caused by an account-wide paused/disabled rejection to `campaigns.template_paused` (ruling 10).
- **Other files:**
  - `backend/src/permissions/permission-map.ts`: the remaining SP-14 routes, plus spec rows.
  - `backend/src/channels/test-prisma.ts`: `workspaceMember`/`role` lookups if missing.
- **Specs:**
  - `health-alerts.spec.ts` (acceptance), `channel-health.scheduler.spec.ts`, `template-health.spec.ts`;
  - extend `templates.service.spec.ts`, `zernio.template.spec.ts` (webhook), `whatsapp-legacy-fixes.spec.ts` or a new `whatsapp-template-webhooks.spec.ts`, `campaign-sender.spec.ts`, `campaign-launch.spec.ts`, `campaign-preview.service.spec.ts`, `permission.service.spec.ts`.

**Produces:**
- `connector_needs_attention` notifications with title `channel.health_downgraded`.
- `ChannelHealthScheduler.sweep(now)` (the verifier drives it through its control port).
- `GET /channels/:id/templates`, `GET /templates/:id/health`, optional `POST /templates/:id/copy-to-number`.
- `Template.status` ∈ {…, `paused`, `disabled`}; `Template.quality`.
- Campaign keys `template_paused`, `template_disabled`, `template_paused_on_number`; preview `templatePaused`; senders `tier`/`quality`/`healthCheckedAt`.

- [ ] Write the failing tests:
  - **`quality drop emits one notification`** (through `ChannelHealthService` and the scheduler, with the in-memory Prisma double, a mocked Zernio whose `number-info` quality is scripted, and a spied `NotificationsService.notify`):
    - members: an owner, an admin, an agent, a viewer, and a custom role holding `channels.update`;
    - sweep 1 (GREEN) sends nothing (baseline);
    - quality becomes YELLOW, and sweeps 2, 3 and 4 (each 24 h later) give **exactly one** `notify` call;
    - its recipients are the owner, the admin and the custom-role member (not the agent or viewer);
    - type `connector_needs_attention`, title `channel.health_downgraded`, body `changes: [{signal:"quality", from:"GREEN", to:"YELLOW"}]`;
    - a sweep returning unknown (Zernio 502) sends nothing more;
    - RED gives one more notification; GREEN gives none; YELLOW again gives one more;
    - a manual check in between follows the same rules;
    - a member whose preference has `inApp=false` gets none (SP-05 unchanged).
  - `concurrent checks notify once`: two checks of one number racing on a downgrade give one notification.
  - `sweep is bounded, idempotent and re-entrancy guarded`:
    - 120 due numbers with batch 50 → 50 checked;
    - an immediate second tick checks the next 50, not the first ones again;
    - a tick while one is running returns at once with `{checked:0}`;
    - `HEALTH_SWEEP_MAX_MS` stops early;
    - disconnected, telegram, webchat and `pending` numbers are never selected;
    - a number checked manually 10 minutes ago is not due;
    - one row throwing does not stop the rest.
  - `sweep reconciles default-number templates without an extra call`: Zernio template list reads equal Zernio numbers checked; `Template` rows get `paused` and `quality`.
  - `paused and disabled map from every source`: `mapStatus`, the Zernio webhook, and Meta's `DISABLED`/`PAUSED`/`REINSTATED` all map; Meta's `FLAGGED` leaves the status unchanged; Meta's template quality webhook sets `quality`, with `UNKNOWN` → `NOT_RATED`.
  - `template webhook is scoped to the owning workspace`: two workspaces with a same-named template, an event for workspace A's account → only A's row changes; an unknown account changes nothing.
  - `template health lists the template on every number`:
    - default, number B (paused in its snapshot), number C (snapshot lacks it) and number D (never checked) → `approved`, `paused`, `missing`, `unknown`;
    - base-language matching (`en` vs `en_US`);
    - disconnected numbers are excluded.
  - `per-number template list reads the snapshot without a provider call`.
  - `paused or disabled template refuses launch with its key`: stored `paused` → 400 `campaigns.template_paused`; `disabled` → `campaigns.template_disabled`; both before `template_not_approved`.
  - `sender copy paused refuses launch`: sender B's live copy `PAUSED` → 400 `campaigns.template_paused_on_number {channelIds:[B], statuses:{B:"paused"}}`. Precedence: a failed read gives 502 first; a missing copy on C plus paused on B gives `paused_on_number`. The preview reports `templatePaused`.
  - `senders expose tier and quality from the snapshot` (unknown when never checked).
  - If (b): `copy to number submits once and refuses duplicates and bad targets`:
    - the target already holds the template → 409 `templates.already_on_number {status}` with **no** create call;
    - otherwise one `createWhatsAppTemplate` with the target `accountId`;
    - a Meta-direct target → 400 `copy_unsupported`;
    - the default number as target, or a foreign, disconnected or non-Zernio channel → 400 `templates.number_invalid`;
    - a not-approved template → 400 `copy_requires_approved`;
    - both calls take budget tokens.
  - `foreign ids return 404 on SP-14 routes` (part 2): `GET /channels/:id/templates`, `GET /templates/:id/health` (404 `templates.not_found`), copy (404 for a foreign template id).
  - `permission map covers SP-14 routes` (part 2), plus the system-role block `SP-14 health routes`.
- [ ] Implement until green. Review checklist for the PR:
  - every Zernio call in `channels/health/` and `copyToNumber` goes through `zernioHealthCall`;
  - every health write is raw SQL fenced on the claim.
- [ ] `npx tsc --noEmit -p tsconfig.json`, the jest paths, then the full `npm test` once. The existing SP-13 launch and preview specs must stay green, extended only.
- [ ] Commit `feat(channels): health sweep, downgrade alerts, paused and disabled templates and per-number template status`.

### Task 3: Frontend — number health page, live check, template health sheet and badges
**Depends on:** the contracts of Tasks 1–2. It can start from Task 1's contract while Task 2 is in review.

**Files:**
- **F1 Model:** `src/screens/channels/health/healthModel.ts` (pure):
  - `FIELD_ORDER`;
  - `signalView(name, signal, tx) → {label, tone: "good"|"warn"|"bad"|"neutral", unknown: boolean, reason?: string, previous?: {label, at}}`;
  - `tierView`: caps and the "shared by numbers in this business" note;
  - `qualityTone`, `nameTone`, `reviewTone` (ported from Tkana);
  - `overallView`, `issueText(key, tx)`;
  - `cooldownLeft(healthNextCheckAt, now)`;
  - `templateStatusView(status)`: approved / pending / rejected / paused / disabled / local / missing / unknown.

  Tests in `healthModel.test.ts`.
- **F2 Hub:** `src/screens/channels/health/NumberHealthSection.tsx`:
  - inside `ChannelDetail.tsx` for WhatsApp `zernio`/`meta` channels;
  - a field grid with each field's `checkedAt` and its unknown reason;
  - the issues list;
  - "Check now" (`channels.update` only) with a live countdown from `healthNextCheckAt`, disabled while counting down, and copy for the 429 keys;
  - "Templates on this number" (`templates.view`; `GET /channels/:id/templates`), with status and quality badges.
- **F3 Overview:** `src/screens/channels/health/NumberHealthOverview.tsx`: the "Number health" page.
  - A view toggle on `ChannelsPage.tsx` ("Channels" | "Number health" / "القنوات" | "صحة الأرقام"), kept in the hash (`#/channels?view=health`).
  - A table of every WhatsApp number: overall, quality, tier, messaging, name status, templates needing review, last checked.
  - A row opens the existing `ChannelDetail` (`?id=`).
  - The data comes from `GET /channels` (health is in the DTO).
- **F4 Templates:**
  - `src/screens/Templates.tsx`: `STATUS_BADGE` adds `paused: "warn"` and `disabled: "bad"`; `toFull` stops collapsing them into `pending`; bilingual status labels replace the raw `{tpl.status}` text; a quality badge (unknown renders as Unknown); the counters add paused and disabled; a "Health" action per row.
  - `src/screens/templates/TemplateHealthSheet.tsx`: a modal sheet from `GET /templates/:id/health`, with one row per number (name, `<bdi>` phone, status badge, quality, checked at), unknown rendered per F1, and an explanation of `missing` vs `unknown`.
  - `src/screens/templates/templateErrors.ts` + test.
- **F5 Copy to number** (only if ruling 11(b) stands): in `TemplateHealthSheet`, a "Copy to this number" button on `missing` rows of Zernio numbers (`templates.create`). A confirm dialog says Meta will review it (up to 24 h). The 409/400 keys are mapped.
- **F6 Campaigns:**
  - `src/screens/campaigns/campaignErrors.ts`: the three new keys (`template_paused_on_number` names numbers through `isolateLtr`).
  - `ReviewSamples.tsx`: a `templatePaused` warning.
  - `SendFromField.tsx`: tier and quality chips per sender (unknown is muted), display only.
- **F7 Notifications:**
  - `src/lib/notificationText.ts`: case `channel.health_downgraded`, with per-signal change wording.
  - `src/lib/recordLink.ts`: `notificationHref`.
  - `src/shell/NotificationsBell.tsx`: its three `recordHref` call sites use `notificationHref`.
- **F8 Types:** `src/lib/types.ts`: `ChannelHealthPublic`, `HealthSignal`, `TemplateSummaryPublic`, `ChannelTemplatesResponse`, `TemplateHealthResponse`. `ChannelDto` gains `health`, `healthCheckedAt`, `healthNextCheckAt`. `Template` gains `quality` and the two statuses. `CampaignSender` gains `tier`, `quality`, `healthCheckedAt`. `CampaignPreviewV2` gains `templatePaused`.
- **F9 Copy:** `src/screens/channels/channelErrors.ts`: the three new keys.
- **Permission gating** with `usePermissions().can(...)`:
  - check: `channels.update`;
  - per-number templates and the health sheet: `templates.view`;
  - copy: `templates.create`.

  Hidden actions are not rendered. A 403 shows the shared no-permission toast.

**Produces:**
- The number health page and per-number section in English and Arabic: live check with cooldown, issues, and the per-number templates.
- Template badges, quality, and the health sheet (plus copy-to-number if ruled in).
- Campaign warnings and keys; the sender tier chips; the notification text and deep link.

- [ ] Write the failing vitest tests:
  - **`unknown fields render as unknown`**:
    - for each field, a signal `{value:"unknown", error:"unsupported"}` gives the label "Unknown" / "غير معروف", tone `neutral`, `unknown: true`, and the reason "This provider doesn't report it";
    - `check_failed` with `lastKnown` gives "Unknown", plus `previous: {label:"High", at}`, worded as previous;
    - never tone `good`, never an empty or dash label;
    - `NOT_RATED` renders "Not rated yet", which is distinct from Unknown;
    - an unknown template status in the sheet renders Unknown, and `missing` renders "Not on this number".
  - `tier labels show the daily cap and unlimited` (`TIER_2K` → "2,000 / day"; `TIER_UNLIMITED` → "Unlimited"; digits pass through).
  - `overall and issue copy cover every key in both languages`.
  - `check button counts down from healthNextCheckAt`.
  - `template status badges keep paused and disabled distinct from pending` (`toFull`).
  - `template error copy covers every SP-14 key in both languages`.
  - `campaign error copy covers the SP-14 template keys`.
  - `health downgrade notification text and deep link` (`notificationHref` → `#/channels?id=…`; other titles unchanged).

  Then implement until they pass, then build the components.
- [ ] `npx vitest run`, `npm run typecheck` and `npm run build` clean. A read-only look at the pages on the dev server is optional; the real UI pass is in Task 4.
- [ ] Commit `feat(channels): number health page, live check, template health sheet and paused/disabled badges`.

### Task 4: Verification
Apply `20261114140000_number_template_health` with `npx prisma migrate deploy`, and only when the controller and the user explicitly approve it (ruling 17). It is safe for `main` (Global Constraints). Record the results in `.superpowers/sdd/2026-11-14-sp14-number-template-health/live-verification.md`, in the format of SP-19's `live-verification.md`: summary, a results table with evidence, DB-side checks, findings, cleanup, and the pending real-provider items. If the harness refuses the write, put the tables in the scratchpad and say so, as SP-13 did; do not reroute.

**Isolation** (no repo code changed; scripts derived from SP-13's in the session scratchpad `C:\Users\ashra\AppData\Local\Temp\claude\7b75a64029a712a6\ebb2057a-6300-4548-9aec-b98487880afb\scratchpad\`):
- **Own instance:** `launch-sp14.js`, derived from `launch-sp13.js`.
  - Backend on **:4230**, compiled with `tsc -p tsconfig.build.json` into a throwaway outDir (`backend/.verify-dist-sp14`, never `backend/dist`) and started with `node`. The user's :4100 process is not touched.
  - A loopback-only control port **:4231** calls `ChannelHealthScheduler.sweep(now)` and `ChannelHealthService.check`.
- **Crons:** all `@nestjs/schedule` jobs are disabled (the SP-13 `lookupSchedulers` patch). `ChannelHealthScheduler` is driven only through the control port. Its `prisma` gets a scoped proxy that confines `channel.findMany/findFirst/updateMany/count` to the test workspaces recorded in `verify-created-sp14.json`. With nothing recorded, it matches nothing, so the sweep can never check a real number. The claim is raw SQL by id, taken only from those confined reads.
- **Provider keys:** set to **empty strings**, not deleted (SP-19 finding E2). The same list as SP-13. `TOKEN_ENC_KEY` is a test-only value, so test Meta channels can hold fake encrypted tokens.
- **No real provider call, ever:**
  - **Zernio:** `ZERNIO_BASE_URL=http://127.0.0.1:4229/api/v1` and `ZERNIO_API_KEY=zz-verify-stub`, pointing at `zernio-stub-sp14.js` (derived from `zernio-stub-sp13.js`). It adds:
    - `GET /whatsapp/number-info?accountId`: per-account scripted `phone`/`waba`, settable through `POST /__control/numberInfo {accountId: {...}}`, including a shape with `phone.health_status.can_send_message`, one with an unexpected value, and one 404 "WhatsApp account not found";
    - per-account `GET /whatsapp/templates` lists with `PAUSED`/`DISABLED` and with and without `quality_score`;
    - `POST /whatsapp/templates` (copy-to-number);
    - the existing fault rules (`429` with Retry-After, `error`, `delay`).
  - **Meta Graph:** `META_GRAPH_BASE_URL=http://127.0.0.1:4228`, pointing at a new `meta-graph-stub-sp14.js`. It binds 127.0.0.1 only and requires `Authorization: Bearer zz-verify-meta-token-*`. It serves:
    - `GET /v21.0/<phoneId>?fields=<one field>`, scripted per id; it returns Graph error #100 for `whatsapp_business_manager_messaging_limit` on one number, to exercise the fallback, and a 190 on another;
    - `GET /v21.0/<wabaId>?fields=business_verification_status|account_review_status`;
    - `GET /v21.0/<wabaId>/message_templates` with paging.

    Anything else gives 404, logged as UNEXPECTED. Every call is logged.
  - **The launcher refuses to start** unless all of these hold:
    - `ZERNIO_BASE_URL` begins with `http://127.0.0.1`;
    - `ZERNIO_API_KEY` equals `zz-verify-stub`;
    - `META_GRAPH_BASE_URL` begins with `http://127.0.0.1`.

    The SP-13 egress guard (fetch, http and https to any non-loopback host throws and is logged to `blocked-egress-sp14.jsonl`) stays. Before cleanup, the script asserts that `blocked-egress-sp14.jsonl` is empty and that each stub's log holds every provider call the run made.
- `ZERNIO_WEBHOOK_SECRET` is a test value, so replayed webhooks can be signed. `META_VERIFY_TOKEN` and the Meta app secret are test values for the signed Meta webhook replay.
- Tunables for test scale: `HEALTH_CHECK_COOLDOWN_MS=5000`, `HEALTH_SWEEP_BATCH=3`, `HEALTH_SWEEP_INTERVAL_MS=10000`, `ZERNIO_HEALTH_RPM=600` (recorded in the notes).
- Test tag `zz-verify-<ts>` on every name and email.

**Setup** (writes only rows tagged with the test tag):
1. Register an owner and a foreign owner. Invite an admin, an agent and a viewer, and create a custom role holding `channels.update` with a member.
2. Insert channels, all `kind whatsapp`:
   - Zernio Z1 (default; `externalId zz-verify-acc-z1-<ts>`, active);
   - Zernio Z2 (active);
   - Zernio Z3 (`needs_attention`);
   - Meta M1 (channel-only; `config.wabaId zz-verify-waba-<ts>`; `secretsEnc` holding `zz-verify-meta-token-<ts>`, encrypted with the test key);
   - Meta M2 with no token (`missing_credentials`);
   - one disconnected Zernio number;
   - one webchat channel.
3. Set the workspace's `zernioProfileId`.
4. Insert approved `Template` rows `zz_verify_promo_<ts>` (en) and `zz_verify_alert_<ts>` (ar). In the stub, the promo template is APPROVED on Z1, PAUSED on Z2 and absent on Z3.
5. Create 20 contacts and a segment, plus one draft campaign per launch case.

**Checks:**
- **Unknown fields:**
  - a live check of Z1 stores `verified`, `codeVerification` and `accountReview` as `unknown`/`unsupported`, and Z1's template quality as unknown (no `quality_score`);
  - a live check of M1 has none of those unknown, and its tier comes through the fallback field;
  - M2 has every field `unknown`/`missing_credentials`, with **zero** Graph calls in the stub log;
  - the UI renders "Unknown" with its reason (screenshots, EN and AR).
- **Live check limits:** a second check of Z1 within 5 s gives 429 `channels.health_check_cooldown`, with no new stub call. After 5 s it passes. Restarting :4230 and re-checking within the window is still refused. Webchat gives 400 `health_unsupported`. The disconnected number gives 409.
- **Budget:** with the stub returning one 429 (Retry-After 2) on number-info, the check waits and succeeds. The stub log shows the retry. The process logs show the shared bucket paused.
- **`quality drop emits one notification` (live):**
  - sweep (baseline) → no notification;
  - stub Z2 quality → YELLOW; advance the stub and wait more than 10 s; sweep three times → **exactly one** `Notification` row per `channels.update` holder (owner, admin, custom-role member), none for the agent or viewer, with title `channel.health_downgraded`;
  - YELLOW → RED → one more;
  - → GREEN → none;
  - the bell shows the bilingual text and opens `#/channels?id=<Z2>`.
- **Sweep bounds:** with batch 3 and 5 due numbers, the first tick checks 3 and the second the other 2. A tick fired while one runs returns `{checked:0}`. Disconnected and webchat are never checked (stub log).
- **Templates:**
  - the sweep reconciles Z1's list; the promo row stays `approved`;
  - a replayed, signed Zernio `whatsapp.template.status_updated` (PAUSED) for Z1's account moves it to `paused`, and schedules a check;
  - the same event signed for the foreign workspace's account leaves this workspace untouched;
  - a replayed Meta `message_template_status_update` `FLAGGED` changes nothing; `DISABLED` gives `disabled`;
  - `GET /templates/:id/health` shows Z1 / Z2 / Z3 / M1 as approved-or-paused / paused / missing / per its snapshot.
- **Launch refusals:** stored `paused` → 400 `campaigns.template_paused`; `disabled` → `campaigns.template_disabled`. Restore `approved`, and a campaign with senders Z1 and Z2 → 400 `template_paused_on_number {channelIds:[Z2]}`. The preview shows `templatePaused`. **No broadcast or send call** appears in the Zernio stub log.
- **Copy to number** (if ruled in): copying the promo template to Z3 → 201 and one `POST /whatsapp/templates` with Z3's account. A second copy to Z3 (now listed by the stub) → 409 `already_on_number` with no create call. Copying to M1 → 400 `copy_unsupported`.
- **Senders:** `GET /campaigns/senders` shows the tier and quality for Z1 and Z2, and Unknown for a never-checked number.
- **Permissions and tenancy:**
  - the foreign owner gets 404 on check, the per-number templates, template health and copy;
  - the agent and viewer get 403 on check (ruling 4);
  - the agent can open the template health sheet; the viewer can read it but cannot copy;
  - an impersonated session can check.
- **No side effects:** `Channel.updatedAt` of every test channel is unchanged by checks and sweeps (read before and after).
- **Index use:** `EXPLAIN` (no `ANALYZE`) of the sweep's due query inside `BEGIN; SET LOCAL enable_seqscan = off; … ROLLBACK;` uses `Channel_kind_healthAttemptedAt_idx`.
- **Migration rerun:** execute the SP-14 migration SQL again inside a transaction that is always rolled back: no errors and 0 rows changed. If the tool safety layer refuses DDL even in a rolled-back transaction (as in SP-13), record it and ask the user; do not reroute.
- **UI through the `verify` skill:**
  - the Number health page and the per-number section in English and Arabic (RTL): unknown values, issues, the countdown after a check, and the templates on a number;
  - the Templates screen with paused and disabled badges and quality, the template health sheet, and copy-to-number (if ruled in);
  - the campaign review warning and the sender chips;
  - the notification;
  - screenshots.

**Cleanup:**
- Delete only the recorded test rows: the workspaces (the cascade covers channels, templates, campaigns, contacts, segments, notifications and roles), then the users.
- Run a residue sweep over every table with a `workspaceId` column, including `Notification`, `Channel` and `Template`.
- Read-only counts before and after: `Workspace`, `User`, `Channel`, `Template`, `Notification`, `Campaign`, `CampaignRecipient`, `Contact`, `Role`, `WorkspaceMember`. Every count must be identical.
- Stop :4230, both stubs and the control port, and remove the outDir.

Then tick SP-14's "Detailed plan written" and "Shipped" boxes in the roadmap, noting the rulings taken and the deviations. Add the deferred items to the roadmap:
- Meta-direct template submission and per-number edit/delete (ruling 11);
- the 24 h usage bar;
- pending category changes;
- a Graph version bump (ruling 13);
- the Meta webhook field subscriptions the user must enable (ruling 12);
- the pending real-provider checks (ruling 19).
