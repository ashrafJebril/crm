# Multi-Tenancy Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert tkana from single-tenant to multi-tenant SaaS — every customer-owned record scoped to a `Workspace`, JWT carries `workspaceId`, services explicitly scope all queries by workspace, with a Prisma extension as a safety net.

**Architecture:**
- New `Workspace` (tenant) + `WorkspaceMember(userId, workspaceId, role)` many-to-many.
- `workspaceId` denormalized onto every customer-owned model (Contact, Conversation, Message, Appointment, Template, Campaign, Pipeline, TicketStage, Ticket, TicketActivity, Note, Keyword, Mention, Integration) so all queries can scope without joins.
- Auth: JWT payload extends with `workspaceId`; AuthGuard attaches it to the request. New `/auth/workspaces` and `/auth/switch-workspace` endpoints for multi-workspace users.
- Request context: NestJS interceptor stores the active workspaceId in `AsyncLocalStorage`; a `@CurrentWorkspace()` decorator extracts it in controllers.
- Defense in depth: every service method takes `workspaceId` explicitly (primary scoping) AND a Prisma `$extends` middleware auto-injects `workspaceId` on known models (safety net for forgetting).
- Existing dev data migrates into a "Default Workspace"; all current users become Owner of it.

**Tech Stack:** NestJS 10, Prisma 5, SQLite (dev), `AsyncLocalStorage` (Node built-in), JWT (existing). No new dependencies. Verification is manual via curl + Prisma Studio + browser dev server — the codebase has no test framework and we don't add one in this plan.

**Scope explicitly excluded (later plans):**
- Billing / Stripe / Subscription enforcement (separate plan)
- Workspace switcher UI dropdown (this plan does the foundation; switcher comes later)
- Per-workspace branding / settings UI
- Postgres RLS (we're on SQLite — RLS comes when we migrate to Postgres for prod)

---

## File Structure

**Backend — created:**
- `backend/src/workspaces/workspaces.module.ts` — module wiring
- `backend/src/workspaces/workspaces.service.ts` — Workspace + Member CRUD
- `backend/src/workspaces/workspaces.controller.ts` — `/api/workspaces/*`
- `backend/src/workspaces/workspaces.dto.ts`
- `backend/src/common/workspace-context.ts` — `AsyncLocalStorage<{ workspaceId }>` singleton + helpers
- `backend/src/common/current-workspace.decorator.ts` — `@CurrentWorkspace()` for controllers
- `backend/src/common/workspace.interceptor.ts` — sets the context per request
- `backend/src/common/prisma-tenancy.ts` — Prisma `$extends` middleware that auto-scopes known models
- `backend/scripts/migrate-multi-tenant.ts` — one-shot data migration: creates Default Workspace, backfills `workspaceId` on all rows, assigns existing users as Owner

**Backend — modified:**
- `backend/prisma/schema.prisma` — Workspace + WorkspaceMember models; `workspaceId` on every customer-owned model; updated unique constraints (Integration becomes `@@unique([workspaceId, platform])`).
- `backend/prisma/seed.ts` — creates Workspace before seeding, scopes all seed data to it.
- `backend/src/auth/auth.service.ts` — `register` creates Workspace + Member + seeds defaults; `login` returns workspaces list when user has multiple, otherwise issues JWT with workspaceId.
- `backend/src/auth/auth.controller.ts` — adds `GET /auth/workspaces`, `POST /auth/switch-workspace`.
- `backend/src/auth/auth.guard.ts` — JWT payload includes workspaceId.
- `backend/src/auth/dto.ts` — extends RegisterDto with optional workspaceName.
- `backend/src/prisma/prisma.service.ts` — applies the tenancy extension.
- `backend/src/app.module.ts` — registers `WorkspaceInterceptor` globally and the `WorkspacesModule`.
- All service files: `contacts.service.ts`, `conversations.service.ts`, `appointments.service.ts`, `templates.service.ts`, `campaigns.service.ts`, `team.service.ts`, `dashboard.service.ts`, `tickets.service.ts`, `notes.service.ts`, `mentions.service.ts`, `keywords.service.ts`, `integrations/facebook.service.ts`, `mentions/open-ticket.service.ts`, `mentions/mentions.scheduler.ts`, `mentions/sources/meta-ig.poller.ts` — every method now accepts `workspaceId` and scopes queries.
- All controller files for the above — extract `workspaceId` via `@CurrentWorkspace()`.

**Frontend — modified:**
- `src/auth/context.tsx` — auth context stores `workspaceId` and `workspaceName`.
- `src/shell/Topbar.tsx` — displays current workspace name.
- `src/lib/types.ts` — adds `Workspace`, `WorkspaceMember` types; auth response shape extended.

---

## Task 1: Read current state + plan dependencies

**Files:** none (exploration only).

- [ ] **Step 1: Verify branch + working tree**

Run:
```powershell
git status
git branch --show-current
```

Expected: branch is `feat/multi-tenancy`, working tree clean.

- [ ] **Step 2: Snapshot current DB state**

Run from `backend/`:
```powershell
npx prisma studio
```

In the browser, note the row count for: `User`, `Contact`, `Integration`, `Mention`, `Keyword`, `Note`, `Ticket`. This is the data we must preserve through the migration. Close Studio when done.

- [ ] **Step 3: Verify Node version supports AsyncLocalStorage**

Run:
```powershell
node --version
```

Expected: v18 or higher (AsyncLocalStorage is built-in since v13.10). The project's `engines` in package.json likely specifies Node 20+; if not, no action needed — we'll use what's installed.

- [ ] **Step 4: Note existing JWT payload shape**

Read `backend/src/auth/auth.guard.ts` and confirm `JwtPayload` currently has `{ sub, email, role }`. This is what we extend in Task 7.

---

## Task 2: Add Workspace + WorkspaceMember models to schema

**Files:**
- Modify: `backend/prisma/schema.prisma`

- [ ] **Step 1: Append Workspace + WorkspaceMember models**

Append at the bottom of `backend/prisma/schema.prisma` (after the Mention model):

```prisma
// ─── Workspaces (tenants) ─────────────────────────────────────────────────

model Workspace {
  id        String   @id @default(cuid())
  name      String
  slug      String   @unique
  timezone  String   @default("Asia/Riyadh")
  lang      String   @default("ar") // "en" | "ar"
  plan      String   @default("free") // "free" | "starter" | "growth" | "pro"

  members WorkspaceMember[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model WorkspaceMember {
  id          String @id @default(cuid())
  userId      String
  workspaceId String
  role        String // "owner" | "admin" | "agent" | "viewer"

  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  createdAt DateTime @default(now())

  @@unique([userId, workspaceId])
  @@index([workspaceId])
}
```

- [ ] **Step 2: Add `memberships` back-relation on User model**

Find the `User` model (around line 15) in `backend/prisma/schema.prisma`. Inside the model body, add the relation line BEFORE the closing brace:

```prisma
  memberships WorkspaceMember[]
```

So the model ends like:
```prisma
  twoFA     Boolean  @default(false)

  memberships WorkspaceMember[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

- [ ] **Step 3: Push schema**

From `backend/`:
```powershell
npx prisma db push
```

Expected: "Your database is now in sync with your Prisma schema. Done in NNNms".

If you get an EPERM error on Prisma client regeneration, kill any running Node processes (`Get-Process node | Stop-Process -Force`), then run `npx prisma generate` again.

- [ ] **Step 4: Verify the tables exist**

From `backend/`:
```powershell
npx prisma studio
```

Confirm `Workspace` and `WorkspaceMember` appear in the model list. Both should be empty (0 rows). Close Studio.

- [ ] **Step 5: Commit**

From the repo root:
```powershell
git add backend/prisma/schema.prisma
git -c user.email=tkana@local -c user.name=tkana commit -m "feat(db): add Workspace and WorkspaceMember models"
```

---

## Task 3: Build the Workspaces module (service, DTOs, controller)

**Files:**
- Create: `backend/src/workspaces/workspaces.dto.ts`
- Create: `backend/src/workspaces/workspaces.service.ts`
- Create: `backend/src/workspaces/workspaces.controller.ts`
- Create: `backend/src/workspaces/workspaces.module.ts`

- [ ] **Step 1: Create the DTO file**

Create `backend/src/workspaces/workspaces.dto.ts`:

```ts
import { IsIn, IsOptional, IsString, MinLength } from "class-validator";

export const WORKSPACE_ROLES = ["owner", "admin", "agent", "viewer"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export class CreateWorkspaceDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsString()
  @IsOptional()
  timezone?: string;

  @IsString()
  @IsOptional()
  lang?: string;
}

export class UpdateWorkspaceDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  timezone?: string;

  @IsString()
  @IsOptional()
  lang?: string;

  @IsString()
  @IsOptional()
  plan?: string;
}

export class AddMemberDto {
  @IsString()
  @MinLength(1)
  userId!: string;

  @IsIn(WORKSPACE_ROLES as unknown as string[])
  role!: WorkspaceRole;
}

export class UpdateMemberRoleDto {
  @IsIn(WORKSPACE_ROLES as unknown as string[])
  role!: WorkspaceRole;
}
```

- [ ] **Step 2: Create the service**

Create `backend/src/workspaces/workspaces.service.ts`:

```ts
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import {
  AddMemberDto,
  CreateWorkspaceDto,
  UpdateMemberRoleDto,
  UpdateWorkspaceDto,
  WorkspaceRole,
} from "./workspaces.dto";

function toSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "workspace"
  );
}

@Injectable()
export class WorkspacesService {
  constructor(private readonly prisma: PrismaService) {}

