# Tier 1A: Content Calendar + Video Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A month-view content calendar inside the Social screen (scheduled + published posts, reschedule/cancel) and video publishing end-to-end (upload mp4/mov ≤300MB → library → compose → schedule/publish).

**Architecture:** Backend NestJS + Prisma in `backend/`; frontend Vite + React in `src/`. Video rides the existing media pipeline (multer → MediaStorage local/Spaces → signed-URL handoff to Zernio) but switches multer from memory to disk staging and teaches the storage layer to ingest from a temp-file path, so 300MB uploads never sit on the heap. Reschedule extends the Tier 0 scheduling surface (`/social/scheduled`) with a PATCH whose Zernio strategy — `PUT /posts/{id}` vs cancel+recreate — is decided by a mandatory live spike (Task 1), because Zernio docs have twice disagreed with their real API. The calendar is a new component consuming only existing + Task 3 endpoints.

**Tech Stack:** NestJS 10, multer (diskStorage), `@aws-sdk/client-s3` (already a dep), jest + ts-jest (`backend/`, spec files `src/**/*.spec.ts`); React 18 with the repo's `useFetch`/`useMutation` hooks and `Modal` component; no test runner on the frontend (typecheck + verify skill).

**Spec:** `docs/superpowers/specs/2026-08-13-content-calendar-video-design.md`

## Global Constraints

- **Bilingual copy:** every user-facing string via `tx("English", "العربية")` with real Arabic.
- **Selective commits:** never `git add -A`; each commit adds only the task's listed files. Trailer on every commit: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **Branch:** stay on `feat/whatsapp-ai-mvp`. **No new dependencies.**
- **Migrations:** none expected. If one becomes necessary, hand-author the SQL folder + `npx prisma migrate deploy` — `prisma migrate dev` is broken repo-wide (tsvector drift; see ledger/memory).
- **Zernio safety:** live tests may schedule + cancel posts (never publishes) on the real connected profile; NEVER publish immediately to the client's live pages during tests. Cancel/clean up every temp post.
- **Workspace tenancy:** every new backend route resolves Zernio state via the workspace's `zernioProfileId` (`ZernioService.getProfileId`); ownership of a post id = membership in that workspace's own scheduled list (Tier 0 pattern).
- **Video limits (spec):** accept exactly `video/mp4` + `video/quicktime`, cap 300MB (`300 * 1024 * 1024`); images keep their existing 20MB cap and 4-mime allowlist.
- **Backend tests:** from `backend/`: `npx jest <path>`; full suite `npm test`. **Frontend:** from root: `npm run typecheck`.

---

### Task 1: Live verification spike — PUT /posts and media durability

No production code. Output = recorded evidence that selects Task 3's strategy and Task 3's test variant. Everything runs with `ZERNIO_API_KEY` from `backend/.env` against `https://zernio.com/api/v1` (override with `ZERNIO_BASE_URL` if set in .env).

**Files:**
- Create: `docs/superpowers/plans/2026-08-13-spike-findings.md` (committed evidence)

**Interfaces:**
- Produces: `PUT_WORKS: yes|no` and `MEDIA_DURABLE: yes|no` verdicts consumed by Task 3.

- [ ] **Step 1: Resolve profileId + accountId**

Read the workspace's `zernioProfileId` from the DB (`backend/`: `npx prisma studio` is interactive — instead use a one-off script or curl our own API):

```bash
# From the repo root; backend dev server must be running (backend/: npm run dev, port 4100).
# Login first if needed; or read straight from Postgres:
cd backend && npx tsx -e "import { PrismaClient } from '@prisma/client'; const p = new PrismaClient(); p.workspace.findFirst({ where: { zernioProfileId: { not: null } } }).then(w => { console.log(w?.id, w?.zernioProfileId); return p.integration.findFirst({ where: { workspaceId: w!.id, provider: 'zernio', platform: 'facebook' } }); }).then(i => { console.log('accountId', i?.pageId); process.exit(0); });"
```

- [ ] **Step 2: Create a temp scheduled post (text-only)**

```bash
curl -s -X POST "https://zernio.com/api/v1/posts" -H "Authorization: Bearer $ZERNIO_API_KEY" -H "Content-Type: application/json" -d '{"content":"tier1a spike - ignore","platforms":[{"platform":"facebook","accountId":"<ACCOUNT_ID>"}],"publishNow":false,"scheduledFor":"<NOW+2H ISO>","timezone":"Asia/Riyadh"}'
```

Record the returned post `_id`.

- [ ] **Step 3: Probe PUT /posts/{id}**

```bash
curl -s -X PUT "https://zernio.com/api/v1/posts/<POST_ID>" -H "Authorization: Bearer $ZERNIO_API_KEY" -H "Content-Type: application/json" -d '{"scheduledFor":"<NOW+3H ISO>","timezone":"Asia/Riyadh"}'
```

Then `GET /posts/<POST_ID>` and check whether `scheduledFor` moved to +3H. Also try `PATCH` with the same body if `PUT` returns 404/405 (record both). Verdict `PUT_WORKS: yes` only if the re-GET shows the new time.

- [ ] **Step 4: Probe media durability (only matters if PUT_WORKS=no)**

Create a second temp scheduled post WITH an image through OUR app (Compose → pick an image → schedule +2h) so the normal signed-URL handoff runs. Then `GET /posts/<POST2_ID>` and inspect `mediaUrls` / `mediaItems[].url`: (a) is the URL on a Zernio-controlled host (not our `/api/media/...` signed URL)? (b) does `curl -sI` on it return 200 without our token? Verdict `MEDIA_DURABLE: yes` if both hold.

- [ ] **Step 5: Clean up + record**

