# Tier 0 Credibility Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every visible number in tkana true and every visible control functional: real post scheduling via Zernio with a visible/cancellable list, comment writes routed through Zernio, Analytics rebuilt on real data, an honest draft-only campaign builder, and removal of stale-AI copy and dead buttons.

**Architecture:** Backend is NestJS + Prisma (Postgres) in `backend/`; frontend is Vite + React 18 + TS in `src/`. Social publishing already flows `ComposeModal → POST /social/publish → SocialService → ZernioService → ZernioClient` — scheduling extends that same path with `scheduledFor`/`timezone` instead of adding new infrastructure. Zernio's `POST /posts` treats `scheduledFor` + `timezone` as the schedule; `GET /posts` lists only Zernio-created posts (i.e., the scheduled queue); `DELETE /posts/{id}` cancels.

**Tech Stack:** NestJS 10, Prisma 5, class-validator, jest + ts-jest (backend, `backend/jest.config.js`, spec files `src/**/*.spec.ts`); React 18 + custom `useFetch`/`useMutation` hooks (frontend, no test runner — verify via `npm run typecheck` and the `verify` skill).

**Spec:** `docs/superpowers/specs/2026-08-12-tier0-credibility-fixes-design.md`

## Global Constraints

- **Bilingual copy:** every user-facing string goes through `tx("English", "العربية")` with real Arabic, matching surrounding code.
- **Selective commits:** the working tree has pre-existing uncommitted changes. NEVER `git add -A` / `git add .`. Task 0 snapshots the pre-existing work; after that, each commit adds only the files listed in its task.
- **Backend tests:** run from `backend/`: `npx jest src/path/file.spec.ts`. Full suite: `npm test`.
- **Frontend checks:** run from repo root: `npm run typecheck`.
- **Branch:** stay on `feat/whatsapp-ai-mvp`.
- **No new dependencies** in either package.json.
- **Workspace scoping:** every backend route resolves Zernio state through the workspace's `zernioProfileId` (via `ZernioService.getProfileId`); never act on client-supplied ids without a workspace-scoped check.
- **Commit trailer:** end every commit message with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **Zernio docs ground truth:** where a step says "verify against Zernio docs", fetch `https://docs.zernio.com/llms-full.txt` (WebFetch) and search it; if a documented path differs from the plan's assumption, use the documented path and update the test expectations to match. Record what you found in the commit message body.

---

### Task 0: Snapshot pre-existing working-tree changes

The tree carries uncommitted work (Kapso removal, Zernio consolidation — see `git status`: deleted `kapso.*` files, modified `zernio.*`, `IntegrationsTab.tsx`, untracked migrations `20260811120000_conversation_external_id/`, `20260811150000_remove_kapso/`, etc.). It must be committed before our tasks so later commits stay clean.

**Files:** everything currently modified/deleted/untracked (no new edits).

- [ ] **Step 1: Review the pending diff**

Run: `git status --porcelain` and `git diff --stat` (and `git diff --cached --stat`).
Expected: changes consistent with Kapso removal + Zernio/social consolidation (kapso files deleted, zernio files modified, two new migration folders). If anything unrelated or surprising appears (credentials, unrelated features), STOP and ask the user.

- [ ] **Step 2: Commit the snapshot**

```bash
git add -A
git commit -m "chore: land pending Kapso-removal and Zernio consolidation work

Pre-existing working-tree state committed as-is so Tier 0 commits stay isolated.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

(This is the ONLY task allowed to use `git add -A`.)

- [ ] **Step 3: Verify clean tree**

Run: `git status --porcelain`
Expected: empty output.

---

### Task 1: ZernioClient — scheduled publishing, created-posts list, cancel

**Files:**
- Modify: `backend/src/integrations/zernio.client.ts` (createPost at :148-160; add two methods after listPosts at :167-172)
- Test: `backend/src/integrations/zernio.client.spec.ts` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces (used by Task 2):
  - `createPost(body: { content: string; platforms: Array<{platform: string; accountId: string; platformSpecificData?: unknown}>; mediaUrls?: string[]; publishNow?: boolean; scheduledFor?: string; timezone?: string })` → `Promise<{ id: string | null; status: string | null }>` — when `scheduledFor` is set, sends `publishNow: false` + `scheduledFor` + `timezone`.
  - `listCreatedPosts(profileId: string): Promise<ZernioPost[]>` — `GET /posts` (Zernio-created posts only; the scheduled queue lives here).
  - `cancelPost(postId: string): Promise<void>` — `DELETE /posts/{postId}`.

- [ ] **Step 1: Verify against Zernio docs**

WebFetch `https://docs.zernio.com/llms-full.txt`; confirm: (a) `POST /v1/posts` accepts `scheduledFor` + `timezone`; (b) `GET /v1/posts` exists and its list response shape (`posts` array vs `data`) and whether a `status` query filter exists; (c) `DELETE /v1/posts/{postId}` cancels a scheduled post. Note findings; adjust Step 3/test paths only if docs differ.

- [ ] **Step 2: Write the failing test**

Create `backend/src/integrations/zernio.client.spec.ts`:

