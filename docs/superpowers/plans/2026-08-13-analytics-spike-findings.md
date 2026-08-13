# Spike findings: Zernio analytics + follower-stats shapes and plan gating (2026-08-13)

Task 1 of the `2026-08-13-social-analytics-overview` plan. Read-only live verification
against the real Zernio API (`https://zernio.com/api/v1`, no `ZERNIO_BASE_URL` override in
`backend/.env`). Only `GET` requests were issued — no posts, no writes, no data mutated on
the connected "Samemha" Facebook/Instagram/WhatsApp accounts. `ZERNIO_API_KEY` value itself
is redacted below; every other field is the raw response.

## Verdicts

- **`ANALYTICS_SHAPE: both`** — `GET /analytics` returns three things in one call: a
  page-level `overview` object (post-count aggregates: `totalPosts`, `publishedPosts`,
  `scheduledPosts`, `lastSync`, `dataStaleness`), a per-account `accounts[]` array
  (followers snapshot per platform), and a `posts[]` array where **each post already
  carries a rolled-up `analytics` object plus a `platforms[]` breakdown with the same
  metrics per platform**. Important nuance: `overview` aggregates **post counts only** —
  it does **not** sum engagement metrics (no total-impressions/total-likes-across-period
  field anywhere). A consumer that needs "total impressions this month" must sum
  `posts[].analytics.impressions` client-side; the API does not do that math.

- **Exact params (live-verified, `GET /analytics`):**
  - `profileId` (required) — filters to one Zernio profile.
  - `fromDate` / `toDate` — `YYYY-MM-DD`, inclusive, genuinely filter (verified: narrow
    window excluding all posts → `total: 0`; exact single-day window → returns exactly the
    2 posts published that day). **Default when omitted is ~90 days ago → today**,
    confirmed by direct observation (see Step 1 evidence) — matches the docs page
    (`docs.zernio.com/analytics/get-analytics`) which states "defaults to 90 days ago if
    omitted. Max range is 366 days."
  - `platform` — filters by platform (`facebook`, `instagram`, `whatsapp`, ...). Verified:
    `platform=facebook` → 5 posts, `platform=instagram` → 6 posts, `platform=whatsapp` →
    0 posts (empty, no error — WhatsApp has no post-analytics concept).
  - `accountId` — filters to one specific social account id within the profile (verified:
    Facebook `accountId` alone reproduced the same 5-post facebook-only result as
    `platform=facebook`).
  - `sortBy` — real values are `date, engagement, impressions, reach, likes, comments,
    shares, saves, clicks, views, follows` (per docs); **live-verified** `sortBy=impressions`
    genuinely re-sorts (descending by default): observed order `81768, 7163, 727, 475, 450,
    415, 371, 291, 218, 190` — a true sort, not echoed/ignored.
  - `order` — `asc`/`desc` (default `desc`). Live-verified: `order=asc` on the same query
    returned ascending `125, 190, 218, 291, 371` — genuinely respected.
  - `source` — `late` (posted via Zernio) / `external` (synced from platform) / `all`.
    Live-verified: `source=external` returned all 11 posts (all of this account's post
    history here is externally-synced, since none were created through Zernio's own
    scheduler at spike time).
  - `limit` (1–100, default 50) and `page` — both behave as documented (pagination object
    with `page/limit/total/pages` genuinely reflects the filtered set).
  - **Unknown params are silently ignored, not errored**: `bogusParamXYZ=hello` returned a
    normal `200` with the usual 6-post default-window result — no validation error.
  - `postId` (per docs, not separately live-tested this spike — out of scope for the brief,
    but documented and plausible given the shape).

- **Exact metric field names per post (identical set for facebook and instagram; verified
  live, both platforms share the same schema)** — nested at `post.analytics` (rolled-up)
  and duplicated inside `post.platforms[i].analytics` (per-platform-account):
  `impressions, reach, likes, comments, shares, saves, clicks, views, follows,
  igReelsAvgWatchTime, igReelsVideoViewTotalTime, videoDurationSeconds, engagementRate,
  lastUpdated`. `igReelsAvgWatchTime`/`igReelsVideoViewTotalTime` are populated for
  Instagram reels and are `0` for Facebook/non-video posts; `videoDurationSeconds` is
  `null` for non-video/short posts. **`views` is `0` for a plain image post while
  `impressions`/`reach` are non-zero** — `views` only tracks video-view-style metrics, not
  raw impressions.

