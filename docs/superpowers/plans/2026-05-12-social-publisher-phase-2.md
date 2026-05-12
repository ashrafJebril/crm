# Social Publisher — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Multi-channel publishing (Facebook **and** Instagram), per-channel preview tabs, and "schedule for later" with a worker that publishes scheduled posts at the right time.

**Architecture:**
- New `ScheduledPost` Prisma model owns the queue: `pending → publishing → published | failed`. Channels are stored as a JSON string (e.g. `["facebook","instagram"]`), media references as a JSON array of Media ids, and per-channel results in a JSON map.
- A `@Cron` worker scans `ScheduledPost` rows every minute and dispatches due posts to the platform services.
- Instagram Graph publishing is a two-step "container then publish" flow that needs the image at a **publicly fetchable URL**. We add a signed-token endpoint `GET /api/media/:id/public?token=…` that bypasses auth for a short TTL (15 min) so Meta's servers can pull it. In dev this means the backend has to be reachable on the public internet (ngrok) — documented in the plan.
- Frontend: `ComposeModal` upgrades to multi-channel chips (FB + IG, multi-select), a "Schedule" toggle with date/time inputs, "All / Facebook / Instagram" preview tabs, and a per-channel error/status display. A new `/scheduled` section in the Social page lists pending/published items so you can see and cancel queued work.

**Tech Stack:** NestJS 10 + Prisma 5 + SQLite, `@nestjs/schedule` (already installed, used by mentions module), native Node 18+ fetch/FormData/Blob for Graph calls, React 18 + Vite. Manual verification via curl + browser. Scheduling lives in-process (no Redis/BullMQ) — fine for SMB volumes.

**Scope explicitly excluded (later phases):**
- Reels, Stories, per-channel post-type selection (Phase 3)
- Follow-up comment, media optimization, IG collaborators, char limits (Phase 3)
- Approval workflow, recurring posts, queue/categories, draft list (Phase 4)
- Canva / Drive / AI image generation (Phase 5)
- Video upload, carousel posts, story-mention auto-share (Phase 3+)

---

## File Structure

**Backend — created:**
- `backend/src/scheduled-posts/scheduled-posts.module.ts`
- `backend/src/scheduled-posts/scheduled-posts.service.ts` — CRUD + the "publish one due post" routine that fans out to platform services
- `backend/src/scheduled-posts/scheduled-posts.controller.ts` — `/api/scheduled-posts/*`
- `backend/src/scheduled-posts/scheduled-posts.dto.ts`
- `backend/src/scheduled-posts/scheduled-posts.scheduler.ts` — `@Cron` tick every minute
- `backend/src/integrations/instagram.service.ts` — IG publishing + status
- `backend/src/integrations/instagram.controller.ts` — `/api/integrations/instagram/*`

**Backend — modified:**
- `backend/prisma/schema.prisma` — add `ScheduledPost` model; add `publicToken` + `publicTokenExpiresAt` to `Media`
- `backend/src/common/prisma-tenancy.ts` — add `"ScheduledPost"` to `SCOPED_MODELS`
- `backend/src/prisma/prisma.service.ts` — expose `scheduledPost` delegate
- `backend/src/app.module.ts` — register `ScheduledPostsModule`
- `backend/src/media/media.service.ts` — `mintPublicToken(id)`, `consumePublicToken(token)` helpers
- `backend/src/media/media.controller.ts` — `GET /api/media/:id/public?token=…` (no auth guard)
- `backend/src/auth/auth.guard.ts` (or wherever the global guard lives) — allow the public media route to bypass auth
- `backend/src/integrations/facebook.service.ts` — at end of `connect()`, attempt IG account discovery and upsert an `Integration { platform: "instagram" }` row
- `backend/src/integrations/integrations.module.ts` — register `InstagramService` + `InstagramController`

**Frontend — created:**
- `src/components/SchedulePicker.tsx` — date/time inputs + "Now / Later" toggle
- `src/screens/Scheduled.tsx` — list of scheduled posts (cancel, view)

**Frontend — modified:**
- `src/lib/types.ts` — add `ScheduledPost` type + extend channel union to include `"instagram"`
- `src/components/ComposeModal.tsx` — multi-select channels, preview tab switcher (All/FB/IG), IG preview card, embed `SchedulePicker`, call new `/social/publish` endpoint
- `src/screens/Social.tsx` — wire a "Scheduled" tab in the header
- `src/shell/nav.ts` + `src/router.tsx` — register `"scheduled"` route

---

## Task 1: Schema — `ScheduledPost` model + public-token fields on Media

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Modify: `backend/src/common/prisma-tenancy.ts`
- Modify: `backend/src/prisma/prisma.service.ts`

- [ ] **Step 1: Add `ScheduledPost` model**

Append at the bottom of `backend/prisma/schema.prisma`:

```prisma
// ─── Scheduled posts (publish queue) ──────────────────────────────────────

model ScheduledPost {
  id            String   @id @default(cuid())
  workspaceId   String
  workspace     Workspace @relation("WorkspaceScheduledPosts", fields: [workspaceId], references: [id], onDelete: Cascade)

  content       String    // post body / caption — applied to every channel
  mediaIds      String    @default("[]")  // JSON array of Media ids
  channels      String    // JSON array, e.g. ["facebook","instagram"]

  scheduledFor  DateTime  // when to publish. For "post now" we set this to NOW().
  status        String    @default("pending") // pending | publishing | published | failed | canceled
  attempts      Int       @default(0)
  lastError     String?
  // Per-channel results once published. JSON object keyed by channel:
  //   { "facebook": { ok: true, postId: "..." }, "instagram": { ok: false, error: "..." } }
  results       String    @default("{}")
  publishedAt   DateTime?

  createdById   String?
  createdBy     User?     @relation("UserScheduledPosts", fields: [createdById], references: [id], onDelete: SetNull)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([workspaceId, status, scheduledFor])
  @@index([workspaceId])
}
```

- [ ] **Step 2: Back-relations**

In the `Workspace` model's back-relations block (just before `createdAt`, after the existing `media` line), add:

```prisma
  scheduledPosts    ScheduledPost[]    @relation("WorkspaceScheduledPosts")
```

In the `User` model body, right after the `uploadedMedia Media[] @relation("UserMediaUploads")` line, add:

```prisma
  scheduledPosts ScheduledPost[] @relation("UserScheduledPosts")
```

- [ ] **Step 3: Add public-URL fields to `Media`**

In the `Media` model, add two fields right after `uploadedById`/`uploadedBy`:

```prisma
  publicToken          String?   @unique
  publicTokenExpiresAt DateTime?
```

- [ ] **Step 4: Push schema + regenerate client**

From `backend/`:
```powershell
npx prisma db push
```

Expected: "Your database is now in sync with your Prisma schema."

If `prisma generate` is blocked by a running backend dev server, stop the dev server (`Stop-Process` on the node PID holding `query_engine-windows.dll.node`), then re-run `npx prisma generate` followed by `npx prisma db push`.

- [ ] **Step 5: Register `ScheduledPost` in the Prisma tenancy extension**

Edit `backend/src/common/prisma-tenancy.ts`. Add `"ScheduledPost"` to the `SCOPED_MODELS` Set, after `"Media"`:

```ts
const SCOPED_MODELS = new Set([
  "Contact",
  "Conversation",
  "Message",
  "Appointment",
  "Template",
  "Campaign",
  "Pipeline",
  "TicketStage",
  "Ticket",
  "TicketActivity",
  "Integration",
  "Keyword",
  "Mention",
  "Note",
  "Media",
  "ScheduledPost",
]);
```

- [ ] **Step 6: Expose `scheduledPost` delegate on PrismaService**

Edit `backend/src/prisma/prisma.service.ts`. In the model-delegates block, add the `scheduledPost` getter after the existing `media` getter:

```ts
  get scheduledPost() { return this.client.scheduledPost; }
```

- [ ] **Step 7: Build backend**

From `backend/`:
```powershell
npm run build
```

Expected: exit 0.

- [ ] **Step 8: Commit**

```powershell
git add backend/prisma/schema.prisma backend/src/common/prisma-tenancy.ts backend/src/prisma/prisma.service.ts
git -c user.email=tkana@local -c user.name=tkana commit -m "feat(db): ScheduledPost model + public-token fields on Media"
```

---

## Task 2: Public signed media URL endpoint (so Meta can fetch images for IG publishing)

**Files:**
- Modify: `backend/src/media/media.service.ts`
- Modify: `backend/src/media/media.controller.ts`
- Modify: `backend/src/auth/auth.guard.ts` (whichever file holds the global JWT guard — verify by grepping for `APP_GUARD` first)

Instagram publishing requires `image_url` pointing at a server that Meta's worker can fetch over HTTPS. Our `/api/media/:id/file` endpoint sits behind a bearer-token guard, so Meta can't reach it. Solution: a single-use signed URL.

- [ ] **Step 1: Grep for the global auth guard**

```powershell
Select-String -Path backend/src/**/*.ts -Pattern "APP_GUARD" -SimpleMatch
```

