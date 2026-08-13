# Tier 1B: Social Analytics Overview — Design

**Date:** 2026-08-13
**Status:** Approved (lean slice: spike + account overview only)
**Context:** Second Tier 1 sub-project from the Aug 2026 marketing gap analysis. The Analytics screen (rebuilt in Tier 0) shows only internal metrics; this adds the first Zernio-backed social metrics. Deliberately cut to the account overview — top-posts table, best-time-to-post, and demographics are later slices. Zernio lesson standing: docs are unreliable (three live-verified discrepancies so far), and their docs mention an "Analytics add-on" (402 error code exists) while the pricing page says analytics is included — a mandatory live spike resolves this before any dependent code.

## Goals

1. A "Social performance" section on the Analytics screen: per connected platform, current followers + growth, and the window's impressions/reach/engagement totals — real numbers from Zernio.
2. Graceful degradation when Zernio can't serve analytics (plan-gating or upstream failure) — a quiet card, never a broken screen.

## Non-goals (later slices)

- Top-posts table, external-post sync surfacing, best-time-to-post, content decay, audience demographics.
- Upgrading the Social screen's insights column (still client-side sums — untouched).
- DB caching/snapshotting of metrics (Zernio holds ~12 months; add caching when there's a reason).
- A 90-day window (the page's existing 7/30 toggle rules).

## 1. Spike (first task, no production code)

Live-verify against the real connected account, recording raw evidence in a committed findings doc:
- `GET /analytics` — exact params for a date-ranged aggregate (fromDate/toDate per research), response shape: does it return aggregate totals, or only per-post rows that we must sum server-side? Which metric fields exist (impressions, reach, likes, comments, shares, engagement)?
- `GET /accounts/follower-stats` — shape, granularity options, whether history covers 30 days for this young account.
- **The 402 question:** does either endpoint reject with a plan/add-on error on our current Zernio plan? If yes, the degradation path ships as the primary state and the UI copy reflects it.

## 2. Backend

- `ZernioClient` gains `getAnalytics(profileId, opts)` and `getFollowerStats(profileId, opts)` — exact paths/params per spike findings; thin wrappers over the existing `request<T>()` helper.
- `ZernioService.analyticsOverview(workspaceId, days: 7 | 30)`:
  - Resolves `zernioProfileId` (existing pattern); returns `{ available: false, reason: "not_connected" }` when absent.
  - Fetches analytics + follower stats, maps to:
    ```
    {
      available: true,
      windowDays: 7 | 30,
      platforms: [{
        platform: string,
        followers: { current: number, delta: number, series: { date: string, count: number }[] },
        impressions: number, reach: number, engagement: number,
        likes: number, comments: number, shares: number,
      }]
    }
    ```
  - Sums per-post rows server-side if Zernio has no aggregate mode (spike decides).
  - `followers.delta` = change across the selected window (`series[last].count - series[first].count`); `series` covers the window at daily granularity, oldest first.
  - **Degradation:** Zernio 402 → `{ available: false, reason: "plan" }`; any other upstream error → `{ available: false, reason: "upstream" }`. Both HTTP 200 — the screen never errors because an external vendor did.
- Route: `GET /social/analytics/overview?days=7|30` on the existing social controller (`resolveDays`-style param handling: only "30" yields 30).

## 3. Frontend

- Analytics screen (`src/screens/Analytics.tsx`) gains a **"Social performance"** section below the message-volume chart, driven by the page's existing `days` state:
  - One card per platform in the payload: platform name, current followers with a signed delta badge, a `Spark` of the follower series, and the window's impressions / reach / engagement totals (existing `Stat` styling).
  - `available: false, reason: "not_connected"` or an empty `platforms` array → section renders nothing.
  - `reason: "plan"` → quiet card: tx("Social analytics isn't included in the current Zernio plan.", …); `reason: "upstream"` → tx("Social analytics is temporarily unavailable.", …).
- Bilingual via `tx()`; loading state matches the page's "…" convention.

## 4. Error handling

All Zernio failure modes are absorbed into `available: false` server-side (with a warn log). The frontend treats only transport failure to OUR backend as an error (existing `useFetch` error slot). Internal metrics above the section are never blocked.

## 5. Testing

- Unit tests: mapping (incl. per-post summing if that's the shape), 402 → `reason:"plan"`, other upstream error → `reason:"upstream"`, no profile → `reason:"not_connected"`, days param handling.
- E2E (verify skill): live numbers for the real account on both windows; section absent on a workspace without Zernio; degradation card verified by mocking a 402 (client-side fetch intercept or temporary env), not by breaking the real account.

## Open verification items (spike resolves before dependent code)

1. `GET /analytics` aggregate vs per-post shape, param names, metric field names.
2. `GET /accounts/follower-stats` path/params/shape.
3. Whether our plan 402-gates these endpoints.