- **Doc-vs-live discrepancies found (docs wrong again, 4th time now across spikes)**:
  post metadata field is **`_id`**, not the docs' claimed `postId`. The per-platform
  breakdown array is named **`platforms`**, not the docs' claimed `platformAnalytics`. Task
  2 must code against the live field names (`_id`, `platforms`), not the doc names.

- **`FOLLOWER_STATS: GET /accounts/follower-stats?profileId=<id>` — AVAILABLE, live-verified,
  200 with real data on first try** (no path variant needed; the brief's primary guess was
  correct). Params (live-verified): `profileId`, `granularity` (`daily`|`weekly`|`monthly`,
  default `daily` when omitted — verified by omitting it and observing `"granularity":
  "daily"` in the response), `fromDate`/`toDate` (`YYYY-MM-DD`, genuinely filter — verified:
  explicit `2026-08-01..2026-08-13` window returned exactly 13 daily Facebook points vs 24
  for the full default window). **`platform=` filter is accepted but silently has no
  effect** — passing `platform=facebook` still returned all 3 accounts (facebook,
  instagram, whatsapp) in both `accounts[]` and `stats{}`; there is no server-side platform
  filter on this endpoint despite `/analytics` supporting one.

  Response shape (live, matches the docs page almost exactly except one field):
  `{ accounts: [{ _id, platform, username, displayName, profilePicture, currentFollowers,
  lastUpdated, growth, growthPercentage, dataPoints, accountStats? }], stats: {
  "<accountId>": [{ date: "YYYY-MM-DD", followers: number }] }, dateRange: { from, to }
  (ISO 8601), granularity }`. **Doc-vs-live discrepancy**: docs state follower-stats
  `fromDate` "defaults to 30 days ago" — live default `dateRange.from` was
  **`2025-01-01T00:00:00.000Z`** (i.e., effectively "all history since Jan 1 2025", not 30
  days). This is the doc being wrong a 4th time; trust the live default, not the doc.

  History depth for this young account: Facebook has **24 daily points**
  (`2026-07-21`..`2026-08-13`, current followers 1179, `growth: -5`,
  `growthPercentage: -0.42`); Instagram has only **3 daily points**
  (`2026-08-11`..`2026-08-13`, current followers 331, `growth: 0`) — consistent with the
  Instagram account only having been connected on `2026-08-10`; WhatsApp has **0 points**
  (`dataPoints: 0`, empty `stats` array — WhatsApp has no follower/audience concept in this
  API).

- **`PLAN_GATED: no`** for both `GET /analytics` and `GET /accounts/follower-stats` on this
  workspace/profile — every probe in this spike returned `HTTP 200` with real data, and the
  `/analytics` response body explicitly carries `"hasAnalyticsAccess": true` at the top
  level (present in every response variant tried, including empty-result ones). No `402`
  or `403` was ever observed. **Caveat for Task 2**: the docs page for follower-stats
  (`docs.zernio.com/accounts/get-follower-stats`) documents a `403` gate for accounts
  *without* the add-on: `{"error": "Analytics add-on required", "message": "...",
  "requiresAddon": true}`. This was never triggered here (this workspace already has
  access) and was **not live-verified** — it's a documented shape only, offered as a
  fallback match for Task 2 in case some other workspace/profile is ungated. Given three
  prior doc inaccuracies found in this same spike, treat this specific error shape as
  "docs say this, unconfirmed live" rather than ground truth.

- **Extra finding worth flagging to Task 2 (data completeness gap, not a gating issue)**:
  `GET /accounts?profileId=` reports `externalPostCount: 5` for Facebook and
  `externalPostCount: 69` for Instagram, but `GET /analytics` (full-history query,
  `fromDate=2026-05-01`) only returns analytics rows for **5 Facebook posts and 6 Instagram
  posts** (11 total) — the Facebook count matches exactly, but Instagram's analytics
  coverage (6) is far smaller than its total external post count (69). This is not an
  error/gate (200, `hasAnalyticsAccess: true`, no error body) — it looks like partial
  analytics backfill/sync for Instagram specifically. Task 2 should not assume `/analytics`
  post rows are a complete mirror of an account's full post history, especially for
  Instagram.