Identify which file registers the global guard. Expected: `backend/src/auth/auth.module.ts` registers an `APP_GUARD` provider pointing at a guard class (e.g. `JwtAuthGuard`).

Read that guard class. It typically calls something like `context.switchToHttp().getRequest()` and verifies the bearer token. We need to add a way for it to skip the request when a route is marked public.

- [ ] **Step 2: Add a `@Public()` decorator**

Create `backend/src/common/public.decorator.ts`:

```ts
import { SetMetadata } from "@nestjs/common";

/** Mark a route public — bypasses the global JWT auth guard. */
export const IS_PUBLIC_KEY = "isPublic";
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
```

- [ ] **Step 3: Teach the global guard to honor `@Public()`**

Edit the global auth guard file from Step 1. In the constructor, inject `Reflector` from `@nestjs/core`. At the top of `canActivate(context)`, before any auth work, check:

```ts
import { Reflector } from "@nestjs/core";
import { IS_PUBLIC_KEY } from "../common/public.decorator";

// In constructor:
constructor(/* existing params */, private readonly reflector: Reflector) {}

// At the top of canActivate:
const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
  context.getHandler(),
  context.getClass(),
]);
if (isPublic) return true;
```

If `Reflector` is already injected, just add the `IS_PUBLIC_KEY` check.

- [ ] **Step 4: Add token mint + consume helpers to MediaService**

Edit `backend/src/media/media.service.ts`. Add two methods to the class:

```ts
import { randomBytes } from "node:crypto";

// ...

/** Mint a single-use public token for a media id, valid for `ttlMs`.
 *  Returns the token string. Overwrites any previous public token on
 *  that row, so old links become invalid. */
async mintPublicToken(workspaceId: string, mediaId: string, ttlMs = 15 * 60 * 1000): Promise<string> {
  const row = await this.get(workspaceId, mediaId);
  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlMs);
  await this.prisma.media.update({
    where: { id: row.id },
    data: { publicToken: token, publicTokenExpiresAt: expiresAt },
  });
  return token;
}

/** Look up a media row by its public token. Returns null if missing or
 *  expired. Does NOT delete the token — the caller decides reuse policy.
 *  IG publishing fetches the image a few times during the container poll,
 *  so single-use would cause failures; we just expire by time. */
async findByPublicToken(token: string) {
  if (!token) return null;
  const row = await this.prisma.media.findUnique({ where: { publicToken: token } });
  if (!row) return null;
  if (!row.publicTokenExpiresAt || row.publicTokenExpiresAt.getTime() < Date.now()) return null;
  return row;
}
```

Note: `prisma.media.findUnique({ where: { publicToken } })` is unscoped — that's intentional. The token IS the auth here; the tenancy extension would normally reject this call because there's no workspace context. To bypass the extension, use the raw `client` if necessary:

```ts
// If the extension blocks this call, use the unscoped client:
const row = await this.prisma.client.media.findUnique({ where: { publicToken: token } });
```

Confirm by trying with `this.prisma.media` first; if Prisma throws "workspace context required" or similar, switch to `this.prisma.client.media`.

- [ ] **Step 5: Add the public route in MediaController**

Edit `backend/src/media/media.controller.ts`. Add the import:

```ts
import { Public } from "../common/public.decorator";
import { Query, NotFoundException } from "@nestjs/common";
```

Add a new handler (place after `serve()`):

```ts
@Public()
@Get(":id/public")
async servePublic(
  @Param("id") id: string,
  @Query("token") token: string,
  @Res() res: Response,
) {
  const row = await this.svc.findByPublicToken(token);
  if (!row || row.id !== id) throw new NotFoundException("Bad or expired token");
  const absolute = path.resolve(UPLOAD_ROOT, row.storedPath);
  // Defense-in-depth: confirm path stays under the workspace's upload dir.
  const wsRoot = path.resolve(UPLOAD_ROOT, row.workspaceId);
  if (!absolute.startsWith(wsRoot + path.sep)) {
    throw new NotFoundException("Bad path");
  }
  res.setHeader("Content-Type", row.mimeType);
  res.setHeader("Cache-Control", "public, max-age=900"); // 15 min
  res.sendFile(absolute);
}
```

- [ ] **Step 6: Build**

From `backend/`:
```powershell
npm run build
```

Expected: exit 0.

- [ ] **Step 7: Smoke test**

Start the backend if not running. Then in PowerShell:

```powershell
$y = Invoke-RestMethod -Uri "http://localhost:3001/api/auth/login" -Method Post -ContentType "application/json" -Body '{"email":"yara@samemha.com","password":"demo1234"}'
$h = @{ Authorization = "Bearer $($y.token)" }

# Find any existing media id
$list = Invoke-RestMethod -Uri "http://localhost:3001/api/media" -Method Get -Headers $h
$first = $list[0]

# Verify the public endpoint rejects a bad token
try {
  curl.exe "http://localhost:3001/api/media/$($first.id)/public?token=garbage" -o $null -s -w "%{http_code}`n"
} catch {}
# Expected: 404
```

We don't have a route to mint tokens from the API yet (Task 4 uses it internally). For now, mint one by hand via `prisma studio` or a one-off node script if you want to verify rendering — otherwise rely on the negative test above.

- [ ] **Step 8: Commit**

```powershell
git add backend/src/common/public.decorator.ts backend/src/media/media.service.ts backend/src/media/media.controller.ts
# Plus whichever auth guard file you modified:
git add backend/src/auth/*.ts
git -c user.email=tkana@local -c user.name=tkana commit -m "feat(media): signed public URL endpoint (for IG/external fetchers)"
```

---

## Task 3: Backend — Instagram account discovery on FB connect

**Files:**
- Modify: `backend/src/integrations/facebook.service.ts`

When the user connects a Facebook Page, Meta links any associated Instagram Business account on that Page. We discover it and create an `Integration { platform: "instagram" }` row using the same Page Access Token (IG Business uses page tokens).

- [ ] **Step 1: Add an IG discovery method to FacebookService**

In `backend/src/integrations/facebook.service.ts`, add this private method to the class (place after `requireToken`):

```ts
/**
 * After a Page is connected, look up its linked Instagram Business
 * account. If one exists, create/update an Integration row with
 * platform="instagram" using the same Page Access Token.
 *
 * Returns the IG user id + username if discovered, else null.
 */
private async maybeDiscoverIg(
  workspaceId: string,
  pageId: string,
  pageToken: string,
  expiresAt: Date | null,
): Promise<{ igUserId: string; igUsername: string } | null> {
  let res: { instagram_business_account?: { id: string } } | null = null;
  try {
    res = await this.graphGet<{ instagram_business_account?: { id: string } }>(
      `/${pageId}?fields=instagram_business_account`,
      pageToken,
    );
  } catch (e) {
    this.log.warn(`IG discovery: graph call failed: ${(e as Error).message}`);
    return null;
  }
  const igId = res?.instagram_business_account?.id;
  if (!igId) return null;

  let igUsername = "Instagram";
  try {
    const me = await this.graphGet<{ id: string; username?: string; name?: string }>(
      `/${igId}?fields=id,username,name`,
      pageToken,
    );
    igUsername = me.username ?? me.name ?? "Instagram";
  } catch (e) {
    this.log.warn(`IG discovery: username fetch failed: ${(e as Error).message}`);
  }

  const existing = await this.prisma.integration.findFirst({
    where: { workspaceId, platform: "instagram" },
  });
  const data = {
    platform: "instagram",
    pageId: igId,
    pageName: igUsername,
    accessToken: pageToken,
    scopes: null,
    expiresAt,
    raw: JSON.stringify({ linkedFbPageId: pageId }),
  };
  if (existing) {
    await this.prisma.integration.update({ where: { id: existing.id }, data });
  } else {
    await this.prisma.integration.create({ data: { ...data, workspaceId } });
  }
  return { igUserId: igId, igUsername };
}
```

- [ ] **Step 2: Call it at the end of `connect()`**

In `backend/src/integrations/facebook.service.ts`, find the existing `connect()` method. Right before its `return` statement, add:

```ts
// Best-effort IG discovery — never fails the FB connect even if IG is missing.
const ig = await this.maybeDiscoverIg(workspaceId, pageId, finalToken, expiresAt);
```

Update the return object to surface IG status:

```ts
return {
  connected: true,
  pageId: row.pageId,
  pageName: row.pageName,
  expiresAt: row.expiresAt,
  candidates: candidates.length > 1 ? candidates.map((c) => ({ id: c.id, name: c.name })) : undefined,
  instagram: ig
    ? { connected: true, userId: ig.igUserId, username: ig.igUsername }
    : { connected: false },
};
```

- [ ] **Step 3: Also disconnect IG when FB disconnects**

In the same file, find `disconnect()`. Right before the final `return { ok: true }`, add:

```ts
// IG is derived from the FB Page Access Token, so disconnect it too.
const ig = await this.prisma.integration.findFirst({
  where: { workspaceId, platform: "instagram" },
});
if (ig) await this.prisma.integration.delete({ where: { id: ig.id } });
```

- [ ] **Step 4: Build**

From `backend/`:
```powershell
npm run build
```

Expected: exit 0.

- [ ] **Step 5: Smoke test**

Reconnect FB via the UI (Settings → Integrations → paste token → Connect). Then:

```powershell
$y = Invoke-RestMethod -Uri "http://localhost:3001/api/auth/login" -Method Post -ContentType "application/json" -Body '{"email":"yara@samemha.com","password":"demo1234"}'
$h = @{ Authorization = "Bearer $($y.token)" }