`DELETE /posts/<id>` for every temp post; re-GET our `GET /social/scheduled` to confirm empty of spike posts. Write `docs/superpowers/plans/2026-08-13-spike-findings.md` with: both verdicts, raw request/response excerpts, date, profile/account ids used.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/plans/2026-08-13-spike-findings.md
git commit -m "docs(spike): verify Zernio PUT /posts and media durability for reschedule

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Backend video support in the media pipeline

**Files:**
- Modify: `backend/src/media/storage/storage.types.ts` (put signature)
- Modify: `backend/src/media/storage/local-storage.ts`, `backend/src/media/storage/spaces-storage.ts`
- Modify: `backend/src/media/media.service.ts` (:13-19 constants, :114-148 finalizeUpload)
- Modify: `backend/src/media/media.controller.ts` (:32-48 upload interceptor)
- Test: `backend/src/media/media.service.spec.ts` (new)

**Interfaces:**
- Consumes: existing `MediaStorage` implementations (read both files first — key generation stays theirs).
- Produces (used by Tasks 4-5): `POST /media/upload` accepts `video/mp4` + `video/quicktime` ≤ 300MB (images unchanged: 4 mimes, ≤20MB); `Media` rows carry the video `mimeType`; serving/signed-URL handoff unchanged.
- Storage contract change: `put(args: { workspaceId: string; mimeType: string; originalFilename: string; buffer?: Buffer; sourcePath?: string })` — exactly one of `buffer`/`sourcePath`; `sourcePath` streams/copies from a temp file without loading it into memory.

- [ ] **Step 1: Write the failing tests**

Create `backend/src/media/media.service.spec.ts`:

```ts
import { BadRequestException } from "@nestjs/common";
import { MediaService } from "./media.service";

function makeFile(over: Partial<Express.Multer.File>): Express.Multer.File {
  return {
    fieldname: "file",
    originalname: "clip.mp4",
    encoding: "7bit",
    mimetype: "video/mp4",
    size: 5 * 1024 * 1024,
    buffer: Buffer.alloc(0),
    path: "C:/tmp/fake-upload",
    destination: "",
    filename: "",
    stream: undefined as never,
  } as Express.Multer.File;
}

describe("MediaService.finalizeUpload", () => {
  let storage: { kind: "local"; put: jest.Mock; getSignedUrl: jest.Mock; delete: jest.Mock };
  let prisma: { media: { create: jest.Mock } };
  let svc: MediaService;

  beforeEach(() => {
    storage = {
      kind: "local",
      put: jest.fn().mockResolvedValue({ key: "ws1/clip.mp4" }),
      getSignedUrl: jest.fn(),
      delete: jest.fn(),
    };
    prisma = { media: { create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: "m1", ...data })) } };
    svc = new MediaService(prisma as never, storage as never);
  });

  it("accepts an mp4 under the video cap and passes sourcePath to storage", async () => {
    const row = await svc.finalizeUpload("ws1", makeFile({}), "u1");
    expect(storage.put).toHaveBeenCalledWith(
      expect.objectContaining({ sourcePath: "C:/tmp/fake-upload", mimeType: "video/mp4" }),
    );
    expect(row.mimeType).toBe("video/mp4");
  });

  it("accepts video/quicktime", async () => {
    await expect(
      svc.finalizeUpload("ws1", makeFile({ mimetype: "video/quicktime", originalname: "clip.mov" }), "u1"),
    ).resolves.toBeTruthy();
  });

  it("rejects a video over 300MB", async () => {
    await expect(
      svc.finalizeUpload("ws1", makeFile({ size: 301 * 1024 * 1024 }), "u1"),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects unsupported video types", async () => {
    await expect(
      svc.finalizeUpload("ws1", makeFile({ mimetype: "video/x-msvideo" }), "u1"),
    ).rejects.toThrow(BadRequestException);
  });

  it("still enforces the 20MB image cap (25MB png rejected)", async () => {
    await expect(
      svc.finalizeUpload("ws1", makeFile({ mimetype: "image/png", originalname: "big.png", size: 25 * 1024 * 1024 }), "u1"),
    ).rejects.toThrow(BadRequestException);
  });

  it("still accepts a normal image (uses sourcePath when present)", async () => {
    const row = await svc.finalizeUpload(
      "ws1",
      makeFile({ mimetype: "image/jpeg", originalname: "a.jpg", size: 2 * 1024 * 1024 }),
      "u1",
    );
    expect(row.mimeType).toBe("image/jpeg");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/media/media.service.spec.ts`
Expected: FAIL — mp4 rejected by the current image-only allowlist (constructor arg order errors also possible; constructor is `(prisma, storage)`, matching the mocks).

- [ ] **Step 3: Implement — media.service.ts**

Replace the constants block (:13-19):

```ts
const ALLOWED_IMAGE = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
const ALLOWED_VIDEO = new Set(["video/mp4", "video/quicktime"]);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB
const MAX_VIDEO_BYTES = 300 * 1024 * 1024; // 300 MB — IG's ceiling; FB/TikTok allow more
```

Replace `finalizeUpload`'s validation + put call (keep the prisma.create block, add `sourcePath` handoff and temp cleanup):

```ts
  async finalizeUpload(
    workspaceId: string,
    file: Express.Multer.File,
    uploadedById: string,
  ) {
    if (!file) throw new BadRequestException("No file uploaded");
    const isImage = ALLOWED_IMAGE.has(file.mimetype);
    const isVideo = ALLOWED_VIDEO.has(file.mimetype);
    if (!isImage && !isVideo) {
      throw new BadRequestException(
        `Unsupported file type: ${file.mimetype}. Allowed: ${[...ALLOWED_IMAGE, ...ALLOWED_VIDEO].join(", ")}`,
      );
    }
    const cap = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
    if (file.size > cap) {
      throw new BadRequestException(
        `File too large (${file.size} bytes). Max ${cap} bytes for ${isVideo ? "videos" : "images"}.`,
      );
    }
    try {
      // Disk-staged uploads (current multer config) hand us file.path; memory
      // uploads (tests, legacy) hand us file.buffer. Storage accepts either.
      const { key } = await this.storage.put({
        workspaceId,
        mimeType: file.mimetype,
        originalFilename: file.originalname,
        ...(file.path ? { sourcePath: file.path } : { buffer: file.buffer }),
      });
      return await this.prisma.media.create({
        data: {
          workspaceId,
          fileName: file.originalname,
          mimeType: file.mimetype,
          sizeBytes: file.size,
          storedPath: key,
          storageKind: this.storage.kind,
          uploadedById,
        },
      });
    } finally {
      if (file.path) {
        const fs = await import("node:fs/promises");
        await fs.unlink(file.path).catch(() => {});
      }
    }
  }
```