  /** List workspaces a user belongs to. */
  async listForUser(userId: string) {
    const memberships = await this.prisma.workspaceMember.findMany({
      where: { userId },
      include: { workspace: true },
      orderBy: { createdAt: "asc" },
    });
    return memberships.map((m) => ({
      id: m.workspace.id,
      name: m.workspace.name,
      slug: m.workspace.slug,
      timezone: m.workspace.timezone,
      lang: m.workspace.lang,
      plan: m.workspace.plan,
      role: m.role as WorkspaceRole,
    }));
  }

  async get(id: string) {
    const ws = await this.prisma.workspace.findUnique({ where: { id } });
    if (!ws) throw new NotFoundException("Workspace not found");
    return ws;
  }

  async create(dto: CreateWorkspaceDto, ownerUserId: string) {
    const baseSlug = toSlug(dto.name);
    let slug = baseSlug;
    let suffix = 0;
    // Loop until we find a free slug.
    while (await this.prisma.workspace.findUnique({ where: { slug } })) {
      suffix += 1;
      slug = `${baseSlug}-${suffix}`;
    }
    const ws = await this.prisma.workspace.create({
      data: {
        name: dto.name,
        slug,
        timezone: dto.timezone ?? "Asia/Riyadh",
        lang: dto.lang ?? "ar",
      },
    });
    await this.prisma.workspaceMember.create({
      data: { userId: ownerUserId, workspaceId: ws.id, role: "owner" },
    });
    return ws;
  }

  async update(id: string, dto: UpdateWorkspaceDto) {
    await this.get(id);
    return this.prisma.workspace.update({ where: { id }, data: dto });
  }

  /** Verify a user is a member and return their role, or throw. */
  async requireMember(userId: string, workspaceId: string): Promise<WorkspaceRole> {
    const m = await this.prisma.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId, workspaceId } },
    });
    if (!m) throw new ForbiddenException("Not a member of this workspace");
    return m.role as WorkspaceRole;
  }

  async listMembers(workspaceId: string) {
    return this.prisma.workspaceMember.findMany({
      where: { workspaceId },
      include: { user: true },
      orderBy: { createdAt: "asc" },
    });
  }

  async addMember(workspaceId: string, dto: AddMemberDto) {
    const exists = await this.prisma.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId: dto.userId, workspaceId } },
    });
    if (exists) throw new ConflictException("Already a member");
    return this.prisma.workspaceMember.create({
      data: { userId: dto.userId, workspaceId, role: dto.role },
    });
  }

  async updateMemberRole(
    workspaceId: string,
    userId: string,
    dto: UpdateMemberRoleDto,
  ) {
    const m = await this.prisma.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId, workspaceId } },
    });
    if (!m) throw new NotFoundException("Member not found");
    return this.prisma.workspaceMember.update({
      where: { id: m.id },
      data: { role: dto.role },
    });
  }

  async removeMember(workspaceId: string, userId: string) {
    const m = await this.prisma.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId, workspaceId } },
    });
    if (!m) throw new NotFoundException("Member not found");
    await this.prisma.workspaceMember.delete({ where: { id: m.id } });
    return { ok: true };
  }
}
```

- [ ] **Step 3: Create the controller**

Create `backend/src/workspaces/workspaces.controller.ts`:

```ts
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
} from "@nestjs/common";
import type { Request } from "express";
import { WorkspacesService } from "./workspaces.service";
import {
  AddMemberDto,
  CreateWorkspaceDto,
  UpdateMemberRoleDto,
  UpdateWorkspaceDto,
} from "./workspaces.dto";
import type { JwtPayload } from "../auth/auth.guard";

@Controller("workspaces")
export class WorkspacesController {
  constructor(private readonly svc: WorkspacesService) {}

  @Get()
  list(@Req() req: Request & { user: JwtPayload }) {
    return this.svc.listForUser(req.user.sub);
  }

  @Post()
  create(
    @Body() dto: CreateWorkspaceDto,
    @Req() req: Request & { user: JwtPayload },
  ) {
    return this.svc.create(dto, req.user.sub);
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.svc.get(id);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() dto: UpdateWorkspaceDto) {
    return this.svc.update(id, dto);
  }

  @Get(":id/members")
  listMembers(@Param("id") id: string) {
    return this.svc.listMembers(id);
  }

  @Post(":id/members")
  addMember(@Param("id") id: string, @Body() dto: AddMemberDto) {
    return this.svc.addMember(id, dto);
  }

  @Patch(":id/members/:userId")
  updateMemberRole(
    @Param("id") id: string,
    @Param("userId") userId: string,
    @Body() dto: UpdateMemberRoleDto,
  ) {
    return this.svc.updateMemberRole(id, userId, dto);
  }

  @Delete(":id/members/:userId")
  removeMember(@Param("id") id: string, @Param("userId") userId: string) {
    return this.svc.removeMember(id, userId);
  }
}
```

- [ ] **Step 4: Create the module**

Create `backend/src/workspaces/workspaces.module.ts`:

```ts
import { Module } from "@nestjs/common";
import { WorkspacesController } from "./workspaces.controller";
import { WorkspacesService } from "./workspaces.service";

@Module({
  controllers: [WorkspacesController],
  providers: [WorkspacesService],
  exports: [WorkspacesService],
})
export class WorkspacesModule {}
```

- [ ] **Step 5: Register in `app.module.ts`**

Open `backend/src/app.module.ts`. Add the import:

```ts
import { WorkspacesModule } from "./workspaces/workspaces.module";
```

Add `WorkspacesModule` to the `imports` array (after `MentionsModule`).

- [ ] **Step 6: Build**

From `backend/`:
```powershell
npm run build
```

Expected: clean exit 0.

- [ ] **Step 7: Commit**

```powershell
git add backend/src/workspaces backend/src/app.module.ts
git -c user.email=tkana@local -c user.name=tkana commit -m "feat(workspaces): CRUD module for workspaces and members"
```

---

## Task 4: Workspace context infra (AsyncLocalStorage + decorator + interceptor)

**Files:**
- Create: `backend/src/common/workspace-context.ts`
- Create: `backend/src/common/current-workspace.decorator.ts`
- Create: `backend/src/common/workspace.interceptor.ts`

- [ ] **Step 1: Create the AsyncLocalStorage singleton**

Create `backend/src/common/workspace-context.ts`:

```ts
import { AsyncLocalStorage } from "node:async_hooks";

export interface WorkspaceStore {
  workspaceId: string;
  userId: string;
}

export const workspaceContext = new AsyncLocalStorage<WorkspaceStore>();

/** Get the current workspace context, or null if not inside a request scope. */
export function getWorkspaceContext(): WorkspaceStore | null {
  return workspaceContext.getStore() ?? null;
}

/** Throws if called outside a workspace-scoped request. */
export function requireWorkspaceContext(): WorkspaceStore {
  const ctx = getWorkspaceContext();
  if (!ctx) {
    throw new Error(
      "Workspace context not set — caller must run inside a request scope",
    );
  }
  return ctx;
}
```

- [ ] **Step 2: Create the `@CurrentWorkspace()` decorator**

Create `backend/src/common/current-workspace.decorator.ts`:

```ts
import { createParamDecorator, ExecutionContext, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import type { JwtPayload } from "../auth/auth.guard";

/** Controller-level decorator: returns the workspaceId from the JWT payload.
 *  Throws 401 if absent (i.e., the token is from before multi-tenancy or the
 *  user hasn't picked a workspace yet). */
export const CurrentWorkspace = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest<Request & { user?: JwtPayload }>();
    const wsId = req.user?.workspaceId;
    if (!wsId) {
      throw new UnauthorizedException("No workspace selected");
    }
    return wsId;
  },
);

/** Returns userId from the JWT payload (Subject). */
export const CurrentUserId = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest<Request & { user?: JwtPayload }>();
    const sub = req.user?.sub;
    if (!sub) throw new UnauthorizedException("No user");
    return sub;
  },
);
```

- [ ] **Step 3: Create the interceptor**

Create `backend/src/common/workspace.interceptor.ts`:

```ts
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import type { Request } from "express";
import { Observable } from "rxjs";
import { workspaceContext } from "./workspace-context";
import type { JwtPayload } from "../auth/auth.guard";

@Injectable()
export class WorkspaceInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: JwtPayload }>();
    const wsId = req.user?.workspaceId;
    const userId = req.user?.sub;
    if (wsId && userId) {
      return new Observable((subscriber) => {
        workspaceContext.run({ workspaceId: wsId, userId }, () => {
          next.handle().subscribe({
            next: (v) => subscriber.next(v),
            error: (e) => subscriber.error(e),
            complete: () => subscriber.complete(),
          });
        });
      });
    }
    return next.handle();
  }
}
```

- [ ] **Step 4: Build to confirm**

From `backend/`:
```powershell
npm run build
```

Expected: exit 0. (We haven't wired the interceptor globally yet — that comes after we update JWT in Task 7.)

- [ ] **Step 5: Commit**

```powershell
git add backend/src/common
git -c user.email=tkana@local -c user.name=tkana commit -m "feat(common): workspace request context (AsyncLocalStorage + decorator + interceptor)"
```

---

## Task 5: Add `workspaceId` (nullable) to all customer-owned models

**Files:**
- Modify: `backend/prisma/schema.prisma`

We add `workspaceId` as `String?` (nullable) first, push, then backfill in Task 6, then tighten to non-null in Task 7.

- [ ] **Step 1: Update Contact model**

In `backend/prisma/schema.prisma`, find the `Contact` model. Add `workspaceId String?` after `convs Int @default(0)`. Also add the relation line and index:

```prisma
  workspaceId String?
  workspace   Workspace? @relation("WorkspaceContacts", fields: [workspaceId], references: [id], onDelete: Cascade)
