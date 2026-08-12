# Tier 0: Credibility Fixes — Design

**Date:** 2026-08-12
**Status:** Approved (approach B: lean fixes + honest campaign drafts)
**Context:** First round of the Aug 2026 marketing gap-analysis roadmap. tkana currently ships several surfaces that are broken or show fabricated data: post scheduling POSTs to a deleted endpoint, social comment writes call legacy Meta routes that fail for Zernio-connected workspaces, the Analytics screen is 100% mock data (including metrics for the removed AI feature), and the campaign builder is a hardcoded mockup. This round makes every visible number true and every visible control functional — it does not add the campaign send engine (Tier 2) or Zernio analytics metrics (Tier 1).

## Goals

1. Scheduling a social post works, and scheduled posts are visible and cancellable.
2. Comment reply/delete work for Zernio-connected workspaces.
3. Every number rendered in Analytics and Campaigns comes from real data.
4. No UI copy references the removed AI feature; no dead buttons remain.

## Non-goals (explicitly out of scope)

- Campaign send engine, drips, retargeting (Tier 2).
- Zernio analytics metrics — reach, impressions, follower growth, best-time (Tier 1).
- Comments unified into the Inbox (Tier 1).
- Email, SMS, report export.
- Webhook-driven scheduled-post status updates (list is fetched live; Tier 1).

## 1. Post scheduling via Zernio

**Backend** (`backend/src/social/`, `backend/src/integrations/zernio.*`):

- `POST /social/publish` accepts optional `scheduledFor` (ISO 8601) and `timezone` (IANA name). When present, `ZernioService.publish` passes `scheduledFor` + `timezone` to `ZernioClient.createPost` instead of `publishNow: true`. The client's `{ publishNow: true, ...body }` spread already permits the override; make the intent explicit in the client signature.
- `GET /social/scheduled` — lists posts with status `scheduled` for the workspace's Zernio profile. Uses Zernio `GET /posts` (returns only Zernio-created posts, which is exactly the scheduled set; the `/analytics` feed endpoint stays as-is for published posts).
- `DELETE /social/scheduled/:id` — cancels via Zernio `DELETE /posts/{postId}`. Workspace ownership is enforced by resolving the post through the workspace's `zernioProfileId`.

**Frontend:**

- `ComposeModal.tsx`: delete the dead `scheduleMut` (`POST /scheduled-posts`); the single publish mutation carries optional `scheduledFor` + `timezone`. Timezone from `Intl.DateTimeFormat().resolvedOptions().timeZone`. Existing SchedulePicker UI and button labels are unchanged.
- `Social.tsx`: new compact **Scheduled** panel at the top of the feed column, rendered only when the list is non-empty: content preview, target channel chips, scheduled time, cancel button with confirm. Refetches after cancel and after a new scheduled post is created.

## 2. Social engagement writes via Zernio

**Backend:**

- `ZernioClient` gains `replyToComment(commentId, message, accountId)` and `deleteComment(commentId)` mapped to Zernio's comment endpoints. **Implementation must start by verifying the exact endpoint paths/params in docs.zernio.com** (existence is confirmed; shapes are not).
- New routes: `POST /integrations/zernio/comments/:id/reply`, `DELETE /integrations/zernio/comments/:id`.

**Frontend (`Social.tsx`):**

- Comment reply and delete mutations point at the Zernio routes for all workspaces.
- **Legacy gating rule:** FB post edit/delete and the IG top-level comment composer render only when a legacy direct-Meta `Integration` row exists for the workspace (Zernio cannot edit externally-published posts; IG top-level comments are reply-only through Zernio). Otherwise these controls hide. Gate on data already available to the screen (integration status), not on a new endpoint.

## 3. Analytics rebuilt on real data

**Backend (`backend/src/dashboard/`):**

- `GET /dashboard/summary` accepts `?days=7|30` for the message timeseries (default 7).
- Summary adds a per-channel conversation breakdown (single groupBy on `Conversation.channel`).

**Frontend (`src/screens/Analytics.tsx` rebuilt):**

- Sections: KPI tiles (contacts, conversations, messages in range, WoW delta) · message-volume chart with a functional 7/30-day range control · per-channel conversation mix · pipeline value by stage (`/tickets/dashboard/summary`) · campaign table aggregates (real sums — honest zeros until Tier 2).
- **Deleted:** AI-handled %, CSAT, funnel, heatmap, agent leaderboard, resolution mix, top intents (nothing populates `intent`), Export / New report buttons, and the mock data files `src/data/analytics.ts` + `analytics-extras.ts` (drop remaining imports).

## 4. Campaigns honesty pass

**Schema:** `Campaign` gains nullable `segmentId` and `templateId` (one migration). Existing free-text `audience` and `schedule` columns stay for display.

**Builder (`src/screens/Campaigns.tsx`):**

- AudienceStep: real segment picker from `/segments` plus an "All contacts" option; live match count via `POST /segments/preview` (all-contacts count from `/contacts`). Hardcoded filter rows and "624 contacts match" removed.
- MessageStep: real WhatsApp template picker (templates API); PhonePreview renders the selected template body. Fake variable chips become real chips only if the template has variables; fake cost estimate deleted.
- ScheduleStep: radio choice stored in `schedule`; static "quiet hours / rate limit" text removed.
- ReviewStep: renders actual selections (segment name + count, template name, schedule); fabricated pre-flight checks removed.
- **CTA is "Save draft" only** — creates a campaign with `status: "draft"`, real `segmentId`/`templateId`/`audience`/`schedule`, and no `agent` field. "Schedule send" does not exist until the Tier 2 engine.

**List view:** the KPI tiles become four real aggregates computed from campaign rows — total sent, delivered rate, read rate, reply rate; the fabricated "SAR attributed" tile is removed until attribution exists (Tier 3). The search box filters the list client-side. The dead "Templates" header button is removed.

## 5. Cleanup

- Strip AI copy: Calendar subtitle, Analytics subtitle + tiles (screen rebuilt anyway), README first line.
- Delete `backend/scripts/smoke-enrichment.ts` (imports a module removed in June).
- Remove the unused `API_KEYS` mock from `src/data/settings-extras.ts`.
- Remove `ANTHROPIC_API_KEY`, `OPENAI_*`, `GOOGLE_CSE_*` from `backend/.env.example`.
- Hide dead buttons: Contacts "Import", Social "Saved".
- No data-model changes beyond the two nullable campaign columns (leave `Message.from = "ai"`, `Conversation.intent/escalated` in place).

## Error handling

- Schedule/cancel failures render inline (ComposeModal already displays mutation errors; the Scheduled panel shows per-row errors and restores rows on failed cancel).
- Zernio comment writes surface the API error message in the existing comment UI failure paths (Social.tsx already restores optimistic state on failure).
- `GET /social/scheduled` failure shows a quiet inline error in the panel, never blocks the feed.

## Testing

- Unit tests for new/changed backend logic (Zernio client methods and social service scheduling paths, with the Zernio HTTP client mocked; dashboard summary `days` param and channel breakdown).
- Each workstream verified end-to-end in the running app (verify skill) before being called done: schedule → appears in Scheduled panel → cancel; comment reply/delete on a Zernio workspace; Analytics shows real counts matching the database; campaign draft created with real segment/template bindings.

## Open verification items (resolve during implementation, before dependent code)

1. Exact Zernio comment endpoint shapes (reply/delete params, whether `accountId` is required).
2. Whether Zernio `GET /posts` supports a status filter or requires client-side filtering.
3. Whether the campaigns backend DTO currently rejects or silently drops the removed `agent` field (frontend stops sending it either way).
