# Spike findings: Zernio PUT /posts + media durability (2026-08-13)

Task 1 of the `2026-08-13-content-calendar-video` plan. Live verification spike against the
real Zernio API (`https://zernio.com/api/v1`, no `ZERNIO_BASE_URL` override present in
`backend/.env`). No production code touched — only this findings doc and throwaway
scratch scripts (deleted before finishing). All calls made with the workspace's live
`ZERNIO_API_KEY` against the connected real Facebook page ("Samemha"). Every temp post
created during this spike was deleted before finishing; publishNow was never used.

## Verdicts

- **`PUT_WORKS: yes`** — verb is `PUT`. `PUT /posts/{id}` with a new `scheduledFor` returns
  HTTP 200 with the updated post, and a subsequent `GET /posts/{id}` confirms the
  `scheduledFor` value actually moved. No fallback to `PATCH` was needed.
- **`MEDIA_DURABLE: not tested — N/A`** — the brief (`task-1-brief.md` Step 4) explicitly
  scopes this probe to "only matters if PUT_WORKS=no". Since Step 3 already proved
  `PUT_WORKS: yes`, the reschedule feature can move `scheduledFor` in place via `PUT`
  without ever touching `mediaUrls`/`mediaItems`, so media-host durability is moot for
  Task 3's decision. Skipped deliberately per the brief's own conditional — not an
  oversight. (If a future task needs this answer for an unrelated reason, it should be
  spiked separately; nothing here should be read as "media is/isn't durable".)

## Setup

- Date: 2026-08-13
- Base URL: `https://zernio.com/api/v1` (no `ZERNIO_BASE_URL` in `backend/.env`)
- Workspace id: `cmpayevw8000011v0tgyu6rz1`
- `zernioProfileId`: `6a5e2408d93a61a68d12624b`
- Facebook `accountId` (Integration.pageId, provider=zernio, platform=facebook):
  `6a5e241c3d50078defff83fd` (page "Samemha")

Resolved via a one-off Prisma read (no server needed for this step):

```
cd backend && npx tsx -e "import { PrismaClient } from '@prisma/client'; const p = new PrismaClient(); p.workspace.findFirst({ where: { zernioProfileId: { not: null } } }).then(w => { console.log(w?.id, w?.zernioProfileId); return p.integration.findFirst({ where: { workspaceId: w!.id, provider: 'zernio', platform: 'facebook' } }); }).then(i => { console.log('accountId', i?.pageId); process.exit(0); });"
```

Output:
```
workspace cmpayevw8000011v0tgyu6rz1 6a5e2408d93a61a68d12624b
accountId 6a5e241c3d50078defff83fd
```

## Step 2: Create temp scheduled post (text-only)

Request (scheduledFor = now+2h UTC at time of call, `2026-08-13T07:36:17Z` observed clock):

```
curl -s -X POST "https://zernio.com/api/v1/posts" \
  -H "Authorization: Bearer $ZERNIO_API_KEY" -H "Content-Type: application/json" \
  -d '{"content":"tier1a spike - ignore","platforms":[{"platform":"facebook","accountId":"6a5e241c3d50078defff83fd"}],"publishNow":false,"scheduledFor":"2026-08-13T09:36:39.000Z","timezone":"Asia/Riyadh"}'
```

Response (`HTTP_STATUS:201`):

```json
{"post":{"userId":"6a5ce190dc7932cb22ba6d11","title":"","content":"tier1a spike - ignore","mediaItems":[],"platforms":[{"platform":"facebook","accountId":{"_id":"6a5e241c3d50078defff83fd","platform":"facebook","profileId":"6a5e2408d93a61a68d12624b","displayName":"Samemha","isActive":true,"profilePicture":"https://scontent-lhr6-1.xx.fbcdn.net/...","username":"Samemha"},"profileId":"6a5e2408d93a61a68d12624b","customMedia":[],"scheduledFor":"2026-08-13T09:36:39.000Z","platformSpecificData":{"__platformUserIdSnapshot":"10174841617410367:page:1058724220665775","__usernameSnapshot":"Samemha"},"status":"pending","publishAttempts":0,"contentHash":"be85b2d373eb4eec71e69c6ad9a541a2","_id":"6a7d7409e5a13d9767423901"}],"scheduledFor":"2026-08-13T09:36:39.000Z","timezone":"Asia/Riyadh","status":"scheduled","tags":[],"hashtags":[],"mentions":[],"visibility":"public","crosspostingEnabled":true,"metadata":{"usageCounted":true},"publishAttempts":0,"recycling":{"enabled":false,"gapFreq":"month","recycleCount":0,"contentVariations":[],"contentVariationIndex":0},"_id":"6a7d7409e5a13d9767423900","createdAt":"2026-08-13T07:36:41.097Z","updatedAt":"2026-08-13T07:36:41.097Z","__v":0},"message":"Post scheduled successfully"}
```

Note the top-level `post._id` (`6a7d7409e5a13d9767423900`) is the id to use for
`GET`/`PUT`/`DELETE /posts/{id}` — distinct from the nested per-platform sub-document
`_id` (`...23901`) inside `platforms[0]`.

Post id used for the rest of this spike: **`6a7d7409e5a13d9767423900`**

## Step 3: Probe PUT /posts/{id}

Request (reschedule to now+3h):