```

And add this index at the end of the model (before closing `}`):
```prisma
  @@index([workspaceId])
```

- [ ] **Step 2: Update Conversation model**

In the `Conversation` model, add `workspaceId String?` near the top (after `agent` field). Add relation:

```prisma
  workspaceId String?
  workspace   Workspace? @relation("WorkspaceConversations", fields: [workspaceId], references: [id], onDelete: Cascade)
```

And index:
```prisma
  @@index([workspaceId])
```

- [ ] **Step 3: Update Message model**

In the `Message` model, add `workspaceId String?` after `attach String?`. Add relation:

```prisma
  workspaceId String?
  workspace   Workspace? @relation("WorkspaceMessages", fields: [workspaceId], references: [id], onDelete: Cascade)
```

And index:
```prisma
  @@index([workspaceId])
```

- [ ] **Step 4: Update Appointment model**

In `Appointment`, add `workspaceId String?` before `contact` relation. Add relation:

```prisma
  workspaceId String?
  workspace   Workspace? @relation("WorkspaceAppointments", fields: [workspaceId], references: [id], onDelete: Cascade)
```

Index:
```prisma
  @@index([workspaceId])
```

- [ ] **Step 5: Update Template model**

In `Template`, add `workspaceId String?` after `uses`. Add relation + index:

```prisma
  workspaceId String?
  workspace   Workspace? @relation("WorkspaceTemplates", fields: [workspaceId], references: [id], onDelete: Cascade)

  @@index([workspaceId])
```

- [ ] **Step 6: Update Pipeline model**

In `Pipeline`, change the unique constraint and add workspace fields. Replace:

```prisma
  key       String  @unique // "retail" | "bulk" | …
```

with:

```prisma
  key       String  // "retail" | "bulk" | …
```

Add workspace fields and the new compound unique:

```prisma
  workspaceId String?
  workspace   Workspace? @relation("WorkspacePipelines", fields: [workspaceId], references: [id], onDelete: Cascade)

  @@unique([workspaceId, key])
  @@index([workspaceId])
```

- [ ] **Step 7: Update TicketStage, Ticket, TicketActivity**

In each of `TicketStage`, `Ticket`, `TicketActivity`, add:

```prisma
  workspaceId String?
  workspace   Workspace? @relation("WorkspaceTicketStages", fields: [workspaceId], references: [id], onDelete: Cascade)

  @@index([workspaceId])
```

Use a unique relation name per model so Prisma doesn't complain:
- `TicketStage` → relation name `"WorkspaceTicketStages"`
- `Ticket` → relation name `"WorkspaceTickets"`
- `TicketActivity` → relation name `"WorkspaceTicketActivities"`

- [ ] **Step 8: Update Integration model**

In `Integration`, remove the `@unique` on `platform`. Replace:

```prisma
  platform     String   @unique // "facebook" | "instagram" | "tiktok" — one row per platform
```

with:

```prisma
  platform     String   // "facebook" | "instagram" | "tiktok"
```

Add workspace fields and the new compound unique:

```prisma
  workspaceId String?
  workspace   Workspace? @relation("WorkspaceIntegrations", fields: [workspaceId], references: [id], onDelete: Cascade)

  @@unique([workspaceId, platform])
  @@index([workspaceId])
```

- [ ] **Step 9: Update Campaign model**

In `Campaign`, add workspace fields + index:

```prisma
  workspaceId String?
  workspace   Workspace? @relation("WorkspaceCampaigns", fields: [workspaceId], references: [id], onDelete: Cascade)

  @@index([workspaceId])
```

- [ ] **Step 10: Update Keyword, Mention, Note**

Each one gets workspace fields + index with a unique relation name:

`Keyword`:
```prisma
  workspaceId String?
  workspace   Workspace? @relation("WorkspaceKeywords", fields: [workspaceId], references: [id], onDelete: Cascade)

  @@index([workspaceId])
```

`Mention`:
```prisma
  workspaceId String?
  workspace   Workspace? @relation("WorkspaceMentions", fields: [workspaceId], references: [id], onDelete: Cascade)

  @@index([workspaceId])
```

`Note`:
```prisma
  workspaceId String?
  workspace   Workspace? @relation("WorkspaceNotes", fields: [workspaceId], references: [id], onDelete: Cascade)

  @@index([workspaceId])
```

- [ ] **Step 11: Add the back-relations on Workspace**

Find the `Workspace` model. Add ALL the back-relations before `createdAt`:

```prisma
  contacts          Contact[]          @relation("WorkspaceContacts")
  conversations     Conversation[]     @relation("WorkspaceConversations")
  messages          Message[]          @relation("WorkspaceMessages")
  appointments      Appointment[]      @relation("WorkspaceAppointments")
  templates         Template[]         @relation("WorkspaceTemplates")
  campaigns         Campaign[]         @relation("WorkspaceCampaigns")
  pipelines         Pipeline[]         @relation("WorkspacePipelines")
  ticketStages      TicketStage[]      @relation("WorkspaceTicketStages")
  tickets           Ticket[]           @relation("WorkspaceTickets")
  ticketActivities  TicketActivity[]   @relation("WorkspaceTicketActivities")
  integrations      Integration[]      @relation("WorkspaceIntegrations")
  keywords          Keyword[]          @relation("WorkspaceKeywords")
  mentions          Mention[]          @relation("WorkspaceMentions")
  notes             Note[]             @relation("WorkspaceNotes")
```

- [ ] **Step 12: Push schema**

From `backend/`:
```powershell
npx prisma db push --accept-data-loss
```

Note: `--accept-data-loss` is needed because Prisma considers dropping the unique constraints on `Pipeline.key` and `Integration.platform` as a potential data loss event. We're aware and accept.

Expected: "Your database is now in sync with your Prisma schema."

- [ ] **Step 13: Build to confirm**

From `backend/`:
```powershell
npm run build
```

Expected: backend build will FAIL with TypeScript errors in the services that reference Prisma — because Prisma types now include the new `workspaceId` field which doesn't have a default, and existing service code doesn't supply it. This is expected. The errors will say something like `Property 'workspaceId' is missing in type ...`. We fix these in the per-service refactor tasks (Tasks 10-15). For now, just note the failure and continue — the schema is correct.

Actually, since the field is nullable (`String?`), TypeScript will allow `undefined` and the build SHOULD succeed. If it fails for other reasons (not nullability), report them.

If build fails on Pipeline `@@unique([pipelineId, number])` in `Ticket` — that's unchanged; should still work. If it fails on Pipeline.key unique constraint — that's the one we dropped, should be fine.

- [ ] **Step 14: Commit**

```powershell
git add backend/prisma/schema.prisma
git -c user.email=tkana@local -c user.name=tkana commit -m "feat(db): add workspaceId (nullable) to all customer-owned models"
```

---

## Task 6: Data migration script — create Default Workspace, backfill all rows

**Files:**
- Create: `backend/scripts/migrate-multi-tenant.ts`

- [ ] **Step 1: Write the migration script**

Create `backend/scripts/migrate-multi-tenant.ts`:

```ts
/* eslint-disable no-console */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // 1) Get or create the Default Workspace.
  let defaultWs = await prisma.workspace.findFirst({
    where: { slug: "default" },
  });
  if (!defaultWs) {
    defaultWs = await prisma.workspace.create({
      data: {
        name: "Default Workspace",
        slug: "default",
        timezone: "Asia/Riyadh",
        lang: "ar",
        plan: "free",
      },
    });
    console.log(`Created Default Workspace: ${defaultWs.id}`);
  } else {
    console.log(`Default Workspace already exists: ${defaultWs.id}`);
  }
  const wsId = defaultWs.id;

  // 2) Make all existing users Owners of the Default Workspace (idempotent).
  const users = await prisma.user.findMany();
  for (const u of users) {
    const existing = await prisma.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId: u.id, workspaceId: wsId } },
    });
    if (!existing) {
      await prisma.workspaceMember.create({
        data: { userId: u.id, workspaceId: wsId, role: "owner" },
      });
      console.log(`  Added ${u.email} as owner`);
    }
  }

  // 3) Backfill workspaceId on every customer-owned table.
  const updates: Array<{ name: string; count: number }> = [];

  for (const [name, fn] of [
    ["Contact",         () => prisma.contact.updateMany({ where: { workspaceId: null }, data: { workspaceId: wsId } })],
    ["Conversation",    () => prisma.conversation.updateMany({ where: { workspaceId: null }, data: { workspaceId: wsId } })],
    ["Message",         () => prisma.message.updateMany({ where: { workspaceId: null }, data: { workspaceId: wsId } })],
    ["Appointment",     () => prisma.appointment.updateMany({ where: { workspaceId: null }, data: { workspaceId: wsId } })],
    ["Template",        () => prisma.template.updateMany({ where: { workspaceId: null }, data: { workspaceId: wsId } })],
    ["Campaign",        () => prisma.campaign.updateMany({ where: { workspaceId: null }, data: { workspaceId: wsId } })],
    ["Pipeline",        () => prisma.pipeline.updateMany({ where: { workspaceId: null }, data: { workspaceId: wsId } })],
    ["TicketStage",     () => prisma.ticketStage.updateMany({ where: { workspaceId: null }, data: { workspaceId: wsId } })],
    ["Ticket",          () => prisma.ticket.updateMany({ where: { workspaceId: null }, data: { workspaceId: wsId } })],
    ["TicketActivity",  () => prisma.ticketActivity.updateMany({ where: { workspaceId: null }, data: { workspaceId: wsId } })],
    ["Integration",     () => prisma.integration.updateMany({ where: { workspaceId: null }, data: { workspaceId: wsId } })],
    ["Keyword",         () => prisma.keyword.updateMany({ where: { workspaceId: null }, data: { workspaceId: wsId } })],
    ["Mention",         () => prisma.mention.updateMany({ where: { workspaceId: null }, data: { workspaceId: wsId } })],
    ["Note",            () => prisma.note.updateMany({ where: { workspaceId: null }, data: { workspaceId: wsId } })],
  ] as const) {
    const res = await fn();
    updates.push({ name, count: res.count });
  }

  console.log("\nBackfill summary:");
  for (const u of updates) console.log(`  ${u.name.padEnd(20)} ${u.count}`);

  // 4) Verify no rows remain with null workspaceId on any table.
  const checks: Array<{ name: string; nulls: number }> = [];
  for (const [name, fn] of [
    ["Contact",         () => prisma.contact.count({ where: { workspaceId: null } })],
    ["Conversation",    () => prisma.conversation.count({ where: { workspaceId: null } })],
    ["Message",         () => prisma.message.count({ where: { workspaceId: null } })],
    ["Appointment",     () => prisma.appointment.count({ where: { workspaceId: null } })],
    ["Template",        () => prisma.template.count({ where: { workspaceId: null } })],
    ["Campaign",        () => prisma.campaign.count({ where: { workspaceId: null } })],
    ["Pipeline",        () => prisma.pipeline.count({ where: { workspaceId: null } })],
    ["TicketStage",     () => prisma.ticketStage.count({ where: { workspaceId: null } })],
    ["Ticket",          () => prisma.ticket.count({ where: { workspaceId: null } })],
    ["TicketActivity",  () => prisma.ticketActivity.count({ where: { workspaceId: null } })],
    ["Integration",     () => prisma.integration.count({ where: { workspaceId: null } })],
    ["Keyword",         () => prisma.keyword.count({ where: { workspaceId: null } })],
    ["Mention",         () => prisma.mention.count({ where: { workspaceId: null } })],
    ["Note",            () => prisma.note.count({ where: { workspaceId: null } })],
  ] as const) {
    checks.push({ name, nulls: await fn() });
  }
  const stillNull = checks.filter((c) => c.nulls > 0);
  if (stillNull.length > 0) {
    console.error("\nFAILED: some tables still have null workspaceId rows:");
    for (const c of stillNull) console.error(`  ${c.name}: ${c.nulls}`);
    process.exit(1);
  }
  console.log("\nAll customer-owned rows are now scoped to a workspace. ✓");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  prisma.$disconnect();
  process.exit(1);
});
```

- [ ] **Step 2: Run the migration**

From `backend/`:
```powershell
npx tsx scripts/migrate-multi-tenant.ts
```

Expected output: lines reporting users added, backfill counts per table, and a final `✓` line. If any table reports `FAILED`, stop and investigate before continuing.

- [ ] **Step 3: Verify in Prisma Studio**

From `backend/`:
```powershell
npx prisma studio
```

- Check `Workspace` table: one row "Default Workspace".
- Check `WorkspaceMember` table: one row per existing user, all with `role: "owner"`.
- Spot-check `Contact`, `Integration`, `Note`, `Mention`: every row should have a non-null `workspaceId`.

Close Studio.

- [ ] **Step 4: Commit**

```powershell
git add backend/scripts/migrate-multi-tenant.ts
git -c user.email=tkana@local -c user.name=tkana commit -m "feat(scripts): one-shot data migration to Default Workspace"
```

---

## Task 7: Tighten schema — make `workspaceId` required + update JWT payload

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Modify: `backend/src/auth/auth.guard.ts`

- [ ] **Step 1: Make `workspaceId` non-nullable on every customer-owned model**

In `backend/prisma/schema.prisma`, for each of the models from Task 5, change:

```prisma
  workspaceId String?
  workspace   Workspace? @relation("WorkspaceX", fields: [workspaceId], references: [id], onDelete: Cascade)
