# Social Publisher — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a workspace-scoped Media Storage module + a Compose modal that publishes a real post (text + optional image) to a connected Facebook Page from inside tkana.

**Architecture:**
- New `Media` Prisma model — per-workspace file metadata. Binary stored on local disk under `backend/uploads/<workspaceId>/`. Streamed via a `GET /api/media/:id/file` endpoint. Local disk now; S3-compatible later.
- New `MediaModule` (service + controller) using `@nestjs/platform-express`'s built-in Multer integration for multipart uploads.
- `FacebookService.publishToPage()` extends the existing FB integration: text via `POST /{page-id}/feed`, text+image via `POST /{page-id}/photos` with a multipart `source` upload using native Node 18+ `FormData` + `Blob`.
- Frontend: a dedicated `Media` screen (browse / upload / delete), a `ComposeModal` component opened by the existing `Compose` button on the Social page (text editor + channel chip + media picker + live FB preview + Post Now).
- Phase 1 only ships Facebook Feed publishing. Instagram, scheduling, reels/stories, approval, queue come in Phases 2-5.

**Tech Stack:** NestJS 10 + Prisma 5 + SQLite, `@nestjs/platform-express` Multer integration (already installed), Node 18+ native `FormData`/`Blob` for the FB multipart upload, React 18 + Vite. Verification is manual via curl + browser dev server — the codebase has no test framework and we don't add one in this plan.

**Scope explicitly excluded (later phases):**
- Instagram, TikTok, WhatsApp publishing
- Scheduling, recurring posts, queue, approval workflow
- Reels / Story post types, per-channel customization
- Media optimization (auto-resize per platform), media folders, search, stock images
- Canva / Google Drive / AI image generation integrations
- Video upload, follow-up comments, IG collaborators, rich-text formatting (B/I/etc.)

Phase 1 ships **the minimum that lets someone publish a text-or-image post to their FB Page from inside tkana.**

---

## File Structure

**Backend — created:**
- `backend/src/media/media.module.ts` — module wiring
- `backend/src/media/media.service.ts` — list/get/upload-finalize/delete; resolves disk paths for the publisher
- `backend/src/media/media.controller.ts` — `/api/media/*` REST + multipart upload + file streaming
- `backend/src/media/media.dto.ts`

**Backend — modified:**
- `backend/prisma/schema.prisma` — add `Media` model; back-relation on Workspace
- `backend/src/common/prisma-tenancy.ts` — add `"Media"` to `SCOPED_MODELS`
- `backend/src/prisma/prisma.service.ts` — expose `media` delegate
- `backend/src/app.module.ts` — register `MediaModule`
- `backend/src/integrations/facebook.service.ts` — add `publishToPage(workspaceId, dto)` method
- `backend/src/integrations/facebook.controller.ts` — add `POST /integrations/facebook/posts` endpoint
- `backend/src/integrations/facebook.dto.ts` — add `PublishToPageDto`
- `backend/.gitignore` — ignore `uploads/`

**Frontend — created:**
- `src/screens/Media.tsx` — Media Storage screen (grid + upload + delete)
- `src/components/ComposeModal.tsx` — modal with text editor, channel chip, media picker, live preview, Post Now

**Frontend — modified:**
- `src/lib/types.ts` — add `Media` type + `"media"` to `RouteId` union
- `src/shell/nav.ts` — add `media` nav entry in Manage section
- `src/router.tsx` — wire `media` route
- `src/screens/Social.tsx` — replace the placeholder Compose button with one that opens `ComposeModal`

---

## Task 1: Schema — add `Media` model

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Modify: `backend/src/common/prisma-tenancy.ts`
- Modify: `backend/src/prisma/prisma.service.ts`

- [ ] **Step 1: Append the `Media` model**

Append at the bottom of `backend/prisma/schema.prisma`:

```prisma
// ─── Media library ────────────────────────────────────────────────────────

model Media {
  id            String   @id @default(cuid())
  workspaceId   String
  workspace     Workspace @relation("WorkspaceMedia", fields: [workspaceId], references: [id], onDelete: Cascade)
  fileName      String   // original filename, kept for display
  mimeType      String   // "image/jpeg" | "image/png" | "image/gif" | "image/webp" | ...
  sizeBytes     Int
  storedPath    String   // path on disk, relative to backend/uploads
  width         Int?     // for images
  height        Int?     // for images
  uploadedById  String?  // FK to User.id; nullable for system-generated assets
  uploadedBy    User?    @relation("UserMediaUploads", fields: [uploadedById], references: [id], onDelete: SetNull)

  createdAt DateTime @default(now())

  @@index([workspaceId])
  @@index([uploadedById])
}
```

- [ ] **Step 2: Add back-relations**

In the `Workspace` model (in the back-relations block before `createdAt`), add the `media` line at the end of the relation list:

```prisma
  media             Media[]            @relation("WorkspaceMedia")
```

In the `User` model body (after the existing `memberships WorkspaceMember[]` line), add:

```prisma
  uploadedMedia WorkspaceMember[] // placeholder — DO NOT use this line
```

Actually that's wrong — use this instead. Add to the User model body, right after `memberships WorkspaceMember[]`:

```prisma
  uploadedMedia Media[] @relation("UserMediaUploads")
```

- [ ] **Step 3: Push schema**

From `backend/`:
```powershell
npx prisma db push
```

Expected: "Your database is now in sync with your Prisma schema."

- [ ] **Step 4: Register `Media` in the Prisma tenancy extension**

Edit `backend/src/common/prisma-tenancy.ts`. Find the `SCOPED_MODELS` `Set` and add `"Media"`:

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
]);
```

- [ ] **Step 5: Expose `media` delegate on PrismaService**

Edit `backend/src/prisma/prisma.service.ts`. In the model-delegates block, add the `media` getter (after the `note` getter):

```ts
  get media() { return this.client.media; }