`ingestBuffer` keeps `ALLOWED_IMAGE`/`MAX_IMAGE_BYTES` (rename its references; webhook attachments stay image-only in this slice).

- [ ] **Step 4: Implement — storage layer**

`storage.types.ts` — change `put`'s parameter to:

```ts
  put(args: {
    workspaceId: string;
    mimeType: string;
    originalFilename: string;
    /** Exactly one of buffer/sourcePath. sourcePath = staged temp file; the
     *  backend must move/stream it WITHOUT loading the whole file in memory. */
    buffer?: Buffer;
    sourcePath?: string;
  }): Promise<{ key: string }>;
```

Read `local-storage.ts` and `spaces-storage.ts` before editing — keep each file's existing key-generation and directory logic, changing only how bytes reach the destination:

- **LocalStorage.put:** where it currently writes `args.buffer` (e.g. `fs.writeFile(dest, buffer)`), branch: `if (args.sourcePath) await fs.copyFile(args.sourcePath, dest); else await fs.writeFile(dest, args.buffer!);`
- **SpacesStorage.put:** where it currently sends `Body: args.buffer` in `PutObjectCommand`, branch:

```ts
    const body = args.sourcePath
      ? (await import("node:fs")).createReadStream(args.sourcePath)
      : args.buffer!;
    const contentLength = args.sourcePath
      ? (await (await import("node:fs/promises")).stat(args.sourcePath)).size
      : args.buffer!.length;
    // include ContentLength in the PutObjectCommand input alongside the
    // file's existing Bucket/Key/ContentType fields
```

(S3 `PutObjectCommand` accepts a Readable body when `ContentLength` is provided — no new dependency needed.)

- [ ] **Step 5: Implement — controller multer config**

In `media.controller.ts`, replace the interceptor (:32-41):

```ts
  @Post("upload")
  @UseInterceptors(
    FileInterceptor("file", {
      // Stage uploads on disk (OS temp dir) instead of buffering in memory —
      // videos are capped at 300 MB and must never sit on the heap.
      // MediaService validates mime + per-type caps and cleans the temp file.
      storage: diskStorage({ destination: tmpdir() }),
      limits: { fileSize: 300 * 1024 * 1024 },
    }),
  )
```

Imports: swap `memoryStorage` for `diskStorage` from `"multer"`, add `import { tmpdir } from "node:os";`.

- [ ] **Step 6: Run tests + build**

`npx jest src/media/media.service.spec.ts` → 6/6 PASS. `npm run build` → clean. Also run the full suite (`npm test`) — storage-interface change must not break other suites.

- [ ] **Step 7: Commit**