```

to:

```prisma
  workspaceId String
  workspace   Workspace @relation("WorkspaceX", fields: [workspaceId], references: [id], onDelete: Cascade)
```

(Remove the `?` after `String` on `workspaceId`, and after `Workspace` on the relation.)

Models to update:
- Contact, Conversation, Message, Appointment, Template, Campaign
- Pipeline, TicketStage, Ticket, TicketActivity
- Integration, Keyword, Mention, Note

- [ ] **Step 2: Push schema**

From `backend/`:
```powershell
npx prisma db push
```

Expected: "Your database is now in sync with your Prisma schema." If you get a "non-null constraint" error here, it means some row still has null `workspaceId` — re-run the migration script from Task 6.

- [ ] **Step 3: Update JWT payload type**

Open `backend/src/auth/auth.guard.ts`. Replace the `JwtPayload` interface (lines 12-16) with:

```ts
export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
  workspaceId?: string; // undefined when user has multiple workspaces and hasn't picked one
}
```

The `workspaceId` is optional because of the "user has many workspaces and hasn't picked one yet" flow.

- [ ] **Step 4: Build to confirm**

From `backend/`:
```powershell
npm run build
```

Expected: this will likely FAIL with TypeScript errors in many service files (Contact, Mention, etc.) because the now-required `workspaceId` isn't supplied on `create` calls. These get fixed in Tasks 10-15. Note the errors and continue.

- [ ] **Step 5: Commit (even if build fails — the codebase is intentionally in transition until Tasks 10-15 land)**

```powershell
git add backend/prisma/schema.prisma backend/src/auth/auth.guard.ts
git -c user.email=tkana@local -c user.name=tkana commit -m "feat(db): make workspaceId required on all customer-owned models; extend JWT payload"
```

---

## Task 8: Update auth — register creates workspace; login/switch handle multi-workspace

**Files:**
- Modify: `backend/src/auth/auth.service.ts`
- Modify: `backend/src/auth/auth.controller.ts`
- Modify: `backend/src/auth/dto.ts`
- Modify: `backend/src/auth/auth.module.ts`

- [ ] **Step 1: Update DTOs**

Open `backend/src/auth/dto.ts`. Add a `SwitchWorkspaceDto` and extend `RegisterDto`:

```ts
import { IsEmail, IsNotEmpty, IsOptional, IsString, MinLength } from "class-validator";

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(6)
  password!: string;
}

export class RegisterDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(6)
  password!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsString()
  role?: string;

  @IsOptional()
  @IsString()
  color?: string;

  // Workspace name to create for this new user (they become owner).
  // Falls back to "{name}'s workspace" if omitted.
  @IsOptional()
  @IsString()
  workspaceName?: string;
}

export class SwitchWorkspaceDto {
  @IsString()
  @MinLength(1)
  workspaceId!: string;
}
```

- [ ] **Step 2: Update auth.service.ts**

Replace the entire content of `backend/src/auth/auth.service.ts` with:

```ts
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcryptjs";
import { PrismaService } from "../prisma/prisma.service";
import { WorkspacesService } from "../workspaces/workspaces.service";
import { LoginDto, RegisterDto, SwitchWorkspaceDto } from "./dto";
import type { JwtPayload } from "./auth.guard";

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly workspaces: WorkspacesService,
  ) {}

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (!user) throw new UnauthorizedException("Invalid credentials");
    const ok = await bcrypt.compare(dto.password, user.password);
    if (!ok) throw new UnauthorizedException("Invalid credentials");

    const memberships = await this.workspaces.listForUser(user.id);
    if (memberships.length === 0) {
      // Edge case: user with no workspace memberships. Create one on the fly
      // so they always land somewhere.
      const ws = await this.workspaces.create(
        { name: `${user.name}'s workspace` },
        user.id,
      );
      return this.issue(user, ws.id, [
        {
          id: ws.id,
          name: ws.name,
          slug: ws.slug,
          timezone: ws.timezone,
          lang: ws.lang,
          plan: ws.plan,
          role: "owner",
        },
      ]);
    }
    if (memberships.length === 1) {
      // Single workspace — auto-select.
      return this.issue(user, memberships[0].id, memberships);
    }
    // Multiple workspaces — return list, client picks via /auth/switch-workspace.
    return this.issue(user, null, memberships);
  }

  async register(dto: RegisterDto) {
    const exists = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (exists) throw new ConflictException("Email already in use");
    const initials = dto.name
      .split(" ")
      .map((s) => s[0] ?? "")
      .join("")
      .slice(0, 2)
      .toUpperCase();
    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        password: await bcrypt.hash(dto.password, 10),
        name: dto.name,
        role: dto.role ?? "Agent",
        color: dto.color ?? "200",
        initials,
      },
    });
    // Auto-create their workspace and assign Owner role.
    const ws = await this.workspaces.create(
      { name: dto.workspaceName ?? `${dto.name}'s workspace` },
      user.id,
    );
    const memberships = await this.workspaces.listForUser(user.id);
    return this.issue(user, ws.id, memberships);
  }

  async switchWorkspace(userId: string, dto: SwitchWorkspaceDto) {
    // Verify membership.
    await this.workspaces.requireMember(userId, dto.workspaceId);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const memberships = await this.workspaces.listForUser(userId);
    return this.issue(user, dto.workspaceId, memberships);
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException("User no longer exists");
    return this.shape(user);
  }

  async myWorkspaces(userId: string) {
    return this.workspaces.listForUser(userId);
  }

  private async issue(
    user: { id: string; email: string; role: string },
    workspaceId: string | null,
    workspaces: Awaited<ReturnType<WorkspacesService["listForUser"]>>,
  ) {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      ...(workspaceId ? { workspaceId } : {}),
    };
    const token = await this.jwt.signAsync(payload);
    const full = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    return {
      token,
      user: this.shape(full),
      workspaces,
      activeWorkspaceId: workspaceId,
    };
  }

  private shape(u: {
    id: string;
    email: string;
    name: string;
    role: string;
    initials: string;
    color: string;
  }) {
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      initials: u.initials,
      color: u.color,
    };
  }
}
```

- [ ] **Step 3: Update auth.controller.ts**

Replace `backend/src/auth/auth.controller.ts` with:

```ts
import { Body, Controller, Get, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { AuthService } from "./auth.service";
import { LoginDto, RegisterDto, SwitchWorkspaceDto } from "./dto";
import { Public } from "./public.decorator";
import type { JwtPayload } from "./auth.guard";

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post("login")
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  @Public()
  @Post("register")
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Get("me")
  me(@Req() req: Request & { user: JwtPayload }) {
    return this.auth.me(req.user.sub);
  }

  @Get("workspaces")
  myWorkspaces(@Req() req: Request & { user: JwtPayload }) {
    return this.auth.myWorkspaces(req.user.sub);
  }

  @Post("switch-workspace")
  switchWorkspace(
    @Body() dto: SwitchWorkspaceDto,
    @Req() req: Request & { user: JwtPayload },
  ) {
    return this.auth.switchWorkspace(req.user.sub, dto);
  }
}
```

- [ ] **Step 4: Update auth.module.ts**

Open `backend/src/auth/auth.module.ts`. Add an import of `WorkspacesModule` and put it in the `imports` array so `WorkspacesService` is available for DI:

```ts
import { WorkspacesModule } from "../workspaces/workspaces.module";
```

Add `WorkspacesModule` to the `imports` array.

- [ ] **Step 5: Build to confirm**

From `backend/`:
```powershell
npm run build
```

Expected: should pass. If TypeScript complains about Prisma queries with `workspaceId` missing, that's the per-service refactor pending (Tasks 10-15). Auth itself should compile cleanly.

- [ ] **Step 6: Commit**

```powershell
git add backend/src/auth
git -c user.email=tkana@local -c user.name=tkana commit -m "feat(auth): register creates workspace; login + switch-workspace handle multi-workspace users"
```

---

## Task 9: Wire `WorkspaceInterceptor` globally + Prisma tenancy extension

**Files:**
- Create: `backend/src/common/prisma-tenancy.ts`
- Modify: `backend/src/prisma/prisma.service.ts`
- Modify: `backend/src/app.module.ts`

- [ ] **Step 1: Create the Prisma extension**

Create `backend/src/common/prisma-tenancy.ts`:

```ts
import { Prisma } from "@prisma/client";
import { getWorkspaceContext } from "./workspace-context";