```

- [ ] **Step 6: Build backend**

From `backend/`:
```powershell
npm run build
```

Expected: exit 0.

- [ ] **Step 7: Commit**

From the repo root:
```powershell
git add backend/prisma/schema.prisma backend/src/common/prisma-tenancy.ts backend/src/prisma/prisma.service.ts
git -c user.email=tkana@local -c user.name=tkana commit -m "feat(db): add Media model with workspace scoping"
```

---

## Task 2: Configure uploads directory + gitignore

**Files:**
- Modify: `backend/.gitignore` (create section if needed)
- Create: `backend/uploads/.gitkeep`

- [ ] **Step 1: Add `uploads/` to `backend/.gitignore`**

Open `backend/.gitignore`. Append:

```
# Media uploads — workspace-scoped, served via /api/media/:id/file.
# Do not commit binary assets; the DB row is the source of truth.
uploads/
!uploads/.gitkeep
```

- [ ] **Step 2: Create the placeholder so the directory exists in git**

Create `backend/uploads/.gitkeep` as an empty file. (Touch it.)

```powershell
New-Item -ItemType File -Path "backend/uploads/.gitkeep" -Force
```

- [ ] **Step 3: Commit**

```powershell
git add backend/.gitignore backend/uploads/.gitkeep
git -c user.email=tkana@local -c user.name=tkana commit -m "chore(backend): create uploads/ dir; ignore contents"
```

---

## Task 3: Media module — service, controller, DTOs

**Files:**
- Create: `backend/src/media/media.dto.ts`
- Create: `backend/src/media/media.service.ts`
- Create: `backend/src/media/media.controller.ts`
- Create: `backend/src/media/media.module.ts`
- Modify: `backend/src/app.module.ts`

This is the largest task. We use `@nestjs/platform-express`'s `FileInterceptor` (Multer wrapper). Multer is bundled — no new dependency.

- [ ] **Step 1: Create the DTO**

Create `backend/src/media/media.dto.ts`:

```ts
// No body DTO for upload — multipart is parsed by Multer.
// Listing supports no filters in Phase 1; future tasks may add type / folder filters.
```

(Leave this file with only the comment for now; we'll add types here in Phase 3 when filtering arrives.)

- [ ] **Step 2: Create the service**

Create `backend/src/media/media.service.ts`:

```ts
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { PrismaService } from "../prisma/prisma.service";

const UPLOAD_ROOT = path.resolve(process.cwd(), "uploads");

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
const MAX_BYTES = 20 * 1024 * 1024; // 20 MB

@Injectable()
export class MediaService {
  constructor(private readonly prisma: PrismaService) {}

  list(workspaceId: string) {
    return this.prisma.media.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
  }

  async get(workspaceId: string, id: string) {
    const row = await this.prisma.media.findFirst({
      where: { id, workspaceId },
    });
    if (!row) throw new NotFoundException("Media not found");
    return row;
  }

  /** Resolve a Media row to its absolute disk path. Used by the streaming
   *  endpoint and by the publisher to attach the file to the FB upload. */
  async resolvePath(workspaceId: string, id: string): Promise<string> {
    const row = await this.get(workspaceId, id);
    const absolute = path.resolve(UPLOAD_ROOT, row.storedPath);
    // Defense against path traversal — the stored path must stay under
    // UPLOAD_ROOT/<workspaceId>/.
    const wsRoot = path.resolve(UPLOAD_ROOT, workspaceId);
    if (!absolute.startsWith(wsRoot + path.sep)) {
      throw new InternalServerErrorException("Media path is outside workspace root");
    }
    return absolute;
  }

  async finalizeUpload(
    workspaceId: string,
    file: Express.Multer.File,
    uploadedById: string,
  ) {
    if (!file) throw new BadRequestException("No file uploaded");
    if (!ALLOWED_MIME.has(file.mimetype)) {
      throw new BadRequestException(
        `Unsupported file type: ${file.mimetype}. Allowed: ${Array.from(ALLOWED_MIME).join(", ")}`,
      );
    }
    if (file.size > MAX_BYTES) {
      throw new BadRequestException(
        `File too large (${file.size} bytes). Max ${MAX_BYTES} bytes.`,
      );
    }
    // Multer wrote the file to disk under uploads/<workspaceId>/<basename>.
    // Store the relative path (relative to UPLOAD_ROOT).
    const storedPath = path
      .relative(UPLOAD_ROOT, file.path)
      .replace(/\\/g, "/");
    return this.prisma.media.create({
      data: {
        workspaceId,
        fileName: file.originalname,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        storedPath,
        uploadedById,
      },
    });
  }