# Get the workspace id from the JWT or just inspect via prisma studio
# Easier: hit a debug endpoint
Invoke-RestMethod -Uri "http://localhost:3001/api/integrations/facebook/status" -Headers $h
```

The response should include nothing IG-related yet (that comes from Task 4). For now, verify via DB:

```powershell
cd backend
npx prisma studio
```

Open the Integration table — there should be 2 rows for the workspace: one `platform="facebook"`, one `platform="instagram"` (if the page actually has an IG Business account linked). If the page doesn't have an IG account, only the FB row exists — that's also a valid outcome.

- [ ] **Step 6: Commit**

```powershell
git add backend/src/integrations/facebook.service.ts
git -c user.email=tkana@local -c user.name=tkana commit -m "feat(integrations/facebook): auto-discover linked Instagram Business account"
```

---

## Task 4: Backend — Instagram publishing service

**Files:**
- Create: `backend/src/integrations/instagram.service.ts`
- Create: `backend/src/integrations/instagram.controller.ts`
- Create: `backend/src/integrations/instagram.dto.ts`
- Modify: `backend/src/integrations/integrations.module.ts`

Instagram Graph publishing requires:
1. POST `/{ig-user-id}/media?image_url=…&caption=…` → returns a *container* id (creation_id)
2. Poll the container until `status_code === FINISHED` (usually instant for static images)
3. POST `/{ig-user-id}/media_publish?creation_id=…` → returns the published media id

The image MUST be reachable from Meta's servers. We use the public-token endpoint built in Task 2.

- [ ] **Step 1: Create the DTO**

Create `backend/src/integrations/instagram.dto.ts`:

```ts
import { ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

export class PublishToIgDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2200) // IG caption max
  content!: string;

  // Phase 2 supports exactly 0 or 1 image. Text-only IG posts are not allowed
  // by the Graph API (IG requires media on every post), so 0 will return 400.
  @IsArray()
  @ArrayMaxSize(1)
  @IsString({ each: true })
  @IsOptional()
  mediaIds?: string[];
}
```

- [ ] **Step 2: Create the service**

Create `backend/src/integrations/instagram.service.ts`:

```ts
import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { MediaService } from "../media/media.service";

const GRAPH = "https://graph.facebook.com/v21.0";

@Injectable()
export class InstagramService {
  private readonly log = new Logger(InstagramService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
  ) {}

  async status(workspaceId: string) {
    const integ = await this.find(workspaceId);
    if (!integ) return { connected: false };
    return {
      connected: true,
      userId: integ.pageId,
      username: integ.pageName,
      expiresAt: integ.expiresAt,
      lastFetchedAt: integ.lastFetchedAt,
    };
  }