/** Models that carry workspaceId and must always be scoped. */
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
]);

/** Read actions that should be filtered by workspaceId. */
const READ_ACTIONS = new Set([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "count",
  "aggregate",
  "groupBy",
]);

/** Write actions where data should carry workspaceId. */
const CREATE_ACTIONS = new Set(["create", "createMany"]);

/** Actions where we filter by workspaceId on `where`. */
const WHERE_ACTIONS = new Set([
  "updateMany",
  "deleteMany",
]);

/**
 * Prisma client extension that auto-injects the active workspaceId on:
 *  - read filters
 *  - create payloads
 *  - update/delete filters
 * Acts as a safety net behind the explicit scoping in service methods.
 * Skipped entirely when no workspace context is set (e.g., the migration script).
 */
export const tenancyExtension = Prisma.defineExtension({
  name: "workspace-tenancy",
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const ctx = getWorkspaceContext();
        if (!ctx || !model || !SCOPED_MODELS.has(model)) {
          return query(args);
        }
        const wsId = ctx.workspaceId;

        // Reads: inject workspaceId into where
        if (READ_ACTIONS.has(operation)) {
          const a = (args ?? {}) as { where?: Record<string, unknown> };
          a.where = { ...(a.where ?? {}), workspaceId: wsId };
          return query(a as typeof args);
        }

        // Creates: inject workspaceId into data
        if (CREATE_ACTIONS.has(operation)) {
          const a = args as { data: Record<string, unknown> | Record<string, unknown>[] };
          if (Array.isArray(a.data)) {
            a.data = a.data.map((row) => ({ workspaceId: wsId, ...row }));
          } else {
            a.data = { workspaceId: wsId, ...a.data };
          }
          return query(a as typeof args);
        }

        // updateMany / deleteMany: inject workspaceId into where
        if (WHERE_ACTIONS.has(operation)) {
          const a = (args ?? {}) as { where?: Record<string, unknown> };
          a.where = { ...(a.where ?? {}), workspaceId: wsId };
          return query(a as typeof args);
        }

        // findUnique / update / delete / upsert by id: post-filter to ensure
        // the result belongs to the active workspace (defense for stolen ids).
        if (
          operation === "findUnique" ||
          operation === "findUniqueOrThrow"
        ) {
          const result = (await query(args)) as { workspaceId?: string } | null;
          if (result && result.workspaceId && result.workspaceId !== wsId) {
            return null as never;
          }
          return result as never;
        }

        return query(args);
      },
    },
  },
});
```

- [ ] **Step 2: Apply the extension in PrismaService**

Open `backend/src/prisma/prisma.service.ts`. Read it first to know its shape, then replace its content with:

```ts
import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { tenancyExtension } from "../common/prisma-tenancy";

/** Type alias for the extended Prisma client. */
type ExtendedPrismaClient = ReturnType<typeof makeExtended>;

function makeExtended() {
  const base = new PrismaClient();
  return base.$extends(tenancyExtension);
}

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly client: ExtendedPrismaClient = makeExtended();

  async onModuleInit(): Promise<void> {
    // PrismaClient connects lazily on first query; no-op here is fine.
  }

  async onModuleDestroy(): Promise<void> {
    // The extended client wraps the base; we need to disconnect the base.
    // The $extends API returns a Proxy whose `$disconnect` works the same.
    await (this.client as unknown as PrismaClient).$disconnect();
  }

  // ─── Delegates ────────────────────────────────────────────────────────
  // Forward every model accessor through the extended client.
  // Using a Proxy so we don't have to enumerate every model.

  // For Prisma 5 with $extends, the result is a different type than
  // PrismaClient. We expose it as `any`-shaped delegators here; callers
  // use them like the original. TypeScript inference still works at the
  // call site because we cast each delegator to the original Prisma type.

  get contact() { return this.client.contact; }
  get user() { return this.client.user; }
  get workspace() { return this.client.workspace; }
  get workspaceMember() { return this.client.workspaceMember; }
  get conversation() { return this.client.conversation; }
  get message() { return this.client.message; }
  get appointment() { return this.client.appointment; }
  get template() { return this.client.template; }
  get campaign() { return this.client.campaign; }
  get pipeline() { return this.client.pipeline; }
  get ticketStage() { return this.client.ticketStage; }
  get ticket() { return this.client.ticket; }
  get ticketActivity() { return this.client.ticketActivity; }
  get integration() { return this.client.integration; }
  get keyword() { return this.client.keyword; }
  get mention() { return this.client.mention; }
  get note() { return this.client.note; }

  get $transaction() { return this.client.$transaction.bind(this.client); }
  get $extends() { return this.client.$extends.bind(this.client); }
}
```

- [ ] **Step 3: Wire WorkspaceInterceptor globally + register WorkspacesModule (already done in Task 3)**

Open `backend/src/app.module.ts`. Add the imports at the top:

```ts
import { APP_INTERCEPTOR } from "@nestjs/core";
import { WorkspaceInterceptor } from "./common/workspace.interceptor";
```

Add to the `providers` array of `@Module({...})` (create one if it doesn't exist):

```ts
providers: [
  { provide: APP_INTERCEPTOR, useClass: WorkspaceInterceptor },
],
```

If `providers` already exists, just add the new entry inside it.

- [ ] **Step 4: Build**

From `backend/`:
```powershell
npm run build
```

Expected: clean. If PrismaService's delegator gets type errors because of how `$extends` types work in Prisma 5, the simplest fallback is to declare each delegator with `as PrismaClient["contact"]` etc. — read the actual Prisma error and adjust the property type only.

- [ ] **Step 5: Commit**

```powershell
git add backend/src/common/prisma-tenancy.ts backend/src/prisma/prisma.service.ts backend/src/app.module.ts
git -c user.email=tkana@local -c user.name=tkana commit -m "feat(common): apply Prisma tenancy extension + register WorkspaceInterceptor globally"
```

---

## Task 10: Refactor Contacts module

**Files:**
- Modify: `backend/src/contacts/contacts.service.ts`
- Modify: `backend/src/contacts/contacts.controller.ts`

The tenancy Prisma extension already auto-scopes most queries when called inside a request. We update the service to ALSO pass workspaceId explicitly (defense in depth) and the controller to extract it via the decorator.

- [ ] **Step 1: Update the service**

Open `backend/src/contacts/contacts.service.ts`. Replace its content with:

```ts
import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreateContactDto, UpdateContactDto } from "./contacts.dto";

interface ContactRow {
  id: string;
  name: string;
  phone: string | null;
  industry: string;
  lifecycle: string;
  source: string;
  value: string | null;
  lastSeen: string;
  tags: string;
  convs: number;
}

const shape = (c: ContactRow) => ({
  id: c.id,
  name: c.name,
  phone: c.phone ?? "",
  industry: c.industry,
  lifecycle: c.lifecycle,
  source: c.source,
  value: c.value ?? "—",
  lastSeen: c.lastSeen,
  tags: JSON.parse(c.tags) as string[],
  convs: c.convs,
});