  async remove(workspaceId: string, id: string) {
    const row = await this.get(workspaceId, id);
    // Delete the DB row first; if the file unlink fails we still want the
    // DB to reflect the user's intent. The file will get garbage-collected
    // in a future cleanup pass.
    await this.prisma.media.delete({ where: { id: row.id } });
    try {
      const absolute = path.resolve(UPLOAD_ROOT, row.storedPath);
      await fs.unlink(absolute);
    } catch {
      // Swallow — DB is the source of truth; orphaned bytes are harmless.
    }
    return { ok: true };
  }
}
```

- [ ] **Step 3: Create the controller**

Create `backend/src/media/media.controller.ts`:

```ts
import {
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { diskStorage } from "multer";
import * as path from "node:path";
import * as fs from "node:fs";
import { randomBytes } from "node:crypto";
import { MediaService } from "./media.service";
import { CurrentWorkspace, CurrentUserId } from "../common/current-workspace.decorator";

const UPLOAD_ROOT = path.resolve(process.cwd(), "uploads");

@Controller("media")
export class MediaController {
  constructor(private readonly svc: MediaService) {}

  @Get()
  list(@CurrentWorkspace() workspaceId: string) {
    return this.svc.list(workspaceId);
  }

  @Post("upload")
  @UseInterceptors(
    FileInterceptor("file", {
      storage: diskStorage({
        destination: (req, _file, cb) => {
          // The auth + workspace interceptor already populated req.user.
          // Multer doesn't have access to NestJS DI; we resolve workspaceId
          // from the JWT payload attached to the request.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const user = (req as any).user as { workspaceId?: string } | undefined;
          if (!user?.workspaceId) return cb(new Error("No workspace context"), "");
          const dir = path.resolve(UPLOAD_ROOT, user.workspaceId);
          fs.mkdirSync(dir, { recursive: true });
          cb(null, dir);
        },
        filename: (_req, file, cb) => {
          const ext = path.extname(file.originalname).toLowerCase().slice(0, 8);
          const id = randomBytes(8).toString("hex");
          cb(null, `${id}${ext}`);
        },
      }),
      limits: { fileSize: 20 * 1024 * 1024 },
    }),
  )
  upload(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUserId() userId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.svc.finalizeUpload(workspaceId, file, userId);
  }

  @Get(":id/file")
  async serve(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Res() res: Response,
  ) {
    const row = await this.svc.get(workspaceId, id);
    const absolute = await this.svc.resolvePath(workspaceId, id);
    res.setHeader("Content-Type", row.mimeType);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.sendFile(absolute);
  }

  @Delete(":id")
  remove(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
  ) {
    return this.svc.remove(workspaceId, id);
  }
}
```

- [ ] **Step 4: Create the module**

Create `backend/src/media/media.module.ts`:

```ts
import { Module } from "@nestjs/common";
import { MediaController } from "./media.controller";
import { MediaService } from "./media.service";

@Module({
  controllers: [MediaController],
  providers: [MediaService],
  exports: [MediaService],
})
export class MediaModule {}
```

- [ ] **Step 5: Register in `app.module.ts`**

Open `backend/src/app.module.ts`. Add the import:

```ts
import { MediaModule } from "./media/media.module";
```

Add `MediaModule` to the `imports` array (place after `NotesModule`, before `AdminModule`).

- [ ] **Step 6: Build**

From `backend/`:
```powershell
npm run build
```

Expected: exit 0. If `@types/multer` is missing and you see "Cannot find name 'Express'", run `npm install -D @types/multer` in the backend directory and rebuild.

- [ ] **Step 7: Smoke test the upload + list flow**

Start the backend (`npm run dev` in `backend/`). In another PowerShell:

```powershell
$y = Invoke-RestMethod -Uri "http://localhost:3001/api/auth/login" -Method Post -ContentType "application/json" -Body '{"email":"yara@samemha.com","password":"demo1234"}'
$h = @{ Authorization = "Bearer $($y.token)" }

# Upload (use any test image on disk)
$form = @{ file = Get-Item "C:\Windows\Web\Wallpaper\Windows\img0.jpg" }
Invoke-RestMethod -Uri "http://localhost:3001/api/media/upload" -Method Post -Headers $h -Form $form

# List
Invoke-RestMethod -Uri "http://localhost:3001/api/media" -Method Get -Headers $h
```

Expected: upload returns a Media row with id, fileName, mimeType, sizeBytes. List returns an array containing it. Inspect `backend/uploads/<workspaceId>/` — the file should exist on disk.

Stop the dev server.

- [ ] **Step 8: Commit**

```powershell
git add backend/src/media backend/src/app.module.ts
git -c user.email=tkana@local -c user.name=tkana commit -m "feat(media): per-workspace file upload, listing, streaming, delete"
```

---

## Task 4: Backend — Facebook Page publishing

**Files:**
- Modify: `backend/src/integrations/facebook.dto.ts`
- Modify: `backend/src/integrations/facebook.service.ts`
- Modify: `backend/src/integrations/facebook.controller.ts`
- Modify: `backend/src/integrations/integrations.module.ts`

Adds `publishToPage(workspaceId, dto)` to FacebookService. Two paths:
- Text only: `POST {graph}/{pageId}/feed?message=...&access_token=...`
- Text + image: `POST {graph}/{pageId}/photos` with multipart `source` (file) + `message` (text)

Node 18+ has native `FormData` and `Blob` — no new dependency.

- [ ] **Step 1: Add the DTO**

In `backend/src/integrations/facebook.dto.ts`, append:

```ts
import { ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

export class PublishToPageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(63206) // FB feed post max
  content!: string;

  // Optional list of Media ids. Phase 1: 0 or 1 supported. More than 1 is
  // accepted by the DTO but currently posted as a single-photo post using
  // only the first id (multi-image is Phase 3 work).
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @IsOptional()
  mediaIds?: string[];
}
```

(Keep the existing `ConnectFacebookDto` and `ReplyToCommentDto` in the file. Just append the new class + its imports at the top.)

- [ ] **Step 2: Inject MediaService into FacebookService**

In `backend/src/integrations/facebook.service.ts`, update the constructor and add a service import at the top:

```ts
import { MediaService } from "../media/media.service";
```

Change the constructor:

```ts
constructor(
  private readonly prisma: PrismaService,
  private readonly media: MediaService,
) {}
```

- [ ] **Step 3: Add the `publishToPage` method**

In `backend/src/integrations/facebook.service.ts`, add this method to the class (place near the other `list*` methods):

```ts
async publishToPage(
  workspaceId: string,
  dto: { content: string; mediaIds?: string[] },
) {
  const { token, pageId } = await this.requireToken(workspaceId);
  const firstMediaId = dto.mediaIds?.[0];

  if (!firstMediaId) {
    // Text-only post — /feed with form-encoded body.
    const url = `${GRAPH}/${pageId}/feed`;
    const params = new URLSearchParams({
      message: dto.content,
      access_token: token,
    });
    const res = await this.fetchJson<{ id: string }>(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    return { id: res.id, kind: "feed" as const };
  }

  // Single-photo post — /photos with multipart upload.
  const mediaRow = await this.media.get(workspaceId, firstMediaId);
  const absolutePath = await this.media.resolvePath(workspaceId, firstMediaId);

  const fs = await import("node:fs/promises");
  const buffer = await fs.readFile(absolutePath);
  const blob = new Blob([buffer], { type: mediaRow.mimeType });
  const form = new FormData();
  form.append("source", blob, mediaRow.fileName);
  form.append("message", dto.content);
  form.append("access_token", token);

  const url = `${GRAPH}/${pageId}/photos`;
  // Native fetch handles multipart FormData encoding for us; do NOT set
  // Content-Type manually — fetch will inject the correct boundary.
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", body: form });
  } catch (e) {
    this.log.error(`Graph network error: ${(e as Error).message}`);
    throw new HttpException("Graph API unreachable", 502);
  }
  const text = await response.text();
  let parsed: unknown = undefined;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
  if (!response.ok) {
    const errMsg =
      typeof parsed === "object" && parsed !== null && "error" in parsed
        // @ts-expect-error - shape from Graph API
        ? ((parsed.error?.message as string) ?? `Graph error ${response.status}`)
        : `Graph error ${response.status}`;
    this.log.warn(`Graph POST ${url} -> ${response.status} ${errMsg}`);
    throw new HttpException(errMsg, response.status >= 500 ? 502 : 400);
  }
  const data = parsed as { id?: string; post_id?: string };
  return { id: data.post_id ?? data.id ?? "", kind: "photo" as const };
}
```

- [ ] **Step 4: Add the controller endpoint**

In `backend/src/integrations/facebook.controller.ts`, add the import:

```ts
import { PublishToPageDto } from "./facebook.dto";
```

Add this endpoint to the `FacebookController` class (near the other POST endpoints):

```ts
@Post("posts")
publishPost(
  @CurrentWorkspace() workspaceId: string,
  @Body() dto: PublishToPageDto,
) {
  return this.svc.publishToPage(workspaceId, dto);
}
```

- [ ] **Step 5: Wire `MediaModule` into `IntegrationsModule`**

In `backend/src/integrations/integrations.module.ts`, import `MediaModule` and add to `imports`:

```ts
import { MediaModule } from "../media/media.module";
```

Add `MediaModule` to the `imports: [...]` array of the `@Module` decorator. (If there's no `imports` array, add one.)

- [ ] **Step 6: Build**

From `backend/`:
```powershell
npm run build
```

Expected: exit 0.

- [ ] **Step 7: Smoke test**

Start the backend in another shell. Then:

```powershell
$y = Invoke-RestMethod -Uri "http://localhost:3001/api/auth/login" -Method Post -ContentType "application/json" -Body '{"email":"yara@samemha.com","password":"demo1234"}'
$h = @{ Authorization = "Bearer $($y.token)" }
$body = '{ "content": "Test post from tkana publisher 🚀" }'
Invoke-RestMethod -Uri "http://localhost:3001/api/integrations/facebook/posts" -Method Post -Headers $h -ContentType "application/json" -Body $body
```

Expected (with FB connected): `{ id: "<page-id>_<post-id>", kind: "feed" }`. If FB is not connected, you get a 404 "Facebook is not connected" — that's the correct gating; reconnect from Settings.

- [ ] **Step 8: Commit**

```powershell
git add backend/src/integrations
git -c user.email=tkana@local -c user.name=tkana commit -m "feat(integrations/facebook): publishToPage (text-only and text+image via multipart)"
```

---

## Task 5: Frontend types + nav + route for Media Storage

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/shell/nav.ts`
- Modify: `src/router.tsx`

- [ ] **Step 1: Add `Media` type and `media` route id**

In `src/lib/types.ts`, find the `RouteId` union and add `"media"` between `"keywords"` and `"team"`:

```ts
export type RouteId =
  | "dashboard"
  | "inbox"
  | "calendar"
  | "social"
  | "mentions"
  | "keywords"
  | "media"
  | "pipeline"
  | "agents"
  | "campaigns"
  | "contacts"
  | "automations"
  | "analytics"
  | "templates"
  | "team"
  | "billing"
  | "settings"
  | "admin";
```

Append at the end of `src/lib/types.ts`:

```ts
// ─── Media library ────────────────────────────────────────────────────────

export interface Media {
  id: string;
  workspaceId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storedPath: string;
  width: number | null;
  height: number | null;
  uploadedById: string | null;
  createdAt: string;
}
```

- [ ] **Step 2: Add the nav entry**

In `src/shell/nav.ts`, update the imports — add `IconAttach` (used as the media icon):

```ts
import {
  IconHome, IconInbox, IconBot, IconCampaign, IconUsers, IconFlow,
  IconChart, IconTemplate, IconTeam, IconBilling, IconCog, IconCal, IconGlobe,
  IconLayers, IconRadar, IconTag, IconBolt, IconAttach,
} from "@/icons";
```

Insert a new `NAV` entry in the **Manage** section (after Templates, before Keywords):

```ts
  { id: "media",       label: "Media",       ar: "الوسائط",        Icon: IconAttach },
```

Add to `TITLES`:

```ts
  media:       { en: "Media library",   ar: "مكتبة الوسائط" },
```

- [ ] **Step 3: Wire the route**

In `src/router.tsx`, add the lazy import to the `screens` map (place after `keywords`):

```ts
  media: lazy(() => import("@/screens/Media")),
```

- [ ] **Step 4: Typecheck**

From repo root:
```powershell
npm run typecheck
```

Expected: this WILL fail because `@/screens/Media` doesn't exist yet — that's Task 6. The error must be ONLY about that missing module. If you see other errors, fix them.

- [ ] **Step 5: Commit**

```powershell
git add src/lib/types.ts src/shell/nav.ts src/router.tsx
git -c user.email=tkana@local -c user.name=tkana commit -m "feat(nav): Media library route (screen lands in next commit)"
```

---

## Task 6: Frontend — Media Storage screen

**Files:**
- Create: `src/screens/Media.tsx`

- [ ] **Step 1: Create the screen**

Create `src/screens/Media.tsx`:

```tsx
import { memo, useRef, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { PageHeader } from "@/components/PageHeader";
import { useFetch, useMutation } from "@/api/useFetch";
import { api, tokenStore } from "@/api/client";
import { IconPlus, IconMore } from "@/icons";
import type { Media } from "@/lib/types";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function MediaImpl() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);

  const listQ = useFetch<Media[]>("/media");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const deleteMut = useMutation<{ id: string }, { ok: true }>((input) =>
    api.delete(`/media/${input.id}`),
  );

  const onPickFile = () => fileInputRef.current?.click();

  const onFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = ""; // reset so the same file can be re-picked

    setUploading(true);
    setUploadError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      // We need a raw fetch here because the `api` helper sends JSON only.
      const base =
        (import.meta.env.VITE_API_URL as string | undefined) ??
        "http://localhost:3001/api";
      const tok = tokenStore.get();
      const resp = await fetch(`${base}/media/upload`, {
        method: "POST",
        headers: tok ? { Authorization: `Bearer ${tok}` } : {},
        body: form,
      });
      if (!resp.ok) {
        const txt = await resp.text();
        let msg = `Upload failed (${resp.status})`;
        try {
          const j = JSON.parse(txt) as { message?: string | string[] };
          msg = Array.isArray(j.message)
            ? j.message.join(", ")
            : j.message ?? msg;
        } catch {
          /* keep generic */
        }
        throw new Error(msg);
      }
      listQ.refetch();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const onDelete = async (m: Media) => {
    if (
      !window.confirm(
        tx(
          `Delete ${m.fileName}? This cannot be undone.`,
          `حذف ${m.fileName}؟ لا يمكن التراجع.`,
        ),
      )
    ) {
      return;
    }
    await deleteMut.mutate({ id: m.id });
    listQ.refetch();
  };

  const items = listQ.data ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <PageHeader
        title={tx("Media library", "مكتبة الوسائط")}
        subtitle={tx(
          "Images you can attach to posts. Up to 20 MB per file.",
          "صور يمكنك إرفاقها بالمنشورات. الحد الأقصى ٢٠ ميغا بايت.",
        )}
        actions={
          <button
            className="btn primary"
            onClick={onPickFile}
            disabled={uploading}
          >
            <IconPlus w={13} />
            {uploading ? tx("Uploading…", "جارٍ الرفع…") : tx("Upload", "رفع")}
          </button>
        }
      />

      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/gif,image/webp"
        onChange={onFileChosen}
        style={{ display: "none" }}
      />

      <div style={{ flex: 1, overflowY: "auto", padding: "16px 24px" }}>
        {uploadError && (
          <div
            style={{
              padding: "10px 12px",
              borderRadius: 8,
              background: "oklch(0.7 0.22 24 / 0.12)",
              color: "var(--bad)",
              fontSize: 12,
              border: "1px solid oklch(0.7 0.22 24 / 0.35)",
              marginBottom: 12,
            }}
          >
            {uploadError}
          </div>
        )}

        {listQ.loading && items.length === 0 && (
          <div className="mono muted pulse" style={{ fontSize: 12, padding: 16 }}>
            {tx("loading…", "جارٍ التحميل…")}
          </div>
        )}

        {!listQ.loading && items.length === 0 && (
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
            {tx(
              "No media yet. Click Upload to add an image.",
              "لا توجد وسائط بعد. اضغط رفع لإضافة صورة.",
            )}
          </div>
        )}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
            gap: 12,
          }}
        >
          {items.map((m) => (
            <MediaTile key={m.id} m={m} onDelete={() => onDelete(m)} />
          ))}
        </div>
      </div>
    </div>
  );
}

function MediaTile({ m, onDelete }: { m: Media; onDelete: () => void }) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);

  const base =
    (import.meta.env.VITE_API_URL as string | undefined) ??
    "http://localhost:3001/api";
  const tok = tokenStore.get();
  // Built-in <img> can't send Authorization headers, so we'd need a signed
  // URL or token-in-URL for direct rendering. Phase 1 ships a simpler tile
  // that shows the filename + a "Open" link that opens the streaming
  // endpoint in a new tab (the tab inherits the auth cookie if any, or
  // appends ?token=... for dev). For the grid thumbnail, we render a
  // placeholder block — the live preview pane in ComposeModal does the
  // actual rendering via a blob fetch.
  const previewUrl = `${base}/media/${m.id}/file`;

  return (
    <div
      style={{
        border: "1px solid var(--line-soft)",
        borderRadius: 12,
        overflow: "hidden",
        background: "var(--bg-1)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          position: "relative",
          aspectRatio: "1 / 1",
          background: "var(--bg-2)",
          display: "grid",
          placeItems: "center",
        }}
      >
        <AuthorizedImage url={previewUrl} alt={m.fileName} token={tok} />
      </div>
      <div style={{ padding: "8px 10px", display: "flex", flexDirection: "column", gap: 4 }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 500,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
          title={m.fileName}
        >
          {m.fileName}
        </div>
        <div
          className="mono"
          style={{
            fontSize: 10,
            color: "var(--ink-3)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span>{formatBytes(m.sizeBytes)}</span>
          <button
            type="button"
            className="btn ghost sm"
            onClick={onDelete}
            style={{ padding: "0 4px", color: "var(--ink-3)" }}
            aria-label={tx("Delete", "حذف")}
            title={tx("Delete", "حذف")}
          >
            <IconMore w={11} />
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * <img> tags don't send Authorization headers. We fetch the binary via
 * fetch() with the bearer token, then render it as a blob URL.
 */
function AuthorizedImage({
  url,
  alt,
  token,
}: {
  url: string;
  alt: string;
  token: string | null;
}) {
  const [src, setSrc] = useState<string | null>(null);

  useState(() => {
    let cancelled = false;
    fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => r.blob())
      .then((b) => {
        if (cancelled) return;
        setSrc(URL.createObjectURL(b));
      })
      .catch(() => {
        /* leave src null */
      });
    return () => {
      cancelled = true;
      if (src) URL.revokeObjectURL(src);
    };
  });

  if (!src) {
    return <div className="mono muted" style={{ fontSize: 11 }}>…</div>;
  }
  return (
    <img
      src={src}
      alt={alt}
      style={{
        width: "100%",
        height: "100%",
        objectFit: "cover",
        display: "block",
      }}
    />
  );
}

const Media = memo(MediaImpl);
export default Media;
```

Note: the `useState` invocation for the side-effect inside `AuthorizedImage` is intentional — React 18 supports lazy initial state. We use it here as a one-shot mount-effect to avoid pulling in `useEffect` for a trivial fetch. If lint complains, replace with `useEffect(() => {...}, [url])`.

- [ ] **Step 2: Typecheck**

```powershell
npm run typecheck
```

Expected: passes. If `Express.Multer.File` causes a TS error in backend (we haven't installed `@types/multer`), run `npm install -D @types/multer` in `backend/`. Frontend should be clean.

- [ ] **Step 3: Browser smoke test**

Start backend and frontend (`npm --prefix backend run dev` and `npm run dev`). Open `http://localhost:5173/#media`. You should see the Media library screen with an Upload button. Click Upload, choose a small JPG/PNG. Confirm:
- The tile appears with the filename and size
- The thumbnail renders (you may need to wait a second for the blob fetch)
- Reload the page; the file persists
- Delete a tile; it disappears and is removed from `backend/uploads/<workspaceId>/`

- [ ] **Step 4: Commit**

```powershell
git add src/screens/Media.tsx
git -c user.email=tkana@local -c user.name=tkana commit -m "feat(media): Media library screen with grid, upload, delete"
```

---

## Task 7: Frontend — ComposeModal component

**Files:**
- Create: `src/components/ComposeModal.tsx`

A modal opened from the Social page. Phase 1 features:
- Textarea for content
- Channel chip — Facebook only (shown disabled "Coming soon" for IG/TikTok)
- Media picker: small popover showing existing media + an Upload button
- Live preview pane on the right with FB-mock styling
- Post Now button → calls `POST /api/integrations/facebook/posts`

- [ ] **Step 1: Create the component**

Create `src/components/ComposeModal.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { useAuth } from "@/auth/context";
import { useFetch, useMutation } from "@/api/useFetch";
import { api, tokenStore } from "@/api/client";
import { Avatar } from "@/components/Avatar";
import { IconBolt, IconCheck, IconPlus, IconX } from "@/icons";
import type { Media } from "@/lib/types";

interface FbStatus {
  connected: boolean;
  pageId?: string;
  pageName?: string;
}

interface ComposeModalProps {
  open: boolean;
  onClose: () => void;
  onPosted?: () => void;
}

const CHAR_LIMIT_FB = 63206;

export function ComposeModal({ open, onClose, onPosted }: ComposeModalProps) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const { activeWorkspace } = useAuth();

  const fbStatusQ = useFetch<FbStatus>(open ? "/integrations/facebook/status" : null);
  const mediaQ = useFetch<Media[]>(open ? "/media" : null);

  const [content, setContent] = useState("");
  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const publishMut = useMutation<
    { content: string; mediaIds?: string[] },
    { id: string; kind: "feed" | "photo" }
  >((input) => api.post("/integrations/facebook/posts", input));

  // Reset state when modal closes (so reopening starts fresh).
  useEffect(() => {
    if (!open) {
      setContent("");
      setSelectedMediaId(null);
      setPickerOpen(false);
    }
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const connected = fbStatusQ.data?.connected === true;
  const selectedMedia = mediaQ.data?.find((m) => m.id === selectedMediaId) ?? null;
  const canPost = content.trim().length > 0 && connected && !publishMut.loading;

  const onPost = async () => {
    if (!canPost) return;
    await publishMut.mutate({
      content: content.trim(),
      mediaIds: selectedMediaId ? [selectedMediaId] : undefined,
    });
    onPosted?.();
    onClose();
  };

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "var(--scrim, rgba(0,0,0,0.55))",
          zIndex: 80,
        }}
      />
      <div
        role="dialog"
        aria-label={tx("Compose new post", "إنشاء منشور")}
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: "min(960px, 96vw)",
          height: "min(700px, 92vh)",
          background: "var(--bg-elev)",
          border: "1px solid var(--line-soft)",
          borderRadius: 14,
          boxShadow: "var(--shadow-lg)",
          zIndex: 81,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "12px 16px",
            borderBottom: "1px solid var(--line-soft)",
          }}
        >
          <span style={{ fontWeight: 600, fontSize: 14 }}>
            {tx("New social post", "منشور جديد")}
          </span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className="btn ghost icon sm"
            onClick={onClose}
            aria-label={tx("Close", "إغلاق")}
          >
            <IconX w={14} />
          </button>
        </div>

        {/* Body: composer on the left, preview on the right */}
        <div style={{ flex: 1, display: "grid", gridTemplateColumns: "1fr 360px", minHeight: 0 }}>
          {/* Composer */}
          <div
            style={{
              padding: 18,
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 14,
              borderInlineEnd: "1px solid var(--line-soft)",
            }}
          >
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
                {tx("Post to", "نشر إلى")}
              </div>
              <ChannelChips connected={connected} pageName={fbStatusQ.data?.pageName} />
            </div>

            <div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  marginBottom: 6,
                }}
              >
                <span
                  className="mono"
                  style={{
                    fontSize: 10,
                    color: "var(--ink-3)",
                    textTransform: "uppercase",
                    letterSpacing: 0.06,
                  }}
                >
                  {tx("Content", "المحتوى")}
                </span>
                <span
                  className="mono"
                  style={{
                    fontSize: 10,
                    color:
                      content.length > CHAR_LIMIT_FB
                        ? "var(--bad)"
                        : "var(--ink-3)",
                  }}
                >
                  {content.length} / {CHAR_LIMIT_FB}
                </span>
              </div>
              <textarea
                autoFocus
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={8}
                placeholder={tx(
                  "Write your post… text and one image are supported in this phase.",
                  "اكتب منشورك… النص وصورة واحدة مدعومة في هذه المرحلة.",
                )}
                style={{
                  width: "100%",
                  minHeight: 160,
                  resize: "vertical",
                  padding: "10px 12px",
                  background: "var(--bg-2)",
                  border: "1px solid var(--line)",
                  borderRadius: 10,
                  color: "var(--ink)",
                  fontSize: 14,
                  fontFamily: "inherit",
                  lineHeight: 1.5,
                  outline: "none",
                }}
              />
            </div>

            {/* Media */}
            <MediaPicker
              media={mediaQ.data ?? []}
              loading={mediaQ.loading}
              selectedId={selectedMediaId}
              onSelect={setSelectedMediaId}
              pickerOpen={pickerOpen}
              setPickerOpen={setPickerOpen}
              onUploaded={() => mediaQ.refetch()}
              tx={tx}
            />

            {publishMut.error && (
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
                {publishMut.error}
              </div>
            )}
          </div>

          {/* Preview pane */}
          <div
            style={{
              background: "var(--bg-1)",
              padding: 18,
              overflowY: "auto",
            }}
          >
            <div
              className="mono"
              style={{
                fontSize: 10,
                color: "var(--ink-3)",
                textTransform: "uppercase",
                letterSpacing: 0.06,
                marginBottom: 10,
              }}
            >
              {tx("Post preview", "معاينة المنشور")}
            </div>
            <FbPreviewCard
              pageName={fbStatusQ.data?.pageName ?? activeWorkspace?.name ?? "Page"}
              content={content}
              media={selectedMedia}
            />
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "12px 16px",
            borderTop: "1px solid var(--line-soft)",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span style={{ flex: 1, fontSize: 11, color: "var(--ink-3)" }}>
            {!connected &&
              tx(
                "Facebook is not connected — connect from Settings → Integrations.",
                "فيسبوك غير متصل — اربطه من الإعدادات.",
              )}
          </span>
          <button type="button" className="btn ghost" onClick={onClose}>
            {tx("Cancel", "إلغاء")}
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={onPost}
            disabled={!canPost}
          >
            <IconBolt w={13} />
            {publishMut.loading
              ? tx("Posting…", "جارٍ النشر…")
              : tx("Post now", "نشر الآن")}
          </button>
        </div>
      </div>
    </>
  );
}

/* ── Channel chips (FB enabled; IG/TikTok placeholders) ───────────────── */

function ChannelChips({
  connected,
  pageName,
}: {
  connected: boolean;
  pageName: string | undefined;
}) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 12px",
          borderRadius: 999,
          background: connected ? "#1877F2" : "var(--bg-2)",
          color: connected ? "#fff" : "var(--ink-3)",
          fontSize: 12,
          fontWeight: 500,
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: connected ? "#fff" : "var(--ink-3)",
          }}
        />
        Facebook {connected && pageName ? `· ${pageName}` : ""}
      </span>
      <span
        style={{
          padding: "6px 12px",
          borderRadius: 999,
          background: "var(--bg-2)",
          color: "var(--ink-3)",
          fontSize: 12,
        }}
      >
        Instagram · {tx("coming soon", "قريباً")}
      </span>
    </div>
  );
}

/* ── Media picker ─────────────────────────────────────────────────────── */

interface MediaPickerProps {
  media: Media[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  pickerOpen: boolean;
  setPickerOpen: (v: boolean) => void;
  onUploaded: () => void;
  tx: (en: string, ar: string) => string;
}

function MediaPicker({
  media,
  loading,
  selectedId,
  onSelect,
  pickerOpen,
  setPickerOpen,
  onUploaded,
  tx,
}: MediaPickerProps) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const onPick = () => fileRef.current?.click();

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";

    setUploading(true);
    setUploadError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const base =
        (import.meta.env.VITE_API_URL as string | undefined) ??
        "http://localhost:3001/api";
      const tok = tokenStore.get();
      const resp = await fetch(`${base}/media/upload`, {
        method: "POST",
        headers: tok ? { Authorization: `Bearer ${tok}` } : {},
        body: form,
      });
      if (!resp.ok) {
        const txt = await resp.text();
        let msg = `Upload failed (${resp.status})`;
        try {
          const j = JSON.parse(txt) as { id?: string; message?: string | string[] };
          msg = Array.isArray(j.message)
            ? j.message.join(", ")
            : j.message ?? msg;
        } catch {
          /* keep generic */
        }
        throw new Error(msg);
      }
      const created = (await resp.json()) as Media;
      onUploaded();
      onSelect(created.id);
      setPickerOpen(false);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  return (
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
        {tx("Media", "وسائط")}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/gif,image/webp"
        onChange={onFile}
        style={{ display: "none" }}
      />
      {selectedId ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 10px",
            border: "1px solid var(--line-soft)",
            borderRadius: 10,
            background: "var(--bg-2)",
          }}
        >
          <PreviewThumb mediaId={selectedId} />
          <span style={{ flex: 1, fontSize: 12, color: "var(--ink-2)" }}>
            {media.find((m) => m.id === selectedId)?.fileName ?? "selected"}
          </span>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => onSelect(null)}
          >
            {tx("Remove", "حذف")}
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn"
            onClick={() => setPickerOpen(!pickerOpen)}
          >
            {tx("Pick from library", "اختر من المكتبة")}
          </button>
          <button
            type="button"
            className="btn"
            onClick={onPick}
            disabled={uploading}
          >
            <IconPlus w={12} />
            {uploading ? tx("Uploading…", "جارٍ الرفع…") : tx("Upload new", "ارفع جديدة")}
          </button>
        </div>
      )}
      {pickerOpen && (
        <div
          style={{
            marginTop: 10,
            border: "1px solid var(--line-soft)",
            borderRadius: 10,
            padding: 10,
            maxHeight: 200,
            overflowY: "auto",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(90px, 1fr))",
            gap: 8,
            background: "var(--bg-2)",
          }}
        >
          {loading && (
            <div className="mono muted pulse" style={{ fontSize: 11 }}>
              {tx("loading…", "جارٍ التحميل…")}
            </div>
          )}
          {!loading && media.length === 0 && (
            <div className="mono muted" style={{ fontSize: 11, gridColumn: "1 / -1" }}>
              {tx("No media yet. Upload one.", "لا توجد وسائط بعد.")}
            </div>
          )}
          {media.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => {
                onSelect(m.id);
                setPickerOpen(false);
              }}
              style={{
                padding: 0,
                background: "var(--bg-1)",
                border: "1px solid var(--line-soft)",
                borderRadius: 8,
                aspectRatio: "1 / 1",
                overflow: "hidden",
                cursor: "pointer",
                position: "relative",
              }}
              title={m.fileName}
            >
              <PreviewThumb mediaId={m.id} />
              {m.id === selectedId && (
                <span
                  style={{
                    position: "absolute",
                    top: 4,
                    insetInlineEnd: 4,
                    background: "var(--accent)",
                    borderRadius: "50%",
                    width: 16,
                    height: 16,
                    display: "grid",
                    placeItems: "center",
                    color: "#fff",
                  }}
                >
                  <IconCheck w={10} />
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      {uploadError && (
        <div
          style={{
            marginTop: 8,
            color: "var(--bad)",
            fontSize: 11,
          }}
        >
          {uploadError}
        </div>
      )}
    </div>
  );
}

/* ── Thumbnail (fetches binary with bearer, renders as blob URL) ────── */

function PreviewThumb({ mediaId }: { mediaId: string }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tok = tokenStore.get();
    const base =
      (import.meta.env.VITE_API_URL as string | undefined) ??
      "http://localhost:3001/api";
    fetch(`${base}/media/${mediaId}/file`, {
      headers: tok ? { Authorization: `Bearer ${tok}` } : {},
    })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => {
        if (cancelled || !b) return;
        setSrc(URL.createObjectURL(b));
      })
      .catch(() => {
        /* leave src null */
      });
    return () => {
      cancelled = true;
    };
  }, [mediaId]);

  useEffect(() => {
    return () => {
      if (src) URL.revokeObjectURL(src);
    };
  }, [src]);

  if (!src) {
    return (
      <div
        className="mono muted"
        style={{
          width: "100%",
          height: "100%",
          display: "grid",
          placeItems: "center",
          fontSize: 10,
        }}
      >
        …
      </div>
    );
  }
  return (
    <img
      src={src}
      alt=""
      style={{
        width: "100%",
        height: "100%",
        objectFit: "cover",
        display: "block",
      }}
    />
  );
}

/* ── FB-style preview card ─────────────────────────────────────────── */

function FbPreviewCard({
  pageName,
  content,
  media,
}: {
  pageName: string;
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
      }}
    >
      <div style={{ padding: 12, display: "flex", gap: 10, alignItems: "center" }}>
        <Avatar name={pageName} color="240" size="lg" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>{pageName}</div>
          <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
            JUST NOW · 🌐
          </div>
        </div>
      </div>
      {content && (
        <div
          style={{
            padding: "0 12px 12px",
            fontSize: 13,
            color: "var(--ink-1)",
            whiteSpace: "pre-wrap",
            lineHeight: 1.45,
          }}
        >
          {content}
        </div>
      )}
      {media && <PreviewThumb mediaId={media.id} />}
      <div
        style={{
          padding: "10px 12px",
          borderTop: "1px solid var(--line-soft)",
          display: "flex",
          gap: 16,
          fontSize: 12,
          color: "var(--ink-3)",
        }}
      >
        <span>👍 Like</span>
        <span>💬 Comment</span>
        <span>↗ Share</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```powershell
npm run typecheck
```

Expected: passes.

- [ ] **Step 3: Commit**

```powershell
git add src/components/ComposeModal.tsx
git -c user.email=tkana@local -c user.name=tkana commit -m "feat(compose): ComposeModal with text + media picker + FB preview"
```

---

## Task 8: Wire the Compose button + end-to-end smoke test

**Files:**
- Modify: `src/screens/Social.tsx`

- [ ] **Step 1: Wire the Compose button on Social.tsx**

Open `src/screens/Social.tsx`. At the top with the other imports, add:

```ts
import { ComposeModal } from "@/components/ComposeModal";
```

Inside the `SocialImpl` function, add a state hook near the existing useState calls (e.g., after `useState<SocialPlatform>("facebook")`):

```ts
const [composeOpen, setComposeOpen] = useState(false);
```

Find the placeholder Compose button (currently `<button className="btn primary"><IconBolt w={13} />{tx("Compose", "إنشاء منشور")}</button>`) and add the `onClick`:

```tsx
<button className="btn primary" onClick={() => setComposeOpen(true)}>
  <IconBolt w={13} />
  {tx("Compose", "إنشاء منشور")}
</button>
```

At the very end of the screen's JSX (just before the closing `</div>` of the root element, AFTER the `<style>` tag if present), add:

```tsx
<ComposeModal
  open={composeOpen}
  onClose={() => setComposeOpen(false)}
  onPosted={() => {
    // Phase 1: just close. Phase 2 will refetch the feed so the new post appears live.
  }}
/>
```

- [ ] **Step 2: Typecheck**

```powershell
npm run typecheck
```

Expected: passes.

- [ ] **Step 3: End-to-end smoke test**

Start backend + frontend. Open the app in the browser:

1. Log in as `yara@samemha.com`.
2. Confirm Facebook is connected (Settings → Integrations). If not, paste a Page Access Token first.
3. Navigate to **Media** in the sidebar. Upload a test image. Confirm it appears.
4. Navigate to **Social**. Click **Compose** in the header.
5. The modal opens. Type some text like "Test from tkana 🚀". The right pane shows a live FB-style preview.
6. Click **Pick from library**, choose the test image. The preview now shows the image attached.
7. Click **Post now**. Wait for the response.
8. Open your actual Facebook Page in a browser tab. **The post should be live with text + image.**

If step 8 fails, capture the backend log (look for the Graph error message) and the response in the browser's network tab.

- [ ] **Step 4: Commit**

```powershell
git add src/screens/Social.tsx
git -c user.email=tkana@local -c user.name=tkana commit -m "feat(social): wire Compose button to ComposeModal"
```

---

## Self-Review

**Spec coverage:**
- ✅ Media model + per-workspace scoping (Task 1)
- ✅ Upload pipeline with multer + disk storage (Task 3)
- ✅ Streaming endpoint with bearer auth (Task 3)
- ✅ Facebook Page publish (text-only and text+image) (Task 4)
- ✅ Media Storage screen with grid + upload + delete (Task 6)
- ✅ Compose modal with text editor + channel chip + media picker + live preview (Task 7)
- ✅ Wired Compose button (Task 8)

**Placeholder scan:**
- Task 1 Step 2 has a deliberately commented-out wrong-pattern line and corrected line; the engineer should follow the corrected one. No "TBD".
- All code blocks are concrete.

**Type consistency:**
- `Media` interface matches `Media` Prisma model exactly (id, workspaceId, fileName, mimeType, sizeBytes, storedPath, width?, height?, uploadedById?, createdAt).
- `PublishToPageDto` field name `content` matches the frontend's `publishMut` body.
- The `mediaIds?: string[]` field is consistent across DTO + service + controller + frontend mutation.

**Known fragilities (deliberate, not blocking Phase 1):**
- File serving sends bytes through Node — fine for dev, but at scale we'd use S3 + signed URLs.
- Multer's `destination` callback reads `workspaceId` off `req.user`, which assumes the AuthGuard ran first. NestJS routes all guards before interceptors before route handlers, so this is correct, but a future refactor that moves the upload endpoint to a public route would break it.
- The FB Graph upload uses native `FormData` + `Blob` (Node 18+). If the project ever downgrades to Node <18, this needs the `form-data` npm package.
- `AuthorizedImage` in `Media.tsx` uses lazy `useState` for a one-shot fetch — concise but unconventional. If lint complains, convert to `useEffect`.
- No retry on Graph 429 — Phase 1 acceptable for SMB volumes.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-12-social-publisher-phase-1.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task with two-stage review (spec compliance, then code quality). Same workflow we used for multi-tenancy and the admin portal — caught real bugs in both.

**2. Inline Execution** — I execute tasks in this session with checkpoints. Faster turnaround but my context fills across 8 tasks.

Which approach?