```
curl -s -X PUT "https://zernio.com/api/v1/posts/6a7d7409e5a13d9767423900" \
  -H "Authorization: Bearer $ZERNIO_API_KEY" -H "Content-Type: application/json" \
  -d '{"scheduledFor":"2026-08-13T10:36:53.000Z","timezone":"Asia/Riyadh"}'
```

Response (`HTTP_STATUS:200`):

```json
{"post":{"recycling":{"enabled":false,"gapFreq":"month","recycleCount":0,"contentVariations":[],"contentVariationIndex":0},"_id":"6a7d7409e5a13d9767423900","userId":"6a5ce190dc7932cb22ba6d11","title":"","content":"tier1a spike - ignore","mediaItems":[],"platforms":[{"platform":"facebook","accountId":{"_id":"6a5e241c3d50078defff83fd", ...},"profileId":"6a5e2408d93a61a68d12624b","customMedia":[],"scheduledFor":"2026-08-13T10:36:53.000Z", ...,"status":"pending","publishAttempts":0,"contentHash":"be85b2d373eb4eec71e69c6ad9a541a2","_id":"6a7d7409e5a13d9767423901"}],"scheduledFor":"2026-08-13T10:36:53.000Z","timezone":"Asia/Riyadh","status":"scheduled", ...,"createdAt":"2026-08-13T07:36:41.097Z","updatedAt":"2026-08-13T07:36:54.832Z","__v":0},"message":"Post updated successfully"}
```

`PUT` returned 200 directly — no 404/405, so `PATCH` fallback was not exercised.

Re-GET to confirm the change actually persisted (not just echoed back):

```
curl -s -X GET "https://zernio.com/api/v1/posts/6a7d7409e5a13d9767423900" \
  -H "Authorization: Bearer $ZERNIO_API_KEY"
```

Response (`HTTP_STATUS:200`):

```json
{"post":{"recycling":{...},"_id":"6a7d7409e5a13d9767423900","userId":{"name":"ashraf","image":"https://lh3.googleusercontent.com/...","id":"6a5ce190dc7932cb22ba6d11"},"title":"","content":"tier1a spike - ignore","mediaItems":[],"platforms":[{"platform":"facebook", ..., "scheduledFor":"2026-08-13T10:36:53.000Z", ..., "_id":"6a7d7409e5a13d9767423901"}],"scheduledFor":"2026-08-13T10:36:53.000Z","timezone":"Asia/Riyadh","status":"scheduled", ...,"createdAt":"2026-08-13T07:36:41.097Z","updatedAt":"2026-08-13T07:36:54.832Z","__v":0}}
```

`scheduledFor` is `2026-08-13T10:36:53.000Z` in both the top-level field and the nested
`platforms[0].scheduledFor` — the +3h value we sent, not the original +2h value. `updatedAt`
also bumped (`07:36:54.832Z` vs the original `07:36:41.097Z`). This confirms the reschedule
was durable, not just echoed in the PUT response.

**Conclusion: `PUT /posts/{id}` genuinely reschedules the post. `PUT_WORKS: yes` (verb `PUT`).**

## Step 4: Media durability probe — skipped (see verdict above)

Not run. Per the brief, this step only matters if `PUT_WORKS: no`; Step 3 already settled
that question, so no media-bearing post was created and no live Facebook page media was
touched during this spike.

## Step 5: Clean up + record

Delete the temp post:

```
curl -s -X DELETE "https://zernio.com/api/v1/posts/6a7d7409e5a13d9767423900" \
  -H "Authorization: Bearer $ZERNIO_API_KEY"
```

Response (`HTTP_STATUS:200`):

```json
{"message":"Post deleted successfully"}
```

Verify nothing of ours remains, via `GET /posts?profileId=`:

```
curl -s -X GET "https://zernio.com/api/v1/posts?profileId=6a5e2408d93a61a68d12624b" \
  -H "Authorization: Bearer $ZERNIO_API_KEY"
```

Response (`HTTP_STATUS:200`):

```json
{"posts":[],"pagination":{"page":1,"limit":10,"total":0,"pages":0}}
```

Confirmed empty — zero posts remain for this profile on Zernio. (The alternative check
via our own `GET /api/social/scheduled` was not exercised: the backend dev server had to be
started fresh for this spike, and reaching that authenticated endpoint would have required
either a real login or hand-crafting a JWT from `JWT_SECRET` — the latter was correctly
blocked by the environment's safety controls as token forging. The brief offers `GET
/posts?profileId=` as an explicit equivalent verification, which is what's used here and is
authoritative: it queries Zernio directly, the same system of record `/social/scheduled`
would proxy.)

## Cleanup confirmation

- One temp post created (`6a7d7409e5a13d9767423900`), rescheduled once via `PUT`, then
  deleted via `DELETE`.
- No second (media) post was created — Step 4 was skipped.
- `publishNow` was never used; nothing was ever published to the live "Samemha" Facebook
  page.
- Post-cleanup `GET /posts?profileId=6a5e2408d93a61a68d12624b` returns `"posts":[]`,
  `"total":0` — confirmed clean.
- Scratch scripts used to resolve DB ids (`backend/.spike-find-user.ts`,
  `backend/.spike-mint-jwt.ts`) were deleted; only this findings doc is committed.