@Injectable()
export class ContactsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(workspaceId: string) {
    const rows = await this.prisma.contact.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(shape);
  }

  async get(workspaceId: string, id: string) {
    const row = await this.prisma.contact.findFirst({
      where: { id, workspaceId },
    });
    if (!row) throw new NotFoundException("Contact not found");
    return shape(row);
  }

  async create(workspaceId: string, dto: CreateContactDto) {
    const row = await this.prisma.contact.create({
      data: {
        workspaceId,
        name: dto.name,
        phone: dto.phone ?? null,
        industry: dto.industry,
        lifecycle: dto.lifecycle,
        source: dto.source,
        value: dto.value ?? null,
        lastSeen: dto.lastSeen ?? "just now",
        tags: JSON.stringify(dto.tags ?? []),
        convs: dto.convs ?? 0,
      },
    });
    return shape(row);
  }

  async update(workspaceId: string, id: string, dto: UpdateContactDto) {
    await this.get(workspaceId, id);
    const row = await this.prisma.contact.update({
      where: { id },
      data: {
        ...dto,
        tags: dto.tags !== undefined ? JSON.stringify(dto.tags) : undefined,
      },
    });
    return shape(row);
  }

  async remove(workspaceId: string, id: string) {
    await this.get(workspaceId, id);
    await this.prisma.contact.delete({ where: { id } });
    return { ok: true };
  }
}
```

- [ ] **Step 2: Update the controller**

Open `backend/src/contacts/contacts.controller.ts`. Replace with:

```ts
import { Body, Controller, Delete, Get, Param, Patch, Post } from "@nestjs/common";
import { ContactsService } from "./contacts.service";
import { CreateContactDto, UpdateContactDto } from "./contacts.dto";
import { CurrentWorkspace } from "../common/current-workspace.decorator";

@Controller("contacts")
export class ContactsController {
  constructor(private readonly svc: ContactsService) {}

  @Get()
  list(@CurrentWorkspace() workspaceId: string) {
    return this.svc.list(workspaceId);
  }

  @Get(":id")
  get(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.get(workspaceId, id);
  }

  @Post()
  create(
    @CurrentWorkspace() workspaceId: string,
    @Body() dto: CreateContactDto,
  ) {
    return this.svc.create(workspaceId, dto);
  }