```bash
git add backend/src/media
git commit -m "feat(media): video uploads (mp4/mov, 300MB) via disk staging and streaming storage

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Backend reschedule endpoint

**Files:**
- Modify: `backend/src/integrations/zernio.client.ts` (add after `cancelPost`)
- Modify: `backend/src/integrations/zernio.service.ts` (add after `cancelScheduledPost`)
- Modify: `backend/src/social/social.dto.ts`, `backend/src/social/social.service.ts`, `backend/src/social/social.controller.ts`
- Test: `backend/src/integrations/zernio.service.scheduled.spec.ts` (extend — created in Tier 0)

**Interfaces:**
- Consumes: Task 1 verdicts (`PUT_WORKS`, `MEDIA_DURABLE`); Tier 0's `listScheduledPosts`/`cancelPost`/`createPost`; `getProfileId`.
- Produces (used by Task 5): `PATCH /social/scheduled/:id` body `{ scheduledFor: ISO8601, timezone: IANA }` → `{ ok: true, id: string }` where `id` is the post's id AFTER reschedule (same id under PUT; the NEW post's id under cancel+recreate). 404 when the id isn't in the workspace's queue.

- [ ] **Step 1: Write the failing tests** (append a new describe to `zernio.service.scheduled.spec.ts`, reusing that file's existing mock setup pattern — read it first)

Strategy A variant (PUT_WORKS=yes):

```ts
describe("reschedulePost (PUT strategy)", () => {
  it("404s when the post isn't in the workspace queue", async () => {
    client.listCreatedPosts.mockResolvedValue([]);
    await expect(
      svc.reschedulePost("ws1", "nope", "2026-08-20T10:00:00.000Z", "Asia/Riyadh"),
    ).rejects.toThrow(NotFoundException);
    expect(client.updatePost).not.toHaveBeenCalled();
  });

  it("updates the post in place and returns the same id", async () => {
    client.listCreatedPosts.mockResolvedValue([
      { _id: "p1", status: "scheduled", content: "hi", platforms: ["facebook"] },
    ]);
    client.updatePost.mockResolvedValue({ id: "p1", status: "scheduled" });
    const res = await svc.reschedulePost("ws1", "p1", "2026-08-20T10:00:00.000Z", "Asia/Riyadh");
    expect(client.updatePost).toHaveBeenCalledWith("p1", {
      scheduledFor: "2026-08-20T10:00:00.000Z",
      timezone: "Asia/Riyadh",
    });
    expect(res).toEqual({ ok: true, id: "p1" });
  });
});
```

Strategy B variant (PUT_WORKS=no — use INSTEAD of the above):

```ts
describe("reschedulePost (cancel+recreate strategy)", () => {
  it("404s when the post isn't in the workspace queue", async () => {
    client.listCreatedPosts.mockResolvedValue([]);
    await expect(
      svc.reschedulePost("ws1", "nope", "2026-08-20T10:00:00.000Z", "Asia/Riyadh"),
    ).rejects.toThrow(NotFoundException);
  });

  it("creates the replacement BEFORE cancelling the original, reusing Zernio-hosted media", async () => {
    client.listCreatedPosts.mockResolvedValue([
      {
        _id: "p1",
        status: "scheduled",
        content: "hi",
        platforms: [{ platform: "facebook", accountId: "acc1" }],
        mediaUrls: ["https://cdn.zernio.com/m/1.jpg"],
      },
    ]);
    client.createPost.mockResolvedValue({ id: "p2", status: "scheduled" });
    client.cancelPost.mockResolvedValue(undefined);
    const res = await svc.reschedulePost("ws1", "p1", "2026-08-20T10:00:00.000Z", "Asia/Riyadh");
    const createOrder = client.createPost.mock.invocationCallOrder[0];
    const cancelOrder = client.cancelPost.mock.invocationCallOrder[0];
    expect(createOrder).toBeLessThan(cancelOrder);
    expect(client.createPost).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "hi",
        mediaUrls: ["https://cdn.zernio.com/m/1.jpg"],
        scheduledFor: "2026-08-20T10:00:00.000Z",
        timezone: "Asia/Riyadh",
      }),
    );
    expect(res).toEqual({ ok: true, id: "p2" });
  });
});
```

(Add `updatePost` / extra mocks to the spec file's client mock object as needed.)

- [ ] **Step 2: Run to verify failure**

`npx jest src/integrations/zernio.service.scheduled.spec.ts` → FAIL (`reschedulePost is not a function`).

- [ ] **Step 3: Implement the client method (Strategy A only)**

If `PUT_WORKS=yes`, add to `zernio.client.ts` after `cancelPost` (use the verb the spike confirmed — PUT or PATCH):

```ts
  /** Update a Zernio-created post in place (spike-verified 2026-08-13). */
  async updatePost(
    postId: string,
    body: { scheduledFor: string; timezone?: string },
  ): Promise<{ id: string | null; status: string | null }> {
    const res = await this.request<{ post?: { _id?: string; status?: string } }>(
      "PUT",
      `/posts/${encodeURIComponent(postId)}`,
      { body },
    );
    return { id: res.post?._id ?? postId, status: res.post?.status ?? null };
  }
```

- [ ] **Step 4: Implement the service method**

Add to `zernio.service.ts` after `cancelScheduledPost`. Strategy A:

```ts
  async reschedulePost(
    workspaceId: string,
    postId: string,
    scheduledFor: string,
    timezone: string,
  ) {
    const mine = await this.listScheduledPosts(workspaceId);
    if (!mine.some((p) => p.id === postId)) {
      throw new NotFoundException("Scheduled post not found");
    }
    const res = await this.client.updatePost(postId, { scheduledFor, timezone });
    return { ok: true as const, id: res.id ?? postId };
  }
```

Strategy B (replaces the body above; note it needs the RAW post row, so it re-lists via the client rather than the mapped `listScheduledPosts`):

```ts
  async reschedulePost(
    workspaceId: string,
    postId: string,
    scheduledFor: string,
    timezone: string,
  ) {
    const profileId = await this.getProfileId(workspaceId);
    if (!profileId) throw new NotFoundException("Scheduled post not found");
    const raw = (await this.client.listCreatedPosts(profileId)).find(
      (p) => (p._id ?? p.id) === postId && (p.status ?? "").toLowerCase() === "scheduled",
    );
    if (!raw) throw new NotFoundException("Scheduled post not found");
    // Re-resolve platform accountIds from our own Integration rows (raw rows
    // may carry platform names only), same source publish() uses.
    const names = Array.isArray(raw.platforms)
      ? raw.platforms.map((pl) => (typeof pl === "string" ? pl : pl.platform ?? "")).filter(Boolean)
      : [];
    const rows = await this.prisma.integration.findMany({
      where: { workspaceId, provider: "zernio", platform: { in: names } },
    });
    const platforms = rows
      .filter((r) => r.pageId)
      .map((r) => ({ platform: r.platform, accountId: r.pageId! }));
    if (platforms.length === 0) throw new NotFoundException("Scheduled post not found");
    const mediaUrls =
      raw.mediaUrls ?? raw.mediaItems?.map((m) => m.url).filter((u): u is string => !!u);
    // Create the replacement FIRST — if it fails, the original still exists.
    const created = await this.client.createPost({
      content: raw.content ?? raw.caption ?? raw.text ?? "",
      platforms,
      mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
      scheduledFor,
      timezone,
    });
    try {
      await this.client.cancelPost(postId);
    } catch (e) {
      // Replacement exists but the original didn't cancel — surface loudly so
      // the user can cancel the duplicate from the calendar.
      this.log.error(`reschedule: replacement ${created.id} created but cancel of ${postId} failed`);
      throw new HttpException("Rescheduled, but the old copy could not be cancelled — remove it from the calendar", 502);
    }
    return { ok: true as const, id: created.id ?? postId };
  }
```

(Strategy B: if the spike said `MEDIA_DURABLE=no`, posts WITH media cannot be safely re-created — in that branch throw `new BadRequestException("Posts with media can't be rescheduled yet — cancel and re-schedule it from Compose")` when `mediaUrls?.length`; text-only posts proceed. Record which branch shipped in the commit message.)

- [ ] **Step 5: Wire DTO/service/controller**

`social.dto.ts`:

```ts
export class RescheduleDto {
  @IsISO8601()
  scheduledFor!: string;

