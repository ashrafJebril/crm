# Tier 1A: Content Calendar + Video Publishing — Design

**Date:** 2026-08-13
**Status:** Approved (Approach 1: calendar as a view toggle inside Social; lean scope)
**Context:** First sub-project of Tier 1 ("harvest the Zernio surface") from the Aug 2026 marketing gap analysis. Tier 0 (commits 9fca845..249c930) delivered scheduling via Zernio with a visible/cancellable queue; this adds the calendar view every competitor treats as table stakes, plus video — the dominant content format for MENA SMBs. Zernio endpoint facts learned in Tier 0 apply: docs are unreliable; `POST /posts`, `GET /posts?profileId=` (profile-scoped, live-verified), and `DELETE /posts/{id}` are proven; `PUT /posts/{id}` is documented but unverified.

## Goals

1. A month-view content calendar showing scheduled and published posts per workspace, with reschedule and cancel.
2. Video publishing end-to-end: upload (mp4/mov, ≤300MB) → media library → compose preview → schedule or publish to FB/IG/TikTok.

## Non-goals (deferred to later Tier 1A slices or sub-projects)

- Carousels (multi-image), first comment, queues/recurring slots, explicit story/reel type selection.
- Drag-to-reschedule (reschedule is popover + datetime picker).
- Approval workflows; per-network content variants.
- Comments/reviews/automations (sub-projects C/D/E).

## 1. Calendar view (frontend)

- Social screen gains a **Feed | Calendar** view toggle near the platform tabs. State local to Social.
- New component file `src/screens/social/ContentCalendar.tsx` (keep Social.tsx from growing; follow the `src/screens/pipeline/` subfolder pattern).
- Month grid (7 columns, weeks as rows), prev/next month navigation, today highlighted, RTL-aware (use logical properties/`marginInlineStart` like the rest of the app). Bilingual via `tx()`.
- **Data:**
  - Scheduled: `GET /social/scheduled` (existing; rows carry `id, content, platforms, mediaUrl, scheduledFor`).
  - Published: existing feed endpoints (`GET /integrations/zernio/posts?platform=`) for the connected platforms; rows carry `createdAt` and `permalink`.
- **Chips:** scheduled = accent-colored, actionable; published = muted. Day cells show at most 3 chips plus a "+N more" control that expands the cell's full list.
- **Popover on chip click:** media thumbnail, content preview, platform chips, time.
  - Scheduled: **Reschedule** (datetime picker → `PATCH /social/scheduled/:id`) and **Cancel** (existing `DELETE /social/scheduled/:id`, reusing the arm/confirm pattern from ScheduledPanel).
  - Published: link out to the platform permalink.
- The ScheduledPanel strip in feed view stays unchanged.

## 2. Reschedule (backend)

- New route `PATCH /social/scheduled/:id` body `{ scheduledFor: ISO8601, timezone: IANA }`, workspace-scoped via the same ownership pattern as cancel (membership in the workspace's own scheduled list).
- **Implementation strategy decided by a mandatory live verification step** (Tier 0's comments lesson): probe Zernio's `PUT /posts/{id}` against a temp scheduled post on the real profile.
  - If PUT updates `scheduledFor`: use it (single call, no media re-handoff).
  - If not: cancel + re-create, sourcing media from the **Zernio-hosted URLs on the post's own row** (`mediaItems`/`mediaUrls`) — never our original signed URLs, which expire.
- Either way, `ZernioService.reschedulePost(workspaceId, postId, scheduledFor, timezone)` hides the strategy; the controller/frontend contract is fixed.

## 3. Video publishing

**Backend (`media` module):**
- Accept `video/mp4` and `video/quicktime` in addition to current image types; per-file size cap 300MB (satisfies IG; FB/TikTok allow more). Enforce via multer limits + mime allowlist; oversized/wrong-type rejections return a specific message the frontend can show.
- Storage via the existing local/DO-Spaces paths and the existing short-lived signed public-URL handoff to Zernio. No schema change expected (`Media.mimeType` already stored); verify streaming/temp-file handling for large uploads rather than buffering wholesale in memory — if the current implementation buffers, switch multer to disk storage for videos.

**Frontend:**
- ComposeModal media picker: videos listed with a play-icon overlay; selected video renders as `<video controls>` in the composer and in the FB/IG preview cards; file input accept list gains the two video mimes; upload error messages surfaced bilingually.
- Media screen: videos render playable (same `<video>` treatment) alongside images.
- Platform guards unchanged: IG/TikTok require media — a video satisfies them. No new per-platform blocking in this slice.
- Post type: standard video post (Zernio's per-platform default — typically a reel on IG). No explicit type selector yet.

## 4. Error handling

- Upload rejects (size/type) show the server's specific message in the existing upload-error slot of the media picker.
- Reschedule failure: inline error in the popover; the chip stays at its original time; calendar refetches on success.
- Calendar data-fetch errors: quiet inline message inside the calendar body; the Feed|Calendar toggle and feed remain functional.

## 5. Testing

- **Backend units:** reschedule service (ownership 404, happy path per chosen strategy, timezone pass-through); media validation (mime allowlist accepts mp4/mov and rejects others, size cap enforced). Mock the Zernio client/prisma per existing spec conventions.
- **Frontend:** `npm run typecheck`; verify-skill E2E: upload a video → appears in library and picker → schedule it ≥10 min out → appears on the calendar on the right day → reschedule to another day (chip moves) → cancel (chip gone). All safe live (nothing publishes). Immediate video publish verified via the fetch-intercept technique (no real post to the client's page).
- Full suites green before completion (backend `npm test`, root typecheck/build).

## Open verification items (resolve during implementation, before dependent code)

1. Does `PUT /posts/{id}` exist and update `scheduledFor`? (Decides §2 strategy.)
2. Are the media URLs on a Zernio post row (`mediaItems[].url`/`mediaUrls`) durable enough to re-use in a re-created post? (Only matters on the fallback path.)
3. Current multer config: memory vs disk storage, existing size limit — determines the §3 large-upload adjustment.