```ts
import { ZernioClient } from "./zernio.client";

describe("ZernioClient publishing", () => {
  let client: ZernioClient;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env.ZERNIO_API_KEY = "test-key";
    client = new ZernioClient();
    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ post: { _id: "p1", status: "scheduled" } })),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it("sends scheduledFor + timezone and publishNow:false when scheduling", async () => {
    const res = await client.createPost({
      content: "hello",
      platforms: [{ platform: "facebook", accountId: "acc1" }],
      scheduledFor: "2026-08-13T10:00:00.000Z",
      timezone: "Asia/Riyadh",
    });
    expect(res).toEqual({ id: "p1", status: "scheduled" });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.publishNow).toBe(false);
    expect(body.scheduledFor).toBe("2026-08-13T10:00:00.000Z");
    expect(body.timezone).toBe("Asia/Riyadh");
  });

  it("defaults to publishNow:true when no scheduledFor", async () => {
    await client.createPost({
      content: "hello",
      platforms: [{ platform: "facebook", accountId: "acc1" }],
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.publishNow).toBe(true);
    expect(body.scheduledFor).toBeUndefined();
  });

  it("lists created posts from GET /posts", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ posts: [{ _id: "p1", status: "scheduled" }] })),
    });
    const posts = await client.listCreatedPosts("prof1");
    expect(posts).toHaveLength(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/posts?");
    expect(url).toContain("profileId=prof1");
  });

  it("cancels a post with DELETE /posts/:id", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve("{}") });
    await client.cancelPost("p1");
    expect(String(fetchMock.mock.calls[0][0])).toContain("/posts/p1");
    expect(fetchMock.mock.calls[0][1].method).toBe("DELETE");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run (from `backend/`): `npx jest src/integrations/zernio.client.spec.ts`
Expected: FAIL — `listCreatedPosts is not a function`, and the scheduling test fails on `publishNow: true`.

- [ ] **Step 4: Implement**

In `zernio.client.ts`, replace `createPost` and add the two methods after `listPosts`:

```ts
  async createPost(body: {
    content: string;
    platforms: Array<{ platform: string; accountId: string; platformSpecificData?: unknown }>;
    mediaUrls?: string[];
    publishNow?: boolean;
    scheduledFor?: string; // ISO 8601 — when set, wins over publishNow
    timezone?: string;     // IANA name, e.g. "Asia/Riyadh"
  }): Promise<{ id: string | null; status: string | null }> {
    const { scheduledFor, timezone, ...rest } = body;
    const payload = scheduledFor
      ? { ...rest, publishNow: false, scheduledFor, timezone }
      : { publishNow: true, ...rest };
    const res = await this.request<{ post?: { _id?: string; status?: string } }>(
      "POST",
      "/posts",
      { body: payload },
    );
    return { id: res.post?._id ?? null, status: res.post?.status ?? null };
  }

  /** Posts CREATED through Zernio (drafts/scheduled/published) — unlike the
   *  /analytics feed, this is where the scheduled queue lives. */
  async listCreatedPosts(profileId: string): Promise<ZernioPost[]> {
    const res = await this.request<{ posts?: ZernioPost[]; data?: ZernioPost[] }>(
      "GET",
      "/posts",
      { query: { profileId, limit: "50" } },
    );
    return res.posts ?? res.data ?? [];
  }

  /** Cancels a scheduled post (deletes the Zernio post). */
  async cancelPost(postId: string): Promise<void> {
    await this.request<unknown>("DELETE", `/posts/${encodeURIComponent(postId)}`, {});
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/integrations/zernio.client.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add backend/src/integrations/zernio.client.ts backend/src/integrations/zernio.client.spec.ts
git commit -m "feat(zernio): client support for scheduled posts, created-posts list, cancel

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Backend scheduling endpoints — publish-with-schedule, list, cancel

**Files:**
- Modify: `backend/src/integrations/zernio.service.ts` (publish at :569-599; add `listScheduledPosts` + `cancelScheduledPost` after `listComments` at :210-223)
- Modify: `backend/src/social/social.dto.ts`
- Modify: `backend/src/social/social.service.ts`
- Modify: `backend/src/social/social.controller.ts`
- Test: `backend/src/social/social.service.spec.ts` (new)

**Interfaces:**
- Consumes (Task 1): `ZernioClient.createPost` (with `scheduledFor`/`timezone`), `listCreatedPosts`, `cancelPost`.
- Produces (used by Task 3):
  - `POST /social/publish` body gains optional `scheduledFor` (ISO string) + `timezone`; response unchanged: `Record<PublishChannel, { ok: boolean; postId?: string; error?: string }>`.
  - `GET /social/scheduled` → `Array<{ id: string; content: string; platforms: string[]; mediaUrl: string | null; scheduledFor: string | null }>`.
  - `DELETE /social/scheduled/:id` → `{ ok: true }` (404 if the id isn't in this workspace's queue).

- [ ] **Step 1: Write the failing test**

Create `backend/src/social/social.service.spec.ts`:

```ts
import { SocialService } from "./social.service";
import { ZernioService } from "../integrations/zernio.service";

describe("SocialService", () => {
  let zernio: jest.Mocked<Pick<ZernioService, "publish">>;
  let svc: SocialService;

  beforeEach(() => {
    zernio = { publish: jest.fn().mockResolvedValue({ id: "z1", status: "scheduled" }) };
    svc = new SocialService(zernio as unknown as ZernioService);
  });

  it("forwards scheduledFor + timezone to ZernioService.publish", async () => {
    const res = await svc.publish(
      "ws1",
      {
        content: "hi",
        channels: ["facebook", "instagram"],
        scheduledFor: "2026-08-13T10:00:00.000Z",
        timezone: "Asia/Riyadh",
      },
      "http://localhost:3001",
    );
    expect(zernio.publish).toHaveBeenCalledWith(
      "ws1",
      expect.objectContaining({
        scheduledFor: "2026-08-13T10:00:00.000Z",
        timezone: "Asia/Riyadh",
      }),
      "http://localhost:3001",
    );
    expect(res.facebook).toEqual({ ok: true, postId: "z1" });
    expect(res.instagram).toEqual({ ok: true, postId: "z1" });
  });

  it("maps failures onto every requested channel", async () => {
    zernio.publish.mockRejectedValue(new Error("boom"));
    const res = await svc.publish(
      "ws1",
      { content: "hi", channels: ["facebook"] },
      "http://localhost:3001",
    );
    expect(res.facebook.ok).toBe(false);
    expect(res.facebook.error).toBe("boom");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/social/social.service.spec.ts`
Expected: FAIL — `svc.publish is not a function` (method is currently `publishNow`).

- [ ] **Step 3: Implement backend changes**

`social.dto.ts` — add to `PublishDto` (import `IsISO8601` from class-validator):

```ts
  /** ISO 8601 instant. Present = schedule instead of publish immediately. */
  @IsOptional()
  @IsISO8601()
  scheduledFor?: string;

  /** IANA timezone the user scheduled in (e.g. "Asia/Riyadh"). */
  @IsOptional()
  @IsString()
  timezone?: string;
```

`social.service.ts` — rename `publishNow` → `publish`, forward the new fields:

```ts
  async publish(
    workspaceId: string,
    dto: PublishDto,
    publicBaseUrl: string,
  ): Promise<Record<PublishChannel, ChannelResult>> {
    const results = {} as Record<PublishChannel, ChannelResult>;
    try {
      const r = await this.zernio.publish(
        workspaceId,
        {
          content: dto.content,
          platforms: dto.channels,
          mediaIds: dto.mediaIds,
          scheduledFor: dto.scheduledFor,
          timezone: dto.timezone,
        },
        publicBaseUrl,
      );
      for (const ch of dto.channels) {
        results[ch] = { ok: true, postId: r.id ?? undefined };
      }
    } catch (e) {
      const msg = (e as { message?: string }).message ?? String(e);
      this.log.warn(`publish for ws=${workspaceId} failed: ${msg}`);
      for (const ch of dto.channels) {
        results[ch] = { ok: false, error: msg };
      }
    }
    return results;
  }
```

Add delegate methods to `SocialService`:

```ts
  listScheduled(workspaceId: string) {
    return this.zernio.listScheduledPosts(workspaceId);
  }

  cancelScheduled(workspaceId: string, postId: string) {
    return this.zernio.cancelScheduledPost(workspaceId, postId);
  }
```

`zernio.service.ts` — `publish()` input type gains `scheduledFor?: string; timezone?: string`, and the final call becomes:

```ts
    return this.client.createPost({
      content: input.content,
      platforms,
      mediaUrls: mediaUrls.length ? mediaUrls : undefined,
      scheduledFor: input.scheduledFor,
      timezone: input.timezone,
    });
```

(`createPost` handles the publishNow/scheduled switch — Task 1.)

Add after `listComments` (import `NotFoundException` from `@nestjs/common`):

```ts
  // ─── Scheduled posts (created through Zernio) ─────────────────────────────

  async listScheduledPosts(workspaceId: string) {
    const profileId = await this.getProfileId(workspaceId);
    if (!profileId) return [];
    const posts = await this.client.listCreatedPosts(profileId);
    return posts
      .filter((p) => (p.status ?? "").toLowerCase() === "scheduled")
      .map((p) => ({
        id: p._id ?? p.id ?? "",
        content: p.content ?? p.caption ?? p.text ?? "",
        platforms: Array.isArray(p.platforms)
          ? p.platforms.map((pl) => (typeof pl === "string" ? pl : pl.platform ?? "")).filter(Boolean)
          : p.platform
            ? [p.platform]
            : [],
        mediaUrl: p.thumbnailUrl ?? p.mediaItems?.[0]?.url ?? p.mediaUrls?.[0] ?? null,
        scheduledFor: p.scheduledFor ?? null,
      }));
  }

  async cancelScheduledPost(workspaceId: string, postId: string) {
    // Ownership check: the id must be in this workspace's own queue.
    const mine = await this.listScheduledPosts(workspaceId);
    if (!mine.some((p) => p.id === postId)) {
      throw new NotFoundException("Scheduled post not found");
    }
    await this.client.cancelPost(postId);
    return { ok: true as const };
  }
```

`social.controller.ts` — update the publish call and add routes (import `Delete`, `Get`, `Param`):

```ts
  @Post("publish")
  publish(@CurrentWorkspace() workspaceId: string, @Body() dto: PublishDto) {
    const publicBase =
      process.env.PUBLIC_BASE_URL ?? process.env.APP_BASE_URL ?? "http://localhost:3001";
    return this.svc.publish(workspaceId, dto, publicBase);
  }

  @Get("scheduled")
  scheduled(@CurrentWorkspace() workspaceId: string) {
    return this.svc.listScheduled(workspaceId);
  }

  @Delete("scheduled/:id")
  cancelScheduled(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.cancelScheduled(workspaceId, id);
  }
```

- [ ] **Step 4: Run tests + build**

Run: `npx jest src/social/social.service.spec.ts` → PASS.
Run: `npm run build` (from `backend/`) → compiles clean.

- [ ] **Step 5: Commit**

```bash
git add backend/src/social backend/src/integrations/zernio.service.ts
git commit -m "feat(social): schedule posts via Zernio; list + cancel the scheduled queue

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Frontend — schedule path through /social/publish + Scheduled panel

**Files:**
- Modify: `src/components/ComposeModal.tsx` (:42-129 — mutations and onPost)
- Create: `src/components/ScheduledPanel.tsx`
- Modify: `src/screens/Social.tsx` (mount panel after the tabs row; bump refresh on posted)

**Interfaces:**
- Consumes (Task 2): `POST /social/publish` with `scheduledFor`/`timezone`; `GET /social/scheduled`; `DELETE /social/scheduled/:id`.
- Produces: `<ScheduledPanel refreshKey={number} />`.

- [ ] **Step 1: ComposeModal — one mutation for both paths**

Delete the `scheduleMut` declaration (:47-55). Extend `publishMut`'s input type and `onPost`:

```ts
  const publishMut = useMutation<
    {
      content: string;
      mediaIds?: string[];
      channels: PublishChannel[];
      scheduledFor?: string;
      timezone?: string;
    },
    Record<string, ChannelResult>
  >((input) => api.post("/social/publish", input));
```

```ts
  const onPost = async () => {
    if (!canPost) return;
    const res = await publishMut.mutate({
      content: content.trim(),
      mediaIds: selectedMediaId ? [selectedMediaId] : undefined,
      channels: selectedChannels,
      scheduledFor: scheduledFor ? scheduledFor.toISOString() : undefined,
      timezone: scheduledFor
        ? Intl.DateTimeFormat().resolvedOptions().timeZone
        : undefined,
    });
    setPublishResults(res);
    const allOk = Object.values(res).every((r) => r.ok);
    onPosted?.();
    if (allOk) onClose();
  };
```

Update the remaining `scheduleMut` references: `canPost` (:100-101) drops `!scheduleMut.loading`; the error box (:314-327) drops `scheduleMut.error`; the footer button (:461-471) uses `publishMut.loading` for both labels ("Scheduling…"/"Posting…" keyed off `scheduledFor` as today).

- [ ] **Step 2: Create ScheduledPanel**

`src/components/ScheduledPanel.tsx`:

```tsx
import { useEffect } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { useFetch, useMutation } from "@/api/useFetch";
import { api } from "@/api/client";
import { IconX } from "@/icons";

interface ScheduledPost {
  id: string;
  content: string;
  platforms: string[];
  mediaUrl: string | null;
  scheduledFor: string | null;
}

/** Compact strip listing Zernio-scheduled posts with cancel. Renders nothing
 *  when the queue is empty, so the Social screen stays unchanged for most users. */
export function ScheduledPanel({ refreshKey }: { refreshKey: number }) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const q = useFetch<ScheduledPost[]>("/social/scheduled");

  useEffect(() => {
    if (refreshKey > 0) q.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const cancelMut = useMutation<{ id: string }, { ok: true }>(({ id }) =>
    api.delete(`/social/scheduled/${id}`),
  );

  const items = q.data ?? [];
  if (!items.length && !q.error) return null;

  return (
    <div style={{ padding: "12px 24px 0" }}>
      <div
        className="mono"
        style={{
          fontSize: 10,
          color: "var(--ink-3)",
          textTransform: "uppercase",
          letterSpacing: 0.06,
          marginBottom: 6,
        }}
      >
        {tx("Scheduled", "المجدولة")} · {items.length}
      </div>
      {q.error && (
        <div style={{ fontSize: 12, color: "var(--bad)", marginBottom: 8 }}>
          {tx("Couldn't load scheduled posts.", "تعذر تحميل المنشورات المجدولة.")}
        </div>
      )}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {items.map((p) => (
          <div
            key={p.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 12px",
              background: "var(--bg-1)",
              border: "1px solid var(--line-soft)",
              borderRadius: 10,
              maxWidth: 420,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 12.5,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  maxWidth: 260,
                }}
              >
                {p.content || tx("(no text)", "(بدون نص)")}
              </div>
              <div className="mono" style={{ fontSize: 10.5, color: "var(--ink-3)" }}>
                {p.platforms.join(" · ")}
                {p.scheduledFor
                  ? ` — ${new Date(p.scheduledFor).toLocaleString(undefined, {
                      day: "numeric",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}`
                  : ""}
              </div>
            </div>
            <button
              type="button"
              className="btn ghost icon sm"
              aria-label={tx("Cancel scheduled post", "إلغاء الجدولة")}
              disabled={cancelMut.loading}
              onClick={() => {
                void cancelMut.mutate({ id: p.id }).then(() => q.refetch()).catch(() => {});
              }}
            >
              <IconX w={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Mount in Social.tsx**

Import `ScheduledPanel`. Add state next to `composeOpen`:

```ts
  const [scheduledRefresh, setScheduledRefresh] = useState(0);
```

Render `<ScheduledPanel refreshKey={scheduledRefresh} />` immediately after the tabs `<div className="tabs" …>…</div>` block. Find the `<ComposeModal` element in this file and extend its `onPosted` callback to also run `setScheduledRefresh((n) => n + 1)` (create `onPosted` if the prop isn't currently passed).

- [ ] **Step 4: Typecheck + verify in the running app**

Run: `npm run typecheck` → clean.
Use the `verify` skill: log in, open Social → Compose, pick a time ≥10 min out, Schedule post → modal closes, post appears in the Scheduled strip; cancel it → strip empties. Confirm immediate "Post now" still works.

- [ ] **Step 5: Commit**

```bash
git add src/components/ComposeModal.tsx src/components/ScheduledPanel.tsx src/screens/Social.tsx
git commit -m "feat(social): working schedule flow with visible, cancellable queue

Replaces the dead POST /scheduled-posts path.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Backend comment writes via Zernio

**Files:**
- Modify: `backend/src/integrations/zernio.client.ts` (add after `listComments` :174-179)
- Modify: `backend/src/integrations/zernio.service.ts` (`listComments` mapping :210-223; add reply/delete)
- Modify: `backend/src/integrations/zernio.controller.ts` (two routes + DTO)
- Test: extend `backend/src/integrations/zernio.client.spec.ts`

**Interfaces:**
- Produces (used by Task 5):
  - `POST /integrations/zernio/comments/:id/reply` body `{ message: string; accountId?: string }` → `{ id: string | null }`.
  - `DELETE /integrations/zernio/comments/:id?accountId=…` → `{ ok: true }`.
  - `GET /integrations/zernio/comments` rows gain `accountId: string | null`.

- [ ] **Step 1: Verify endpoint shapes against Zernio docs**

WebFetch `https://docs.zernio.com/llms-full.txt`; locate the comment endpoints (reply to comment, delete comment — the docs list a full comment suite including reply/edit/delete/hide). Record the exact paths and required params. The steps below assume `POST /inbox/comments/{commentId}/reply` and `DELETE /inbox/comments/{commentId}`; **if docs differ, use the documented paths in both implementation and tests.**

- [ ] **Step 2: Write the failing tests** (append to `zernio.client.spec.ts`)

```ts
describe("ZernioClient comments", () => {
  let client: ZernioClient;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env.ZERNIO_API_KEY = "test-key";
    client = new ZernioClient();
    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ id: "c2" })),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it("replies to a comment", async () => {
    const res = await client.replyToComment("c1", "thanks!", "acc1");
    expect(res).toEqual({ id: "c2" });
    expect(String(fetchMock.mock.calls[0][0])).toContain("/inbox/comments/c1/reply");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toEqual({ message: "thanks!", accountId: "acc1" });
  });

  it("deletes a comment", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve("{}") });
    await client.deleteComment("c1", "acc1");
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/inbox/comments/c1");
    expect(url).toContain("accountId=acc1");
    expect(fetchMock.mock.calls[0][1].method).toBe("DELETE");
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx jest src/integrations/zernio.client.spec.ts` → FAIL (`replyToComment is not a function`).

- [ ] **Step 4: Implement**

`zernio.client.ts` (after `listComments`):

```ts
  async replyToComment(
    commentId: string,
    message: string,
    accountId?: string,
  ): Promise<{ id: string | null }> {
    const res = await this.request<{ id?: string; _id?: string; comment?: { _id?: string } }>(
      "POST",
      `/inbox/comments/${encodeURIComponent(commentId)}/reply`,
      { body: { message, accountId } },
    );
    return { id: res.id ?? res._id ?? res.comment?._id ?? null };
  }

  async deleteComment(commentId: string, accountId?: string): Promise<void> {
    await this.request<unknown>(
      "DELETE",
      `/inbox/comments/${encodeURIComponent(commentId)}`,
      { query: { accountId } },
    );
  }
```

`zernio.service.ts` — in `listComments` mapping, add `accountId: c.accountId ?? null,` to the returned object. Then add:

```ts
  /** Guard: an accountId sent by the client must be one of this workspace's
   *  own Zernio-connected accounts. */
  private async assertOwnAccount(workspaceId: string, accountId?: string) {
    if (!accountId) return;
    const row = await this.prisma.integration.findFirst({
      where: { workspaceId, provider: "zernio", pageId: accountId },
    });
    if (!row) throw new NotFoundException("Account not found in this workspace");
  }

  async replyToComment(
    workspaceId: string,
    commentId: string,
    message: string,
    accountId?: string,
  ) {
    const profileId = await this.getProfileId(workspaceId);
    if (!profileId) throw new BadRequestException("Zernio is not connected");
    await this.assertOwnAccount(workspaceId, accountId);
    return this.client.replyToComment(commentId, message, accountId);
  }

  async deleteComment(workspaceId: string, commentId: string, accountId?: string) {
    const profileId = await this.getProfileId(workspaceId);
    if (!profileId) throw new BadRequestException("Zernio is not connected");
    await this.assertOwnAccount(workspaceId, accountId);
    await this.client.deleteComment(commentId, accountId);
    return { ok: true as const };
  }
```

`zernio.controller.ts` — add DTO + routes (import `Query` already present):

```ts
class ZernioCommentReplyDto {
  @IsString() message!: string;
  @IsOptional() @IsString() accountId?: string;
}
```

(add `IsOptional` to the class-validator import)

```ts
  @Post("integrations/zernio/comments/:id/reply")
  replyToComment(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Body() dto: ZernioCommentReplyDto,
  ) {
    return this.zernio.replyToComment(workspaceId, id, dto.message, dto.accountId);
  }

  @Delete("integrations/zernio/comments/:id")
  deleteComment(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Query("accountId") accountId?: string,
  ) {
    return this.zernio.deleteComment(workspaceId, id, accountId);
  }
```

- [ ] **Step 5: Run tests + build**

Run: `npx jest src/integrations/zernio.client.spec.ts` → PASS. `npm run build` → clean.

- [ ] **Step 6: Commit**

```bash
git add backend/src/integrations/zernio.client.ts backend/src/integrations/zernio.client.spec.ts backend/src/integrations/zernio.service.ts backend/src/integrations/zernio.controller.ts
git commit -m "feat(zernio): comment reply/delete routed through Zernio with ownership guard

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Social screen — writes via Zernio; remove impossible actions

Live feeds only load for Zernio-connected platforms (`fbConnected` derives from `/integrations/zernio/status`, feed from `/integrations/zernio/posts` — Social.tsx:212-224), so the legacy direct-Meta write paths are unreachable-or-broken. Zernio cannot edit externally-published posts and supports top-level comments as *replies* only. Locked decision (spec §2 gating, resolved): remove FB post edit/delete and the top-level composer; make the composer a **reply** composer; delete goes through Zernio.

**Files:**
- Modify: `src/screens/Social.tsx` (:399-467 mutations, :527-569 submitComment, :596-599 Saved button, comment rows render)

**Interfaces:**
- Consumes (Task 4): the two Zernio comment routes; `accountId` now present on `/integrations/zernio/comments` rows.

- [ ] **Step 1: Track accountId on live comments**

Find the local mapping of live comments (the `useEffect` that mirrors `liveCommentsQ.data` into overrides, ~:355-370) and the `LiveFbComment` interface; add `accountId?: string | null` to both the interface and the mapped object. Grep `interface SocialComment` (it is defined in `src/lib/types.ts` or locally) and add `accountId?: string | null;`.

- [ ] **Step 2: Replace the mutations**

Delete `replyMutation` (:404-412), `igCommentMutation` (:414-423), `deletePostMut` + `editPostMut` (:458-467) and the `editingPost` state + its menu items/modal usages. Add:

```ts
  const zernioReplyMut = useMutation<
    { commentId: string; message: string; accountId?: string },
    { id: string | null }
  >((input) =>
    api.post(`/integrations/zernio/comments/${input.commentId}/reply`, {
      message: input.message,
      accountId: input.accountId,
    }),
  );

  const zernioDeleteMut = useMutation<
    { commentId: string; accountId?: string },
    { ok: boolean }
  >((input) =>
    api.delete(
      `/integrations/zernio/comments/${input.commentId}` +
        (input.accountId ? `?accountId=${encodeURIComponent(input.accountId)}` : ""),
    ),
  );
```

- [ ] **Step 3: Reply flow**

Add state `const [replyTo, setReplyTo] = useState<SocialComment | null>(null);`. In the comment row render, add a small "Reply" ghost button per comment that calls `setReplyTo(c)`. Rewrite `submitComment`:

```ts
  function submitComment() {
    if (!selected || !user || !replyTo) return;
    const body = draft.trim();
    if (!body) return;
    const localId = `${selected.id}-local-${Date.now()}`;
    const newComment: SocialComment = {
      id: localId,
      author: user.name,
      authorHandle: `@${user.email.split("@")[0] ?? "you"}`,
      body,
      likes: 0,
      at: tx("now", "الآن"),
    };
    const postId = selected.id;
    writeComments(postId, [...getCurrentComments(selected), newComment]);
    setDraft("");
    zernioReplyMut
      .mutate({ commentId: replyTo.id, message: body, accountId: replyTo.accountId ?? undefined })
      .then((res) => {
        if (res.id) {
          setOverrides((prev) => {
            const list = prev[postId]?.comments ?? [];
            return {
              ...prev,
              [postId]: { comments: list.map((c) => (c.id === localId ? { ...c, id: res.id! } : c)) },
            };
          });
        }
        setReplyTo(null);
      })
      .catch(() => {
        // Roll back the optimistic row so a failed reply isn't shown as posted.
        setOverrides((prev) => {
          const list = prev[postId]?.comments ?? [];
          return { ...prev, [postId]: { comments: list.filter((c) => c.id !== localId) } };
        });
      });
  }
```

The composer input: when `replyTo` is set, show a dismissible "Replying to {replyTo.author}" chip above it; when null, disable the input with placeholder `tx("Select a comment to reply", "اختر تعليقًا للرد عليه")`.

- [ ] **Step 4: Delete via Zernio**

In `deleteComment` (:435-456) replace the `deleteCommentMutation.mutate({ platform…, commentId… })` call with:

```ts
    zernioDeleteMut
      .mutate({ commentId: c.id, accountId: c.accountId ?? undefined })
      .catch(() => {
        writeComments(postId, before);
      });
```

and drop the `isLiveFb`/`isLiveIg` platform gating in favor of the existing live-post check (`liveFbPostIds.has(postId) || liveIgPostIds.has(postId)`).

- [ ] **Step 5: Remove dead controls**

Remove the "Saved" button (:596-599). Remove the card action menu items for post edit/delete and any now-unused imports/state. Keep the like toggle (local-only) as-is.

- [ ] **Step 6: Typecheck + verify**

`npm run typecheck` → clean. Verify skill: on a Zernio-connected workspace, open Social → select a post with comments → Reply to a comment (lands, survives refresh) → delete a comment (gone after refresh). Confirm no edit/delete menu on posts and no Saved button.

- [ ] **Step 7: Commit**

```bash
git add src/screens/Social.tsx src/lib/types.ts
git commit -m "fix(social): comment reply/delete via Zernio; drop unreachable legacy post actions

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Dashboard summary — range param + channel mix

**Files:**
- Modify: `backend/src/dashboard/dashboard.module.ts`
- Test: `backend/src/dashboard/dashboard.spec.ts` (new)

**Interfaces:**
- Produces (used by Task 7): `GET /dashboard/summary?days=7|30` — response gains `windowDays: 7 | 30`, `channels: Array<{ channel: string; count: number }>`; `daily` covers the requested window; `counts`/`deltas` unchanged (deltas stay week-over-week).

- [ ] **Step 1: Write the failing test**

`backend/src/dashboard/dashboard.spec.ts`:

```ts
import { resolveDays, lastNDays } from "./dashboard.module";

describe("dashboard helpers", () => {
  it("resolves the days param safely", () => {
    expect(resolveDays(undefined)).toBe(7);
    expect(resolveDays("7")).toBe(7);
    expect(resolveDays("30")).toBe(30);
    expect(resolveDays("999")).toBe(7);
    expect(resolveDays("abc")).toBe(7);
  });

  it("pads lastNDays to n entries ending today (UTC)", () => {
    const days = lastNDays(30);
    expect(days).toHaveLength(30);
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    expect(days[29]).toBe(today.toISOString().slice(0, 10));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/dashboard/dashboard.spec.ts` → FAIL (`resolveDays` not exported).

- [ ] **Step 3: Implement**

In `dashboard.module.ts`: export `lastNDays` (add `export` keyword) and add:

```ts
/** Only 7 and 30 are supported; anything else falls back to 7. */
export function resolveDays(q?: string): 7 | 30 {
  return q === "30" ? 30 : 7;
}
```

In `summary()`: signature becomes

```ts
  async summary(@CurrentWorkspace() workspaceId: string, @Query("days") daysQ?: string) {
    const n = resolveDays(daysQ);
    const sinceN = startOfDayUtc(n - 1);
```

(import `Query` from `@nestjs/common`). Use `sinceN` ONLY in the message-timeseries raw query (`AND m."createdAt" >= ${sinceN}`). Keep `since7 = startOfDayUtc(6)` and `since14 = startOfDayUtc(13)` unchanged for `convThis7`/`convPrev7` — the week-over-week delta stays a fixed 7-day comparison regardless of the chart window. Daily padding becomes `lastNDays(n)`. Add to the `Promise.all`:

```ts
      this.prisma.conversation.groupBy({
        by: ["channel"],
        where: { workspaceId },
        _count: { _all: true },
      }),
```

destructured as `channelsRaw`, and add to the return:

```ts
      windowDays: n,
      channels: channelsRaw.map((c) => ({ channel: c.channel, count: c._count._all })),
```

- [ ] **Step 4: Run tests + build**

`npx jest src/dashboard/dashboard.spec.ts` → PASS. `npm run build` → clean.

- [ ] **Step 5: Commit**

```bash
git add backend/src/dashboard/dashboard.module.ts backend/src/dashboard/dashboard.spec.ts
git commit -m "feat(dashboard): 7/30-day summary window and per-channel conversation mix

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Analytics screen rebuilt on real data

**Files:**
- Rewrite: `src/screens/Analytics.tsx`
- Delete: `src/data/analytics.ts`, `src/data/analytics-extras.ts`

**Interfaces:**
- Consumes: `GET /dashboard/summary?days=` (Task 6 shape), `GET /tickets/dashboard/summary` → `{ openValue, currency, winRate, wonCount, lostCount, avgCloseHours, totalTickets }`, `GET /campaigns` → `Campaign[]`.
- Chart primitives (`src/components/charts.tsx`): `AreaChart({ a, b, w?, h? })`, `Donut({ items: {value, color, label?}[], size?, thickness? })`, `Spark({ values, w?, h? })`.

- [ ] **Step 1: Confirm the mock data files are only imported by Analytics**

Run Grep for `data/analytics` across `src/` — expected: only `src/screens/Analytics.tsx`. If another importer exists, fix it in this task.

- [ ] **Step 2: Rewrite the screen**

Replace `src/screens/Analytics.tsx` entirely:

```tsx
import { memo, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { PageHeader } from "@/components/PageHeader";
import { AreaChart, Donut } from "@/components/charts";
import { useFetch } from "@/api/useFetch";
import type { Campaign } from "@/lib/types";

interface DailyRow { day: string; total: number; human: number }
interface Summary {
  counts: { contacts: number; conversations: number; appointments: number; campaigns: number; templates: number; escalated: number; unread: number };
  daily: DailyRow[];
  deltas: { conversationsPct: number; conversationsThis7: number; conversationsPrev7: number };
  windowDays: 7 | 30;
  channels: { channel: string; count: number }[];
}
interface PipelineSummary {
  openValue: number; currency: string; winRate: number;
  wonCount: number; lostCount: number; avgCloseHours: number; totalTickets: number;
}

const CHANNEL_COLORS: Record<string, string> = {
  whatsapp: "var(--ok)",
  instagram: "#E1306C",
  facebook: "#1877F2",
  tiktok: "var(--ink-3)",
  webchat: "var(--accent)",
};

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat" style={{ padding: 14 }}>
      <div className="label">{label}</div>
      <div className="value" style={{ fontSize: 24 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{sub}</div>}
    </div>
  );
}

function AnalyticsImpl() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const [days, setDays] = useState<7 | 30>(7);

  const summaryQ = useFetch<Summary>(`/dashboard/summary?days=${days}`);
  const pipelineQ = useFetch<PipelineSummary>("/tickets/dashboard/summary");
  const campaignsQ = useFetch<Campaign[]>("/campaigns");

  const s = summaryQ.data;
  const p = pipelineQ.data;
  const campaigns = campaignsQ.data ?? [];

  const msgTotal = s ? s.daily.reduce((a, d) => a + d.total, 0) : 0;
  const totals = campaigns.reduce(
    (a, c) => ({ sent: a.sent + c.sent, read: a.read + c.read, replied: a.replied + c.replied }),
    { sent: 0, read: 0, replied: 0 },
  );

  return (
    <div style={{ overflowY: "auto", flex: 1 }}>
      <PageHeader
        title={tx("Analytics", "التحليلات")}
        subtitle={tx(
          "How your team performed across all channels",
          "أداء فريقك عبر جميع القنوات",
        )}
        actions={
          <div style={{ display: "flex", gap: 6 }}>
            {([7, 30] as const).map((d) => (
              <button
                key={d}
                className={`btn ${days === d ? "primary" : ""}`.trim()}
                onClick={() => setDays(d)}
              >
                {d === 7 ? tx("Last 7 days", "آخر ٧ أيام") : tx("Last 30 days", "آخر ٣٠ يوم")}
              </button>
            ))}
          </div>
        }
      />

      <div style={{ padding: "0 24px 24px", display: "grid", gap: 14 }}>
        {(summaryQ.error || pipelineQ.error) && (
          <div style={{ padding: 10, fontSize: 12, color: "var(--bad)", border: "1px solid var(--line-soft)", borderRadius: 8 }}>
            {summaryQ.error ?? pipelineQ.error}
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12 }}>
          <Stat label={tx("Contacts", "جهات الاتصال")} value={s ? s.counts.contacts.toLocaleString() : "…"} />
          <Stat
            label={tx("Conversations", "المحادثات")}
            value={s ? s.counts.conversations.toLocaleString() : "…"}
            sub={s ? `${s.deltas.conversationsPct >= 0 ? "+" : ""}${s.deltas.conversationsPct}% ${tx("vs last week", "مقارنة بالأسبوع الماضي")}` : undefined}
          />
          <Stat
            label={days === 7 ? tx("Messages (7d)", "الرسائل (٧ي)") : tx("Messages (30d)", "الرسائل (٣٠ي)")}
            value={s ? msgTotal.toLocaleString() : "…"}
          />
          <Stat label={tx("Unread", "غير المقروءة")} value={s ? s.counts.unread.toLocaleString() : "…"} />
        </div>

        <div className="card">
          <div className="card-h">
            <h3>{tx("Message volume", "حجم الرسائل")}</h3>
            <span className="sub">{tx("All messages vs. sent by team", "كل الرسائل مقابل رسائل الفريق")}</span>
          </div>
          <div style={{ padding: 18, overflowX: "auto" }}>
            {s && s.daily.length > 1 && (
              <AreaChart a={s.daily.map((d) => d.total)} b={s.daily.map((d) => d.human)} w={720} h={180} />
            )}
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <div className="card">
            <div className="card-h"><h3>{tx("Conversations by channel", "المحادثات حسب القناة")}</h3></div>
            <div style={{ padding: 18, display: "flex", gap: 20, alignItems: "center" }}>
              {s && s.channels.length > 0 ? (
                <>
                  <Donut
                    items={s.channels.map((c) => ({
                      value: c.count,
                      color: CHANNEL_COLORS[c.channel] ?? "var(--ink-3)",
                      label: c.channel,
                    }))}
                  />
                  <div style={{ display: "grid", gap: 6 }}>
                    {s.channels.map((c) => (
                      <div key={c.channel} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
                        <span style={{ width: 8, height: 8, borderRadius: "50%", background: CHANNEL_COLORS[c.channel] ?? "var(--ink-3)" }} />
                        <span style={{ textTransform: "capitalize" }}>{c.channel}</span>
                        <span className="mono" style={{ color: "var(--ink-3)" }}>{c.count.toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <span className="mono muted" style={{ fontSize: 12 }}>{tx("No conversations yet.", "لا توجد محادثات بعد.")}</span>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-h"><h3>{tx("Pipeline", "المسار")}</h3></div>
            <div style={{ padding: 18, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Stat label={tx("Open value", "القيمة المفتوحة")} value={p ? `${p.currency} ${p.openValue.toLocaleString()}` : "…"} />
              <Stat label={tx("Win rate", "معدل الفوز")} value={p ? `${p.winRate}%` : "…"} sub={p ? `${p.wonCount} ${tx("won", "فوز")} · ${p.lostCount} ${tx("lost", "خسارة")}` : undefined} />
              <Stat label={tx("Avg. close time", "متوسط الإغلاق")} value={p ? `${p.avgCloseHours}h` : "…"} />
              <Stat label={tx("Total deals", "إجمالي الصفقات")} value={p ? p.totalTickets.toLocaleString() : "…"} />
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-h">
            <h3>{tx("Campaigns", "الحملات")}</h3>
            <span className="sub">{tx("Lifetime totals across all campaigns", "إجماليات كل الحملات")}</span>
          </div>
          <div style={{ padding: 18, display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12 }}>
            <Stat label={tx("Sent", "المرسلة")} value={totals.sent.toLocaleString()} />
            <Stat label={tx("Read", "المقروءة")} value={totals.read.toLocaleString()} />
            <Stat label={tx("Replied", "الردود")} value={totals.replied.toLocaleString()} />
          </div>
        </div>
      </div>
    </div>
  );
}

export const Analytics = memo(AnalyticsImpl);
export default Analytics;
```

**Note:** check how the router imports this screen (`src/router.tsx`) — match the existing export style (named vs default) exactly; the old file's export form wins.

- [ ] **Step 3: Delete the mock data files**

Delete `src/data/analytics.ts` and `src/data/analytics-extras.ts`.

- [ ] **Step 4: Typecheck + verify**

`npm run typecheck` → clean (any remaining importer of the deleted files will surface here).
Verify skill: Analytics shows numbers matching Dashboard (contacts/conversations), the 7d/30d toggle changes the chart window, channel donut reflects real conversations, pipeline card matches the Pipeline screen, campaign totals are real (zeros are expected and fine).

- [ ] **Step 5: Commit**

```bash
git add src/screens/Analytics.tsx
git rm src/data/analytics.ts src/data/analytics-extras.ts
git commit -m "feat(analytics): rebuild on real data; remove fabricated metrics

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Campaign schema + DTO + frontend types

**Files:**
- Modify: `backend/prisma/schema.prisma` (Campaign model :371-392)
- Create: migration via prisma CLI
- Modify: `backend/src/campaigns/campaigns.module.ts` (CreateCampaignDto)
- Modify: `src/lib/types.ts` (Campaign interface :236-250)

**Interfaces:**
- Produces (used by Tasks 9-10): `Campaign` gains `segmentId?: string | null; templateId?: string | null`; loses `agent` on the frontend type. `POST /campaigns` accepts optional `segmentId`, `templateId`.

- [ ] **Step 1: Schema**

In the `Campaign` model, after `schedule String?` add:

```prisma
  // Honest-draft bindings: the real segment + WhatsApp template the draft
  // will use. Plain ids (no FK) — the send engine arrives in Tier 2.
  segmentId  String?
  templateId String?
```

- [ ] **Step 2: Migration**

Run (from `backend/`): `npx prisma migrate dev --name campaign_segment_template`
Then open the generated `backend/prisma/migrations/*_campaign_segment_template/migration.sql` and confirm it contains ONLY the two `ALTER TABLE "Campaign" ADD COLUMN` lines. If it contains anything else, STOP — the schema had unrelated drift; investigate before applying.

- [ ] **Step 3: DTO**

In `CreateCampaignDto` add:

```ts
  @IsOptional() @IsString() segmentId?: string;
  @IsOptional() @IsString() templateId?: string;
```

- [ ] **Step 4: Frontend type**

In `src/lib/types.ts` `Campaign`: remove `agent: string;`, add `segmentId: string | null; templateId: string | null;`. Run `npm run typecheck` — expect errors in `src/screens/Campaigns.tsx` referencing `agent` (fixed in Task 9; if the typecheck reports ONLY Campaigns.tsx sites, proceed — Tasks 8+9 land as consecutive commits; run the final check in Task 9).

- [ ] **Step 5: Backend build + commit**

`cd backend && npm run build` → clean.

```bash
git add backend/prisma/schema.prisma backend/prisma/migrations backend/src/campaigns/campaigns.module.ts src/lib/types.ts
git commit -m "feat(campaigns): segmentId/templateId bindings; drop agent from the client type

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Honest campaign builder

**Files:**
- Modify: `src/screens/Campaigns.tsx` (builder components :116-774)

**Interfaces:**
- Consumes: `GET /segments` → `Segment[]` (`{ id, name, nameAr, color, filter, count, … }` — counts included), `GET /templates` → `Template[]` (`{ id, name, lang, category, status, body, buttons, … }`), `GET /dashboard/summary` (`counts.contacts`), `POST /campaigns` (Task 8 DTO).
- Produces: builder emits `CreateCampaignBody = { name, audience, channel: "Broadcast", status: "draft", recipients, schedule, segmentId?, templateId? }` — **no `agent` field**.

- [ ] **Step 1: Builder state + data**

In `CampaignBuilder`, fetch data and hold real state (replace the `body` state):

```ts
  const segmentsQ = useFetch<Segment[]>("/segments");
  const templatesQ = useFetch<Template[]>("/templates");
  const summaryQ = useFetch<{ counts: { contacts: number } }>("/dashboard/summary");

  const [name, setName] = useState("");
  const [segmentId, setSegmentId] = useState<string | null>(null); // null = all contacts
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [scheduleChoice, setScheduleChoice] = useState<"now" | "later" | "drip" | "trigger">("later");

  const segments = segmentsQ.data ?? [];
  const templates = (templatesQ.data ?? []).filter((t) => !!t.body);
  const selectedSegment = segments.find((s) => s.id === segmentId) ?? null;
  const audienceCount = selectedSegment ? selectedSegment.count : summaryQ.data?.counts.contacts ?? 0;
  const audienceLabel = selectedSegment ? selectedSegment.name : tx("All contacts", "كل جهات الاتصال");
  const selectedTemplate = templates.find((t) => t.id === templateId) ?? null;
```

(imports: `Segment`, `Template` from `@/lib/types`; `useFetch` already imported at top of file.)

- [ ] **Step 2: AudienceStep — real segment picker**

Replace `AudienceStep` and delete `FilterRow` entirely:

```tsx
interface AudienceStepProps {
  tx: Tx;
  segments: Segment[];
  segmentId: string | null;
  onSelect: (id: string | null) => void;
  count: number;
}

function AudienceStep({ tx, segments, segmentId, onSelect, count }: AudienceStepProps) {
  const options: { id: string | null; label: string; count: number }[] = [
    { id: null, label: tx("All contacts", "كل جهات الاتصال"), count: -1 },
    ...segments.map((s) => ({ id: s.id, label: s.name, count: s.count })),
  ];
  return (
    <div className="card">
      <div className="card-h">
        <h3>{tx("Audience", "الجمهور")}</h3>
        <span className="sub mono">
          {count.toLocaleString()} {tx("contacts match", "جهة اتصال")}
        </span>
      </div>
      <div style={{ padding: 18, display: "grid", gap: 8 }}>
        {options.map((opt) => {
          const active = segmentId === opt.id;
          return (
            <label
              key={opt.id ?? "__all"}
              style={{
                display: "flex", gap: 12, padding: 12, alignItems: "center", cursor: "pointer",
                background: active ? "var(--accent-soft)" : "var(--bg-1)",
                border: `1px solid ${active ? "var(--accent-ring)" : "var(--line-soft)"}`,
                borderRadius: 10,
              }}
            >
              <input
                type="radio"
                name="audience"
                checked={active}
                onChange={() => onSelect(opt.id)}
                style={{ accentColor: "var(--accent)" }}
              />
              <span style={{ flex: 1, fontWeight: 500, fontSize: 13 }}>{opt.label}</span>
              {opt.count >= 0 && (
                <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
                  {opt.count.toLocaleString()}
                </span>
              )}
            </label>
          );
        })}
        {segments.length === 0 && (
          <div className="mono muted" style={{ fontSize: 11 }}>
            {tx("No segments yet — create them in Contacts.", "لا توجد شرائح بعد — أنشئها من جهات الاتصال.")}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: MessageStep — real template picker**

Replace `MessageStep` (delete the EN/AR toggle buttons, editable textarea, fake variable chips, and the whole "Quick reply buttons" card):

```tsx
interface MessageStepProps {
  tx: Tx;
  templates: Template[];
  templateId: string | null;
  onSelect: (id: string | null) => void;
}

function MessageStep({ tx, templates, templateId, onSelect }: MessageStepProps) {
  const selected = templates.find((t) => t.id === templateId) ?? null;
  const vars = selected?.body?.match(/\{\{[^}]+\}\}/g) ?? [];
  return (
    <div className="card">
      <div className="card-h">
        <div>
          <h3>{tx("Message", "الرسالة")}</h3>
          <div className="sub">{tx("WhatsApp template", "قالب واتساب")}</div>
        </div>
      </div>
      <div style={{ padding: 18, display: "grid", gap: 14 }}>
        <Field label={tx("Template", "القالب")}>
          <select
            style={INPUT_STYLE}
            value={templateId ?? ""}
            onChange={(e) => onSelect(e.target.value || null)}
          >
            <option value="">{tx("Select a template…", "اختر قالبًا…")}</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} · {t.status} · {t.lang.toUpperCase()}
              </option>
            ))}
          </select>
        </Field>
        {selected?.body && (
          <div
            style={{
              padding: 12, borderRadius: 10, background: "var(--bg-2)",
              border: "1px solid var(--line-soft)", fontSize: 13, lineHeight: 1.5,
              whiteSpace: "pre-wrap",
            }}
          >
            {selected.body}
          </div>
        )}
        {selected && selected.status !== "approved" && (
          <div style={{ fontSize: 12, color: "var(--warn, #b58a00)" }}>
            {tx(
              "This template isn't approved by Meta yet — the campaign can be drafted but not sent.",
              "هذا القالب غير معتمد من ميتا بعد — يمكن حفظ الحملة كمسودة فقط.",
            )}
          </div>
        )}
        {vars.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {vars.map((v) => (
              <span key={v} className="mono" style={{ fontSize: 11, padding: "3px 8px", background: "var(--bg-2)", border: "1px solid var(--line-soft)", borderRadius: 6 }}>
                {v}
              </span>
            ))}
          </div>
        )}
        {templates.length === 0 && (
          <div className="mono muted" style={{ fontSize: 11 }}>
            {tx("No templates with a body yet — create one in Templates.", "لا توجد قوالب بعد — أنشئ واحدًا من القوالب.")}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: ScheduleStep — real selection, no fake constraints**

Replace `ScheduleStep`: same card/radio layout, but options come from props and selection is real state. Remove the "Quiet hours" and "Rate limit" `Field` rows and the `hr`.

```tsx
interface ScheduleStepProps {
  tx: Tx;
  choice: "now" | "later" | "drip" | "trigger";
  onChoose: (c: "now" | "later" | "drip" | "trigger") => void;
}

function ScheduleStep({ tx, choice, onChoose }: ScheduleStepProps) {
  const options = [
    { id: "now" as const, label: tx("Send now", "إرسال الآن"), sub: tx("Begins as soon as sending ships", "يبدأ فور توفر الإرسال") },
    { id: "later" as const, label: tx("Schedule for later", "جدولة لاحقاً"), sub: tx("Pick a date when sending ships", "اختر التاريخ عند توفر الإرسال") },
    { id: "drip" as const, label: tx("Drip over time", "تنقيط عبر الوقت"), sub: tx("Staggered delivery", "تسليم موزّع") },
    { id: "trigger" as const, label: tx("Trigger-based", "مبني على مشغل"), sub: tx("Send when a contact joins the audience", "عند الانضمام للجمهور") },
  ];
  return (
    <div className="card">
      <div className="card-h"><h3>{tx("Schedule", "الموعد")}</h3></div>
      <div style={{ padding: 18, display: "grid", gap: 14 }}>
        {options.map((opt) => {
          const on = choice === opt.id;
          return (
            <label
              key={opt.id}
              onClick={() => onChoose(opt.id)}
              style={{
                display: "flex", gap: 12, padding: 14, alignItems: "center", cursor: "pointer",
                background: on ? "var(--accent-soft)" : "var(--bg-1)",
                border: `1px solid ${on ? "var(--accent-ring)" : "var(--line-soft)"}`,
                borderRadius: 10,
              }}
            >
              <span style={{ width: 16, height: 16, borderRadius: "50%", border: `2px solid ${on ? "var(--accent)" : "var(--line)"}`, display: "grid", placeItems: "center" }}>
                {on && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent)" }} />}
              </span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 500 }}>{opt.label}</div>
                <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 2 }}>{opt.sub}</div>
              </div>
            </label>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: ReviewStep — real values, no fake checks**

```tsx
interface ReviewStepProps {
  tx: Tx;
  audienceLabel: string;
  audienceCount: number;
  template: Template | null;
  scheduleLabel: string;
}

function ReviewStep({ tx, audienceLabel, audienceCount, template, scheduleLabel }: ReviewStepProps) {
  const rows: [string, string][] = [
    [tx("Audience", "الجمهور"), `${audienceLabel} · ${audienceCount.toLocaleString()} ${tx("contacts", "جهة")}`],
    [tx("Template", "القالب"), template ? `${template.name} · ${template.status}` : tx("None selected", "لم يُختر")],
    [tx("Schedule", "الموعد"), scheduleLabel],
    [tx("Channel", "القناة"), "WhatsApp"],
  ];
  return (
    <div className="card">
      <div className="card-h"><h3>{tx("Review", "مراجعة")}</h3></div>
      <div style={{ padding: 18, display: "grid", gap: 10 }}>
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
            <span style={{ color: "var(--ink-3)" }}>{k}</span>
            <span style={{ fontWeight: 500 }}>{v}</span>
          </div>
        ))}
        <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 4 }}>
          {tx(
            "Saved as a draft — sending arrives with the campaign engine.",
            "تُحفظ كمسودة — الإرسال يتوفر مع محرك الحملات.",
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: PhonePreview — template body, no cost card**

Change `PhonePreview` props to `{ body: string; buttons: string[]; tx: Tx }`. Render `buttons` (from the parsed template) instead of the hardcoded three chips, and delete the entire "Estimated cost" block (:561-599). In `CampaignBuilder`, derive:

```ts
  const previewBody = selectedTemplate?.body ?? tx("Select a template to preview it.", "اختر قالبًا للمعاينة.");
  let previewButtons: string[] = [];
  try {
    const parsed = selectedTemplate?.buttons ? JSON.parse(selectedTemplate.buttons) as { text?: string }[] : [];
    previewButtons = parsed.map((b) => b.text ?? "").filter(Boolean);
  } catch { previewButtons = []; }
```

- [ ] **Step 7: CampaignBuilder wiring**

Header: replace the hardcoded `<h1>` title with a borderless input bound to `name` (placeholder `tx("Campaign name", "اسم الحملة")`), delete the fake "Draft · auto-saved 12s ago" line, and delete the header "Save draft" + "Schedule" buttons. Default `step` state to `1`.

Step render block becomes:

```tsx
          {step === 1 && (
            <AudienceStep tx={tx} segments={segments} segmentId={segmentId} onSelect={setSegmentId} count={audienceCount} />
          )}
          {step === 2 && (
            <MessageStep tx={tx} templates={templates} templateId={templateId} onSelect={setTemplateId} />
          )}
          {step === 3 && <ScheduleStep tx={tx} choice={scheduleChoice} onChoose={setScheduleChoice} />}
          {step === 4 && (
            <ReviewStep tx={tx} audienceLabel={audienceLabel} audienceCount={audienceCount} template={selectedTemplate} scheduleLabel={scheduleLabel} />
          )}
```

with

```ts
  const scheduleLabel = {
    now: tx("Send now", "إرسال الآن"),
    later: tx("Scheduled", "مجدولة"),
    drip: tx("Drip", "تنقيط"),
    trigger: tx("Trigger-based", "مشغل"),
  }[scheduleChoice];
```

Footer CTA (step 4): label `tx("Save draft", "حفظ مسودة")`, disabled when `!name.trim() || !templateId || launching`, and:

```ts
                  void onLaunch({
                    name: name.trim(),
                    audience: audienceLabel,
                    channel: "Broadcast",
                    status: "draft",
                    recipients: audienceCount,
                    schedule: scheduleLabel,
                    segmentId: segmentId ?? undefined,
                    templateId: templateId ?? undefined,
                  });
```

Update `CreateCampaignBody` (:22-30): remove `agent: string;`, add `segmentId?: string; templateId?: string;`. `<PhonePreview body={previewBody} buttons={previewButtons} tx={tx} />`.

- [ ] **Step 8: Typecheck + verify**

`npm run typecheck` → clean (including the Task 8 leftovers).
Verify skill: New campaign → pick a segment (count matches the Contacts screen), pick a template (body + buttons preview), pick schedule, Review shows the real selections, Save draft → row appears in the list with correct audience/recipients/schedule; the DB row carries `segmentId`/`templateId` and no fake stats. Also confirm draft CTA disabled without name/template.

- [ ] **Step 9: Commit**

```bash
git add src/screens/Campaigns.tsx
git commit -m "feat(campaigns): builder creates honest drafts from real segments and templates

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Campaigns list — real KPI tiles, working search, no dead buttons

**Files:**
- Modify: `src/screens/Campaigns.tsx` (list view :861-960)

**Interfaces:**
- Consumes: `Campaign[]` from `GET /campaigns` (already fetched in `CampaignsImpl`).

- [ ] **Step 1: Real aggregates + search state**

In `CampaignsImpl` add:

```ts
  const [query, setQuery] = useState("");
  const totals = campaigns.reduce(
    (a, c) => ({
      sent: a.sent + c.sent,
      delivered: a.delivered + c.delivered,
      read: a.read + c.read,
      replied: a.replied + c.replied,
    }),
    { sent: 0, delivered: 0, read: 0, replied: 0 },
  );
  const rate = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 1000) / 10}%` : "—");
```

and extend the row filter:

```ts
  const filtered = (tab === "all" ? campaigns : campaigns.filter((c) => c.status === tab)).filter(
    (c) => c.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
```

- [ ] **Step 2: Replace the four MiniStat tiles** (:887-906)

```tsx
          <MiniStat label={tx("Sent", "المرسلة")} value={totals.sent.toLocaleString()} sub={tx("across all campaigns", "عبر كل الحملات")} />
          <MiniStat label={tx("Delivered rate", "معدل التسليم")} value={rate(totals.delivered, totals.sent)} sub={`${totals.delivered.toLocaleString()} ${tx("delivered", "مسلّمة")}`} />
          <MiniStat label={tx("Read rate", "معدل القراءة")} value={rate(totals.read, totals.delivered)} sub={`${totals.read.toLocaleString()} ${tx("read", "مقروءة")}`} />
          <MiniStat label={tx("Reply rate", "معدل الرد")} value={rate(totals.replied, totals.read)} sub={`${totals.replied.toLocaleString()} ${tx("replies", "رد")}`} />
```

- [ ] **Step 3: Wire the search input** (:948-951)

```tsx
          <input
            placeholder={tx("Search campaigns…", "ابحث في الحملات…")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ ...INPUT_STYLE, width: 220 }}
          />
```

- [ ] **Step 4: Remove the dead "Templates" header button** (:871-874) and its now-unused `IconTemplate` import if unreferenced.

- [ ] **Step 5: Typecheck + verify**

`npm run typecheck` → clean. Verify skill: tiles show zeros/`—` truthfully, search narrows rows live, no Templates button.

- [ ] **Step 6: Commit**

```bash
git add src/screens/Campaigns.tsx
git commit -m "fix(campaigns): KPI tiles from real rows; wire search; drop dead button

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Stale-AI copy and dead-code cleanup

**Files:**
- Modify: `src/screens/Calendar.tsx` (:1752-1755), `README.md` (:1), `backend/.env.example` (:44-55), `src/data/settings-extras.ts`, `src/screens/Contacts.tsx` (:814-817)
- Delete: `backend/scripts/smoke-enrichment.ts`

- [ ] **Step 1: Calendar subtitle** — replace:

```ts
        subtitle={tx(
          "Bookings, reschedules, and no-shows across your team.",
          "الحجوزات والتعديلات وعدم الحضور عبر فريقك.",
        )}
```

- [ ] **Step 2: README** — line 1 becomes:

```markdown
# tkana — WhatsApp & social engagement CRM for SMBs
```

- [ ] **Step 3: .env.example** — delete the two blocks at :44-55 (`# Listening / mentions` with `ANTHROPIC_API_KEY`, `GOOGLE_CSE_KEY`, `GOOGLE_CSE_CX`; and `# OpenAI (AI replies + KB embeddings)` with `OPENAI_API_KEY`, `OPENAI_REPLY_MODEL`, `OPENAI_EMBED_MODEL`, `AI_REPLY_CONFIDENCE_THRESHOLD`).

- [ ] **Step 4: Dead script** — `git rm backend/scripts/smoke-enrichment.ts` (imports the deleted `src/mentions` module; breaks TS compile of scripts).

- [ ] **Step 5: API_KEYS mock** — Grep `API_KEYS` and `ApiKey` across `src/`; expected importer count: zero outside `settings-extras.ts`. Remove the `ApiKey` interface and `API_KEYS` export from `src/data/settings-extras.ts`. (Leave the other exports — they may be consumed by Settings/Team.)

- [ ] **Step 6: Contacts Import button** — remove the dead button (:814-817) and the `IconBook` import if now unused.

- [ ] **Step 7: Typecheck + build**

`npm run typecheck` → clean. `cd backend && npm run build` → clean.

- [ ] **Step 8: Commit**

```bash
git add src/screens/Calendar.tsx README.md backend/.env.example src/data/settings-extras.ts src/screens/Contacts.tsx
git rm backend/scripts/smoke-enrichment.ts
git commit -m "chore: strip stale AI copy, dead mocks, and dead buttons

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: Full verification pass

**Files:** none new (fixups only if something fails).

- [ ] **Step 1: Full backend suite + build**

From `backend/`: `npm test` → all green. `npm run build` → clean.

- [ ] **Step 2: Frontend** — from root: `npm run typecheck && npm run build` → clean.

- [ ] **Step 3: End-to-end sweep with the verify skill**

1. Compose → schedule a post → visible in Scheduled strip → cancel it.
2. Compose → Post now → per-channel results render.
3. Social → reply to a comment → survives refresh; delete a comment → gone after refresh.
4. Analytics → numbers match Dashboard; 7/30 toggle works; no AI copy anywhere.
5. Campaigns → create a draft with segment + template → row + DB bindings correct; tiles/search honest.
6. Grep the repo for leftover lies: `AI handled`, `atlas`, `scheduled-posts` → zero hits in `src/` and `backend/src/`.

- [ ] **Step 4: Fixups** — commit any fixes as `fix: <what> found in Tier 0 verification` (with trailer), each with explicit pathspecs.

---

## Self-review notes (spec → plan coverage)

- Spec §1 scheduling → Tasks 1-3. Spec §2 comment writes + gating → Tasks 4-5 (gating resolved to removal — legacy paths are unreachable because feeds are Zernio-only; recorded in Task 5 preamble). Spec §3 analytics → Tasks 6-7. Spec §4 campaigns → Tasks 8-10. Spec §5 cleanup → Task 11 (+ Saved button in Task 5, Analytics dead buttons die with the rewrite in Task 7). Spec testing section → per-task tests + Task 12. Spec open items 1-2 → Task 1 Step 1 and Task 4 Step 1; open item 3 (DTO `agent` handling) → moot: frontend stops sending it (Task 9) and the DTO whitelist never accepted it.