  @IsString()
  timezone!: string;
}
```

`social.service.ts`:

```ts
  reschedule(workspaceId: string, postId: string, dto: RescheduleDto) {
    return this.zernio.reschedulePost(workspaceId, postId, dto.scheduledFor, dto.timezone);
  }
```

`social.controller.ts` (import `Patch`, `RescheduleDto`):

```ts
  @Patch("scheduled/:id")
  reschedule(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Body() dto: RescheduleDto,
  ) {
    return this.svc.reschedule(workspaceId, id, dto);
  }
```

- [ ] **Step 6: Run tests + build; live smoke**

`npx jest src/integrations/zernio.service.scheduled.spec.ts` → PASS; `npm run build` → clean. Live smoke against the dev server: schedule a temp post via the app, `curl -X PATCH .../social/scheduled/<id>` to a new time, confirm via `GET /social/scheduled` the time moved (and, for Strategy B, the id changed and the old id is gone), then cancel it.

- [ ] **Step 7: Commit**

```bash
git add backend/src/integrations backend/src/social
git commit -m "feat(social): reschedule scheduled posts (PATCH /social/scheduled/:id)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Frontend video — compose, media picker, library

**Files:**
- Modify: `src/components/ComposeModal.tsx` (accept list :656, MediaPicker grid + selected row, PreviewThumb, FbPreviewCard/IgPreviewCard media rendering, placeholder copy :265-268)
- Modify: `src/screens/Media.tsx` (accept :119, subtitle :100-103, MediaTile/AuthorizedImage)

**Interfaces:**
- Consumes: Task 2's upload contract; `Media.mimeType` (already on the frontend type).
- Produces (used by Task 5's E2E): video posts flow through the same `mediaIds` publish path — no compose API change.

- [ ] **Step 1: ComposeModal — accept + copy**

File input accept (:656) becomes `"image/jpeg,image/png,image/gif,image/webp,video/mp4,video/quicktime"`. Textarea placeholder (:265-268) becomes `tx("Write your post… text and one image or video are supported in this phase.", "اكتب منشورك… النص وصورة أو فيديو واحد مدعوم في هذه المرحلة.")`.

- [ ] **Step 2: ComposeModal — media-type-aware previews**

`PreviewThumb` currently blob-fetches and renders `<img>`. Give it a `mimeType` prop and branch:

```tsx
function PreviewThumb({ mediaId, mimeType }: { mediaId: string; mimeType?: string }) {
  // ... existing blob fetch unchanged ...
  const isVideo = !!mimeType?.startsWith("video/");
  if (!src) { /* existing "…" placeholder unchanged */ }
  if (isVideo) {
    return (
      <video
        src={src}
        controls
        preload="metadata"
        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
      />
    );
  }
  return <img src={src} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />;
}
```

**Grid-tile guard:** in the MediaPicker grid (the `media.map` at :729), do NOT blob-fetch videos per tile (a grid of 300MB fetches). For video rows render a static placeholder instead of `PreviewThumb`:

```tsx
{m.mimeType.startsWith("video/") ? (
  <div
    className="mono muted"
    style={{ width: "100%", height: "100%", display: "grid", placeItems: "center", fontSize: 20 }}
    aria-label={tx("Video", "فيديو")}
  >
    ▶
  </div>
) : (
  <PreviewThumb mediaId={m.id} />
)}
```

The SELECTED media row (:660-683) and the preview cards get the full player: thread `mimeType` through — `<PreviewThumb mediaId={selectedId} mimeType={media.find((m) => m.id === selectedId)?.mimeType} />`, and in `FbPreviewCard`/`IgPreviewCard` change `{media && <PreviewThumb mediaId={media.id} />}` to `{media && <PreviewThumb mediaId={media.id} mimeType={media.mimeType} />}` (the `Media` object is already passed in).

- [ ] **Step 3: Media.tsx — accept, copy, tiles**

Accept (:119) gains the two video mimes. Subtitle becomes `tx("Images up to 20 MB and videos up to 300 MB you can attach to posts.", "صور حتى ٢٠ م.ب وفيديو حتى ٣٠٠ م.ب يمكنك إرفاقها بالمنشورات.")`. Empty-state copy: "add an image" → `tx("No media yet. Click Upload to add an image or video.", "لا توجد وسائط بعد. اضغط رفع لإضافة صورة أو فيديو.")`.

`MediaTile`: for `m.mimeType.startsWith("video/")` rows, render a click-to-load player instead of `AuthorizedImage` (avoids fetching every video in the grid):

```tsx
{m.mimeType.startsWith("video/") ? (
  <VideoTile url={previewUrl} token={tok} label={tx("Load video", "تحميل الفيديو")} />
) : (
  <AuthorizedImage url={previewUrl} alt={m.fileName} token={tok} />
)}
```

New component in the same file:

```tsx
/** Videos aren't fetched until asked — a grid of large blobs would be brutal.
 *  First click fetches with the bearer token and swaps in a playable element. */
function VideoTile({ url, token, label }: { url: string; token: string | null; label: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    return () => {
      if (src) URL.revokeObjectURL(src);
    };
  }, [src]);

  if (src) {
    return (
      <video src={src} controls style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
    );
  }
  return (
    <button
      type="button"
      className="btn ghost"
      disabled={loading}
      onClick={() => {
        setLoading(true);
        fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
          .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`))))
          .then((b) => setSrc(URL.createObjectURL(b)))
          .catch(() => setLoading(false));
      }}
      style={{ width: "100%", height: "100%", display: "grid", placeItems: "center", fontSize: 22 }}
      aria-label={label}
    >
      {loading ? "…" : "▶"}
    </button>
  );
}
```

- [ ] **Step 4: Typecheck + verify**

`npm run typecheck` → clean. Verify skill: upload a small mp4 in Media (appears with ▶ tile, click loads and plays), open Compose → pick it (player renders in composer and preview cards), IG/TikTok chips accept it as satisfying the media requirement. Upload a 25MB png → the 20MB image error surfaces; a fake 400MB file is rejected by multer (skip if impractical — note it).

- [ ] **Step 5: Commit**

```bash
git add src/components/ComposeModal.tsx src/screens/Media.tsx
git commit -m "feat(media): video upload, preview, and compose support (mp4/mov)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Content calendar