  async publish(
    workspaceId: string,
    dto: { content: string; mediaIds?: string[] },
    publicBaseUrl: string,
  ) {
    const { token, igUserId } = await this.requireToken(workspaceId);
    const firstMediaId = dto.mediaIds?.[0];
    if (!firstMediaId) {
      throw new BadRequestException(
        "Instagram requires an image; text-only posts are not supported by the Graph API.",
      );
    }
    // Mint a 15-min public URL for Meta to fetch the image.
    const pubToken = await this.media.mintPublicToken(workspaceId, firstMediaId);
    const imageUrl = `${publicBaseUrl.replace(/\/$/, "")}/api/media/${firstMediaId}/public?token=${pubToken}`;

    // Step 1: create container
    const containerUrl =
      `${GRAPH}/${igUserId}/media?` +
      new URLSearchParams({
        image_url: imageUrl,
        caption: dto.content,
        access_token: token,
      }).toString();
    const container = await this.fetchJson<{ id: string }>(containerUrl, { method: "POST" });

    // Step 2: poll container (IG processes the image asynchronously)
    await this.waitForContainerReady(container.id, token);

    // Step 3: publish
    const publishUrl =
      `${GRAPH}/${igUserId}/media_publish?` +
      new URLSearchParams({ creation_id: container.id, access_token: token }).toString();
    const published = await this.fetchJson<{ id: string }>(publishUrl, { method: "POST" });

    return { id: published.id, containerId: container.id };
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private async waitForContainerReady(containerId: string, token: string): Promise<void> {
    const maxAttempts = 15; // ~30 seconds (2s sleeps)
    for (let i = 0; i < maxAttempts; i++) {
      let st: { status_code?: string; status?: string } = {};
      try {
        st = await this.fetchJson<{ status_code?: string; status?: string }>(
          `${GRAPH}/${containerId}?fields=status_code,status&access_token=${encodeURIComponent(token)}`,
          { method: "GET" },
        );
      } catch (e) {
        this.log.warn(`Container poll ${containerId} threw: ${(e as Error).message}`);
      }
      if (st.status_code === "FINISHED") return;
      if (st.status_code === "ERROR" || st.status_code === "EXPIRED") {
        throw new HttpException(`Instagram container ${containerId} ${st.status_code}: ${st.status ?? ""}`, 400);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new HttpException(`Instagram container ${containerId} did not finish within timeout`, 504);
  }

  private async find(workspaceId: string) {
    return this.prisma.integration.findFirst({
      where: { workspaceId, platform: "instagram" },
    });
  }

  private async requireToken(workspaceId: string): Promise<{ token: string; igUserId: string }> {
    const integ = await this.find(workspaceId);
    if (!integ?.accessToken || !integ.pageId) {
      throw new NotFoundException("Instagram is not connected");
    }
    return { token: integ.accessToken, igUserId: integ.pageId };
  }

  private async fetchJson<T>(url: string, init: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (e) {
      this.log.error(`IG Graph network error: ${(e as Error).message}`);
      throw new HttpException("Instagram Graph unreachable", 502);
    }
    const text = await res.text();
    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    if (!res.ok) {
      const errMsg =
        typeof parsed === "object" && parsed !== null && "error" in parsed
          // @ts-expect-error - Graph shape
          ? (parsed.error?.message as string) ?? `IG error ${res.status}`
          : `IG error ${res.status}`;
      this.log.warn(`IG ${init.method} ${url} -> ${res.status} ${errMsg}`);
      throw new HttpException(errMsg, res.status >= 500 ? 502 : 400);
    }
    return parsed as T;
  }
}
```

- [ ] **Step 3: Create the controller**

Create `backend/src/integrations/instagram.controller.ts`:

```ts
import { Body, Controller, Get, Post } from "@nestjs/common";
import { InstagramService } from "./instagram.service";
import { PublishToIgDto } from "./instagram.dto";
import { CurrentWorkspace } from "../common/current-workspace.decorator";

@Controller("integrations/instagram")
export class InstagramController {
  constructor(private readonly svc: InstagramService) {}

  @Get("status")
  status(@CurrentWorkspace() workspaceId: string) {
    return this.svc.status(workspaceId);
  }

  @Post("posts")
  publish(
    @CurrentWorkspace() workspaceId: string,
    @Body() dto: PublishToIgDto,
  ) {
    const publicBase =
      process.env.PUBLIC_BASE_URL ??
      process.env.APP_BASE_URL ??
      "http://localhost:3001";
    return this.svc.publish(workspaceId, dto, publicBase);
  }
}
```

- [ ] **Step 4: Register in IntegrationsModule**

Edit `backend/src/integrations/integrations.module.ts`. Add imports:

```ts
import { InstagramService } from "./instagram.service";
import { InstagramController } from "./instagram.controller";
```

Add `InstagramController` to `controllers` and `InstagramService` to `providers` AND `exports` (Task 6 will inject it into ScheduledPostsService).

- [ ] **Step 5: Document the `PUBLIC_BASE_URL` env var**

Edit `backend/.env.example` (or create it if missing). Append:

```
# Public base URL that external services (Instagram Graph fetchers, etc.)
# can reach the backend at. For dev, run `ngrok http 3001` and paste the
# https URL here. Falls back to APP_BASE_URL, then localhost:3001.
PUBLIC_BASE_URL=
```

If `backend/.env.example` doesn't exist, create it with just those three lines plus the standard `DATABASE_URL` placeholder.

- [ ] **Step 6: Build**

From `backend/`:
```powershell
npm run build
```

Expected: exit 0.

- [ ] **Step 7: Smoke test (without ngrok — gating only)**

```powershell
$y = Invoke-RestMethod -Uri "http://localhost:3001/api/auth/login" -Method Post -ContentType "application/json" -Body '{"email":"yara@samemha.com","password":"demo1234"}'
$h = @{ Authorization = "Bearer $($y.token)" }

# Check status — should be connected if FB has an IG Business account linked,
# or { connected: false } otherwise.
Invoke-RestMethod -Uri "http://localhost:3001/api/integrations/instagram/status" -Headers $h

# Attempt text-only publish — should 400 with "Instagram requires an image"
$body = '{ "content": "no image" }'
try {
  Invoke-RestMethod -Uri "http://localhost:3001/api/integrations/instagram/posts" -Method Post -Headers $h -ContentType "application/json" -Body $body
} catch {
  $_.ErrorDetails.Message
}
```

Expected: status returns either `connected:false` or `connected:true` with `userId`/`username`; the text-only publish returns 400 with the documented message.

Actual live publish requires ngrok — not part of this smoke test.

- [ ] **Step 8: Commit**

```powershell
git add backend/src/integrations/instagram.service.ts backend/src/integrations/instagram.controller.ts backend/src/integrations/instagram.dto.ts backend/src/integrations/integrations.module.ts backend/.env.example
git -c user.email=tkana@local -c user.name=tkana commit -m "feat(integrations/instagram): publish service + status endpoint"
```

---

## Task 5: Backend — multi-channel `/social/publish` endpoint

**Files:**
- Create: `backend/src/social/social.module.ts`
- Create: `backend/src/social/social.service.ts`
- Create: `backend/src/social/social.controller.ts`
- Create: `backend/src/social/social.dto.ts`
- Modify: `backend/src/app.module.ts`

Single endpoint that the frontend calls. Accepts a list of channels and dispatches to each platform service in parallel. Returns per-channel results so the UI can show "FB ✓, IG ✗ (token expired)".

- [ ] **Step 1: Create the DTO**

Create `backend/src/social/social.dto.ts`:

```ts
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

const ALL_CHANNELS = ["facebook", "instagram"] as const;
export type PublishChannel = (typeof ALL_CHANNELS)[number];

export class PublishDto {
  @IsString()
  @MinLength(1)
  @MaxLength(63206)
  content!: string;

  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @IsOptional()
  mediaIds?: string[];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(ALL_CHANNELS.length)
  @IsIn(ALL_CHANNELS, { each: true })
  channels!: PublishChannel[];
}
```

- [ ] **Step 2: Create the service**

Create `backend/src/social/social.service.ts`:

```ts
import { Injectable, Logger } from "@nestjs/common";
import { FacebookService } from "../integrations/facebook.service";
import { InstagramService } from "../integrations/instagram.service";
import { PublishDto, PublishChannel } from "./social.dto";

export interface ChannelResult {
  ok: boolean;
  postId?: string;
  error?: string;
}

@Injectable()
export class SocialService {
  private readonly log = new Logger(SocialService.name);
  constructor(
    private readonly fb: FacebookService,
    private readonly ig: InstagramService,
  ) {}

  async publishNow(
    workspaceId: string,
    dto: PublishDto,
    publicBaseUrl: string,
  ): Promise<Record<PublishChannel, ChannelResult>> {
    // Fan out to each channel concurrently. Each channel's failure is
    // captured per-channel; we never short-circuit the others.
    const tasks = dto.channels.map(async (ch): Promise<[PublishChannel, ChannelResult]> => {
      try {
        if (ch === "facebook") {
          const r = await this.fb.publishToPage(workspaceId, {
            content: dto.content,
            mediaIds: dto.mediaIds,
          });
          return [ch, { ok: true, postId: r.id }];
        }
        if (ch === "instagram") {
          const r = await this.ig.publish(
            workspaceId,
            { content: dto.content, mediaIds: dto.mediaIds },
            publicBaseUrl,
          );
          return [ch, { ok: true, postId: r.id }];
        }
        return [ch, { ok: false, error: `Unknown channel: ${ch as string}` }];
      } catch (e) {
        const msg = (e as { message?: string }).message ?? String(e);
        this.log.warn(`publishNow ${ch} for ws=${workspaceId} failed: ${msg}`);
        return [ch, { ok: false, error: msg }];
      }
    });

    const settled = await Promise.all(tasks);
    return Object.fromEntries(settled) as Record<PublishChannel, ChannelResult>;
  }
}
```

- [ ] **Step 3: Create the controller**

Create `backend/src/social/social.controller.ts`:

```ts
import { Body, Controller, Post } from "@nestjs/common";
import { SocialService } from "./social.service";
import { PublishDto } from "./social.dto";
import { CurrentWorkspace } from "../common/current-workspace.decorator";

@Controller("social")
export class SocialController {
  constructor(private readonly svc: SocialService) {}

  @Post("publish")
  publish(
    @CurrentWorkspace() workspaceId: string,
    @Body() dto: PublishDto,
  ) {
    const publicBase =
      process.env.PUBLIC_BASE_URL ??
      process.env.APP_BASE_URL ??
      "http://localhost:3001";
    return this.svc.publishNow(workspaceId, dto, publicBase);
  }
}
```

- [ ] **Step 4: Create the module**

Create `backend/src/social/social.module.ts`:

```ts
import { Module } from "@nestjs/common";
import { IntegrationsModule } from "../integrations/integrations.module";
import { SocialController } from "./social.controller";
import { SocialService } from "./social.service";

@Module({
  imports: [IntegrationsModule],
  controllers: [SocialController],
  providers: [SocialService],
  exports: [SocialService],
})
export class SocialModule {}
```

This requires `IntegrationsModule` to `exports: [FacebookService, InstagramService]`. If it doesn't already export FacebookService, add it.

- [ ] **Step 5: Register in app.module.ts**

In `backend/src/app.module.ts`, add the import:

```ts
import { SocialModule } from "./social/social.module";
```

Add `SocialModule` to the `imports` array (after `MediaModule`).

- [ ] **Step 6: Build**

From `backend/`:
```powershell
npm run build
```

Expected: exit 0. If TS errors about `FacebookService` not being exported from `IntegrationsModule`, add it to the module's `exports: [...]` array.

- [ ] **Step 7: Smoke test**

```powershell
$y = Invoke-RestMethod -Uri "http://localhost:3001/api/auth/login" -Method Post -ContentType "application/json" -Body '{"email":"yara@samemha.com","password":"demo1234"}'
$h = @{ Authorization = "Bearer $($y.token)" }

# FB-only text post via the new unified endpoint
$body = '{ "content": "Multi-channel test - FB only", "channels": ["facebook"] }'
Invoke-RestMethod -Uri "http://localhost:3001/api/social/publish" -Method Post -Headers $h -ContentType "application/json" -Body $body
```

Expected: returns `{ facebook: { ok: true, postId: "..." } }` if FB token has `pages_manage_posts`, OR `{ facebook: { ok: false, error: "..." } }` if it doesn't. Either is a valid wiring outcome.

- [ ] **Step 8: Commit**

```powershell
git add backend/src/social backend/src/app.module.ts backend/src/integrations/integrations.module.ts
git -c user.email=tkana@local -c user.name=tkana commit -m "feat(social): unified multi-channel /social/publish endpoint"
```

---

## Task 6: Backend — Scheduled posts service + scheduler tick

**Files:**
- Create: `backend/src/scheduled-posts/scheduled-posts.module.ts`
- Create: `backend/src/scheduled-posts/scheduled-posts.service.ts`
- Create: `backend/src/scheduled-posts/scheduled-posts.controller.ts`
- Create: `backend/src/scheduled-posts/scheduled-posts.dto.ts`
- Create: `backend/src/scheduled-posts/scheduled-posts.scheduler.ts`
- Modify: `backend/src/app.module.ts`

The scheduler ticks every minute. For each `ScheduledPost` with `status="pending"` and `scheduledFor <= now`, it flips `status` to `publishing`, calls `SocialService.publishNow(...)`, then writes the results to `results` and flips `status` to `published` (or `failed` if every channel failed).

- [ ] **Step 1: Create the DTO**

Create `backend/src/scheduled-posts/scheduled-posts.dto.ts`:

```ts
import { ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsIn, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

const ALL_CHANNELS = ["facebook", "instagram"] as const;

export class CreateScheduledPostDto {
  @IsString()
  @MinLength(1)
  @MaxLength(63206)
  content!: string;

  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @IsOptional()
  mediaIds?: string[];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(ALL_CHANNELS.length)
  @IsIn(ALL_CHANNELS, { each: true })
  channels!: (typeof ALL_CHANNELS)[number][];

  /** ISO-8601 string. Use a past/now value for "post immediately via the queue". */
  @IsDateString()
  scheduledFor!: string;
}
```

- [ ] **Step 2: Create the service**

Create `backend/src/scheduled-posts/scheduled-posts.service.ts`:

```ts
import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { SocialService } from "../social/social.service";
import { CreateScheduledPostDto } from "./scheduled-posts.dto";

@Injectable()
export class ScheduledPostsService {
  private readonly log = new Logger(ScheduledPostsService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly social: SocialService,
  ) {}

  async create(workspaceId: string, userId: string | null, dto: CreateScheduledPostDto) {
    const scheduledFor = new Date(dto.scheduledFor);
    if (Number.isNaN(scheduledFor.getTime())) {
      throw new BadRequestException("Invalid scheduledFor");
    }
    return this.prisma.scheduledPost.create({
      data: {
        workspaceId,
        createdById: userId,
        content: dto.content,
        mediaIds: JSON.stringify(dto.mediaIds ?? []),
        channels: JSON.stringify(dto.channels),
        scheduledFor,
        status: "pending",
      },
    });
  }

  async list(workspaceId: string, status?: string) {
    return this.prisma.scheduledPost.findMany({
      where: { workspaceId, ...(status ? { status } : {}) },
      orderBy: { scheduledFor: "asc" },
      take: 200,
    });
  }

  async cancel(workspaceId: string, id: string) {
    const row = await this.prisma.scheduledPost.findFirst({
      where: { id, workspaceId },
    });
    if (!row) throw new NotFoundException("Scheduled post not found");
    if (row.status !== "pending") {
      throw new BadRequestException(`Cannot cancel a post in status "${row.status}"`);
    }
    return this.prisma.scheduledPost.update({
      where: { id: row.id },
      data: { status: "canceled" },
    });
  }

  /**
   * Run one tick: claim every pending post whose scheduledFor <= now,
   * mark it publishing, fan out via SocialService, write results.
   * Called by the scheduler cron AND exposed via an internal admin endpoint
   * for manual triggering during testing.
   */
  async runTick(publicBaseUrl: string): Promise<{ picked: number; published: number; failed: number }> {
    const due = await this.prisma.scheduledPost.findMany({
      where: {
        status: "pending",
        scheduledFor: { lte: new Date() },
      },
      take: 25, // batch cap per tick
    });
    let published = 0;
    let failed = 0;
    for (const post of due) {
      // Optimistic claim: only flip if still pending.
      const claimed = await this.prisma.scheduledPost.updateMany({
        where: { id: post.id, status: "pending" },
        data: { status: "publishing", attempts: { increment: 1 } },
      });
      if (claimed.count === 0) continue; // someone else got it

      const channels = JSON.parse(post.channels) as Array<"facebook" | "instagram">;
      const mediaIds = JSON.parse(post.mediaIds) as string[];
      const results = await this.social.publishNow(
        post.workspaceId,
        { content: post.content, mediaIds, channels },
        publicBaseUrl,
      );
      const anyOk = Object.values(results).some((r) => r.ok);
      await this.prisma.scheduledPost.update({
        where: { id: post.id },
        data: {
          status: anyOk ? "published" : "failed",
          results: JSON.stringify(results),
          publishedAt: anyOk ? new Date() : null,
          lastError: anyOk
            ? null
            : Object.entries(results)
                .filter(([, r]) => !r.ok)
                .map(([ch, r]) => `${ch}: ${r.error}`)
                .join("; "),
        },
      });
      if (anyOk) published += 1;
      else failed += 1;
    }
    if (due.length) {
      this.log.log(`Scheduled tick: picked=${due.length} published=${published} failed=${failed}`);
    }
    return { picked: due.length, published, failed };
  }
}
```

- [ ] **Step 3: Create the controller**

Create `backend/src/scheduled-posts/scheduled-posts.controller.ts`:

```ts
import { Body, Controller, Delete, Get, Param, Post, Query } from "@nestjs/common";
import { ScheduledPostsService } from "./scheduled-posts.service";
import { CreateScheduledPostDto } from "./scheduled-posts.dto";
import { CurrentWorkspace, CurrentUserId } from "../common/current-workspace.decorator";

@Controller("scheduled-posts")
export class ScheduledPostsController {
  constructor(private readonly svc: ScheduledPostsService) {}

  @Get()
  list(
    @CurrentWorkspace() workspaceId: string,
    @Query("status") status?: string,
  ) {
    return this.svc.list(workspaceId, status);
  }

  @Post()
  create(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUserId() userId: string,
    @Body() dto: CreateScheduledPostDto,
  ) {
    return this.svc.create(workspaceId, userId, dto);
  }

  @Delete(":id")
  cancel(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
  ) {
    return this.svc.cancel(workspaceId, id);
  }

  /** Manual trigger for the worker — useful during dev/testing. */
  @Post("_admin/run")
  runOnce() {
    const base =
      process.env.PUBLIC_BASE_URL ??
      process.env.APP_BASE_URL ??
      "http://localhost:3001";
    return this.svc.runTick(base);
  }
}
```

- [ ] **Step 4: Create the scheduler**

Create `backend/src/scheduled-posts/scheduled-posts.scheduler.ts`:

```ts
import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { ScheduledPostsService } from "./scheduled-posts.service";

@Injectable()
export class ScheduledPostsScheduler {
  private readonly log = new Logger(ScheduledPostsScheduler.name);
  constructor(private readonly svc: ScheduledPostsService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick() {
    const base =
      process.env.PUBLIC_BASE_URL ??
      process.env.APP_BASE_URL ??
      "http://localhost:3001";
    try {
      await this.svc.runTick(base);
    } catch (e) {
      this.log.error(`Scheduler tick failed: ${(e as Error).message}`);
    }
  }
}
```

- [ ] **Step 5: Create the module**

Create `backend/src/scheduled-posts/scheduled-posts.module.ts`:

```ts
import { Module } from "@nestjs/common";
import { SocialModule } from "../social/social.module";
import { ScheduledPostsController } from "./scheduled-posts.controller";
import { ScheduledPostsService } from "./scheduled-posts.service";
import { ScheduledPostsScheduler } from "./scheduled-posts.scheduler";

@Module({
  imports: [SocialModule],
  controllers: [ScheduledPostsController],
  providers: [ScheduledPostsService, ScheduledPostsScheduler],
  exports: [ScheduledPostsService],
})
export class ScheduledPostsModule {}
```

- [ ] **Step 6: Register in app.module.ts**

In `backend/src/app.module.ts`, add the import:

```ts
import { ScheduledPostsModule } from "./scheduled-posts/scheduled-posts.module";
```

Add `ScheduledPostsModule` to the `imports` array (after `SocialModule`). Also confirm `ScheduleModule.forRoot()` is already imported at the app level (it must be, because the mentions scheduler uses it). If it's not, add `ScheduleModule.forRoot()` to the imports.

- [ ] **Step 7: Build**

From `backend/`:
```powershell
npm run build
```

Expected: exit 0.

- [ ] **Step 8: Smoke test**

```powershell
$y = Invoke-RestMethod -Uri "http://localhost:3001/api/auth/login" -Method Post -ContentType "application/json" -Body '{"email":"yara@samemha.com","password":"demo1234"}'
$h = @{ Authorization = "Bearer $($y.token)" }

# Schedule a FB-only post for 2 seconds in the future
$when = (Get-Date).ToUniversalTime().AddSeconds(2).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
$body = "{ ""content"": ""Scheduled test"", ""channels"": [""facebook""], ""scheduledFor"": ""$when"" }"
$created = Invoke-RestMethod -Uri "http://localhost:3001/api/scheduled-posts" -Method Post -Headers $h -ContentType "application/json" -Body $body
$created

# Manually trigger the worker (don't wait a minute)
Invoke-RestMethod -Uri "http://localhost:3001/api/scheduled-posts/_admin/run" -Method Post -Headers $h

# List to see status
Invoke-RestMethod -Uri "http://localhost:3001/api/scheduled-posts" -Method Get -Headers $h
```

Expected: created post starts as `status="pending"`. After `_admin/run`, it should be `status="published"` (with FB postId in `results`) or `status="failed"` (with `lastError`). Either confirms the wiring; the actual FB token scope decides which.

- [ ] **Step 9: Commit**

```powershell
git add backend/src/scheduled-posts backend/src/app.module.ts
git -c user.email=tkana@local -c user.name=tkana commit -m "feat(scheduled-posts): queue + cron worker + admin trigger"
```

---

## Task 7: Frontend — types + ComposeModal upgrade (multi-channel + preview tabs)

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/components/ComposeModal.tsx`

This task focuses on the in-modal changes. Task 8 adds the schedule UI; Task 9 adds the scheduled-posts list view.

- [ ] **Step 1: Add `ScheduledPost` type + `PublishChannel`**

In `src/lib/types.ts`, after the existing `Media` interface, append:

```ts
// ─── Social publishing ────────────────────────────────────────────────────

export type PublishChannel = "facebook" | "instagram";

export interface ChannelResult {
  ok: boolean;
  postId?: string;
  error?: string;
}

export interface ScheduledPost {
  id: string;
  workspaceId: string;
  content: string;
  mediaIds: string;   // JSON string
  channels: string;   // JSON string
  scheduledFor: string;
  status: "pending" | "publishing" | "published" | "failed" | "canceled";
  attempts: number;
  lastError: string | null;
  results: string;    // JSON string
  publishedAt: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}
```

- [ ] **Step 2: Replace ComposeModal's channel chip with a multi-select + add IG status fetch**

Open `src/components/ComposeModal.tsx`. The current file has a single FB-focused channel chip and posts via `/integrations/facebook/posts`. Replace it with a multi-channel implementation.

First, update the imports at the top of the file:

```ts
import type { Media, PublishChannel, ChannelResult } from "@/lib/types";
```

Add a state hook for channel selection inside `ComposeModal`, right after the existing `useState` calls:

```ts
const [selectedChannels, setSelectedChannels] = useState<PublishChannel[]>(["facebook"]);
const [previewTab, setPreviewTab] = useState<"all" | PublishChannel>("all");
const [publishResults, setPublishResults] = useState<Record<string, ChannelResult> | null>(null);
```

Add IG status fetch alongside the existing FB status fetch:

```ts
interface IgStatus {
  connected: boolean;
  userId?: string;
  username?: string;
}
const igStatusQ = useFetch<IgStatus>(open ? "/integrations/instagram/status" : null);
```

- [ ] **Step 3: Replace the publish mutation**

In `ComposeModal.tsx`, replace the existing `publishMut` declaration:

```ts
const publishMut = useMutation<
  { content: string; mediaIds?: string[]; channels: PublishChannel[] },
  Record<string, ChannelResult>
>((input) => api.post("/social/publish", input));
```

Update the `onPost` handler:

```ts
const onPost = async () => {
  if (!canPost) return;
  const res = await publishMut.mutate({
    content: content.trim(),
    mediaIds: selectedMediaId ? [selectedMediaId] : undefined,
    channels: selectedChannels,
  });
  setPublishResults(res);
  // Auto-close only if every channel succeeded; otherwise keep the modal
  // open so the user can see which ones failed.
  const allOk = Object.values(res).every((r) => r.ok);
  onPosted?.();
  if (allOk) onClose();
};
```

Update `canPost` so it requires at least one connected, selected channel:

```ts
const fbReady = fbStatusQ.data?.connected === true && selectedChannels.includes("facebook");
const igReady = igStatusQ.data?.connected === true && selectedChannels.includes("instagram");
const igRequiresImage = selectedChannels.includes("instagram") && !selectedMediaId;
const canPost =
  content.trim().length > 0 &&
  selectedChannels.length > 0 &&
  (fbReady || igReady) &&
  !igRequiresImage &&
  !publishMut.loading;
```

- [ ] **Step 4: Replace `ChannelChips` to be multi-select**

In the same file, replace the `ChannelChips` component with:

```tsx
interface ChannelChipsProps {
  fbConnected: boolean;
  fbPageName: string | undefined;
  igConnected: boolean;
  igUsername: string | undefined;
  selected: PublishChannel[];
  onToggle: (ch: PublishChannel) => void;
  tx: (en: string, ar: string) => string;
}

function ChannelChips({
  fbConnected,
  fbPageName,
  igConnected,
  igUsername,
  selected,
  onToggle,
  tx,
}: ChannelChipsProps) {
  const renderChip = (
    ch: PublishChannel,
    label: string,
    connected: boolean,
    color: string,
  ) => {
    const isSelected = selected.includes(ch);
    const enabled = connected;
    return (
      <button
        type="button"
        disabled={!enabled}
        onClick={() => onToggle(ch)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 12px",
          borderRadius: 999,
          border: isSelected ? `1px solid ${color}` : "1px solid var(--line-soft)",
          background: isSelected ? color : "var(--bg-2)",
          color: isSelected ? "#fff" : enabled ? "var(--ink-1)" : "var(--ink-3)",
          fontSize: 12,
          fontWeight: 500,
          cursor: enabled ? "pointer" : "not-allowed",
          opacity: enabled ? 1 : 0.55,
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: isSelected ? "#fff" : enabled ? color : "var(--ink-3)",
          }}
        />
        {label}
        {!enabled && ` · ${tx("not connected", "غير متصل")}`}
      </button>
    );
  };

  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {renderChip(
        "facebook",
        `Facebook${fbConnected && fbPageName ? ` · ${fbPageName}` : ""}`,
        fbConnected,
        "#1877F2",
      )}
      {renderChip(
        "instagram",
        `Instagram${igConnected && igUsername ? ` · @${igUsername}` : ""}`,
        igConnected,
        "#E1306C",
      )}
    </div>
  );
}
```

And update the call site inside the modal body:

```tsx
<ChannelChips
  fbConnected={fbStatusQ.data?.connected === true}
  fbPageName={fbStatusQ.data?.pageName}
  igConnected={igStatusQ.data?.connected === true}
  igUsername={igStatusQ.data?.username}
  selected={selectedChannels}
  onToggle={(ch) => {
    setSelectedChannels((prev) =>
      prev.includes(ch) ? prev.filter((c) => c !== ch) : [...prev, ch],
    );
  }}
  tx={tx}
/>
```

- [ ] **Step 5: Add preview tabs above the preview card**

In `ComposeModal.tsx`, find the preview pane (the right column starting with `{/* Preview pane */}`). Replace the existing `FbPreviewCard` invocation with a small tab strip + tab-aware rendering:

```tsx
<div style={{ marginBottom: 10, display: "flex", gap: 6 }}>
  {(["all", "facebook", "instagram"] as const).map((t) => (
    <button
      key={t}
      type="button"
      onClick={() => setPreviewTab(t)}
      style={{
        padding: "4px 10px",
        borderRadius: 999,
        border: previewTab === t ? "1px solid var(--accent-ring)" : "1px solid var(--line-soft)",
        background: previewTab === t ? "var(--accent-soft)" : "var(--bg-2)",
        color: "var(--ink-1)",
        fontSize: 11,
        cursor: "pointer",
        textTransform: "capitalize",
      }}
    >
      {t === "all" ? tx("All", "الكل") : t}
    </button>
  ))}
</div>

{(previewTab === "all" || previewTab === "facebook") && selectedChannels.includes("facebook") && (
  <div style={{ marginBottom: 14 }}>
    <FbPreviewCard
      pageName={fbStatusQ.data?.pageName ?? activeWorkspace?.name ?? "Page"}
      content={content}
      media={selectedMedia}
    />
  </div>
)}

{(previewTab === "all" || previewTab === "instagram") && selectedChannels.includes("instagram") && (
  <IgPreviewCard
    username={igStatusQ.data?.username ?? activeWorkspace?.name ?? "instagram"}
    content={content}
    media={selectedMedia}
  />
)}

{!selectedChannels.length && (
  <div className="mono muted" style={{ fontSize: 11, padding: 12 }}>
    {tx("Select at least one channel.", "اختر قناة واحدة على الأقل.")}
  </div>
)}
```

- [ ] **Step 6: Add `IgPreviewCard` component**

In the same file, add this component near the existing `FbPreviewCard`:

```tsx
function IgPreviewCard({
  username,
  content,
  media,
}: {
  username: string;
  content: string;
  media: Media | null;
}) {
  return (
    <div
      style={{
        background: "var(--bg-elev)",
        border: "1px solid var(--line-soft)",
        borderRadius: 12,
        overflow: "hidden",
        maxWidth: 340,
      }}
    >
      <div style={{ padding: "10px 12px", display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            width: 28,
            height: 28,
            borderRadius: "50%",
            background:
              "linear-gradient(135deg, #f09433 0%, #e6683c 25%, #dc2743 50%, #cc2366 75%, #bc1888 100%)",
            display: "grid",
            placeItems: "center",
            color: "#fff",
            fontSize: 11,
            fontWeight: 700,
          }}
        >
          {username.slice(0, 1).toUpperCase()}
        </span>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{username}</span>
        <span style={{ marginInlineStart: "auto", color: "var(--ink-3)" }}>···</span>
      </div>
      {media ? (
        <PreviewThumb mediaId={media.id} />
      ) : (
        <div
          className="mono muted"
          style={{
            aspectRatio: "1 / 1",
            display: "grid",
            placeItems: "center",
            background: "var(--bg-2)",
            fontSize: 11,
          }}
        >
          (image required)
        </div>
      )}
      <div style={{ padding: "8px 12px", fontSize: 13, color: "var(--ink-1)" }}>
        <strong>{username}</strong>{" "}
        <span style={{ whiteSpace: "pre-wrap" }}>{content}</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Surface per-channel results in the modal footer**

In `ComposeModal.tsx`, just above the existing footer "not connected" warning, add a results banner that only appears after a publish attempt:

```tsx
{publishResults && (
  <div
    style={{
      padding: "10px 12px",
      borderRadius: 8,
      background: "var(--bg-2)",
      border: "1px solid var(--line-soft)",
      fontSize: 12,
      display: "flex",
      flexDirection: "column",
      gap: 4,
      marginBottom: 8,
    }}
  >
    {Object.entries(publishResults).map(([ch, r]) => (
      <div key={ch} style={{ color: r.ok ? "var(--ok)" : "var(--bad)" }}>
        {ch}: {r.ok ? `✓ ${r.postId}` : `✗ ${r.error}`}
      </div>
    ))}
  </div>
)}
```

- [ ] **Step 8: Typecheck**

```powershell
npm run typecheck
```

Expected: passes.

- [ ] **Step 9: Commit**

```powershell
git add src/lib/types.ts src/components/ComposeModal.tsx
git -c user.email=tkana@local -c user.name=tkana commit -m "feat(compose): multi-channel selection, IG preview, per-channel results"
```

---

## Task 8: Frontend — Schedule UI in ComposeModal

**Files:**
- Create: `src/components/SchedulePicker.tsx`
- Modify: `src/components/ComposeModal.tsx`

- [ ] **Step 1: Create `SchedulePicker`**

Create `src/components/SchedulePicker.tsx`:

```tsx
import { useEffect, useState } from "react";

interface SchedulePickerProps {
  /** When null, "Post now" mode. When a Date, "Schedule for later". */
  value: Date | null;
  onChange: (v: Date | null) => void;
  tx: (en: string, ar: string) => string;
}

function toInputDateTime(d: Date): string {
  // Format as YYYY-MM-DDTHH:MM in local time for <input type="datetime-local">.
  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

function defaultLater(): Date {
  // Default to 1 hour from now, rounded down to the minute.
  const d = new Date(Date.now() + 60 * 60 * 1000);
  d.setSeconds(0, 0);
  return d;
}

export function SchedulePicker({ value, onChange, tx }: SchedulePickerProps) {
  const mode = value === null ? "now" : "later";
  const [draft, setDraft] = useState<string>(() =>
    value ? toInputDateTime(value) : toInputDateTime(defaultLater()),
  );

  // Keep `draft` in sync if the parent resets `value` (e.g., after publishing).
  useEffect(() => {
    if (value) setDraft(toInputDateTime(value));
  }, [value]);

  const onSetMode = (next: "now" | "later") => {
    if (next === "now") {
      onChange(null);
    } else {
      const parsed = new Date(draft);
      if (!Number.isNaN(parsed.getTime())) onChange(parsed);
      else onChange(defaultLater());
    }
  };

  const onDraftChange = (s: string) => {
    setDraft(s);
    const parsed = new Date(s);
    if (!Number.isNaN(parsed.getTime())) onChange(parsed);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 6 }}>
        {(["now", "later"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onSetMode(m)}
            style={{
              padding: "5px 12px",
              borderRadius: 999,
              border: mode === m ? "1px solid var(--accent-ring)" : "1px solid var(--line-soft)",
              background: mode === m ? "var(--accent-soft)" : "var(--bg-2)",
              color: "var(--ink-1)",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            {m === "now" ? tx("Post now", "نشر الآن") : tx("Schedule", "جدولة")}
          </button>
        ))}
      </div>
      {mode === "later" && (
        <input
          type="datetime-local"
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          min={toInputDateTime(new Date())}
          style={{
            padding: "8px 10px",
            background: "var(--bg-2)",
            border: "1px solid var(--line)",
            borderRadius: 10,
            color: "var(--ink-1)",
            fontSize: 13,
            fontFamily: "inherit",
            outline: "none",
            width: 220,
          }}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Wire `SchedulePicker` into ComposeModal**

In `src/components/ComposeModal.tsx`, add imports:

```ts
import { SchedulePicker } from "./SchedulePicker";
```

Add state for the schedule:

```ts
const [scheduledFor, setScheduledFor] = useState<Date | null>(null);
```

Add a scheduling mutation alongside `publishMut`:

```ts
const scheduleMut = useMutation<
  {
    content: string;
    mediaIds?: string[];
    channels: PublishChannel[];
    scheduledFor: string;
  },
  { id: string; status: string; scheduledFor: string }
>((input) => api.post("/scheduled-posts", input));
```

Insert the `SchedulePicker` into the composer column, immediately under the Media picker block. The block goes just before the existing `{publishMut.error && (...)}` block:

```tsx
<div>
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
    {tx("Timing", "التوقيت")}
  </div>
  <SchedulePicker value={scheduledFor} onChange={setScheduledFor} tx={tx} />
</div>
```

- [ ] **Step 3: Branch `onPost` between immediate and scheduled**

Replace the `onPost` handler in `ComposeModal.tsx` with:

```ts
const onPost = async () => {
  if (!canPost) return;
  // Schedule path
  if (scheduledFor) {
    await scheduleMut.mutate({
      content: content.trim(),
      mediaIds: selectedMediaId ? [selectedMediaId] : undefined,
      channels: selectedChannels,
      scheduledFor: scheduledFor.toISOString(),
    });
    onPosted?.();
    onClose();
    return;
  }
  // Immediate path
  const res = await publishMut.mutate({
    content: content.trim(),
    mediaIds: selectedMediaId ? [selectedMediaId] : undefined,
    channels: selectedChannels,
  });
  setPublishResults(res);
  const allOk = Object.values(res).every((r) => r.ok);
  onPosted?.();
  if (allOk) onClose();
};
```

Also, update the loading-aware button label so the user sees "Scheduling…" when scheduling and "Posting…" when posting now. In the footer's submit button:

```tsx
<button
  type="button"
  className="btn primary"
  onClick={onPost}
  disabled={!canPost || scheduleMut.loading}
>
  <IconBolt w={13} />
  {scheduledFor
    ? scheduleMut.loading
      ? tx("Scheduling…", "جارٍ الجدولة…")
      : tx("Schedule post", "جدولة")
    : publishMut.loading
      ? tx("Posting…", "جارٍ النشر…")
      : tx("Post now", "نشر الآن")}
</button>
```

Update `canPost`:

```ts
const canPost =
  content.trim().length > 0 &&
  selectedChannels.length > 0 &&
  (fbReady || igReady) &&
  !igRequiresImage &&
  !publishMut.loading &&
  !scheduleMut.loading;
```

Reset `scheduledFor` when the modal closes (in the existing `useEffect` that resets state on `!open`):

```ts
useEffect(() => {
  if (!open) {
    setContent("");
    setSelectedMediaId(null);
    setPickerOpen(false);
    setSelectedChannels(["facebook"]);
    setPreviewTab("all");
    setPublishResults(null);
    setScheduledFor(null);
  }
}, [open]);
```

- [ ] **Step 4: Show scheduleMut error**

Replace the existing error block:

```tsx
{(publishMut.error || scheduleMut.error) && (
  <div
    style={{
      padding: "10px 12px",
      borderRadius: 8,
      background: "oklch(0.7 0.22 24 / 0.12)",
      color: "var(--bad)",
      fontSize: 12,
      border: "1px solid oklch(0.7 0.22 24 / 0.35)",
    }}
  >
    {publishMut.error ?? scheduleMut.error}
  </div>
)}
```

- [ ] **Step 5: Typecheck**

```powershell
npm run typecheck
```

Expected: passes.

- [ ] **Step 6: Commit**

```powershell
git add src/components/SchedulePicker.tsx src/components/ComposeModal.tsx
git -c user.email=tkana@local -c user.name=tkana commit -m "feat(compose): schedule for later (date/time picker + scheduled-posts API)"
```

---

## Task 9: Frontend — Scheduled posts list view

**Files:**
- Create: `src/screens/Scheduled.tsx`
- Modify: `src/lib/types.ts` (already has `ScheduledPost` from Task 7 — no change here)
- Modify: `src/shell/nav.ts`
- Modify: `src/router.tsx`

- [ ] **Step 1: Add `scheduled` to the RouteId union**

In `src/lib/types.ts`, find the `RouteId` union and add `"scheduled"` right after `"media"`:

```ts
  | "media"
  | "scheduled"
  | "pipeline"
```

- [ ] **Step 2: Add the nav entry**

In `src/shell/nav.ts`, add `IconCal` is already imported (verify). Insert a new entry in the Manage section, immediately after the `media` entry:

```ts
  { id: "scheduled",   label: "Scheduled",   ar: "المجدولة",     Icon: IconCal },
```

Add to `TITLES`:

```ts
  scheduled:   { en: "Scheduled posts",  ar: "المنشورات المجدولة" },
```

- [ ] **Step 3: Wire the route**

In `src/router.tsx`, add the lazy import after the `media` line:

```ts
  scheduled: lazy(() => import("@/screens/Scheduled")),
```

- [ ] **Step 4: Create the screen**

Create `src/screens/Scheduled.tsx`:

```tsx
import { memo, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { PageHeader } from "@/components/PageHeader";
import { useFetch, useMutation } from "@/api/useFetch";
import { api } from "@/api/client";
import { Badge } from "@/components/Badge";
import { IconX } from "@/icons";
import type { ScheduledPost, ChannelResult } from "@/lib/types";

type StatusFilter = "all" | "pending" | "published" | "failed" | "canceled";

function parseChannels(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function parseResults(raw: string): Record<string, ChannelResult> {
  try {
    return (JSON.parse(raw) ?? {}) as Record<string, ChannelResult>;
  } catch {
    return {};
  }
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function statusKind(s: ScheduledPost["status"]): "ok" | "bad" | "ai" | "" {
  if (s === "published") return "ok";
  if (s === "failed") return "bad";
  if (s === "publishing") return "ai";
  if (s === "pending") return "ai";
  return "";
}

function ScheduledImpl() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);

  const [filter, setFilter] = useState<StatusFilter>("all");
  const listQ = useFetch<ScheduledPost[]>(
    filter === "all" ? "/scheduled-posts" : `/scheduled-posts?status=${filter}`,
  );
  const cancelMut = useMutation<{ id: string }, ScheduledPost>((input) =>
    api.delete(`/scheduled-posts/${input.id}`),
  );

  const onCancel = async (post: ScheduledPost) => {
    if (
      !window.confirm(
        tx(
          "Cancel this scheduled post? It will not be published.",
          "إلغاء المنشور المجدول؟ لن يُنشر.",
        ),
      )
    )
      return;
    await cancelMut.mutate({ id: post.id });
    listQ.refetch();
  };

  const posts = listQ.data ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <PageHeader
        title={tx("Scheduled posts", "المنشورات المجدولة")}
        subtitle={tx(
          "Posts queued for later, plus the recent publish history.",
          "المنشورات المجدولة وسجل النشر الحديث.",
        )}
      />

      <div style={{ padding: "10px 24px", display: "flex", gap: 6 }}>
        {(["all", "pending", "published", "failed", "canceled"] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            style={{
              padding: "4px 12px",
              borderRadius: 999,
              border: filter === f ? "1px solid var(--accent-ring)" : "1px solid var(--line-soft)",
              background: filter === f ? "var(--accent-soft)" : "var(--bg-2)",
              color: "var(--ink-1)",
              fontSize: 12,
              cursor: "pointer",
              textTransform: "capitalize",
            }}
          >
            {f}
          </button>
        ))}
      </div>

      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "12px 24px",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        {listQ.loading && posts.length === 0 && (
          <div className="mono muted pulse" style={{ fontSize: 12, padding: 12 }}>
            {tx("loading…", "جارٍ التحميل…")}
          </div>
        )}
        {!listQ.loading && posts.length === 0 && (
          <div
            className="mono muted"
            style={{
              fontSize: 13,
              padding: "32px 16px",
              textAlign: "center",
              border: "1px dashed var(--line-soft)",
              borderRadius: 12,
            }}
          >
            {tx("Nothing scheduled.", "لا توجد منشورات مجدولة.")}
          </div>
        )}
        {posts.map((p) => {
          const channels = parseChannels(p.channels);
          const results = parseResults(p.results);
          return (
            <div
              key={p.id}
              style={{
                border: "1px solid var(--line-soft)",
                borderRadius: 12,
                padding: 14,
                background: "var(--bg-1)",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Badge kind={statusKind(p.status)} dot>
                  {p.status}
                </Badge>
                <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
                  {p.status === "published" && p.publishedAt
                    ? `${tx("Published", "نُشر")}: ${formatWhen(p.publishedAt)}`
                    : `${tx("Scheduled for", "موعد النشر")}: ${formatWhen(p.scheduledFor)}`}
                </span>
                <span style={{ marginInlineStart: "auto", display: "flex", gap: 6 }}>
                  {channels.map((ch) => (
                    <span
                      key={ch}
                      style={{
                        padding: "2px 8px",
                        borderRadius: 999,
                        background: ch === "facebook" ? "#1877F2" : "#E1306C",
                        color: "#fff",
                        fontSize: 10,
                        fontWeight: 500,
                      }}
                    >
                      {ch}
                    </span>
                  ))}
                </span>
              </div>
              <div
                style={{
                  fontSize: 13,
                  color: "var(--ink-1)",
                  whiteSpace: "pre-wrap",
                  lineHeight: 1.5,
                  display: "-webkit-box",
                  WebkitLineClamp: 4,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                }}
              >
                {p.content}
              </div>
              {Object.keys(results).length > 0 && (
                <div
                  style={{
                    fontSize: 11,
                    fontFamily: "var(--font-mono)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 2,
                    color: "var(--ink-3)",
                  }}
                >
                  {Object.entries(results).map(([ch, r]) => (
                    <span key={ch} style={{ color: r.ok ? "var(--ok)" : "var(--bad)" }}>
                      {ch}: {r.ok ? `✓ ${r.postId}` : `✗ ${r.error}`}
                    </span>
                  ))}
                </div>
              )}
              {p.lastError && p.status === "failed" && (
                <div style={{ color: "var(--bad)", fontSize: 11 }}>{p.lastError}</div>
              )}
              {p.status === "pending" && (
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => onCancel(p)}
                    disabled={cancelMut.loading}
                    style={{ color: "var(--bad)" }}
                  >
                    <IconX w={12} />
                    {tx("Cancel", "إلغاء")}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const Scheduled = memo(ScheduledImpl);
export default Scheduled;
```

- [ ] **Step 5: Typecheck**

```powershell
npm run typecheck
```

Expected: passes.

- [ ] **Step 6: End-to-end browser smoke**

Start backend + frontend. Log in. Navigate to **Social** → click **Compose**:

1. Confirm Facebook chip shows connected (with Page name). IG chip should show connected only if FB Page has linked IG Business — otherwise "not connected".
2. Toggle FB off, IG on. Type text but don't attach media — the Post button stays disabled (IG requires image).
3. Attach an image. Switch the preview tab between **All / Facebook / Instagram** — IG card should render.
4. Switch to **Schedule** mode, pick a time 2-3 minutes in the future. Hit **Schedule post**. Modal closes.
5. Navigate to **Scheduled** in the sidebar. The post appears with status `pending`, your channels, and the scheduled time.
6. Hit the Admin trigger (or wait up to a minute):
   ```powershell
   $y = Invoke-RestMethod -Uri "http://localhost:3001/api/auth/login" -Method Post -ContentType "application/json" -Body '{"email":"yara@samemha.com","password":"demo1234"}'
   $h = @{ Authorization = "Bearer $($y.token)" }
   Invoke-RestMethod -Uri "http://localhost:3001/api/scheduled-posts/_admin/run" -Method Post -Headers $h
   ```
7. Refresh the Scheduled screen. The post should be `published` (with FB postId in results) or `failed` (with error). Either confirms the wiring; the actual outcome depends on token scope and IG ngrok setup.

- [ ] **Step 7: Commit**

```powershell
git add src/lib/types.ts src/shell/nav.ts src/router.tsx src/screens/Scheduled.tsx
git -c user.email=tkana@local -c user.name=tkana commit -m "feat(scheduled): Scheduled posts screen + nav entry"
```

---

## Self-Review

**Spec coverage:**
- ✅ Multi-channel selection (FB + IG) — Task 7 multi-select chips
- ✅ Instagram publishing — Tasks 3, 4
- ✅ Preview tabs (All / FB / IG) — Task 7 step 5
- ✅ Schedule for later (date/time picker) — Task 8
- ✅ Scheduled posts list view — Task 9
- ✅ Cancel a queued post — Task 9 step 4
- ✅ Per-channel result display — Task 7 step 7
- ✅ Background worker that publishes due posts — Task 6

**Placeholder scan:** No "TBD", "fill in", or vague "add error handling" steps. All code blocks are concrete and complete.

**Type consistency:**
- `PublishChannel` type defined in `src/lib/types.ts` (Task 7) is consistent with backend's `PublishChannel` type in `social.dto.ts` (Task 5) — both are `"facebook" | "instagram"`.
- `ChannelResult` shape `{ ok, postId?, error? }` matches between backend (Task 5) and frontend (Task 7).
- `ScheduledPost.status` enum `"pending" | "publishing" | "published" | "failed" | "canceled"` is consistent between schema (Task 1), service (Task 6), and frontend (Task 7, 9).
- `mediaIds` is stored as a JSON-encoded string at the DB level (Task 1) and parsed at read time (Task 9 helper `parseChannels` / `parseResults`).

**Known fragilities (deliberate, not blocking Phase 2):**
- IG publishing requires Meta to fetch the image over the public internet. On localhost without ngrok, IG publish will 502 ("Failed to fetch image_url"). The error is clear and surfaces in `ChannelResult.error`. Documented in Task 4's `.env.example`.
- The scheduler is in-process and runs in every backend instance. On multi-instance prod deployments, two instances will race for the same row — the `updateMany({ where: { status: "pending" }})` claim handles this safely (only one wins), but the scheduler will be needlessly active on every instance. Phase 4+ can move scheduling to a single worker process or use a DB-level row lock.
- The `attempts` field is incremented but never used to retry failed posts. Phase 4 can add a `retryUntil` deadline and re-enqueue with exponential backoff.
- IG container poll has a 30-second timeout. Image containers typically finish in <5s; if Meta gets slow this will spuriously fail. Phase 3 can extend or move to webhook-based status notifications.
- Multi-image IG carousels are not supported (DTO caps `mediaIds` at 1). Phase 3 work.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-12-social-publisher-phase-2.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task with two-stage review. Same pattern that landed Phase 1 cleanly. Best for 9 tasks where each ships an isolated capability.

**2. Inline Execution** — I execute all 9 tasks in this session with checkpoints. Faster turnaround per task but my context fills across the phase.

Which approach?