  @Patch(":id")
  update(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Body() dto: UpdateContactDto,
  ) {
    return this.svc.update(workspaceId, id, dto);
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

- [ ] **Step 3: Build**

From `backend/`:
```powershell
npm run build
```

Expected: clean for contacts. Other modules may still fail — that's expected.

- [ ] **Step 4: Commit**

```powershell
git add backend/src/contacts
git -c user.email=tkana@local -c user.name=tkana commit -m "feat(contacts): scope service and controller by workspaceId"
```

---

## Task 11: Refactor Conversations module

**Files:**
- Modify: `backend/src/conversations/conversations.service.ts`
- Modify: `backend/src/conversations/conversations.controller.ts`

- [ ] **Step 1: Update the service**

Replace `backend/src/conversations/conversations.service.ts`:

```ts
import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import {
  CreateConversationDto,
  CreateMessageDto,
  UpdateConversationDto,
} from "./conversations.dto";

@Injectable()
export class ConversationsService {
  constructor(private readonly prisma: PrismaService) {}

  list(workspaceId: string) {
    return this.prisma.conversation.findMany({
      where: { workspaceId },
      orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
    });
  }

  async get(workspaceId: string, id: string) {
    const conv = await this.prisma.conversation.findFirst({
      where: { id, workspaceId },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
    if (!conv) throw new NotFoundException("Conversation not found");
    return conv;
  }

  create(workspaceId: string, dto: CreateConversationDto) {
    return this.prisma.conversation.create({
      data: {
        ...dto,
        workspaceId,
        unread: 0,
        pinned: dto.pinned ?? false,
        escalated: dto.escalated ?? false,
      },
    });
  }

  async update(workspaceId: string, id: string, dto: UpdateConversationDto) {
    await this.get(workspaceId, id);
    return this.prisma.conversation.update({ where: { id }, data: dto });
  }

  async markRead(workspaceId: string, id: string) {
    await this.get(workspaceId, id);
    return this.prisma.conversation.update({
      where: { id },
      data: { unread: 0 },
    });
  }

  async remove(workspaceId: string, id: string) {
    await this.get(workspaceId, id);
    await this.prisma.conversation.delete({ where: { id } });
    return { ok: true };
  }

  async listMessages(workspaceId: string, conversationId: string) {
    await this.get(workspaceId, conversationId);
    return this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: "asc" },
    });
  }

  async addMessage(
    workspaceId: string,
    conversationId: string,
    dto: CreateMessageDto,
  ) {
    await this.get(workspaceId, conversationId);
    const now = new Date();
    const t = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const message = await this.prisma.message.create({
      data: { ...dto, conversationId, workspaceId, t },
    });
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        preview: dto.body.slice(0, 140),
        lastAt: "now",
        lastFrom: dto.from,
        unread: dto.from === "them" ? { increment: 1 } : 0,
      },
    });
    return message;
  }
}
```

- [ ] **Step 2: Update the controller**

Read `backend/src/conversations/conversations.controller.ts` first (it has more endpoints than contacts). Then mechanically apply this pattern to every controller method:
- Add `@CurrentWorkspace() workspaceId: string` as the first parameter
- Pass `workspaceId` as the first argument to every `svc.X()` call

Example transformation:
```ts
// before
@Get()
list() { return this.svc.list(); }

// after
@Get()
list(@CurrentWorkspace() workspaceId: string) {
  return this.svc.list(workspaceId);
}
```

Apply this to every endpoint in the file. Add the import:
```ts
import { CurrentWorkspace } from "../common/current-workspace.decorator";
```

- [ ] **Step 3: Build**

```powershell
npm run build
```

Expected: conversations builds. Other unrefactored modules still fail.

- [ ] **Step 4: Commit**

```powershell
git add backend/src/conversations
git -c user.email=tkana@local -c user.name=tkana commit -m "feat(conversations): scope service and controller by workspaceId"
```

---

## Task 12: Refactor Appointments, Templates, Campaigns, Team, Dashboard

**Files:**
- Modify: `backend/src/appointments/appointments.service.ts`
- Modify: `backend/src/appointments/appointments.controller.ts`
- Modify: `backend/src/templates/templates.module.ts` (if templates has a service)
- Modify: any service/controller files in `templates`, `campaigns`, `team`, `dashboard`

For each module:

- [ ] **Step 1: Read the existing service file**

For each module, run `Read` on the service file. Note all methods.

- [ ] **Step 2: Add `workspaceId` as first parameter to every method, pass to Prisma `where` and `data`**

Mechanical transformation for each method:
- Add `workspaceId: string` as the first parameter
- Add `workspaceId` to the `where` clause for reads (findMany, findFirst, count, etc.)
- Add `workspaceId` to `data` for creates
- For methods that operate on a single record by id, use `findFirst({ where: { id, workspaceId } })` instead of `findUnique({ where: { id } })` so the workspace check is enforced.

- [ ] **Step 3: Add `@CurrentWorkspace() workspaceId: string` as first parameter to every controller method**

In every controller in this batch, add the import:
```ts
import { CurrentWorkspace } from "../common/current-workspace.decorator";
```

Then add the param to each method.

- [ ] **Step 4: Build**

```powershell
npm run build
```

Expected: these modules now build clean. Tickets, Notes, Mentions, Keywords, Integrations still fail.

- [ ] **Step 5: Commit**

```powershell
git add backend/src/appointments backend/src/templates backend/src/campaigns backend/src/team backend/src/dashboard
git -c user.email=tkana@local -c user.name=tkana commit -m "feat: scope appointments/templates/campaigns/team/dashboard by workspaceId"
```

---

## Task 13: Refactor Tickets module (pipelines, stages, tickets, activities)

**Files:**
- Modify: `backend/src/tickets/tickets.service.ts`
- Modify: `backend/src/tickets/tickets.controller.ts`

This is the largest module. The same mechanical pattern applies.

- [ ] **Step 1: Read the current service file**

Run `Read` on `backend/src/tickets/tickets.service.ts` to see all methods. Note that some methods cross multiple tables (Pipeline → TicketStage → Ticket → TicketActivity).

- [ ] **Step 2: Apply scoping to every method**

For each method:
- Accept `workspaceId: string` as first parameter
- Add `workspaceId` to all `where` clauses for Pipeline, TicketStage, Ticket, TicketActivity reads
- Add `workspaceId` to all `data` for creates (including TicketActivity creates — denormalize from the parent ticket)

Specifically:
- `listPipelines(workspaceId)` → filter Pipelines by workspaceId
- `getPipeline(workspaceId, id)` → findFirst with both
- `listTickets(workspaceId, q)` → filter by workspaceId + existing q filters
- `getTicket(workspaceId, id)` → findFirst with both, include relations
- `createTicket(workspaceId, dto)` → set workspaceId on the new Ticket
- `moveTicket(workspaceId, id, dto)` → verify ticket belongs to workspace before move; TicketActivity insert gets workspaceId too
- `addNote(workspaceId, id, dto)` → TicketActivity insert with workspaceId
- `deleteTicket(workspaceId, id)` → verify before delete
- `dashboardSummary(workspaceId)` → filter all aggregations by workspaceId

For new ticket number generation:
```ts
const lastTicket = await this.prisma.ticket.findFirst({
  where: { pipelineId, workspaceId },
  orderBy: { number: "desc" },
});
```

- [ ] **Step 3: Update the controller**

Add `@CurrentWorkspace() workspaceId: string` to every endpoint method. Add the import.

- [ ] **Step 4: Build**

```powershell
npm run build
```

- [ ] **Step 5: Commit**

```powershell
git add backend/src/tickets
git -c user.email=tkana@local -c user.name=tkana commit -m "feat(tickets): scope pipelines, stages, tickets, and activities by workspaceId"
```

---

## Task 14: Refactor Notes, Mentions, Keywords, OpenTicketService

**Files:**
- Modify: `backend/src/notes/notes.service.ts`
- Modify: `backend/src/notes/notes.controller.ts`
- Modify: `backend/src/mentions/mentions.service.ts`
- Modify: `backend/src/mentions/mentions.controller.ts`
- Modify: `backend/src/mentions/keywords.service.ts`
- Modify: `backend/src/mentions/keywords.controller.ts`
- Modify: `backend/src/mentions/open-ticket.service.ts`
- Modify: `backend/src/mentions/mentions.scheduler.ts`
- Modify: `backend/src/mentions/sources/meta-ig.poller.ts`

- [ ] **Step 1: Apply scoping pattern to Notes, Mentions, Keywords services + controllers**

Same mechanical pattern: `workspaceId` first parameter on every method; `where` and `data` updated; controllers use `@CurrentWorkspace()`.

- [ ] **Step 2: Update OpenTicketService**

`backend/src/mentions/open-ticket.service.ts` — the `fromMention(mentionId)` method must:
- Take `workspaceId` as first parameter
- Verify mention belongs to workspaceId before operating
- Create Contact + Ticket + TicketActivity all with workspaceId set
- Update Note creation (if any) with workspaceId

Updated signature:
```ts
async fromMention(workspaceId: string, mentionId: string) {
  const mention = await this.prisma.mention.findFirst({
    where: { id: mentionId, workspaceId },
  });
  // ... rest of the existing transaction, but every create includes workspaceId
}
```

Controllers that call this update their wiring.

- [ ] **Step 3: Update MentionsScheduler**

`backend/src/mentions/mentions.scheduler.ts` has a `runOnce()` method. Now it needs to iterate per-workspace:

```ts
async runOnce(): Promise<{ scanned: number; ingested: number }> {
  const workspaces = await this.prisma.workspace.findMany();
  let totalScanned = 0;
  let totalIngested = 0;
  for (const ws of workspaces) {
    const { scanned, ingested } = await this.runOnceForWorkspace(ws.id);
    totalScanned += scanned;
    totalIngested += ingested;
  }
  this.logger.log(`Poll cycle complete (all workspaces): scanned=${totalScanned}, ingested=${totalIngested}`);
  return { scanned: totalScanned, ingested: totalIngested };
}

async runOnceForWorkspace(workspaceId: string): Promise<{ scanned: number; ingested: number }> {
  const keywords = await this.prisma.keyword.findMany({
    where: { workspaceId, enabled: true },
  });
  // ... existing inner loop, but every poller call passes workspaceId
  // and every mention.create / mention.findUnique passes workspaceId.
}
```

The cron tick now sweeps ALL workspaces.

- [ ] **Step 4: Update MetaIgPoller**

`backend/src/mentions/sources/meta-ig.poller.ts` reads the Instagram integration. Now it needs the workspaceId so it picks the right tenant's IG token:

```ts
async fetchFor(workspaceId: string, keyword: { id: string; value: string; kind: string }): Promise<RawMention[]> {
  // ...
  const integration = await this.prisma.integration.findFirst({
    where: { workspaceId, platform: "instagram" },
  });
  // ... rest unchanged
}
```

Update the Poller interface signature accordingly in `poller.types.ts`:
```ts
export interface Poller {
  readonly source: string;
  fetchFor(workspaceId: string, keyword: { id: string; value: string; kind: string }): Promise<RawMention[]>;
}
```

And update GoogleCsePoller to accept workspaceId too (even if it doesn't use it directly — for symmetry).

The admin controller endpoint is unchanged externally; it just calls `runOnce()` (sweeps all workspaces) or `runOnceForWorkspace(workspaceId)` (for the current workspace). Add an optional query param to scope:

```ts
@Post("run")
run(@CurrentWorkspace() workspaceId: string) {
  return this.scheduler.runOnceForWorkspace(workspaceId);
}
```

- [ ] **Step 5: Build**

```powershell
npm run build
```

- [ ] **Step 6: Commit**

```powershell
git add backend/src/notes backend/src/mentions
git -c user.email=tkana@local -c user.name=tkana commit -m "feat: scope notes, mentions, keywords, pollers, and open-ticket by workspaceId"
```

---

## Task 15: Refactor Integrations / FacebookService

**Files:**
- Modify: `backend/src/integrations/facebook.service.ts`
- Modify: `backend/src/integrations/facebook.controller.ts`

This is the trickiest module because every Graph API call depends on the workspace's stored token.

- [ ] **Step 1: Add `workspaceId` to every public method**

Every public method in `FacebookService` (`status`, `connect`, `disconnect`, `listPages`, `selectPage`, `listPosts`, `listComments`, `replyToComment`, `listConversations`, `listMessagesInConversation`, `sendDirectMessage`) must accept `workspaceId: string` as the first parameter.

The private `find()` helper changes:
```ts
private async find(workspaceId: string) {
  return this.prisma.integration.findFirst({
    where: { workspaceId, platform: "facebook" },
  });
}

private async requireToken(workspaceId: string): Promise<{ token: string; pageId: string }> {
  const integ = await this.find(workspaceId);
  if (!integ?.accessToken || !integ.pageId) {
    throw new NotFoundException("Facebook is not connected");
  }
  return { token: integ.accessToken, pageId: integ.pageId };
}

private async touchFetched(workspaceId: string) {
  await this.prisma.integration.updateMany({
    where: { workspaceId, platform: "facebook" },
    data: { lastFetchedAt: new Date() },
  });
}
```

All call sites of these helpers pass workspaceId through.

Inside `listConversations(workspaceId)`, the existing Contact upsert needs to include workspaceId so the auto-imported FB contacts are scoped:

```ts
const contact = await this.prisma.contact.upsert({
  where: {
    externalSource_externalId: {
      externalSource: "facebook",
      externalId: other.id,
    },
  },
  create: {
    workspaceId,             // <-- new
    name: other.name ?? "Facebook user",
    industry: "social",
    lifecycle: "lead",
    source: "facebook",
    lastSeen: this.fmtCompact(c.updated_time),
    externalSource: "facebook",
    externalId: other.id,
  },
  update: {
    name: other.name ?? undefined,
    lastSeen: this.fmtCompact(c.updated_time),
  },
});
```

**Important note**: the `@@unique([externalSource, externalId])` on Contact is global (not per-workspace). This means a single Facebook user (PSID 12345) can only exist as ONE Contact across ALL workspaces. This is a real consideration — for SaaS, the same FB user might be a customer of two different tkana tenants. Update the unique constraint to be per-workspace:

In `backend/prisma/schema.prisma`, find:
```prisma
  @@unique([externalSource, externalId])
```

Change to:
```prisma
  @@unique([workspaceId, externalSource, externalId])
```

This requires another `prisma db push`. Note this in the commit message.

The upsert syntax updates:
```ts
where: {
  workspaceId_externalSource_externalId: {
    workspaceId,
    externalSource: "facebook",
    externalId: other.id,
  },
},
```

Also `connect()` — when a new FB integration is connected for a workspace, the existing row could conflict on `@@unique([workspaceId, platform])`. Update the upsert/create logic:

```ts
const existing = await this.find(workspaceId);
const row = existing
  ? await this.prisma.integration.update({ where: { id: existing.id }, data })
  : await this.prisma.integration.create({ data: { ...data, workspaceId } });
```

- [ ] **Step 2: Update the controller**

Every endpoint in `facebook.controller.ts` adds `@CurrentWorkspace() workspaceId: string` as the first parameter and passes it through.

- [ ] **Step 3: Push schema change for the per-workspace external-id unique constraint**

```powershell
npx prisma db push
```

If there are existing duplicate (externalSource, externalId) across workspaces — for the dev DB there's only one workspace so no conflict. For production migrations later, plan this carefully.

- [ ] **Step 4: Build**

```powershell
npm run build
```

Expected: clean.

- [ ] **Step 5: Commit**

```powershell
git add backend/src/integrations backend/prisma/schema.prisma
git -c user.email=tkana@local -c user.name=tkana commit -m "feat(integrations): scope Facebook service by workspaceId; per-workspace contact externalId unique"
```

---

## Task 16: Update seed.ts

**Files:**
- Modify: `backend/prisma/seed.ts`

- [ ] **Step 1: Update the reset() function to also clear Workspace tables**

In `backend/prisma/seed.ts`, update the `reset()` function:

```ts
async function reset() {
  await prisma.note.deleteMany();
  await prisma.ticketActivity.deleteMany();
  await prisma.ticket.deleteMany();
  await prisma.ticketStage.deleteMany();
  await prisma.pipeline.deleteMany();
  await prisma.message.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.appointment.deleteMany();
  await prisma.contact.deleteMany();
  await prisma.template.deleteMany();
  await prisma.campaign.deleteMany();
  await prisma.mention.deleteMany();
  await prisma.keyword.deleteMany();
  await prisma.integration.deleteMany();
  await prisma.workspaceMember.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany();
}
```

- [ ] **Step 2: Create a Default Workspace before seeding any customer-owned data**

After the `reset()` call and before any user/template/campaign creation, add:

```ts
const defaultWs = await prisma.workspace.create({
  data: {
    name: "Default Workspace",
    slug: "default",
    timezone: "Asia/Riyadh",
    lang: "ar",
    plan: "free",
  },
});
const wsId = defaultWs.id;
```

- [ ] **Step 3: Attach every existing seed record to that workspace**

After creating each user, also create a WorkspaceMember:

```ts
const yara = await prisma.user.create({
  data: { /* ... existing ... */ },
});
await prisma.workspaceMember.create({
  data: { userId: yara.id, workspaceId: wsId, role: "owner" },
});
```

And do the same for omar/lina/karim (with roles: "owner", "admin", "agent", "agent" respectively).

For every Template and Campaign creation, add `workspaceId: wsId` to the data:

```ts
for (const t of tpls) await prisma.template.create({ data: { ...t, workspaceId: wsId } });
```

```ts
for (const c of cmps) await prisma.campaign.create({ data: { ...c, workspaceId: wsId } });
```

- [ ] **Step 4: Run the seed**

From `backend/`:
```powershell
npm run seed
```

Expected: no errors. All seeded records have a workspaceId.

- [ ] **Step 5: Smoke test**

Verify in Prisma Studio: `Workspace` has 1 row, `WorkspaceMember` has 4 rows, `Template` and `Campaign` rows all have `workspaceId` set.

- [ ] **Step 6: Commit**

```powershell
git add backend/prisma/seed.ts
git -c user.email=tkana@local -c user.name=tkana commit -m "feat(seed): create Default Workspace and scope all seeded data to it"
```

---

## Task 17: Frontend — store workspace in auth context + show in Topbar

**Files:**
- Modify: `src/auth/context.tsx`
- Modify: `src/lib/types.ts`
- Modify: `src/shell/Topbar.tsx`

- [ ] **Step 1: Add Workspace types**

In `src/lib/types.ts`, after the existing types, append:

```ts
// ─── Workspaces ───────────────────────────────────────────────────────────

export type WorkspaceRole = "owner" | "admin" | "agent" | "viewer";

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  lang: string;
  plan: string;
  role: WorkspaceRole;
}
```

- [ ] **Step 2: Update auth context**

Read `src/auth/context.tsx` first. Then extend it so the auth context stores:
- `workspaces: Workspace[]` — all workspaces the user belongs to
- `activeWorkspace: Workspace | null` — currently selected workspace

The login response from the backend now includes `{ token, user, workspaces, activeWorkspaceId }`. The context reads these and stores them.

The login function:
```ts
const login = async (email: string, password: string) => {
  const resp = await api.post<{
    token: string;
    user: User;
    workspaces: Workspace[];
    activeWorkspaceId: string | null;
  }>("/auth/login", { email, password });
  tokenStore.set(resp.token);
  const active = resp.workspaces.find((w) => w.id === resp.activeWorkspaceId) ?? null;
  setUser(resp.user);
  setWorkspaces(resp.workspaces);
  setActiveWorkspace(active);
};
```

Also add a `switchWorkspace(workspaceId)` function that calls `POST /auth/switch-workspace` and updates the token + active workspace state.

- [ ] **Step 3: Update Topbar to display the active workspace name**

In `src/shell/Topbar.tsx`, read its current content. Add a display element near where the user's name/avatar appears showing the active workspace name. Example placement:

```tsx
const { activeWorkspace } = useAuth();

{activeWorkspace && (
  <span style={{
    fontSize: 12,
    color: "var(--ink-2)",
    padding: "4px 10px",
    borderRadius: 999,
    border: "1px solid var(--line-soft)",
    background: "var(--bg-1)",
  }}>
    {activeWorkspace.name}
  </span>
)}
```

Insert before the user avatar/menu. The exact placement should match the Topbar's existing visual rhythm.

- [ ] **Step 4: Typecheck**

```powershell
npm run typecheck
```

Expected: clean.

- [ ] **Step 5: Start dev server and check**

```powershell
npm run dev
```

Open `http://localhost:5173`, log in as `yara@samemha.com` / `demo1234`. Confirm:
- Login still works
- Topbar shows "Default Workspace" pill
- Pages load normally (Inbox, Pipeline, Contacts all functional)

- [ ] **Step 6: Commit**

```powershell
git add src/auth src/lib/types.ts src/shell/Topbar.tsx
git -c user.email=tkana@local -c user.name=tkana commit -m "feat(frontend): store workspaces in auth context; show active workspace in Topbar"
```

---

## Task 18: End-to-end multi-tenant isolation verification

**Files:** none (verification only)

Goal: confirm that two workspaces' data is fully isolated.

- [ ] **Step 1: Both servers running**

In two shells:
```powershell
npm --prefix backend run dev
```
```powershell
npm run dev
```

- [ ] **Step 2: Register a second user with a new workspace via curl**

```powershell
$body = '{"email":"test@tkana.local","password":"test1234","name":"Test User","workspaceName":"Test Co"}'
$resp = Invoke-RestMethod -Uri "http://localhost:3001/api/auth/register" -Method Post -ContentType "application/json" -Body $body
$resp
```

Expected: returns `{ token, user, workspaces: [{...one workspace named "Test Co"...}], activeWorkspaceId: <id> }`.

Capture the token: `$testToken = $resp.token`.

- [ ] **Step 3: List contacts as the test user**

```powershell
$h = @{ Authorization = "Bearer $testToken" }
Invoke-RestMethod -Uri "http://localhost:3001/api/contacts" -Method Get -Headers $h
```

Expected: empty array `[]`. The Test Co workspace has no contacts. If you see Yara's FB-imported contacts here, **isolation is broken — stop and investigate**.

- [ ] **Step 4: Create a contact in Test Co**

```powershell
$body = '{"name":"Test Contact","industry":"tech","lifecycle":"lead","source":"manual"}'
$h = @{ Authorization = "Bearer $testToken" }
Invoke-RestMethod -Uri "http://localhost:3001/api/contacts" -Method Post -Headers $h -ContentType "application/json" -Body $body
```

Expected: returns the new Contact.

- [ ] **Step 5: Log in as Yara, verify Test Contact is NOT visible**

```powershell
$body = '{"email":"yara@samemha.com","password":"demo1234"}'
$yaraResp = Invoke-RestMethod -Uri "http://localhost:3001/api/auth/login" -Method Post -ContentType "application/json" -Body $body
$yaraToken = $yaraResp.token
$h = @{ Authorization = "Bearer $yaraToken" }
$contacts = Invoke-RestMethod -Uri "http://localhost:3001/api/contacts" -Method Get -Headers $h
$contacts | Where-Object { $_.name -eq "Test Contact" }
```

Expected: the filter returns nothing. Yara should see her own workspace's contacts, NOT Test Co's "Test Contact". If "Test Contact" appears in Yara's list, **isolation is broken**.

- [ ] **Step 6: Verify the same for mentions**

If there are mentions in the default workspace from earlier testing, log in as test user and:
```powershell
$h = @{ Authorization = "Bearer $testToken" }
Invoke-RestMethod -Uri "http://localhost:3001/api/mentions" -Method Get -Headers $h
```

Expected: empty (Test Co has no mentions).

- [ ] **Step 7: Verify in the browser**

In one browser tab, log in as `yara@samemha.com`. In an incognito tab, log in as `test@tkana.local`. Both should see only their own workspace's data. Topbar should show different workspace names.

- [ ] **Step 8: Final commit (if minor tweaks needed)**

```powershell
git status
# If anything was tweaked:
git add .
git -c user.email=tkana@local -c user.name=tkana commit -m "test: verified multi-tenant isolation end-to-end"
```

---

## Self-Review

**Spec coverage:**
- Workspace + WorkspaceMember schema — Task 2 ✓
- workspaceId on all customer models — Tasks 5, 7 ✓
- Existing data migration — Task 6 ✓
- Workspaces CRUD module — Task 3 ✓
- Request context (AsyncLocalStorage + decorator + interceptor) — Tasks 4, 9 ✓
- JWT payload extends with workspaceId — Task 7 ✓
- Auth flow (register creates workspace, login auto-selects or returns list, switch-workspace endpoint) — Task 8 ✓
- Prisma extension safety net — Task 9 ✓
- All service modules refactored — Tasks 10-15 ✓
- Seed update — Task 16 ✓
- Frontend auth context + Topbar — Task 17 ✓
- E2E isolation verification — Task 18 ✓

**Placeholder scan:** the only non-specific bits are in Task 12 ("read the file first") and Task 13 ("apply mechanical pattern to every method") — these are deliberate because the pattern is identical and listing every method is mostly noise. The pattern is fully specified in Tasks 10 and 11.

**Type consistency:**
- `WorkspaceRole` consistent across backend (`workspaces.dto.ts`) and frontend (`types.ts`) ✓
- `JwtPayload` extends with `workspaceId?` consistently in `auth.guard.ts` and the decorator ✓
- Workspace model fields consistent between Prisma schema, service responses, and frontend type ✓
- Relation names in schema unique per `@relation` clause ✓

**Known fragilities (deliberate, document but don't fix in this plan):**
- The Prisma extension is a safety net only — primary scoping is in service methods. If a developer writes a service that bypasses the extension (e.g., raw SQL or `$queryRaw`), no scoping happens.
- The Contact `@@unique([workspaceId, externalSource, externalId])` is changed in Task 15 — if production already has data with the old `@@unique([externalSource, externalId])`, you'd need a careful migration. For dev, it's a no-op because only one workspace exists.
- No workspace-switcher UI dropdown yet — single-workspace users land in their workspace; multi-workspace users get the list in the login response but the UI to switch is not built here.
- No per-plan limits enforced (Billing comes in a separate plan).
- No tests added — verification is manual curl + Prisma Studio + browser per existing codebase convention.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-11-multi-tenancy-migration.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, two-stage review between tasks (spec compliance, then code quality), isolated context per step. Used successfully for the Phase 1 mentions build.

**2. Inline Execution** — I execute tasks in this session using executing-plans, batch with checkpoints for your review. Faster, but my context fills up across 18 tasks.

Which approach?