**Files:**
- Create: `src/screens/social/ContentCalendar.tsx`
- Modify: `src/screens/Social.tsx` (view toggle near the tabs :575-590; conditional render)

**Interfaces:**
- Consumes: `GET /social/scheduled` → `{id, content, platforms, mediaUrl, scheduledFor}[]`; `GET /integrations/zernio/posts` (no platform param = all platforms) → `{id, platform, body, mediaUrl, createdAt, permalink, ...}[]`; `PATCH /social/scheduled/:id` `{scheduledFor, timezone}` (Task 3); `DELETE /social/scheduled/:id`; `SchedulePicker` (`{ value: Date | null; onChange: (d: Date | null) => void; tx }` — read `src/components/SchedulePicker.tsx` to confirm before use); `Modal` component (`src/components/Modal.tsx`, used like Media.tsx's DeleteConfirmDialog).
- Produces: `<ContentCalendar refreshKey={number} />`.

- [ ] **Step 1: Build the component**

Create `src/screens/social/ContentCalendar.tsx`:

```tsx
import { useMemo, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { useFetch, useMutation } from "@/api/useFetch";
import { api } from "@/api/client";
import { Modal } from "@/components/Modal";
import { SchedulePicker } from "@/components/SchedulePicker";
import { IconChev } from "@/icons";

interface ScheduledRow {
  id: string;
  content: string;
  platforms: string[];
  mediaUrl: string | null;
  scheduledFor: string | null;
}
interface PublishedRow {
  id: string;
  platform: string;
  body: string;
  mediaUrl: string | null;
  createdAt: string | null;
  permalink: string | null;
}
interface CalItem {
  key: string;
  kind: "scheduled" | "published";
  id: string;
  date: Date;
  content: string;
  platforms: string[];
  mediaUrl: string | null;
  permalink: string | null;
}

/** ISO date (YYYY-MM-DD) in LOCAL time — calendar cells bucket by local day. */
function localDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 6 rows x 7 cols of Dates covering the month, weeks starting Sunday —
 *  matches the appointments Calendar screen's convention. */
function buildMonthGrid(year: number, month: number): Date[][] {
  const first = new Date(year, month, 1);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());
  const weeks: Date[][] = [];
  const cur = new Date(start);
  for (let w = 0; w < 6; w += 1) {
    const row: Date[] = [];
    for (let d = 0; d < 7; d += 1) {
      row.push(new Date(cur));
      cur.setDate(cur.getDate() + 1);
    }
    weeks.push(row);
  }
  return weeks;
}

export function ContentCalendar({ refreshKey }: { refreshKey: number }) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);

  const scheduledQ = useFetch<ScheduledRow[]>(`/social/scheduled?rk=${refreshKey}`);
  const publishedQ = useFetch<PublishedRow[]>("/integrations/zernio/posts");

  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth()); // 0-based
  const [expandedDay, setExpandedDay] = useState<string | null>(null);
  const [selected, setSelected] = useState<CalItem | null>(null);

  const items: CalItem[] = useMemo(() => {
    const out: CalItem[] = [];
    for (const s of scheduledQ.data ?? []) {
      if (!s.scheduledFor) continue;
      out.push({
        key: `s-${s.id}`,
        kind: "scheduled",
        id: s.id,
        date: new Date(s.scheduledFor),
        content: s.content,
        platforms: s.platforms,
        mediaUrl: s.mediaUrl,
        permalink: null,
      });
    }
    for (const p of publishedQ.data ?? []) {
      if (!p.createdAt) continue;
      out.push({
        key: `p-${p.platform}-${p.id}`,
        kind: "published",
        id: p.id,
        date: new Date(p.createdAt),
        content: p.body,
        platforms: [p.platform],
        mediaUrl: p.mediaUrl,
        permalink: p.permalink,
      });
    }
    return out;
  }, [scheduledQ.data, publishedQ.data]);

  const byDay = useMemo(() => {
    const m = new Map<string, CalItem[]>();
    for (const it of items) {
      const k = localDayKey(it.date);
      const list = m.get(k) ?? [];
      list.push(it);
      m.set(k, list);
    }
    for (const list of m.values()) {
      list.sort((a, b) => a.date.getTime() - b.date.getTime());
    }
    return m;
  }, [items]);

  const weeks = useMemo(() => buildMonthGrid(year, month), [year, month]);
  const monthLabel = new Date(year, month, 1).toLocaleDateString(
    t.lang === "ar" ? "ar" : undefined,
    { month: "long", year: "numeric" },
  );
  const todayKey = localDayKey(new Date());

  const nav = (delta: number) => {
    const d = new Date(year, month + delta, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth());
    setExpandedDay(null);
  };

  const refetchAll = () => {
    scheduledQ.refetch();
    publishedQ.refetch();
  };

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "12px 24px 24px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <button type="button" className="btn ghost icon sm" onClick={() => nav(-1)} aria-label={tx("Previous month", "الشهر السابق")}>
          <IconChev w={14} className="flip-rtl" style={{ transform: "rotate(180deg)" }} />
        </button>
        <span style={{ fontWeight: 600, fontSize: 14, minWidth: 140, textAlign: "center" }}>{monthLabel}</span>
        <button type="button" className="btn ghost icon sm" onClick={() => nav(1)} aria-label={tx("Next month", "الشهر التالي")}>
          <IconChev w={14} className="flip-rtl" />
        </button>
        <span style={{ flex: 1 }} />
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--ink-3)" }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--accent)" }} />
          {tx("Scheduled", "مجدول")}
          <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--ink-3)", marginInlineStart: 10 }} />
          {tx("Published", "منشور")}
        </span>
      </div>

      {(scheduledQ.error || publishedQ.error) && (
        <div style={{ fontSize: 12, color: "var(--bad)", marginBottom: 8 }}>
          {tx("Couldn't load some posts.", "تعذر تحميل بعض المنشورات.")}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 }}>
        {weeks[0].map((d) => (
          <div key={`h-${d.getDay()}`} className="mono" style={{ fontSize: 10, color: "var(--ink-3)", textTransform: "uppercase", padding: "0 6px 4px" }}>
            {d.toLocaleDateString(t.lang === "ar" ? "ar" : undefined, { weekday: "short" })}
          </div>
        ))}
        {weeks.flat().map((d) => {
          const key = localDayKey(d);
          const inMonth = d.getMonth() === month;
          const dayItems = byDay.get(key) ?? [];
          const isExpanded = expandedDay === key;
          const visible = isExpanded ? dayItems : dayItems.slice(0, 3);
          return (
            <div
              key={key}
              style={{
                minHeight: 96,
                border: "1px solid var(--line-soft)",
                borderRadius: 8,
                padding: 6,
                background: key === todayKey ? "var(--accent-soft)" : inMonth ? "var(--bg-1)" : "var(--bg-2)",
                opacity: inMonth ? 1 : 0.55,
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              <span className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>{d.getDate()}</span>
              {visible.map((it) => (
                <button
                  key={it.key}
                  type="button"
                  onClick={() => setSelected(it)}
                  title={it.content}
                  style={{
                    textAlign: "start",
                    fontSize: 11,
                    lineHeight: 1.3,
                    padding: "3px 6px",
                    borderRadius: 6,
                    border: "1px solid transparent",
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    background: it.kind === "scheduled" ? "var(--accent-soft)" : "var(--bg-2)",
                    color: it.kind === "scheduled" ? "var(--accent)" : "var(--ink-2)",
                  }}
                >
                  {it.date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}{" "}
                  {it.content || tx("(no text)", "(بدون نص)")}
                </button>
              ))}
              {dayItems.length > 3 && !isExpanded && (
                <button type="button" className="btn ghost sm" style={{ fontSize: 10, padding: "1px 6px", alignSelf: "start" }} onClick={() => setExpandedDay(key)}>
                  +{dayItems.length - 3} {tx("more", "المزيد")}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {selected && (
        <PostDetailModal
          item={selected}
          tx={tx}
          onClose={() => setSelected(null)}
          onChanged={() => {
            setSelected(null);
            refetchAll();
          }}
        />
      )}
    </div>
  );
}

function PostDetailModal({
  item,
  tx,
  onClose,
  onChanged,
}: {
  item: CalItem;
  tx: (en: string, ar: string) => string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [newTime, setNewTime] = useState<Date | null>(null);
  const [armedCancel, setArmedCancel] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rescheduleMut = useMutation<{ id: string; scheduledFor: string; timezone: string }, { ok: true }>(
    ({ id, scheduledFor, timezone }) => api.patch(`/social/scheduled/${id}`, { scheduledFor, timezone }),
  );
  const cancelMut = useMutation<{ id: string }, { ok: true }>(({ id }) => api.delete(`/social/scheduled/${id}`));

  const busy = rescheduleMut.loading || cancelMut.loading;

  return (
    <Modal onClose={busy ? () => {} : onClose} width={480} label="Post details" panelStyle={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span
          className="mono"
          style={{
            fontSize: 10,
            textTransform: "uppercase",
            padding: "2px 8px",
            borderRadius: 999,
            background: item.kind === "scheduled" ? "var(--accent-soft)" : "var(--bg-2)",
            color: item.kind === "scheduled" ? "var(--accent)" : "var(--ink-2)",
          }}
        >
          {item.kind === "scheduled" ? tx("Scheduled", "مجدول") : tx("Published", "منشور")}
        </span>
        <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
          {item.platforms.join(" · ")} — {item.date.toLocaleString()}
        </span>
      </div>

      {item.mediaUrl && (
        <img src={item.mediaUrl} alt="" style={{ maxHeight: 180, objectFit: "cover", borderRadius: 8 }} />
      )}

      <div style={{ fontSize: 13, whiteSpace: "pre-wrap", lineHeight: 1.5, maxHeight: 160, overflowY: "auto" }}>
        {item.content || tx("(no text)", "(بدون نص)")}
      </div>

      {item.kind === "published" && item.permalink && (
        <a href={item.permalink} target="_blank" rel="noreferrer" className="btn" style={{ alignSelf: "start" }}>
          {tx("View on platform", "عرض على المنصة")}
        </a>
      )}

      {item.kind === "scheduled" && (
        <>
          <div>
            <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)", textTransform: "uppercase", marginBottom: 6 }}>
              {tx("Reschedule to", "إعادة الجدولة إلى")}
            </div>
            <SchedulePicker value={newTime} onChange={setNewTime} tx={tx} />
          </div>
          {error && <div style={{ fontSize: 12, color: "var(--bad)" }}>{error}</div>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button
              type="button"
              className={armedCancel ? "btn sm danger" : "btn ghost"}
              disabled={busy}
              onBlur={() => setArmedCancel(false)}
              onClick={() => {
                if (!armedCancel) {
                  setArmedCancel(true);
                  setError(null);
                  return;
                }
                setArmedCancel(false);
                void cancelMut
                  .mutate({ id: item.id })
                  .then(onChanged)
                  .catch(() => setError(tx("Couldn't cancel this post.", "تعذر إلغاء هذا المنشور.")));
              }}
            >
              {armedCancel ? tx("Confirm cancel", "تأكيد الإلغاء") : tx("Cancel post", "إلغاء المنشور")}
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={!newTime || busy}
              onClick={() => {
                if (!newTime) return;
                setError(null);
                void rescheduleMut
                  .mutate({
                    id: item.id,
                    scheduledFor: newTime.toISOString(),
                    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                  })
                  .then(onChanged)
                  .catch(() => setError(tx("Couldn't reschedule this post.", "تعذرت إعادة جدولة المنشور.")));
              }}
            >
              {rescheduleMut.loading ? tx("Rescheduling…", "جارٍ إعادة الجدولة…") : tx("Reschedule", "إعادة جدولة")}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
```

Adjust to reality where the plan's assumptions differ (verify before wiring): `Modal`'s exact props (`onClose`, `width`, `label`, `panelStyle` — as used in Media.tsx:210-215); `SchedulePicker`'s props (read the file; if its signature differs, adapt the call, not the picker). Note the `?rk=` param on the scheduled fetch is a cache-buster to make `useFetch` re-run when `refreshKey` changes — if `useFetch` re-fetches on URL change (it does; URL is its dependency), this works without an effect.

- [ ] **Step 2: Social.tsx — view toggle**

Add state next to `composeOpen`: `const [view, setView] = useState<"feed" | "calendar">("feed");` and import `ContentCalendar` from `@/screens/social/ContentCalendar`.

Insert a toggle row immediately AFTER the tabs `</div>` (:588) and BEFORE `<ScheduledPanel …>`:

```tsx
      <div style={{ display: "flex", gap: 6, padding: "10px 24px 0" }}>
        {(["feed", "calendar"] as const).map((v) => (
          <button
            key={v}
            type="button"
            className={`btn sm ${view === v ? "primary" : "ghost"}`.trim()}
            onClick={() => setView(v)}
          >
            {v === "feed" ? tx("Feed", "الخلاصة") : tx("Calendar", "التقويم")}
          </button>
        ))}
      </div>
```

Wrap the existing feed content: `<ScheduledPanel …>` and the `social-grid` div render only when `view === "feed"`; when `view === "calendar"` render `<ContentCalendar refreshKey={scheduledRefresh} />` instead. The platform tabs stay visible in both views (the calendar ignores them — it shows all platforms).

- [ ] **Step 3: Typecheck + verify**

`npm run typecheck` → clean. Verify skill (all safe — nothing publishes): schedule two posts ≥10 min out on different days → Calendar shows both on the right days; today is highlighted; prev/next month works; a day with 4+ items shows "+N more" and expands; click a scheduled chip → modal shows content/platforms/time; reschedule to tomorrow → chip moves (and with Strategy B, the id changed transparently); arm+confirm cancel → chip gone; published posts appear as muted chips with a working permalink link; RTL: switch to Arabic and confirm layout mirrors.

- [ ] **Step 4: Commit**

```bash
git add src/screens/social/ContentCalendar.tsx src/screens/Social.tsx
git commit -m "feat(social): month content calendar with reschedule and cancel

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Full verification pass

**Files:** none new (fixups only, committed individually as `fix: <what> found in Tier 1A verification`).

- [ ] **Step 1:** backend/: `npm test` (all suites green) and `npm run build` clean.
- [ ] **Step 2:** root: `npm run typecheck && npm run build` clean.
- [ ] **Step 3: E2E sweep** (verify skill):
  1. Upload a real small mp4 (if none available on the machine, generate one: `ffmpeg -f lavfi -i testsrc=duration=2:size=320x240:rate=10 tier1a.mp4` if ffmpeg exists; otherwise upload any file renamed `.mp4` with mime `video/mp4` and note that playback checks are skipped — the pipeline validates mime+size, not codecs).
  2. Media library: video tile shows ▶, click loads and plays (real mp4 only).
  3. Compose: pick the video → player in composer + preview cards → schedule ≥10 min out → appears on the calendar → open it → reschedule to another day → chip moves → cancel → gone. (If Task 3 shipped Strategy B with `MEDIA_DURABLE=no`, verify instead that rescheduling the video post returns the friendly "can't reschedule media posts yet" error and text-only reschedule works.)
  4. Feed | Calendar toggle: feed view unchanged (Scheduled strip, comments, reply flow intact — regression check).
  5. Image flows still work: upload image, compose with image, schedule + cancel.
  6. Oversize guard: attempt >20MB image → specific error surfaces in the picker.
- [ ] **Step 4:** Grep sweep: no leftover `scheduleMut`, no `console.log` introduced by this plan's commits (`git diff <task1-base>..HEAD | grep -n "console.log"` → only pre-existing).

---

## Self-review notes (spec → plan coverage)

- Spec §1 calendar (toggle, month grid, 3+N chips, popover, reschedule/cancel, strip stays) → Task 5. Spec §2 reschedule (PATCH route, ownership, verified strategy, media-durability fallback) → Tasks 1+3, both strategies fully coded, duplicate-risk ordering handled (create-before-cancel + loud 502). Spec §3 video (mimes, 300MB, disk staging resolving open item 3, compose/library previews, no type selector) → Tasks 2+4. Spec §4 error handling (upload specifics, popover inline errors, quiet calendar errors) → Tasks 2/4/5. Spec §5 testing → per-task tests + Task 6. Open items 1-2 → Task 1; open item 3 → resolved during planning (memoryStorage 20MB confirmed; plan switches to disk staging).
- Known simplifications, deliberate: published chips bucket by local browser day; the calendar ignores the platform tabs (shows all); spaces-backed video serving proxies whole files through the backend (range/seek deferred — noted, acceptable for MVP).
