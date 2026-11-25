# Comment auto-reply → private DM (Zernio comment automations)

**Date:** 2026-11-25
**Branch:** `feat/comment-auto-reply`
**Status:** built. The spike settled the blocking question (see below) and the
feature is implemented — schema, client, service, routes, UI and tests. The one
thing still unproven end to end is noted under "What is still unproven".

---

## Intent, and why

A Kewy Pass campaign runs as a video on Instagram/Facebook. Viewers comment a
keyword ("كيوي"). We want each of them to get a private DM within seconds, and
we want their reply to land in the Aram inbox as a real conversation attached to
a real contact — so the CRM owns the lead instead of someone scraping comments by
hand.

Meta supports this as **Private Replies**: one DM per comment, within 7 days of
the comment, and the 24-hour messaging window only opens once the person replies
to that DM. Those are Meta's rules and they shape the message copy more than the
code: **the first DM has to end in a question**, or the lead dies there.

The business reason to build this inside the CRM rather than in Meta Business
Suite (which can do the keyword→DM part today, with no code) is **attribution**:
knowing which reel and which ad produced each lead, inside the same system that
holds the conversation.

## Goals

- A setting in the CRM that enables and disables comment auto-reply per workspace.
- Keyword rules, the DM body, and an optional public reply, all editable in the UI.
- Their reply arrives in the existing inbox as a contact + conversation (already true).
- Lead-source attribution: which post, and which ad, produced each lead.
- Bilingual EN/AR, like every other settings card.

## Non-goals

- Replacing or extending the workflow engine. (Option C below — later.)
- Building our own keyword matcher or private-reply sender. (Option B — blocked.)
- Multi-rule management, unless the scope question below is answered that way.
- TikTok / Threads / LinkedIn / YouTube: Zernio's docs state these have **no
  private reply to a comment**, only a public reply. Out of scope.

## Anti-goals

**A switch that does not actually switch anything off.** The automation runs at
Zernio, not in our process. If the UI shows a toggle and flipping it to "off"
does not stop Zernio sending DMs, we have shipped something worse than nothing:
the operator believes the campaign is stopped while strangers keep receiving
messages. If we cannot disable, we do not ship a toggle — see "The blocking
unknown".

Second anti-goal: a DM that does not invite a reply. Meta grants exactly one
private reply per comment and it cannot be retried, so a dead-end message
permanently burns the lead.

## Constraints (all verified against Zernio's published docs)

| Constraint | Source |
|---|---|
| One private reply per comment, ever. Reuse answers `400 privateReplyConsumed`. | Zernio comments docs |
| The private reply must be sent within **7 days** of the comment. | Zernio Instagram inbox docs |
| The 24-hour window opens only when the person replies. | Meta messaging policy, repeated in Zernio docs |
| An automation answers **only comments posted while it is active**. Pre-existing comments never fire. | Zernio comment-automations docs |
| Account-wide automations watch the **5 newest posts**; Graph reads capped at 20 per account per run. | Zernio comment-automations docs |
| Only **one active per-post automation** per post (409 otherwise). | Zernio comment-automations docs |
| Private reply is supported on Instagram and Facebook only. | Zernio platform compare |
| The Zernio API key is **global across workspaces**; isolation rides on `profileId`. | `backend/src/integrations/zernio.client.ts` |
| Inbox webhook events 403 `feature_not_available` on legacy AppSumo plans. | Zernio webhooks docs |

## The blocking unknown — probed 2026-11-25, largely resolved

