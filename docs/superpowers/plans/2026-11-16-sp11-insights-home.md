# SP-11 Insights, Working Home and Module Settings: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- **Support insights** (`GET /insights/support?from&to&channelId`): conversations, AI resolution rate, median first response (AI-only replies excluded), median handling time, time saved, share turned into tickets, a resolution-mix donut, hour-of-day peaks, a split by WhatsApp number, topic friction, and a **Team** tab per agent. Every metric is defined once as SQL in this plan and pinned by a fixture test named after it (roadmap acceptance: one fixture test per metric, including `median first response excludes AI-only replies`).
- **Sales insights** (`GET /insights/sales?from&to&pipelineId`): leads, replied, speed to reply with a distribution, waiting now, won, a weekly trend, lead sources (ads from SP-15, then channel, then contact source), a stage funnel, lost reasons (SP-07 catalog), and a Reps table with follow-up totals (SP-04).
- **Working home** (`GET /home`): "Needs a person" (waiting conversations, my late follow-ups, unassigned tickets), Today / Tomorrow (my follow-ups, bookings, tickets due), "While you were away" (what the AI agent did since my last visit), and a one-time **Day-1 home** with setup steps. Everything is filtered to records the member may open (acceptance `home lists only permitted records`).
- **Module settings hub:** one Settings tab that lists each module the member can configure and links to its settings.
- **Greeting fix:** the dashboard's hardcoded "Welcome back, Yara" (`src/screens/Dashboard.tsx:240`) and "Samemha" become the signed-in member's first name and the workspace name.
- **The "ask" box is hidden** until SP-18 ships (ruling 1). Nothing is rendered and no endpoint is added.