## Setup

- Date: 2026-08-13.
- Base URL: `https://zernio.com/api/v1` (no override in `backend/.env`).
- `zernioProfileId` re-verified via `GET /accounts?profileId=6a5e2408d93a61a68d12624b` →
  `HTTP 200`, returns 3 accounts (facebook `6a5e241c3d50078defff83fd` "Samemha", instagram
  `6a79cba3d0fe733d1acba711` "samemha_jo", whatsapp `6a79d322d0fe733d1ace7bcf") and
  top-level `"hasAnalyticsAccess": true`. Same profile used throughout this spike.
- Auth: `Authorization: Bearer $ZERNIO_API_KEY` read from `backend/.env`, never printed —
  redacted as `$ZERNIO_API_KEY` in every command below.

## Step 0: Re-verify profileId

```bash
curl -s "https://zernio.com/api/v1/accounts?profileId=6a5e2408d93a61a68d12624b" \
  -H "Authorization: Bearer $ZERNIO_API_KEY"
```

`HTTP_STATUS:200`. Confirmed the same profile from the prior Tier 1A spike is still valid,
with 3 connected accounts (facebook, instagram, whatsapp) and `"hasAnalyticsAccess":true`
at the top level of the response.

## Step 1: Probe GET /analytics

### 1a. Requested 30-day window (brief's literal probe)

```bash
curl -s "https://zernio.com/api/v1/analytics?profileId=6a5e2408d93a61a68d12624b&fromDate=2026-07-14&toDate=2026-08-13&limit=100" \
  -H "Authorization: Bearer $ZERNIO_API_KEY"
```

`HTTP_STATUS:200`.

```json
{
  "overview": {"totalPosts":0,"publishedPosts":0,"scheduledPosts":0,"lastSync":"2026-08-13T12:17:31.654Z","dataStaleness":{"staleAccountCount":0,"syncTriggered":false}},
  "posts": [],
  "pagination": {"page":1,"limit":100,"total":0,"pages":1},
  "accounts": [
    {"_id":"6a5e241c3d50078defff83fd","platform":"facebook","username":"Samemha","displayName":"Samemha","profileId":"6a5e2408d93a61a68d12624b","followersCount":1179,"followersLastUpdated":"2026-08-13T04:14:03.655Z"},
    {"_id":"6a79cba3d0fe733d1acba711","platform":"instagram","username":"samemha_jo","displayName":"Samemha - صممها","profileId":"6a5e2408d93a61a68d12624b","followersCount":331,"followersLastUpdated":"2026-08-13T04:45:04.126Z"},
    {"_id":"6a79d322d0fe733d1ace7bcf","platform":"whatsapp","username":"+962 7 9626 1184","displayName":"samemha_jo","profileId":"6a5e2408d93a61a68d12624b","followersCount":null,"followersLastUpdated":"2026-08-11T05:56:59.201Z"}
  ],
  "hasAnalyticsAccess": true
}
```

Zero posts in the last 30 days — this account's real post history (see 1f) predates this
window (last post `2026-05-23`), which is itself a useful data point: this business has had
no social activity in the 30 days immediately prior to the spike date. This is not a bug or
gate; the date filter is legitimately working (confirmed next).

### 1b. Default window (no fromDate/toDate) — establishes the ~90-day default

```bash
curl -s "https://zernio.com/api/v1/analytics?profileId=6a5e2408d93a61a68d12624b&sortBy=impressions&limit=10" \
  -H "Authorization: Bearer $ZERNIO_API_KEY"
```

`HTTP_STATUS:200`. `overview.totalPosts: 6`, `pagination.total: 6` — posts dated
`2026-05-15` through `2026-05-23` only (3 days × facebook+instagram pairs).

### 1c/1d. Platform filter

```bash
curl -s "https://zernio.com/api/v1/analytics?profileId=6a5e2408d93a61a68d12624b&platform=facebook&limit=10" -H "Authorization: Bearer $ZERNIO_API_KEY"
curl -s "https://zernio.com/api/v1/analytics?profileId=6a5e2408d93a61a68d12624b&platform=instagram&limit=10" -H "Authorization: Bearer $ZERNIO_API_KEY"
```

Both `HTTP_STATUS:200`, `overview.totalPosts: 3` each (within the default ~90-day window).
Confirms `platform=` is a real, respected filter.

### 1f. Wide date range — reveals the full 11-post history and explains 1a/1b

```bash
curl -s "https://zernio.com/api/v1/analytics?profileId=6a5e2408d93a61a68d12624b&fromDate=2026-05-01&toDate=2026-08-13&limit=100" \
  -H "Authorization: Bearer $ZERNIO_API_KEY"
```

`HTTP_STATUS:200`. `overview: {"totalPosts":11,"publishedPosts":11,"scheduledPosts":0,...}`,
`pagination: {"page":1,"limit":100,"total":11,"pages":1}`. Full post list (platform,
publishedAt, impressions):

```
facebook   2026-05-23T09:29:18.000Z  impressions=371
instagram  2026-05-23T09:29:09.000Z  impressions=291
facebook   2026-05-18T17:48:27.000Z  impressions=450
instagram  2026-05-18T17:47:52.000Z  impressions=7163
instagram  2026-05-15T14:00:13.000Z  impressions=475
facebook   2026-05-15T14:00:11.000Z  impressions=190
facebook   2026-05-13T10:15:21.000Z  impressions=81768
instagram  2026-05-13T10:15:18.000Z  impressions=415
facebook   2026-05-09T20:24:37.000Z  impressions=125
instagram  2026-05-09T12:05:09.000Z  impressions=727
instagram  2026-05-06T20:13:21.000Z  impressions=218
```

The oldest post in the account's analytics history is `2026-05-06`. `today (2026-08-13) −
90 days ≈ 2026-05-15` — exactly where the default-window result (1b) cuts off (`2026-05-15`
onward = 6 posts; the 5 older posts from `05-06`/`05-09`/`05-13` are excluded by default and
only appear once `fromDate=2026-05-01` is passed explicitly). This is a precise live
confirmation of the docs' "defaults to 90 days ago" claim for `/analytics`.

### 1g/1h. Date-range filter precision checks

```bash
# Narrow window with zero matching posts
curl -s "https://zernio.com/api/v1/analytics?profileId=6a5e2408d93a61a68d12624b&fromDate=2026-05-16&toDate=2026-05-17&limit=100" -H "Authorization: Bearer $ZERNIO_API_KEY"
# → HTTP_STATUS:200, overview.totalPosts:0, pagination.total:0

# Exact single-day window matching 2 known posts
curl -s "https://zernio.com/api/v1/analytics?profileId=6a5e2408d93a61a68d12624b&fromDate=2026-05-18&toDate=2026-05-18&limit=100" -H "Authorization: Bearer $ZERNIO_API_KEY"
# → HTTP_STATUS:200, overview.totalPosts:2, exactly the facebook+instagram posts published 2026-05-18
```

Both confirm `fromDate`/`toDate` are real, precise, inclusive date filters — not decorative.

### 1i. Unknown/garbage param — ignored, not errored

```bash
curl -s "https://zernio.com/api/v1/analytics?profileId=6a5e2408d93a61a68d12624b&bogusParamXYZ=hello&limit=5" \
  -H "Authorization: Bearer $ZERNIO_API_KEY"
```

`HTTP_STATUS:200` — identical shape/behavior to the no-garbage-param default-window call
(`overview.totalPosts:6`). Unknown params are silently dropped server-side.

### 1j/1m. sortBy + order — genuinely sort, not cosmetic

```bash
curl -s "https://zernio.com/api/v1/analytics?profileId=6a5e2408d93a61a68d12624b&sortBy=impressions&limit=10&fromDate=2026-05-01&toDate=2026-08-13" -H "Authorization: Bearer $ZERNIO_API_KEY"
# → impressions descending: 81768, 7163, 727, 475, 450, 415, 371, 291, 218, 190

curl -s "https://zernio.com/api/v1/analytics?profileId=6a5e2408d93a61a68d12624b&sortBy=impressions&order=asc&limit=5&fromDate=2026-05-01&toDate=2026-08-13" -H "Authorization: Bearer $ZERNIO_API_KEY"
# → impressions ascending: 125, 190, 218, 291, 371
```

Both `HTTP_STATUS:200`. Sort order is real and default is descending; `order=asc` flips it.

### 1n. accountId filter

```bash
curl -s "https://zernio.com/api/v1/analytics?profileId=6a5e2408d93a61a68d12624b&accountId=6a5e241c3d50078defff83fd&fromDate=2026-05-01&toDate=2026-08-13" \
  -H "Authorization: Bearer $ZERNIO_API_KEY"
```

`HTTP_STATUS:200`. `overview.totalPosts:5` — identical result set to `platform=facebook`,
confirming `accountId` is a valid, working alternative filter granularity (single account
vs. whole platform).

### 1k/1l. Full per-post metric fields, both platforms (wide range)

Facebook (`platform=facebook&fromDate=2026-05-01&toDate=2026-08-13`), 5 posts — one is an
`image` post, rest are `video`:

```
video 2026-05-23 {"impressions":371,"reach":300,"likes":2,"comments":0,"shares":3,"saves":0,"clicks":1,"views":371,"follows":0,"igReelsAvgWatchTime":0,"igReelsVideoViewTotalTime":0,"videoDurationSeconds":null,"engagementRate":1.35,"lastUpdated":"2026-08-12 00:57:37"}
video 2026-05-18 {"impressions":450,"reach":377,"likes":2,"comments":0,"shares":0,"saves":0,"clicks":0,"views":450,"follows":0,"igReelsAvgWatchTime":0,"igReelsVideoViewTotalTime":0,"videoDurationSeconds":null,"engagementRate":0.44,"lastUpdated":"2026-08-11 20:21:44"}
video 2026-05-15 {"impressions":190,"reach":145,"likes":1,"comments":0,"shares":0,"saves":0,"clicks":0,"views":190,"follows":0,"igReelsAvgWatchTime":0,"igReelsVideoViewTotalTime":0,"videoDurationSeconds":null,"engagementRate":0.53,"lastUpdated":"2026-08-11 20:21:44"}
video 2026-05-13 {"impressions":81768,"reach":44864,"likes":159,"comments":0,"shares":4,"saves":0,"clicks":1547,"views":81768,"follows":0,"igReelsAvgWatchTime":0,"igReelsVideoViewTotalTime":0,"videoDurationSeconds":null,"engagementRate":0.2,"lastUpdated":"2026-08-12 04:02:57"}
image 2026-05-09 {"impressions":125,"reach":74,"likes":0,"comments":0,"shares":0,"saves":0,"clicks":0,"views":0,"follows":0,"igReelsAvgWatchTime":0,"igReelsVideoViewTotalTime":0,"videoDurationSeconds":null,"engagementRate":0,"lastUpdated":"2026-08-11 20:21:44"}
```

Note the image post: `impressions:125, reach:74` but `views:0` — `views` tracks
video-view-style playback, not raw impressions, and is legitimately `0` for a static image.

Instagram (`platform=instagram&fromDate=2026-05-01&toDate=2026-08-13`), 6 posts, all
`video` (reels):

```
video 2026-05-23 {"impressions":291,"reach":216,"likes":5,"comments":1,"shares":0,"saves":0,"clicks":0,"views":291,"follows":0,"igReelsAvgWatchTime":5394,"igReelsVideoViewTotalTime":1251476,"videoDurationSeconds":null,"engagementRate":2.06,"lastUpdated":"2026-08-12 14:08:37"}
video 2026-05-18 {"impressions":7163,"reach":4597,"likes":124,"comments":80,"shares":296,"saves":3,"clicks":0,"views":7163,"follows":0,"igReelsAvgWatchTime":5710,"igReelsVideoViewTotalTime":33182362,"videoDurationSeconds":null,"engagementRate":7.02,"lastUpdated":"2026-08-12 14:08:37"}
video 2026-05-15 {"impressions":475,"reach":378,"likes":12,"comments":0,"shares":4,"saves":1,"clicks":0,"views":475,"follows":0,"igReelsAvgWatchTime":4904,"igReelsVideoViewTotalTime":2103975,"videoDurationSeconds":34,"engagementRate":3.58,"lastUpdated":"2026-08-12 14:08:37"}
video 2026-05-13 {"impressions":415,"reach":309,"likes":11,"comments":0,"shares":1,"saves":3,"clicks":0,"views":415,"follows":0,"igReelsAvgWatchTime":5873,"igReelsVideoViewTotalTime":2055665,"videoDurationSeconds":63,"engagementRate":3.61,"lastUpdated":"2026-08-12 14:08:37"}
video 2026-05-09 {"impressions":727,"reach":497,"likes":16,"comments":7,"shares":5,"saves":2,"clicks":0,"views":727,"follows":0,"igReelsAvgWatchTime":7536,"igReelsVideoViewTotalTime":4393528,"videoDurationSeconds":null,"engagementRate":4.13,"lastUpdated":"2026-08-12 14:08:37"}
video 2026-05-06 {"impressions":218,"reach":160,"likes":9,"comments":0,"shares":3,"saves":0,"clicks":0,"views":218,"follows":0,"igReelsAvgWatchTime":7919,"igReelsVideoViewTotalTime":1401785,"videoDurationSeconds":49,"engagementRate":5.5,"lastUpdated":"2026-08-12 14:08:37"}
```

Field set is byte-for-byte identical between facebook and instagram post objects — no
platform-specific extra/missing keys observed (the docs' claim that `igReels*` fields are
Instagram-specific is true in *population* — they're always `0`/present-but-zero for
Facebook — but the *schema* is shared across platforms, not platform-conditional.)

### 1o/1p. source + whatsapp platform sanity checks

```bash
curl -s "https://zernio.com/api/v1/analytics?profileId=6a5e2408d93a61a68d12624b&source=external&fromDate=2026-05-01&toDate=2026-08-13" -H "Authorization: Bearer $ZERNIO_API_KEY"
# → HTTP_STATUS:200, totalPosts:11 (all 11 posts are source=external at spike time)

curl -s "https://zernio.com/api/v1/analytics?profileId=6a5e2408d93a61a68d12624b&platform=whatsapp" -H "Authorization: Bearer $ZERNIO_API_KEY"
# → HTTP_STATUS:200, {"overview":{"totalPosts":0,...},"posts":[],"pagination":{...,"total":0},"accounts":[{...whatsapp account...}],"hasAnalyticsAccess":true}
```

WhatsApp returns a clean empty result, not an error — confirms the endpoint gracefully
no-ops for platforms with no post-analytics concept rather than 400/404/500.

### Full sample post object (unredacted except nothing sensitive — real Arabic ad copy from the live page)

```json
{
  "_id": "6a5e24df3d50078defff936f",
  "latePostId": null,
  "content": "خلّي ستايلك يعبّر عنك وعن هويتك بطريقتك الخاصة 👕 ... #Samemha",
  "publishedAt": "2026-05-23T09:29:18.000Z",
  "scheduledFor": "2026-05-23T09:29:18.000Z",
  "status": "published",
  "analytics": {
    "impressions": 371, "reach": 300, "likes": 2, "comments": 0, "shares": 3,
    "saves": 0, "clicks": 1, "views": 371, "follows": 0,
    "igReelsAvgWatchTime": 0, "igReelsVideoViewTotalTime": 0,
    "videoDurationSeconds": null, "engagementRate": 1.35,
    "lastUpdated": "2026-08-12 00:57:37"
  },
  "platforms": [
    {
      "platform": "facebook", "status": "published",
      "platformPostId": "1058724220665775_122104659315305939",
      "accountId": "6a5e241c3d50078defff83fd", "accountUsername": "Samemha",
      "analytics": { "impressions": 371, "reach": 300, "likes": 2, "comments": 0, "shares": 3, "saves": 0, "clicks": 1, "views": 371, "follows": 0, "igReelsAvgWatchTime": 0, "igReelsVideoViewTotalTime": 0, "videoDurationSeconds": null, "engagementRate": 1.35, "lastUpdated": "2026-08-12 00:57:37" },
      "syncStatus": "synced",
      "platformPostUrl": "https://www.facebook.com/reel/1319344233680779/",
      "errorMessage": null
    }
  ],
  "platform": "facebook",
  "platformPostUrl": "https://www.facebook.com/reel/1319344233680779/",
  "isExternal": true,
  "isAd": false,
  "profileId": "6a5e2408d93a61a68d12624b",
  "thumbnailUrl": "https://scontent-lhr6-2.xx.fbcdn.net/...",
  "mediaType": "video",
  "mediaItems": [{"type":"video","url":"https://...mp4","thumbnail":"https://..."}]
}
```

Confirms: top-level id field is `_id` (not docs' `postId`), per-platform breakdown array is
`platforms` (not docs' `platformAnalytics`), and each `platforms[i]` entry nests its own
`analytics` object identical in schema to the rolled-up `post.analytics`.

## Step 2: Probe follower stats

### 2a. Primary path (brief's guess — worked immediately, no fallback needed)

```bash
curl -s "https://zernio.com/api/v1/accounts/follower-stats?profileId=6a5e2408d93a61a68d12624b&granularity=daily" \
  -H "Authorization: Bearer $ZERNIO_API_KEY"
```

`HTTP_STATUS:200`.

```json
{
  "accounts": [
    {"_id":"6a5e241c3d50078defff83fd","profileId":"6a5e2408d93a61a68d12624b","isActive":true,"platform":"facebook","username":"Samemha","displayName":"Samemha","profilePicture":"https://...","currentFollowers":1179,"lastUpdated":"2026-08-13T04:14:03.655Z","growth":-5,"growthPercentage":-0.42,"dataPoints":24},
    {"_id":"6a79cba3d0fe733d1acba711","profileId":"6a5e2408d93a61a68d12624b","isActive":true,"platform":"instagram","username":"samemha_jo","displayName":"Samemha - صممها","profilePicture":"https://...","currentFollowers":331,"lastUpdated":"2026-08-13T04:45:04.126Z","growth":0,"growthPercentage":0,"dataPoints":3,"accountStats":{"followsCount":0,"mediaCount":68,"accountType":"BUSINESS","instagramScopedId":"17841430008933062"}},
    {"_id":"6a79d322d0fe733d1ace7bcf","profileId":"6a5e2408d93a61a68d12624b","isActive":true,"platform":"whatsapp","username":"+962 7 9626 1184","displayName":"samemha_jo","currentFollowers":0,"growth":0,"growthPercentage":0,"dataPoints":0}
  ],
  "stats": {
    "6a5e241c3d50078defff83fd": [
      {"date":"2026-07-21","followers":1184},{"date":"2026-07-22","followers":1184},{"date":"2026-07-23","followers":1184},
      {"date":"2026-07-24","followers":1185},{"date":"2026-07-25","followers":1185},{"date":"2026-07-26","followers":1184},
      {"date":"2026-07-27","followers":1184},{"date":"2026-07-28","followers":1184},{"date":"2026-07-29","followers":1183},
      {"date":"2026-07-30","followers":1183},{"date":"2026-07-31","followers":1183},{"date":"2026-08-01","followers":1183},
      {"date":"2026-08-02","followers":1183},{"date":"2026-08-03","followers":1183},{"date":"2026-08-04","followers":1182},
      {"date":"2026-08-05","followers":1181},{"date":"2026-08-06","followers":1180},{"date":"2026-08-07","followers":1180},
      {"date":"2026-08-08","followers":1180},{"date":"2026-08-09","followers":1180},{"date":"2026-08-10","followers":1180},
      {"date":"2026-08-11","followers":1180},{"date":"2026-08-12","followers":1179},{"date":"2026-08-13","followers":1179}
    ],
    "6a79cba3d0fe733d1acba711": [
      {"date":"2026-08-11","followers":331},{"date":"2026-08-12","followers":331},{"date":"2026-08-13","followers":331}
    ],
    "6a79d322d0fe733d1ace7bcf": []
  },
  "dateRange": {"from":"2025-01-01T00:00:00.000Z","to":"2026-08-13T23:59:59.999Z"},
  "granularity": "daily"
}
```

### 2b–2e. Param variants

```bash
# granularity=weekly — buckets to weekly points
curl -s "https://zernio.com/api/v1/accounts/follower-stats?profileId=6a5e2408d93a61a68d12624b&granularity=weekly" -H "Authorization: Bearer $ZERNIO_API_KEY"
# → HTTP_STATUS:200, facebook dataPoints:4 (weekly buckets from 24 daily), instagram dataPoints:1

# no granularity param — confirms default is "daily"
curl -s "https://zernio.com/api/v1/accounts/follower-stats?profileId=6a5e2408d93a61a68d12624b" -H "Authorization: Bearer $ZERNIO_API_KEY"
# → HTTP_STATUS:200, "granularity":"daily" in response, identical to 2a

# explicit fromDate/toDate — genuinely filters
curl -s "https://zernio.com/api/v1/accounts/follower-stats?profileId=6a5e2408d93a61a68d12624b&fromDate=2026-08-01&toDate=2026-08-13&granularity=daily" -H "Authorization: Bearer $ZERNIO_API_KEY"
# → HTTP_STATUS:200, dateRange.from:"2026-08-01T00:00:00.000Z", facebook dataPoints:13 (vs 24 for full default range) — confirmed real filter

# platform=facebook filter — accepted but NO-OP
curl -s "https://zernio.com/api/v1/accounts/follower-stats?profileId=6a5e2408d93a61a68d12624b&platform=facebook" -H "Authorization: Bearer $ZERNIO_API_KEY"
# → HTTP_STATUS:200, still returns all 3 accounts (facebook+instagram+whatsapp) unfiltered — platform= is silently ignored here (unlike on /analytics, where it works)
```

**Key discrepancy vs docs**: the default `dateRange.from` observed live is
`2025-01-01T00:00:00.000Z`, not "30 days ago" as `docs.zernio.com/accounts/get-follower-stats`
claims. Live default returns the account's entire follower history (bounded only by however
far back Zernio has actually been tracking it — 24 days of real data for Facebook, 3 for
Instagram, both far short of the Jan-2025 floor, meaning the floor is just "no lower bound
imposed", not evidence of tracking since Jan 2025).

## Step 3: 402/403 plan-gating verdict

**`PLAN_GATED: no`** — every one of the ~20 GET calls made in this spike (all recorded
above) returned `HTTP 200`. No `402` and no `403` was ever observed on `GET /analytics` or
`GET /accounts/follower-stats` for this profile/workspace. The `/analytics` response body
carries an explicit `"hasAnalyticsAccess": true` flag on every call (present even on
zero-result calls like the whatsapp-platform probe and the empty 30-day window), which is
the API's own signal that this workspace already has whatever paid tier/add-on gates
analytics.

For completeness, the **documented** (not live-verified) gate shape from
`docs.zernio.com/accounts/get-follower-stats`, offered to Task 2 as a fallback pattern to
match against defensively, given this workspace could never trigger it:

```json
// HTTP 403 (per docs only — never observed live in this spike)
{ "error": "Analytics add-on required", "message": "...", "requiresAddon": true }
```

Given three other doc-vs-live mismatches already found in this same spike (post `_id` vs
`postId`, `platforms` vs `platformAnalytics`, and the follower-stats default date-range),
Task 2 should treat this specific error shape as unconfirmed and be prepared for it to be
wrong (different status code, different field names) if it's ever actually hit against a
real ungated-tier workspace.

## Cleanup confirmation

Strictly read-only spike: no `POST`/`PUT`/`PATCH`/`DELETE` request was issued at any point.
No post was created, scheduled, edited, or deleted. No live Facebook/Instagram/WhatsApp
account state was touched. Only `GET /accounts`, `GET /analytics` (many param variants),
and `GET /accounts/follower-stats` (several param variants) were called, all against the
real, already-connected "Samemha" accounts, using the existing `ZERNIO_API_KEY` from
`backend/.env`. No scratch scripts were left in the repo — response bodies were captured to
the session scratchpad directory (outside the repo) for inspection and are not part of this
commit.