Zernio's public docs show exactly two comment-automation endpoints: `POST
/v1/comment-automations` (create) and `GET /v1/comment-automations` (list). **No
update, no delete, and no documented way to set `isActive: false`.** Since the
automation runs at Zernio rather than in our process, a UI toggle that cannot
actually stop it would be worse than no toggle at all (see Anti-goals).

Resolved by probing the live API rather than reading more docs —
`spikes/zernio/spike.mjs` → `ca:list`, `ca:probe-disable`.

### What the probe established

Zernio returns two *different* 404s, which is what makes probing with a
deliberately fake id conclusive:

- a missing route → `{"error":"No such API endpoint: …","code":"endpoint_not_found"}`
- a real route that just couldn't find the row → `{"error":"Automation not found"}`

Results against `/comment-automations/000000000000000000000000`:

| Call | Result | Reading |
|---|---|---|
| `GET /comment-automations` | **200** `{"success":true,"automations":[]}` | Available on this plan — **not** gated like the AppSumo webhook case. Zero automations exist today. |
| `PATCH /comment-automations/{id}` | 404 `Automation not found` | **Route exists**, undocumented |
| `DELETE /comment-automations/{id}` | 404 `Automation not found` | **Route exists**, undocumented |
| `PUT` / `POST` on `/{id}` | 405 | Path real, those verbs are not |
| `…/status`, `…/disable`, `…/deactivate`, `…/pause` | 404 `endpoint_not_found` | Invented — do not exist |

**Conclusion: an undocumented `PATCH /v1/comment-automations/{id}` exists, and so
does `DELETE`.** Disable is therefore almost certainly implementable, and the
design proceeds with a real on/off toggle.

### What is still unproven

That `PATCH {isActive:false}` is *accepted* — the route exists, but a fake id
404s before any body validation, so the payload shape is unconfirmed. Proving it
end to end needs a real automation id, which means creating a live automation
(`ca:create … --i-understand`) and re-probing against it. **That step sends real
DMs if a real person comments the keyword, so it is gated behind an explicit flag
and needs the user's go-ahead.** Mitigations built into the command: a nonsense
keyword, `--post=` scoping to a single test post, and `matchMode: 'exact'`.

Since `DELETE` also exists, there is a fallback even if `PATCH` rejects the body:
disable by deleting and re-creating on re-enable. Slightly lossy (the automation's
counters reset) but functionally a working switch.

## Approaches considered

### A — A settings card over Zernio's comment automations *(chosen)*

The card writes a `POST /v1/comment-automations` rule. Zernio owns keyword
matching, the private reply, the public reply, the 7-day window, dedupe, retries
and the counters. We store the returned automation id and read stats back.

- **For:** smallest build (2–3 client methods, one service, one card). Meta's
  rules are handled upstream. Keyword modes, send delays, follower gating and
  button DMs come free. Works on Instagram and Facebook including ad comments.
- **Against:** disable is undocumented (above). The rule keeps running if our app
  is down or the workspace is suspended.

### B — Our own rule engine on `comment.received`

Subscribe to the `comment.received` webhook, match keywords in our code, call a
Zernio private-reply endpoint directly.

- **For:** rules live in our DB; "off" is trivially just not calling.
- **Against:** **the private-reply endpoint is not documented.** Its error codes
  (`privateReplyConsumed`, `privateReplyOutcome`) appear in the docs; its path
  never does. For Facebook the docs state private reply exists *only* through
  comment automations. We would also re-implement the 7-day window, dedupe and
  retries. **Not available** without Zernio confirming an endpoint.

### C — A `comment_received` workflow trigger

Add the trigger to `TRIGGER_TYPES` and a send step, making this one more workflow
beside the existing six triggers.

- **For:** conditions, delays, AI steps and tagging compose for free; one mental
  model for every automation.
- **Against:** still needs A underneath — the send goes through Zernio either
  way. Much heavier UI for what is currently one rule per campaign.

**Chosen: A.** B is blocked on an undocumented endpoint; C needs A underneath it
regardless. A is both the cheapest and the only one that can ship.

## What already exists (verified in the tree)

| Piece | State |
|---|---|
| `zernio.client.ts` | 28 methods; no comment-automation methods, no private reply |
| `zernio.service.ts` → `replyToComment()` | Public comment reply with a workspace tenancy guard — the pattern to copy |
| `zernio.controller.ts:190` `POST /webhooks/zernio` | Live, HMAC-guarded by `ZernioWebhookSignatureGuard` |
| `zernio.service.ts` → `handleEvent()` | Handles message/account events; **drops `comment.received`** as "Unhandled" |
| `zernio.service.ts` → `ingestInbound()` | Turns an inbound DM into a Contact + Conversation |
| `zernio.service.ts:1418` | l-agent auto-reply when `conv.aiEnabled && !conv.aiPausedAt` |
| `IntegrationsTab.tsx` + `ZernioCard.tsx` | The settings surface the new card slots into |
| `Workspace.zernioProfileId` | Per-workspace Zernio profile id |
| `Integration` (`provider="zernio"`, `platform`, `pageId`) | The per-platform account rows |

Everything from "their reply arrives" onward **already works**. The build is the
front half only.

## The design

### UI — a section on the channel's own page in the Channels hub

**Changed during the build (2026-11-25).** The design said "Settings →
Integrations, below `ZernioCard`". That was wrong about the current app:
`ZernioCard` is no longer rendered on the Integrations tab at all. SP-19 moved
every channel to a Channels hub, and the Integrations tab now shows only a
"Channels moved" pointer plus the MCP card.

So the form lives in `ChannelDetail` (`src/screens/channels/`), shown for a
`provider="zernio"` channel of kind `instagram` or `facebook` that is not
disconnected — beside the website-chat settings and number-health sections,
which follow the same per-kind pattern. This is a better fit than the original
plan anyway: the rule is scoped to ONE connected account, and that page *is* one
connected account, which is also why the table is keyed `(workspaceId,
accountId)`.

Five states, in the order an operator hits them:

1. **Off, empty.** Switch beside the title (not at the bottom — it is the most
   important control). Fields editable, `Save rule` disabled until valid. Copy:
   "Nothing is sent while this is off."
2. **Filled in, not live.** Saved locally. The warning under the message field is
   load-bearing: one DM per comment, so end it with a question.
3. **Switching on.** A confirmation dialog, because this is the only action that
   creates anything at Zernio. It must state that **comments already under the
   post will never be answered**.
4. **Active.** Live status line plus a Performance block fed by Zernio's own
   `dmsSent` / `dmsFailed` / `linkClicks` / `uniqueContacts`. "Became contacts" is
   ours, derived from inbound DMs we already ingest.
5. **Paused.** New comments ignored. Existing inbox threads **untouched** — the
   card says so explicitly, because the fear on switching off is "did I just drop
   211 live conversations?" (No.)

Fields: account, trigger keywords (+ match mode), applies-to (all posts / one
post), private message, public reply, reply-once-per-person, send delay, hand
over to the AI agent.

### Backend

Routes (shape follows the existing `integrations/zernio/*` controller):

| UI action | Our route | Zernio call |
|---|---|---|
| Save rule | `PUT /integrations/zernio/comment-rules/:id` | none — local only |
| Switch on | `POST …/comment-rules/:id/enable` | `POST /v1/comment-automations` |
| Switch off | `POST …/comment-rules/:id/disable` | `PATCH /v1/comment-automations/:id` `{isActive:false}` — route confirmed, body unproven; `DELETE` as fallback |
| Edit while active | `PUT …/comment-rules/:id` | `PATCH`, or disable + re-create |
| Open the card | `GET …/comment-rules` | `GET /v1/comment-automations` |

**Zernio is the source of truth for whether a rule is running**; our row records
which automation is ours and what it was configured with. The card reads both and
shows Zernio's answer.

**Tenancy guard (non-negotiable).** Copy the `replyToComment()` pattern: resolve
`workspace.zernioProfileId`, confirm the `accountId` belongs to an `Integration`
row with `provider="zernio"` in *this* workspace, then call through. The Zernio
API key is global, so this guard is the only thing keeping workspaces apart. A
missing guard lets any workspace create automations on another's accounts.

### Persistence

One table, one row per rule: workspace, platform, accountId, Zernio automation id,
keywords + match mode, `platformPostId` (nullable), DM body, public reply body,
the behaviour flags, enabled flag, `enabledAt` / `disabledAt`.

### Attribution

Handle `comment.received` in `handleEvent()` instead of dropping it. Persist the
post permalink and the `comment.ad` object (`id`, `title`, `originalMediaId` on
Instagram; `promotionStatus`, `isDarkPost` on Facebook). This is the piece that
justifies building it in the CRM instead of using Business Suite.

## Decisions made here (builder's calls, flag if wrong)

- The card goes on **Integrations**, under `ZernioCard` — not a new tab, not
  under Workspace. It is an integration behaviour, and the connect card is its
  prerequisite.
- The switch lives **beside the card title**, and switching on is **confirmed**,
  switching off is not. Starting outbound messaging to strangers deserves a
  confirm; stopping it should never have friction.
- Stats are **read live from Zernio on card open**, not mirrored into our DB on a
  schedule. Fewer moving parts, and it cannot drift.
- Our row is **not** authoritative for "running". Zernio is.

## Open questions (for the user)

1. **May the spike create one live automation to finish proving the switch?**
   It needs a real id. Scoped to a single test post with a nonsense keyword and
   `matchMode: 'exact'`, the realistic blast radius is zero — but it is outward
   facing on a real account, so it is the user's call, not mine.
   *(Largely downgraded by the probe: the routes exist. This confirms the body.)*
2. **One rule, or many?** One per workspace (simplest, matches the Kewy Pass
   campaign), one per connected account, or a list with add/edit/delete.
   *Assumption until answered: one rule per workspace.*
3. **If `PATCH` turns out to reject `isActive`** — disable by `DELETE` and
   re-create on re-enable (my pick; costs the counters), or hold for Zernio?

## What was actually built

| Piece | Where |
|---|---|
| `CommentAutoReply`, `CommentLead` models + migration | `backend/prisma/schema.prisma`, `migrations/20261125120000_comment_auto_reply` |
| Tenancy registration (both models are workspace-scoped) | `backend/src/common/prisma-tenancy.ts`, `backend/src/prisma/prisma.service.ts` |
| `createCommentAutomation`, `listCommentAutomations`, `updateCommentAutomation`, `deleteCommentAutomation` | `backend/src/integrations/zernio.client.ts` |
| `listCommentRules`, `saveCommentRule`, `enableCommentRule`, `disableCommentRule`, `deleteCommentRule` | `backend/src/integrations/zernio.service.ts` |
| `comment.received` handling, `linkCommentLead`, `armAgentForCommentLead` | `backend/src/integrations/zernio.service.ts` |
| Five routes under `integrations/zernio/comment-rules` | `backend/src/integrations/zernio.controller.ts` |
| The form, with the switch, the confirm dialog and the stats | `src/screens/channels/CommentAutoReplyForm.tsx` |
| 28 tests | `zernio.service.comment-rules.spec.ts`, `zernio.service.comment-leads.spec.ts` |

Two behaviours worth knowing when reading the code:

- **Saving never touches Zernio.** Only `enable` does. The operator can redraft
  the message as often as they like without a single DM going out.
- **Editing a live rule re-creates the automation**, because Zernio fixes the
  keywords and the message at creation time. An edit that only wrote our row
  would leave the old DM going out — the UI warns about the few-second gap.

## Risks

- **The rule outlives the CRM.** Deleting our row or suspending the workspace does
  not stop Zernio. The card must be the only way to create one.
- **A spent DM cannot be retried.** Argues for a test mode that fires against one
  of our own comments before a campaign goes live.
- **Comments before the rule never fire.** A reel armed too late loses every
  comment already under it. Surfaced in the state-3 dialog.
- **Legacy plan gate.** `GET /comment-automations` returned 200 on this account,
  so automations are not plan-gated here. The documented `403
  feature_not_available` applies to *inbox webhook events*, so `comment.received`
  (used only for attribution) still needs confirming separately.
- **We will depend on two undocumented endpoints** (`PATCH` and `DELETE` on
  `/comment-automations/{id}`). Undocumented means unversioned: they can change
  without notice. Worth asking Zernio to document them, and worth a clear failure
  path in the card if a disable call ever starts failing.
- **Business Suite is the fallback.** A keyword automation there needs no code and
  works this week; replies still reach the Aram inbox over the existing Zernio
  connection. What is lost is the rule living in the CRM, and attribution.