**Architecture:**
- **One shape for every metric.** `backend/src/insights/`:
  - `insights-range.ts` (pure): `parseRange(from, to, tz, now)` → `{fromUtc, toUtcExclusive, days, tz}`; `YYYY-MM-DD` inclusive, workspace-local (`Workspace.timezone` through SP-04 `validTz`), span 1–366 days, default the last 30 local days ending today; 400 `insights.range_invalid` otherwise. One `now` is taken per request and passed to every statement (Tkana's "one anchor" rule), so sections can never disagree about "today".
  - `insights-scope.ts`: `conversationScopeSql(scope, alias)` (moved from `dashboard.module.ts` `sqlScope`, which then imports it): an assigned-only viewer's figures cover only conversations assigned to them; a closed scope matches nothing. **Every conversation- or message-derived metric is computed under the viewer's scope** (Review Focus 1).
  - `support-metrics.sql.ts` / `sales-metrics.sql.ts`: each metric is one exported `Prisma.Sql` builder (`(ws, range, scope, opts) => Prisma.Sql`), the SQL written out below. No ORM aggregation, no JS-side loops over messages.
  - `insights.service.ts`: runs each **section** in its own transaction with `SET LOCAL statement_timeout = '8s'` and `SET LOCAL jit = off`. A section that times out or fails returns `{status: "unavailable"}` and the others still answer (Tkana spec D9). No caching (ruling 9).
  - **Null is "no data", never 0.** A rate or median with an empty denominator is `null` and renders "No data yet" / "لا بيانات بعد".
- **Message model facts the SQL relies on** (checked in `schema.prisma` and the writers):
  - `Message.from` is `them` (customer), `ai` (agent), `human` (staff). There is no event row: SP-31 builds thread events at read time (`customer-thread.service.ts`), so every `Message` row is a real message.
  - A conversation is long-lived (one per contact and channel). An **exchange** starts at a customer message whose previous message in the conversation (by `createdAt, id`) is not a customer message, or that has no previous message.
  - Resolution (`resolution/conversation-resolution.service.ts`) keeps only the **latest** verdict on the row: `resolutionStatus` (`resolved` | `closed` | `open` | null), `resolution` (reason), `resolvedAt`, `resolutionIssue` (`complaint` | `escalation` | `none`), `resolutionSentiment`, `topics`, `painPoints`. A customer writing again clears it. There is no verdict history (ruling 3).
  - `Message.sentById` is new in this SP (ruling 4) and null for every older message.
- **Support metrics** (range = `[fromUtc, toUtcExclusive)`; `S` = scope fragment on `c`; `ch` = optional `c."channelId" = $channelId`). The constants live in `insights-constants.ts`: `RESOLUTION_LOOKBACK = interval '7 days'`, `SECONDS_SAVED_PER_MESSAGE = 60` (2 × 30 s, Tkana PLT-1717), `TOPIC_MIN_CONVERSATIONS = 3`, `TOP_TOPICS = 10`.

  | Metric | Definition (SQL) | Fixture test (exact name) |
  |---|---|---|
  | `conversations` | `COUNT(DISTINCT m."conversationId")` over `Message m JOIN Conversation c` where `m."workspaceId" = $ws`, `m.from = 'them'`, `m."createdAt"` in range, `S`, `ch` | `conversations counts distinct conversations with a customer message in range` |
  | `decided` | conversations with `c."resolvedAt"` in range and `c."resolutionStatus" IN ('resolved','closed')`, `S`, `ch` | (part of the next two) |
  | `aiResolved` | decided, `resolutionStatus = 'resolved'`, `NOT c.escalated`, `c."resolutionIssue" NOT IN ('complaint','escalation')`, and `NOT EXISTS (SELECT 1 FROM Message h WHERE h."conversationId" = c.id AND h.from = 'human' AND h."createdAt" > c."resolvedAt" - RESOLUTION_LOOKBACK AND h."createdAt" <= c."resolvedAt")` | `ai resolution rate = ai-resolved / decided (nothing decided → null)` |
  | `aiResolutionRate` | `decided > 0 ? round1(100 * aiResolved / decided) : null` (percent, one decimal) | same test |
  | `medianFirstResponseSec` | exchanges whose start `e` is in range; reply `r` = the first message after `e` in the conversation with `from <> 'them'`; then the first `human` message `h` after `e` and **before the next exchange start**. Exchanges where `r.from = 'ai'` and no `h` exists are **excluded** (AI-only); exchanges with no reply at all are excluded and counted as `unanswered`. `percentile_cont(0.5) WITHIN GROUP (ORDER BY h."createdAt" - e."createdAt")` in seconds | **`median first response excludes AI-only replies`** |
  | `medianHandlingSec` | for each `decided` conversation: `resolvedAt − ` the start of its earliest exchange with `createdAt > resolvedAt − RESOLUTION_LOOKBACK`; median as above | `median handling time runs from exchange start to resolvedAt` |
  | `timeSaved` | `customerMessages` = customer messages in range whose **next** non-customer message is `ai` (the AI answered first); `hours = round1(customerMessages * SECONDS_SAVED_PER_MESSAGE / 3600)`; both returned | `time saved credits 60 s per customer message answered first by AI` |
  | `ticketShare` | of the `conversations` set, those with a `Ticket t` where `t."conversationId" = c.id`, `t."createdAt"` in range and `t."pipelineId"` in a `kind = 'support'` pipeline; `conversations > 0 ? round1(100 * n / conversations) : null` | `share turned into tickets counts support tickets created from the range's conversations` |
  | `resolutionMix` | over `decided`, disjoint, first match wins: `closed` (`resolutionStatus = 'closed'`) → `escalated` (`c.escalated` or `resolutionIssue IN ('complaint','escalation')`) → `ai` (`aiResolved`) → `human`; returns `{ai, human, escalated, closed}` that sum to `decided` | `resolution mix buckets are disjoint and sum to decided` |
  | `peaks` | customer messages in range grouped by `EXTRACT(DOW FROM m."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE $tz)` and `EXTRACT(HOUR …)` → a 7 × 24 matrix plus per-hour totals | `hour-of-day peaks bucket customer messages in the workspace timezone` |
  | `byNumber` | `conversations` and `aiResolutionRate` grouped by `c."channelId"` for `Channel.kind = 'whatsapp'`; conversations with no channel → one "Unassigned number" row (`channelId: null`); a deleted channel's rows → "Removed number" | `by number splits conversations and ai rate per WhatsApp channel` |
  | `topicFriction` | over `decided` conversations with `topics`: `jsonb_array_elements_text(c.topics)` lower-cased and trimmed; per topic: `count`, `escalatedShare` (escalated bucket), `negativeShare` (`resolutionSentiment = 'negative'`); only topics with `count >= TOPIC_MIN_CONVERSATIONS`; top `TOP_TOPICS` by `count desc, topic` | `topic friction ranks topics with escalation and negative share` |
  | `team[]` | per member: `assigned` = conversations in `conversations` with `assigneeId = member`; `replies` = `human` messages in range with `sentById = member`; `medianFirstResponseSec` = the first-response median over exchanges whose first human reply has `sentById = member`; `resolved` = decided conversations with `assigneeId = member` and bucket `human`. A `null` `sentById` reply counts in an "Unattributed" row. Former members are one "Former member" row | `team rows attribute replies to the sending member` |

- **Sales metrics** (pipeline `P` = `pipelineId`, else the workspace's first non-archived `kind = 'leads'` pipeline, else the default pipeline; a foreign/missing id → 404 `insights.pipeline_not_found`). A **lead** is a `Ticket` of `P`. Conversation-derived parts use the viewer's scope; ticket parts need `tickets.view` (else the section is `{status: "forbidden"}`). Constants: `SPEED_BUCKETS = [5, 15, 60, 240, 1440]` minutes → `<5m`, `5–15m`, `15–60m`, `1–4h`, `4–24h`, `>24h`, `not replied`.

  | Metric | Definition (SQL) | Fixture test (exact name) |
  |---|---|---|
  | `leads` | `COUNT(*)` of tickets of `P` with `createdAt` in range | `leads counts cards created in range in the pipeline` |
  | `replied` | of `leads`, those with an `ai` or `human` message in a (scoped) conversation of the ticket's contact with `createdAt > t."createdAt"` | `replied counts leads with a staff or AI message after creation` |
  | `speedToReply` | per lead: the first **`human`** message in a scoped conversation of its contact after `t."createdAt"` (AI excluded, ruling 5); `median` in seconds over leads with one; `distribution` = counts per `SPEED_BUCKETS` bucket, plus `not replied` | `speed to reply is the median to the first staff reply`, `speed distribution buckets are exhaustive` |
  | `waiting` | **now** (not range): open leads of `P` (stage not terminal, `closedAt IS NULL`) whose contact's latest message over scoped conversations with `status NOT IN ('resolved','closed','spam')` is `from = 'them'` | `waiting counts open leads whose latest visible message is the customer's` |
  | `won` | `COUNT(DISTINCT a."ticketId")` of `TicketActivity a` with `kind = 'won'` and `createdAt` in range, ticket in `P` | `won counts distinct cards with a won move in range` |
  | `weekly[]` | `leads` and `won` per workspace-local week (`date_trunc('week', … AT TIME ZONE $tz)` shifted to the week start of ruling 10), every week of the range present (zeros filled) | `weekly trend buckets by workspace-local week` |
  | `sources[]` | per lead, first match wins: (1) an ad — the earliest conversation of the contact with `adSourceId` (SP-15) → `{kind: "ad", id, label: adName ?? headline ?? sourceId}`; (2) the channel kind of the contact's earliest conversation → `{kind: "channel", key}`; (3) `Contact.source` (`import`, `manual`, `meta_lead_form`, …) → `{kind: "contact_source", key}`; each with `leads` and `won` | `lead sources attribute ad, channel, then contact source` |
  | `funnel[]` | per stage of `P` in `order`: leads of the range that **reached** it = created in it, or a `TicketActivity` with `toStage` = its key, or currently in it; terminal lost stages listed after the won stage | `stage funnel counts cards that reached each stage` |
  | `lostReasons[]` | `TicketActivity kind = 'lost'` in range in `P`, grouped by the ticket's `lostReasonId` → `LostReason.label/labelAr`, else the `lostReason` snapshot text, else "No reason" | `lost reasons group by catalog reason with snapshot fallback` |
  | `reps[]` | per `Ticket.ownerId` of `P`: `leads` (created in range), `won`, `lost`, `medianSpeedToReplySec` (first `human` reply with `sentById = owner`); follow-ups (SP-04 `Activity`, `assigneeId = owner`): `done` (`doneAt` in range), `overdue` (open, `dueAt < now`), `dueToday` (open, in today's local bounds through `localDayBounds`); unowned → "Unassigned" | `reps table totals owners and follow-ups` |

- **Working home** (`backend/src/home/home.service.ts`, `GET /home`, `authenticated`; every section is computed **as the member**, with their permissions and conversation scope):
  - **Needs a person** (each list ≤ 10 rows plus a `total`):
    - `waitingConversations` (needs `conversations.view`): scoped conversations with `status NOT IN ('resolved','closed','spam','pending_customer')`, latest message `from = 'them'`, and (`aiEnabled = false` or `escalated = true`), with `assigneeId = me OR assigneeId IS NULL`; ordered by that message's age, oldest first; row `{id, contactName, channel, waitingSince, assigneeId, escalated}`.
    - `lateFollowUps` (SP-04 queue logic): my activities, not done, `dueAt` before today's local start; the activity's link must pass the SP-04 permission (`tickets.view` or `contacts.view`).
    - `unassignedTickets` (needs `tickets.view`): open tickets of `kind = 'support'` pipelines with `ownerId IS NULL`, ordered by `slaDueAt` nulls last (SP-09), then `createdAt`.
  - **Today / Tomorrow** (local days): my follow-ups due; bookings (needs `bookings.view`; `status IN ('pending','confirmed')`; mine when I have a `StaffResource`/`staffId`, else all) — present only when SP-10's columns exist, else bookings by `staffId = me`; my open tickets with `slaDueAt` in the day (SP-09).
  - **While you were away:** `since = WorkspaceMember.homeSeenAt` (null → the last 24 h). Counts since then, under my scope: AI replies (`from = 'ai'`), conversations the AI resolved (`aiResolved` definition with `resolvedAt > since`), bookings created with `source = 'self-booking'`, tickets created by automation (`TicketActivity kind = 'created'` with `byUserId IS NULL`); plus ≤ 5 conversation rows. `POST /home/seen` sets `homeSeenAt = now()` for me (called when the home has been on screen 3 s).
  - **Day-1 home:** shown when `WorkspaceMember.homeDay1DismissedAt IS NULL` and not every setup step is done. Steps (each `{key, done, href}`, each `done` computed from data, never stored): `connect_channel` (any active `Channel`), `add_knowledge` (any knowledge doc), `invite_team` (> 1 member), `set_pipeline` (a non-default pipeline or a stage edit, i.e. `Pipeline.version > 0`), `add_services` (any `Service`, when SP-10 shipped), `first_reply` (any `human` message). `POST /home/day1/dismiss` sets `homeDay1DismissedAt`. Steps whose screen the member cannot use are omitted.
  - **Every record row** in the response is re-checked by kind with the same rules as SP-05's `canOpenRecord` (in bulk: one query per kind with the scope in `WHERE`, not one call per row).
- **Module settings hub (frontend only).** `src/screens/settings/ModulesTab.tsx` at `#/settings?tab=modules`, built from a pure table `src/screens/settings/modules.ts`: `{key, title, titleAr, description, descriptionAr, links: {label, href, permission}[]}` for Inbox (saved replies, labels), Contacts (custom fields, import), Sales pipelines (pipelines tab, lost reasons), Support (support pipeline and SLA), Bookings (services, staff — SP-10), Campaigns and templates, Ads (Meta Ads connection — SP-15), AI agent (Kewy AI, knowledge), Channels, Team and roles, Notifications (the SP-05 preferences dialog). A module with no link the member may use is hidden. `Workspace.enabledModules` is not consulted (ruling 8).
- **Greeting.** `src/screens/dashboard/greeting.ts` (pure): `greeting(now, tz, firstName, lang)` → "Good morning, <name>" / "صباح الخير يا <name>" (morning 05–12, afternoon 12–17, evening otherwise, workspace-local), falling back to "Welcome back" / "أهلاً بعودتك" without a name. `firstName` = the first word of `GET /auth/me` `name`. The subtitle becomes "Here's how <workspace name> is doing today" / "إليك ما يحدث في <workspace name> اليوم".

**Tech Stack:** NestJS 10, Prisma 5 (Postgres/Neon, raw SQL with `percentile_cont`), jest/ts-jest; React 18 + Vite, vitest; the existing `src/components/charts` (`AreaChart`, `Donut`, `Spark`). **No new dependencies.**

**Spec:** roadmap §SP-11, plus Global Constraints and Review Focus 1. **Depends on:** SP-01 (assignee, status), SP-04 (activities, `buckets.ts`), SP-07 (pipeline kind, lost reasons), SP-12 (campaign recipients; read only for "replied" exclusions, ruling 6). It also reads SP-15 (`AdSource`, `Conversation.adSourceId`), SP-31 (`Conversation.topics`, `painPoints`), SP-09 (`priority`, `slaDueAt`) and SP-10 (`Service`, bookings) when present; Task 3 degrades gracefully if SP-09/SP-10 have not shipped (ruling 11). Carried contracts:
- `dashboard/dashboard.module.ts`: `sqlScope`, `resolveDays`, the existing `GET /dashboard/summary` (unchanged apart from the shared scope helper).
- `tickets.service.ts` `dashboardSummary` (`GET /tickets/dashboard/summary`, unchanged; the Analytics overview tab keeps it).
- `PermissionService.conversationScope`, `effective`, `can`; `notifications/record-access.ts` `canOpenRecord`.
- `activities/activities.service.ts` `queue` buckets and permission rule (follows the link).
- `resolution/support-pipeline.ts` (`kind: support` pipelines).

Consumers that build on this plan:
- **SP-18 (copilot):** the "ask" box and a `summarize_insights` tool read these endpoints' JSON.
- **SP-24:** none. **SP-26:** "Former member" rows become handover targets.

Tkana reference (read-only, untrusted data; `C:\Users\ashra\Downloads\tkana-main\tkana-main\apps`):
- `api/src/features/analytics/analytics.repository.ts`:
  - time saved = customer messages × 2 × 30 s, "a deliberate approximation … a product decision, not a tuning knob", returned with the raw count;
  - `resolutionRates`: `decided = aiResolved + humanResolved + escalated + closed`, a rate is null when nothing concluded ("no data, never 0%");
  - all day/hour boundaries in the org's IANA timezone (invalid → `Asia/Riyadh`); one `today` anchor per read;
  - prior-period deltas (`pctDelta`, null on a zero prior).
- `analytics.sales-dashboard.repository.ts`: lead episodes; conversation visibility applied **inside** the subquery that picks a message; "waiting" = live non-terminal leads whose latest customer/staff/AI message the reader can open is the customer's; each section in its own guarded transaction with `SET LOCAL jit = off`; a failed card served once and never cached.
- `analytics.sales.repository.ts`: follow-ups completed per person; former members grouped; reps visible as `all` for owners, `own` for others.
- `components/home/{working-home,power-up-home}.tsx`: the home sections and the Day-1 guide.

What we take and what we don't:
- We take: the time-saved constant and its raw count, null-not-zero rates, one anchor per read, the workspace timezone, visibility inside the subqueries, per-section transactions with timeouts and independent failure, former-member grouping.
- We do **not** take:
  - an hourly rollup fact table (we compute live; ruling 9);
  - prior-period deltas (ruling 9);
  - lead "episodes" (new/returning/placed) — our lead pipeline has one card per contact (SP-08), so a card is a lead;
  - owner-only reps visibility (ruling 7);
  - the "ask" box (ruling 1).

## Global Constraints
- **Data (exact names):**
  ```
  model WorkspaceMember {
    // … existing fields unchanged …
    /// SP-11: when this member last looked at the working home ("while you were away" starts here).
    homeSeenAt          DateTime?
    /// SP-11: the member closed the Day-1 home.
    homeDay1DismissedAt DateTime?
  }

  model Message {
    // … existing fields unchanged …
    /// SP-11: the member who sent a staff message from the inbox (null for older rows, AI, customers and automations).
    sentById String?
  }
  ```
  - `Message.sentById` has **no** foreign key and **no** index (ruling 4): a FK would validate against the largest table under lock, and the Team query filters by workspace and range first. A removed member's id stays and reads as "Former member".
- **Writers of `sentById`** (Task 1): `ConversationsService` human send paths (`conversations.service.ts` both `message.create` with `from: "human"`), and the inbox template send when a member triggers it (`whatsapp.service.ts` / `zernio.service.ts` template sends get an optional `actorId`). Workflow and campaign sends pass none.
- **DTOs** (`backend/src/insights/insights.dto.ts`, mirrored in `src/lib/types.ts`):
  - `Section<T> = {status: "ok", data: T} | {status: "unavailable"} | {status: "forbidden"}`.
  - `SupportInsights = {range: {from, to, tz}, channelId: string | null, headline: Section<{conversations, decided, aiResolved, aiResolutionRate, medianFirstResponseSec, unanswered, medianHandlingSec, timeSaved: {customerMessages, hours}, ticketShare}>, resolutionMix: Section<{ai, human, escalated, closed}>, peaks: Section<{matrix: number[7][24], byHour: number[24]}>, byNumber: Section<{channelId, label, conversations, aiResolutionRate}[]>, topicFriction: Section<{topic, count, escalatedShare, negativeShare}[]>, team: Section<{userId: string | null, name, former: boolean, assigned, replies, medianFirstResponseSec, resolved}[]>}`.
  - `SalesInsights = {range, pipeline: {id, name, nameAr, kind}, headline: Section<{leads, replied, medianSpeedToReplySec, waiting, won}>, distribution: Section<{bucket, count}[]>, weekly: Section<{weekStart, leads, won}[]>, sources: Section<{kind, key, id?, label, leads, won}[]>, funnel: Section<{stageId, key, label, labelAr, reached, isWon, isTerminal}[]>, lostReasons: Section<{reasonId: string | null, label, labelAr, count}[]>, reps: Section<{userId: string | null, name, former, leads, won, lost, medianSpeedToReplySec, followUps: {done, overdue, dueToday}}[]>}`.
  - `HomeDto = {now, tz, needsPerson: {waitingConversations: Section<{total, items}>, lateFollowUps: Section<…>, unassignedTickets: Section<…>}, today: {followUps, bookings, ticketsDue}, tomorrow: {…}, away: {since, aiReplies, aiResolved, agentBookings, autoTickets, conversations: {id, contactName, resolvedAt}[]}, day1: {show: boolean, steps: {key, done, href}[]}}`. A section the member has no permission for is `forbidden` and the UI hides it.
- **API** (every route workspace-scoped; a foreign id gives **404**):
  - `GET /insights/support?from&to&channelId` (`reports.view`) → `SupportInsights`. A foreign or non-WhatsApp `channelId` → 404 `insights.channel_not_found`.
  - `GET /insights/sales?from&to&pipelineId` (`reports.view`) → `SalesInsights`.
  - `GET /home` (`authenticated`) → `HomeDto`.
  - `POST /home/seen` (`authenticated`) → `{homeSeenAt}`.
  - `POST /home/day1/dismiss` (`authenticated`) → `{dismissedAt}`.
  - Errors (`backend/src/insights/insights-errors.ts`): 400 `insights.range_invalid`; 404 `insights.channel_not_found`, `insights.pipeline_not_found`. Frontend `src/screens/insights/insightsErrors.ts` with a test covering every key.
- **Copy and layout:**
  - Every string through `tx("English","العربية")` with real Arabic. Examples: "AI resolution rate" / "نسبة الحل بالذكاء الاصطناعي", "Median first response" / "متوسط أول رد (الوسيط)", "Median handling time" / "الوسيط لمدة المعالجة", "Time saved" / "الوقت الموفَّر" with the tooltip "Estimated at 60 seconds per customer message the AI answered first" / "تقدير: ٦٠ ثانية لكل رسالة عميل ردّ عليها الذكاء الاصطناعي أولًا" (Latin digits in the rendered number), "Turned into tickets" / "تحوّلت إلى تذاكر", "Needs a person" / "تحتاج إلى شخص", "While you were away" / "أثناء غيابك", "No data yet" / "لا بيانات بعد".
  - Durations: `formatDuration(sec, lang)` → "4 min" / "٤ د" with Latin digits (`ar-SA-u-nu-latn`), "1 h 20 min", "2 d 3 h".
  - Logical CSS only; charts' x-axes start at the inline start (mirrored in RTL), values in Latin digits; numbers, phone numbers and names in `<bdi>`; topic labels `dir="auto"`. Dialogs set `dir`.
  - The range picker states the zone: "Days in <tz>" / "الأيام بتوقيت <tz>".
- **Permissions (SP-25).** No catalogue change. `permission-map.ts` adds:
  - `GET /insights/support`: `reports.view`
  - `GET /insights/sales`: `reports.view`
  - `GET /home`: `authenticated` (sections filtered in the service)
  - `POST /home/seen`: `authenticated`
  - `POST /home/day1/dismiss`: `authenticated`

  `system-role-decisions.spec.ts` adds an `SP-11 insights and home routes` block: owner, admin, agent and viewer read both insights (all hold `reports.view`); a custom role without `reports.view` gets 403; every member reads the home. `permission-sidedoors.spec.ts` adds `support insights respect assigned visibility` and `home lists only permitted records`.
- **Migration:**
  - File: `backend/prisma/migrations/20261116140000_insights_home/migration.sql`, after SP-10's `20261116130000_bookings_catalog`. **Every applied migration is never edited.** Hand-written; `npx prisma migrate deploy` only.
  - Contents (additive and idempotent):
    ```sql
    ALTER TABLE "WorkspaceMember" ADD COLUMN IF NOT EXISTS "homeSeenAt" TIMESTAMP(3),
                                  ADD COLUMN IF NOT EXISTS "homeDay1DismissedAt" TIMESTAMP(3);
    ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "sentById" TEXT;
    ```
  - **Prisma-conformant**: `prisma migrate diff` from the base schema yields exactly these columns.
  - **Safe for the deployed `main`:** three nullable columns with no default (metadata-only on Postgres 11+, no rewrite even on `Message`); `main` never selects them and its inserts leave them null. No index, no FK, no constraint, no `UPDATE`, `DELETE`, `DROP` or type change. **No backfill** (older messages stay unattributed; ruling 4).
  - Why a migration at all: "while you were away" needs a per-member, cross-device "last seen" (ruling 2), the Day-1 home needs a per-member dismissal, and per-agent Team figures need the sender (ruling 4). If the controller rejects rulings 2 and 4, the migration is dropped and the plan uses `localStorage` and assignee attribution instead.
- **Tests:**
  - **Fixture method (ruling 12):** one shared world `backend/src/insights/__fixtures__/insights-world.ts` (a workspace in `Asia/Riyadh`, members of each system role plus an assigned-only agent, two WhatsApp channels and one Instagram, conversations and messages with exact timestamps, resolution verdicts, tickets in leads/deals/support pipelines with activities, lost reasons, ad sources, activities, bookings), with the **expected value of every metric written by hand** in `insights-expected.ts`. Two runners assert the same expectations:
    - `insights-oracle.spec.ts` (always runs): a plain TS implementation of each definition over the world (`insights-oracle.ts`, test-only) equals the expectations — it pins the *definitions*;
    - `support-metrics.db.spec.ts` / `sales-metrics.db.spec.ts` / `home.db.spec.ts` (skipped without `INSIGHTS_TEST_DATABASE_URL`, the `conversation-resolution.db.spec.ts` pattern): seed the world into a fresh throwaway workspace, run the **real SQL**, assert the expectations, delete the workspace — they pin the *SQL*. Task 6 runs them against production in a throwaway workspace.
    - Each metric's test (both runners) has the exact name from the tables above.
  - backend: `npx jest src/insights src/home src/dashboard src/conversations src/integrations src/permissions` plus `npx tsc --noEmit -p tsconfig.json`; the full `npm test` once per task. Known unrelated failure: `hjz-client-sync › is inert when HJZ is not configured`.
  - frontend: `npx vitest run` plus `npm run typecheck`; `npm run build` once in Tasks 4 and 5.
  - **Named acceptance tests (exact names):** every metric test above (21), plus **`median first response excludes AI-only replies`** and **`home lists only permitted records`** (backend jest `src/home/home.service.spec.ts` and the sidedoors spec), and the frontend `greeting uses the member name and workspace timezone` (vitest).
  - No provider is called anywhere in SP-11.
- **Commits:** selective `git add <paths>`, never `-A`. Trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not stage `.playwright-mcp/`, `.claude/worktrees/` or any untracked file this plan did not create.

## Review Focus
1. **A restricted member reads conversations through a report (Review Focus 1).**
   - Every conversation/message-derived figure, list and row (support, sales replied/waiting/speed, home lists, the "away" rows) is computed under the viewer's scope inside the SQL, never filtered afterwards; a figure can never reveal a hidden conversation's existence through a count difference the member could not otherwise see.
   - Tests: `support insights respect assigned visibility`, `home lists only permitted records`, `sales waiting ignores hidden threads`.
2. **One definition per metric.**
   - Each metric is one SQL builder and one fixture test; the frontend never recomputes a metric; null means no data and is never shown as 0.
   - Tests: the 21 metric tests; `rates and medians are null on empty input`.
3. **Time zones and the anchor.**
   - Ranges, hours, weeks and "today/tomorrow" are workspace-local; one `now` per request; a message at 23:30 local belongs to its local day and hour.
   - Tests: `hour-of-day peaks bucket customer messages in the workspace timezone`, `range parsing is workspace-local and bounded`, `today and tomorrow use local days`.
4. **Cost.**
   - Every section is bounded by `statement_timeout` and fails alone; no N+1 (record checks are per kind, in bulk); medians are computed in SQL.
   - Tests: `a timed-out section is unavailable and others answer`, `home checks records in bulk` (query count ≤ 12).
5. **Existing dashboard unchanged.**
   - `GET /dashboard/summary` and `GET /tickets/dashboard/summary` answer exactly as before; the scope helper move is behaviour-neutral.
   - Tests: `dashboard.spec.ts` and the tickets dashboard specs unmodified and green.

## Architecture Rulings and Risks
Each item names the risk, then the recommended ruling. Items marked **(needs controller ruling)** are repeated under Controller rulings, where the controller fills in the decision.

1. **The "ask" box.** The roadmap: it sends the metrics JSON to the copilot (SP-18), "or is hidden until SP-18 ships".
   - **Ruling:** hidden — not rendered, no endpoint, no flag. SP-18's plan adds it (its `summarize_insights` tool reads these endpoints). Nothing in SP-11 waits on SP-18.
   - **(needs controller ruling, minor)**
2. **"While you were away" and Day-1 state.** No "last seen" exists (`User.status` is a static string).
   - **Ruling:** `WorkspaceMember.homeSeenAt` and `homeDay1DismissedAt` (per member, per workspace, across devices), set by `POST /home/seen` and `POST /home/day1/dismiss`.
   - **Alternative:** `localStorage` only (no migration; per device, lost on another browser). **(needs controller ruling)**
3. **Resolution history.** A conversation keeps only its latest verdict and resets when the customer writes again. A conversation resolved twice in a range counts once; one resolved and then reopened before the read does not count.
   - **Ruling:** accept for SP-11 and say it in the metric tooltip ("Latest outcome of each conversation" / "آخر نتيجة لكل محادثة"). AI-only = no staff message in the 7 days before `resolvedAt` (`RESOLUTION_LOOKBACK`).
   - **Alternative:** an append-only `ConversationOutcome` table written by the resolution service from now on (exact history going forward, a second migration, and a change to the resolution path). **(needs controller ruling)**
4. **Who sent a staff message.** `Message` has no sender id (`agent` is unused), so per-agent first response and replies cannot be attributed.
   - **Ruling:** add `Message.sentById` (nullable, no FK, no index), written by the inbox send paths from SP-11 on. The Team tab and the reps' speed use it; older replies fall into "Unattributed" (stated in the UI with the date it starts). No backfill (there is nothing to backfill from).
   - **Alternative:** attribute to the conversation's current assignee (no migration; wrong after reassignment). **(needs controller ruling)**
5. **Speed to reply and first response count only staff.** An AI reply arrives in seconds and would make both medians meaningless.
   - **Ruling:** both medians measure the first `human` message (roadmap's `median first response excludes AI-only replies`); exchanges the AI alone answered are excluded and reported through the AI resolution rate and time saved. `replied` (sales) counts AI replies too, since the customer did get an answer.
   - Accepted risk: a workflow or automation template send stored as `from: "human"` counts as a staff reply; Task 6 measures how many such rows exist (`sentById IS NULL AND from = 'human'` after deploy) and a follow-up can mark them. **(needs controller ruling)**
6. **Campaign replies.** SP-12's `CampaignRecipient` marks replies to campaigns; a customer replying to a broadcast starts an exchange.
   - **Ruling:** campaign replies count as exchanges like any other inbound message (they are real customer messages a person may need to answer). No exclusion.
   - **(needs controller ruling, minor)**
7. **Reps visibility.** Tkana shows every rep to owners and only their own row to other members.
   - **Ruling:** every holder of `reports.view` sees every rep row; conversation-derived columns are still computed under the reader's scope. Our system roles grant `reports.view` to agents and viewers (SP-25), so if per-rep privacy matters the owner removes `reports.view` from a custom role.
   - **Alternative:** non-managers see only their own row and the totals. **(needs controller ruling)**
8. **Module hub and `enabledModules`.** `Workspace.enabledModules` (JOTECK admin) is not read by the frontend today.
   - **Ruling:** the hub filters by permission only and does not read or write `enabledModules`; no module on/off toggles in SP-11.
   - **(needs controller ruling, minor)**
9. **Live SQL, no rollup, no cache, no deltas.**
   - **Ruling:** live SQL per request with per-section timeouts; no fact table, no cache, no prior-period deltas. Task 6 measures every section on a seeded 20 000-message throwaway workspace; any section over 3 s becomes a follow-up (an index in its own migration and approval, as SP-16 ruling 10: `Message(workspaceId, createdAt)` cannot be built `CONCURRENTLY` inside Prisma's transactional migrations, and a plain build would lock inbound writes).
   - **Alternative:** add prior-period deltas to the headline tiles now (one more pass per section). **(needs controller ruling)**
10. **Week start.** Weekly trends need a week boundary.
    - **Ruling:** weeks start on **Sunday** for workspaces whose `lang` is `ar` and **Monday** for `en` (computed in SQL from `date_trunc('week', …)` with a one-day shift for Sunday).
    - **(needs controller ruling, minor)**
11. **Phase 4 ordering.** The home reads SP-09 (`slaDueAt`, support pipelines) and SP-10 (services, staff bookings); sales sources read SP-15.
    - **Ruling:** SP-11 is planned and built **after** SP-09 and SP-10 merge (migration order SP-09 → SP-10 → SP-11). If it must start earlier, the home's "tickets due" and "add services" step are behind a schema check (`information_schema.columns`), rendering "not available" rather than failing.
    - **(needs controller ruling)**
12. **Fixture tests need a real Postgres.** The repo's jest suite is DB-free; the SQL (percentiles, window functions, `AT TIME ZONE`) cannot run on the in-memory doubles.
    - **Ruling:** the shared world + hand-written expectations, checked by a TS oracle in every run and by DB specs against a disposable database when `INSIGHTS_TEST_DATABASE_URL` is set. Task 6 runs the DB specs against production inside a throwaway workspace (the SQL is workspace-scoped), with cleanup.
    - **Alternative:** a disposable local Postgres in CI (Docker; not available in this repo's CI today). **(needs controller ruling)**
13. **Where the home lives.**
    - **Ruling:** the `dashboard` route becomes the home: the working-home sections on top, the existing overview charts below under "Overview" / "نظرة عامة"; the Day-1 home replaces the top while it shows. The Analytics route gets tabs **Overview | Support | Sales** (`#/analytics?tab=support&from=…&to=…&channel=…&pipeline=…`), and Support has a **Team** sub-tab.
    - **Alternative:** a new `home` route as the landing page. **(needs controller ruling, minor)**
14. **Shared files.** SP-09/SP-10 edit `schema.prisma`, `permission-map.ts`, `system-role-decisions.spec.ts`, `src/lib/types.ts`; Task 1 edits the send paths in `whatsapp.service.ts`, `zernio.service.ts` (SP-15/16/17 also touched them).
    - **Ruling:** base on the commit that ships SP-10, recorded as the base SHA; Task 1 owns `schema.prisma` and the migration for SP-11; the send-path change is the optional `actorId` parameter only. **(needs controller ruling)**
15. **Verification touches production.**
    - Task 6 runs on the production DB in throwaway workspaces. SP-11 calls no provider; the launcher still empties every provider key and keeps the egress guard. The 20 000-message seed needs its own **explicit approval**, separate from the migration's.
    - **(needs controller ruling)**
16. **Size.** The roadmap says L. Five build tasks (three backend, two frontend) plus verification; the metric count makes it a large L. Dropping the Team tab (ruling 4) and the Day-1 home keeps it a firm L. **(needs controller ruling)**

### Controller rulings
*Decided 2026-11-16: every recommendation below is accepted, except that R11/R14 are amended: Task 1 (schema, sender recording, shared helpers, support insights) starts now from 3f2f41d, because it does not depend on SP-10. Tasks 2–5 wait for SP-10 to be merged. Migration 20261116140000_insights_home and the timing seed each need explicit user approval.*
- **R1** (ask box hidden; SP-18 adds it). Accepted.
- **R2** (`homeSeenAt`, `homeDay1DismissedAt` on `WorkspaceMember`). Accepted.
- **R3** (latest-verdict semantics; 7-day lookback for AI-only). Accepted; outcome history as a follow-up.
- **R4** (`Message.sentById`, no FK, no index, no backfill). Accepted.
- **R5** (staff-only medians; `replied` counts AI). Accepted.
- **R6** (campaign replies count as exchanges). Accepted.
- **R7** (all reps visible to `reports.view`). Accepted.
- **R8** (hub by permission only; `enabledModules` untouched). Accepted.
- **R9** (live SQL, no cache, no deltas; index only as a measured follow-up). Accepted.
- **R10** (week start Sunday for Arabic, Monday for English). Accepted.
- **R11** (build after SP-09/SP-10; schema-checked fallbacks otherwise). Accepted.
- **R12** (shared world, TS oracle always, DB specs on a disposable/throwaway database). Accepted.
- **R13** (home on the `dashboard` route; Analytics tabs). Accepted.
- **R14** (base on the SP-10 ship commit; Task 1 owns the schema). Accepted.
- **R15** (production verification; migration and seed each need explicit approval). Accepted.
- **R16** (size L, 5 build tasks + verification). Accepted.

---

### Task 1: Backend — migration, `sentById` writers, shared insights plumbing, support insights
**Owns:** `schema.prisma` and the migration for all of SP-11.

**Files:**
- `backend/prisma/schema.prisma`; `backend/prisma/migrations/20261116140000_insights_home/migration.sql`; `backend/src/insights/insights-home-migration.spec.ts`.
- Create `backend/src/insights/`: `insights-constants.ts`, `insights-range.ts`, `insights-scope.ts`, `insights-errors.ts`, `insights.dto.ts`, `support-metrics.sql.ts`, `insights.service.ts` (`support()`; section runner with `statement_timeout`), `insights.controller.ts`, `insights.module.ts`, `__fixtures__/insights-world.ts`, `insights-expected.ts`, `insights-oracle.ts` (test-only), `insights-oracle.spec.ts`, `support-metrics.db.spec.ts`, `world-seed.ts` (seeds the world into a new workspace and returns a cleanup function; used by the DB specs and Task 6).
- `backend/src/dashboard/dashboard.module.ts`: import `conversationScopeSql` (behaviour unchanged).
- `backend/src/conversations/conversations.service.ts`: `sentById` on staff sends (the controller passes the member id). `backend/src/integrations/whatsapp.service.ts`, `zernio.service.ts`: an optional `actorId` on the template send used by the inbox, written to `sentById`.
- `backend/src/app.module.ts`: `InsightsModule`.
- `permission-map.ts` + spec rows; `system-role-decisions.spec.ts` (`SP-11 insights and home routes`, support part); `permission-sidedoors.spec.ts` (`support insights respect assigned visibility`).

**Produces:** `SupportInsights`, the plumbing (`parseRange`, `conversationScopeSql`, section runner, world seed) used by Tasks 2–3.

- [ ] Write the failing tests:
  - `migration is additive, idempotent and Prisma-named (SP-11)`: three `ADD COLUMN IF NOT EXISTS`, nullable, no default; nothing else (no index, FK, `UPDATE`, `DROP`); folder > `20261116130000`; pinned sha256 of `20261116120000_support_tickets` and `20261116130000_bookings_catalog`; `prisma migrate diff` equality recorded.
  - `staff sends record the sender`: an inbox text send and an inbox template send store `sentById = the member`; workflow/campaign template sends and AI replies store null; existing send specs unchanged.
  - `range parsing is workspace-local and bounded`: default last 30 local days; `from > to`, > 366 days, malformed → 400 `insights.range_invalid`; Riyadh day boundaries at 21:00Z.
  - The support metric tests, each in both runners: `conversations counts distinct conversations with a customer message in range`, `ai resolution rate = ai-resolved / decided (nothing decided → null)`, **`median first response excludes AI-only replies`** (the world holds: an exchange answered by AI only → excluded; one answered by AI then staff 12 min later → 12 min; one answered by staff in 3 min → 3 min; one unanswered → `unanswered: 1`; an exchange started before `from` → excluded; expected median 7.5 min), `median handling time runs from exchange start to resolvedAt`, `time saved credits 60 s per customer message answered first by AI`, `share turned into tickets counts support tickets created from the range's conversations`, `resolution mix buckets are disjoint and sum to decided`, `hour-of-day peaks bucket customer messages in the workspace timezone` (a message at 20:30Z is hour 23 Riyadh), `by number splits conversations and ai rate per WhatsApp channel`, `topic friction ranks topics with escalation and negative share`, `team rows attribute replies to the sending member`.
  - `rates and medians are null on empty input` (an empty workspace: every rate and median null, counts 0).
  - `support insights respect assigned visibility` (sidedoors): the assigned-only agent's figures equal the world restricted to their conversations (expected values written in `insights-expected.ts`).
  - `a timed-out section is unavailable and others answer` (the section runner with a fake that throws `57014`).
  - `foreign channel id is 404` (B's channel from A; an Instagram channel → 404).
- [ ] Implement until green.
- [ ] `npx tsc --noEmit -p tsconfig.json`, the jest paths, then the full `npm test` once. `npx prisma generate`. **Do not run `migrate`** (ruling 15). `dashboard.spec.ts` unmodified and green.
- [ ] Commit `feat(insights): support insights with fixture-pinned sql metrics and message sender`.

### Task 2: Backend — sales insights
**Depends on:** Task 1 (plumbing, world).

**Files:** `backend/src/insights/sales-metrics.sql.ts`, `insights.service.ts` (`sales()`), the controller route, `sales-metrics.db.spec.ts`; the world and `insights-expected.ts` gain the sales parts; `permission-map.ts` row and the role block's sales part.

- [ ] Write the failing tests (both runners): `leads counts cards created in range in the pipeline`, `replied counts leads with a staff or AI message after creation`, `speed to reply is the median to the first staff reply`, `speed distribution buckets are exhaustive` (every lead in exactly one bucket; bucket edges at 5, 15, 60, 240, 1440 min go to the higher bucket), `waiting counts open leads whose latest visible message is the customer's`, `won counts distinct cards with a won move in range` (won, reopened, won again in range → 1), `weekly trend buckets by workspace-local week` (Arabic workspace weeks start Sunday; empty weeks present with zeros), `lead sources attribute ad, channel, then contact source`, `stage funnel counts cards that reached each stage`, `lost reasons group by catalog reason with snapshot fallback`, `reps table totals owners and follow-ups`; plus `sales waiting ignores hidden threads` (sidedoors), `default pipeline is the first leads pipeline`, `foreign pipeline id is 404`, `ticket sections are forbidden without tickets.view` (a custom role with `reports.view` only).
- [ ] Implement until green.
- [ ] `npx tsc --noEmit -p tsconfig.json`, the jest paths, the full `npm test` once.
- [ ] Commit `feat(insights): sales insights with leads, speed, sources, funnel, lost reasons and reps`.

### Task 3: Backend — working home
**Depends on:** Task 1. Reads SP-09/SP-10 data (ruling 11).

**Files:** `backend/src/home/` (`home.module.ts`, `home.controller.ts`, `home.service.ts`, `home-records.ts` (bulk permission/scope check per kind, reusing `canOpenRecord`'s rules), `day1-steps.ts`), specs `home.service.spec.ts`, `home.db.spec.ts`; `app.module.ts`; `permission-map.ts` rows; sidedoors case.

- [ ] Write the failing tests:
  - **`home lists only permitted records`**: the assigned-only agent sees only their/unassigned visible waiting conversations, never a hidden one (by id, by count and in "away" rows); a role without `tickets.view` gets `unassignedTickets: {status: "forbidden"}`; without `bookings.view`, no bookings; a follow-up linked to a ticket is hidden without `tickets.view`; another workspace's rows never appear; the owner sees all.
  - `waiting conversations are unanswered, visible and need a person` (AI-handled and not escalated → excluded; escalated → included; `pending_customer`/`resolved`/`closed`/`spam` → excluded; latest message staff → excluded; oldest first).
  - `today and tomorrow use local days` (a follow-up at 23:30 local is today; 00:10 local tomorrow).
  - `away summary counts agent work since last seen` (`homeSeenAt` null → last 24 h; `POST /home/seen` moves it; counts under scope).
  - `day-1 home shows until dismissed or set up` (steps computed from data; dismissal per member; steps the member cannot use omitted).
  - `home checks records in bulk` (query count ≤ 12 for a home with 30 rows).
  - `home degrades without sp-09 or sp-10 columns` (the schema check returns false → those parts `unavailable`, no error).
- [ ] Implement until green.
- [ ] `npx tsc --noEmit -p tsconfig.json`, the jest paths, the full `npm test` once.
- [ ] Commit `feat(home): working home with needs-a-person, today and tomorrow, away summary and day-1 steps`.

### Task 4: Frontend — Analytics Support, Team and Sales tabs
**Depends on:** the contracts of Tasks 1–2.

**Files:**
- **F1 Model (pure, with tests):** `src/screens/insights/insightsModel.ts` (`formatDuration`, `formatRate`, `sectionView` for ok/unavailable/forbidden/null, `peaksScale`, `speedBucketLabel`), `insightsParams.ts` (tab, range presets 7/30/90/custom, channel, pipeline ↔ hash), `insightsErrors.ts`.
- **F2 Support tab:** `src/screens/insights/SupportInsights.tsx`: headline tiles (with the time-saved and latest-outcome tooltips), the resolution-mix `Donut`, a 7 × 24 peaks heat grid (logical layout, accessible table fallback), by-number list, topic friction table; the WhatsApp number select; the Team sub-tab table (`TeamTable.tsx`) with "Unattributed since <date>" and "Former member".
- **F3 Sales tab:** `SalesInsights.tsx`: tiles, the speed distribution bars, the weekly `AreaChart`, sources list (ad rows link to `#/ads?ad=<id>` for `reports.view`), the funnel, lost reasons, the Reps table with follow-up totals linking to `#/followups?assignee=<id>`.
- **F4 Analytics shell:** `src/screens/Analytics.tsx` gains tabs Overview | Support | Sales (Overview = today's content unchanged); the range picker with "Days in <tz>".
- **F5 Types:** `src/lib/types.ts`: `Section`, `SupportInsights`, `SalesInsights`.

- [ ] Write the failing vitest tests: `insights durations and rates format in both languages with Latin digits` (null → "No data yet"), `section states render unavailable and hide forbidden`, `insights tab, range, channel and pipeline round-trip through the hash`, `speed buckets label every bucket in both languages`, `insights error copy covers every SP-11 key in both languages`.
- [ ] Implement until green, then build the components.
- [ ] `npx vitest run`, `npm run typecheck`, `npm run build` clean.
- [ ] Commit `feat(insights): support, team and sales insights screens`.

### Task 5: Frontend — working home, Day-1 home, module settings hub, greeting
**Depends on:** Task 3's contract.

**Files:**
- **F1 Model (pure, with tests):** `src/screens/dashboard/greeting.ts`, `src/screens/home/homeModel.ts` (section visibility, waiting-since words, day-1 progress), `src/screens/settings/modules.ts`.
- **F2 Home:** `src/screens/home/WorkingHome.tsx` (Needs a person with three lists, Today / Tomorrow, While you were away; rows open the record sheet `?record=<kind>:<id>`; `POST /home/seen` after 3 s on screen), `Day1Home.tsx` (steps with links, progress, "Dismiss" / "إخفاء").
- **F3 Dashboard:** `src/screens/Dashboard.tsx`: the greeting from `greeting.ts` with the member's first name and the workspace name (no "Yara", no "Samemha"); `WorkingHome` (or `Day1Home`) on top, the existing charts under "Overview".
- **F4 Module hub:** `src/screens/settings/ModulesTab.tsx` and the `modules` tab in `src/screens/Settings.tsx`.
- **F5 Types:** `HomeDto`.

- [ ] Write the failing vitest tests: **`greeting uses the member name and workspace timezone`** (morning/afternoon/evening by workspace-local hour; no name → "Welcome back"; Arabic copy; never "Yara"), `home sections hide forbidden parts and show unavailable ones`, `day-1 progress counts done steps`, `module hub shows only permitted modules` (a viewer sees no module whose every link needs a write permission; links carry the right hashes).
- [ ] Implement until green, then build the components. Grep `src/` for `Yara`, `يارا` and `Samemha` in `Dashboard.tsx`: none left there (the `src/data/team*.ts` mocks are SP-26's).
- [ ] `npx vitest run`, `npm run typecheck`, `npm run build` clean.
- [ ] Commit `feat(home): working home, day-1 setup, module settings hub and real greeting`.

### Task 6: Verification
Apply `20261116140000_insights_home` with `npx prisma migrate deploy`, only when the controller and the user explicitly approve it (ruling 15). Record the results in `.superpowers/sdd/2026-11-16-sp11-insights-home/live-verification.md` in the SP-15 format: summary, results table with evidence, DB-side checks, findings, cleanup, pending items. If the harness refuses the write, put the tables in the scratchpad and say so; do not reroute.

**Before approval (read-only, production):** `reltuples` of `Message`, `WorkspaceMember`; `SELECT count(*) FROM "Message" WHERE "from" = 'human'` (for ruling 5's baseline). Ask separately for approval of the 20 000-message seed.

**Isolation** (no repo code changed; scripts derived from SP-15's in the session scratchpad `C:\Users\ashra\AppData\Local\Temp\claude\7b75a64029a712a6\ebb2057a-6300-4548-9aec-b98487880afb\scratchpad\`):
- **Own instance:** `launch-sp11.js`, derived from `launch-sp15.js`. Backend on **:4240** from `backend/.verify-dist-sp11` (never `backend/dist`), working directory `sp11-run/`; it records `perf_hooks.monitorEventLoopDelay` per check. The user's :4100 process is not touched.
- **Crons:** all `@nestjs/schedule` jobs disabled (the resolution sweep never runs; verdicts are seeded).
- **No external call, ever:** SP-11 calls no provider. Every provider key and base URL (Zernio, Meta, l, HJZ, Anthropic, OpenAI, `DO_SPACES_*`) is an **empty string** (SP-19 E2). The world is seeded straight into the database by `world-seed.ts` (no webhook, no send). The launcher refuses to start unless all of them are empty. The SP-13 egress guard stays; `blocked-egress-sp11.jsonl` must be empty before cleanup.
- Test tag `zz-verify-<ts>` on every name and email.

**Setup** (writes only rows of throwaway workspaces; ids in `verify-created-sp11.json`):
1. Register an owner and a foreign owner; invite an admin, an agent with `assigned` visibility (custom role), a viewer and a custom role without `reports.view`.
2. Seed the fixture world into the test workspace with `world-seed.ts` (re-pointing its member ids to the invited users).
3. With the separate approval: seed a second throwaway workspace with 20 000 messages over 2 000 conversations (generated, tagged) for timings.
4. Record the before-counts listed under Cleanup.

**Checks:**
- **Run the DB specs** (`support-metrics.db.spec.ts`, `sales-metrics.db.spec.ts`, `home.db.spec.ts`) with `INSIGHTS_TEST_DATABASE_URL` = production; each creates and deletes its own throwaway workspace: every metric test green — this is the live proof of every named metric test, including **`median first response excludes AI-only replies`**.
- **Through the API** on the seeded workspace: `GET /insights/support` and `/insights/sales` as the owner equal `insights-expected.ts`; as the assigned-only agent equal the restricted expectations; the custom role without `reports.view` → 403; the foreign owner with this workspace's channel/pipeline ids → 404; a range of 400 days → 400.
- **`home lists only permitted records` (live):** the home of each role matches the expected lists; no hidden conversation id appears in any response body of the assigned-only agent (grep of the raw JSON); `POST /home/seen` and the Day-1 dismissal persist (DB).
- **Sender:** an inbox send through `POST /conversations/:id/messages` on a test conversation (no channel credentials, so the provider send fails locally before any call or is skipped; record which) stores `sentById`.
- **Timings:** each section on the 20 000-message workspace: wall time and event-loop delay recorded; `EXPLAIN` (no `ANALYZE`) of the first-response and peaks queries recorded with their plans. Any section > 3 s is a finding with a proposed index follow-up (ruling 9).
- **Dashboard unchanged:** `GET /dashboard/summary` and `GET /tickets/dashboard/summary` on the test workspace equal the values computed from the seeded rows by the pre-SP-11 code (run the same requests against a build of the base SHA on :4242, same DB, then stop it).
- **Migration rerun:** the SQL again in an always-rolled-back transaction: no error, 0 rows changed (or record a tool refusal and ask the user; do not reroute).
- **UI through the `verify` skill:** the home (needs a person, today/tomorrow, away, Day-1 and its dismissal), the greeting with the owner's name, Analytics Support/Team/Sales in English and Arabic (RTL), "No data yet" on an empty range, the module hub per role; screenshots.

**Cleanup:**
- Delete only the recorded test rows: the workspaces (the cascade covers members, roles, channels, contacts, conversations, messages, tickets, activities, ad sources, bookings, notifications), then the users.
- Residue sweep over every table with a `workspaceId` column.
- Read-only counts before and after: `Workspace`, `User`, `WorkspaceMember`, `Role`, `Channel`, `Contact`, `Conversation`, `Message`, `Ticket`, `TicketActivity`, `Activity`, `AdSource`, `AdReferral`, `Appointment`, `Notification`. Every count identical.
- Stop :4240 (and :4242), remove the outDirs and `sp11-run/`.

Then tick SP-11's "Detailed plan written" and "Shipped" boxes in the roadmap, noting the rulings and deviations. Add the deferred items: the "ask" box (to SP-18, ruling 1), conversation outcome history (ruling 3), marking automated `human` messages (ruling 5), prior-period deltas and any measured index (ruling 9), module on/off toggles (ruling 8).
