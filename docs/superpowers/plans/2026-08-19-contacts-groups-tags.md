# Contacts Groups & Tags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Manual customer groups (built on the segment engine, instantly usable as campaign audiences) and a managed tag catalog with colors, surfaced in a three-tab Contacts screen with bulk assignment.

**Architecture:** Groups are `Segment` rows with `origin: "manual"` whose members live in the existing `SegmentMember` table (cascades already correct); `GET /segments` gains an origin-aware count branch (member-count for manual/hjz — fixing hjz counts, which today wrongly run an empty filter). Tags gain a catalog entity (`Tag`: name+color per workspace) layered UNDER the existing storage — contacts keep a JSON string array of names (verified live: `"[\"SmokeTest\"]"`), so the Inbox editor and segment tag-filters keep working untouched; rename/delete propagate via single jsonb UPDATEs. The Contacts screen splits into Contacts | Groups | Tags tabs, reusing the existing bulk-select bar (it already exists with bulk-tag and bulk-delete) and adding "Add to group".

**Tech Stack:** NestJS 10 + Prisma 5 (Postgres/Neon; raw jsonb SQL for tag propagation) + jest/ts-jest; React 18 with the repo's `useFetch`/`useMutation`, `Modal`, `Badge` components; no frontend test runner (typecheck + verify skill).

**Spec:** `docs/superpowers/specs/2026-08-19-contacts-groups-tags-design.md`

## Global Constraints

- **Bilingual copy:** every user-facing string via `tx("English", "العربية")` with real Arabic; RTL-safe (logical properties).
- **Selective commits:** never `git add -A`; each commit adds only its task's files. Trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **Branch:** `main` (current checkout; push also syncs `feat/whatsapp-ai-mvp`). **No new dependencies.**
- **Migrations:** hand-authored SQL folder + `npx prisma migrate deploy` (repo rule — `migrate dev` is broken by tsvector drift). The shared Neon DB is PRODUCTION — data steps must be idempotent and additive.
- **Tag-name matching is exact-element** (jsonb array element equality): renaming "VIP" must never touch "VIPER" (the segment-filter substring wart is NOT to be replicated).
- **Tenancy:** every route workspace-scoped; foreign contactIds/segment ids → 404; member endpoints reject non-manual origins with 400.
- **Backend tests:** from `backend/`: `npx jest <path>`; full `npm test`. **Frontend:** root `npm run typecheck`.
- **Local backend on :4100** runs `node dist/main` started by the session — after backend changes: `npm run build`, `npx kill-port 4100`, relaunch `node dist/main` from `backend/` (background) before live checks.

---

### Task 1: Tag schema + absorb migration

**Files:**
- Modify: `backend/prisma/schema.prisma` (add Tag model after Template; add `tags Tag[]` relation on Workspace)
- Create: `backend/prisma/migrations/20260819150000_tag_catalog/migration.sql`

**Interfaces:**
- Produces (Tasks 2+): Prisma `Tag` model `{id, workspaceId, name, color, createdAt}` with `@@unique([workspaceId, name])`.

- [ ] **Step 1: Schema**

Add after the `Template` model:

```prisma
// Managed tag catalog: metadata (color, identity) OVER the tag names stored
// on Contact.tags. Assignment truth stays the contact's name array, so every
// name-matching surface (Inbox editor, segment filters) works unchanged.
model Tag {
  id    String @id @default(cuid())
  name  String
  color String // hue string, same convention as Segment.color

  workspaceId String
  workspace   Workspace @relation("WorkspaceTags", fields: [workspaceId], references: [id], onDelete: Cascade)

  createdAt DateTime @default(now())

  @@unique([workspaceId, name])
  @@index([workspaceId])
}
```

On the `Workspace` model add (next to its other relation lists): `tags Tag[] @relation("WorkspaceTags")`.

- [ ] **Step 2: Hand-authored migration**

`backend/prisma/migrations/20260819150000_tag_catalog/migration.sql`:

```sql
-- Managed tag catalog over the existing name-based Contact.tags storage.
-- The absorb step promotes every distinct tag name already in use into the
-- catalog with a deterministic 12-step hue, so day one shows real data.
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Tag_workspaceId_name_key" ON "Tag"("workspaceId", "name");
CREATE INDEX "Tag_workspaceId_idx" ON "Tag"("workspaceId");

ALTER TABLE "Tag" ADD CONSTRAINT "Tag_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Absorb existing tags (idempotent; md5 ids are fine — cuid is client-side).
INSERT INTO "Tag" ("id", "workspaceId", "name", "color")
SELECT md5(random()::text || clock_timestamp()::text || t."workspaceId" || t.name),
       t."workspaceId",
       t.name,
       ((abs(hashtext(t.name)) % 12) * 30)::text
FROM (
  SELECT DISTINCT c."workspaceId", trim(e) AS name
  FROM "Contact" c, jsonb_array_elements_text(c."tags"::jsonb) e
  WHERE trim(e) <> ''
) t
ON CONFLICT ("workspaceId", "name") DO NOTHING;
```

- [ ] **Step 3: Apply + generate**

From `backend/`: `npx prisma migrate deploy` (expect exactly this one migration applied; earlier ones already recorded). Then `npx prisma generate` (if EPERM: `npx kill-port 4100`, retry, relaunch the backend later).

- [ ] **Step 4: Verify absorption (read-only)**

```bash
cd backend && npx tsx -e "import {PrismaClient} from '@prisma/client'; const p=new PrismaClient(); p.tag.findMany({select:{name:true,color:true}}).then(r=>{console.log(r);process.exit(0)})"
```

Expected: one row per distinct existing tag name (e.g. SmokeTest + seed tags), hue colors like "0".."330".

- [ ] **Step 5: Commit**

```bash
git add backend/prisma/schema.prisma backend/prisma/migrations/20260819150000_tag_catalog
git commit -m "feat(tags): tag catalog model + absorb-existing-tags migration"
```

---

### Task 2: Tags backend module

**Files:**
- Create: `backend/src/tags/tags.module.ts` (controller + service + DTOs in one file, segments-module style)
- Modify: `backend/src/app.module.ts` (register TagsModule in imports)
- Test: `backend/src/tags/tags.spec.ts`

**Interfaces:**
- Produces (Tasks 4/6):
  - `GET /tags` → `[{id, name, color, usageCount}]` sorted by name.
  - `POST /tags {name, color?}` → row (existing name returns the existing row, 200 — idempotent create for quick-create).
  - `PATCH /tags/:id {name?, color?}` → `{tag, contactsUpdated}` — rename rewrites exact-name elements across the workspace's contacts.
  - `DELETE /tags/:id` → `{ok: true, contactsUpdated}` — strips the name from contacts.
  - `POST /tags/assign {contactIds: string[], add?: string[], remove?: string[]}` → `{contactsUpdated}` — bulk tag ops; unknown names in `add` quick-create catalog rows (auto hue).

- [ ] **Step 1: Write the failing tests**

`backend/src/tags/tags.spec.ts` — the propagation logic is raw SQL, so unit tests target the SERVICE's non-SQL logic with prisma mocked, plus the hue helper; SQL correctness is pinned by the live smoke in Step 6:

```ts
import { NotFoundException } from "@nestjs/common";
import { TagsService, hueForName } from "./tags.module";

describe("hueForName", () => {
  it("is deterministic and lands on the 12-step wheel", () => {
    const h1 = hueForName("VIP");
    expect(h1).toBe(hueForName("VIP"));
    const n = Number(h1);
    expect(n % 30).toBe(0);
    expect(n).toBeGreaterThanOrEqual(0);
    expect(n).toBeLessThan(360);
  });
});

describe("TagsService", () => {
  let prisma: {
    tag: { findMany: jest.Mock; findFirst: jest.Mock; create: jest.Mock; update: jest.Mock; delete: jest.Mock };
    contact: { findMany: jest.Mock; update: jest.Mock };
    $queryRawUnsafe: jest.Mock;
    $executeRawUnsafe: jest.Mock;
    $queryRaw: jest.Mock;
    $executeRaw: jest.Mock;
  };
  let svc: TagsService;

  beforeEach(() => {
    prisma = {
      tag: {
        findMany: jest.fn().mockResolvedValue([{ id: "t1", name: "VIP", color: "90" }]),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: "new", ...data })),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: "t1", name: "VIP", color: "90", ...data })),
        delete: jest.fn().mockResolvedValue({}),
      },
      contact: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn() },
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      $executeRawUnsafe: jest.fn().mockResolvedValue(0),
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: jest.fn().mockResolvedValue(0),
    };
    svc = new TagsService(prisma as never);
  });

  it("create is idempotent: an existing name returns the existing row", async () => {
    prisma.tag.findFirst.mockResolvedValue({ id: "t1", name: "VIP", color: "90" });
    const row = await svc.create("ws1", "VIP");
    expect(row.id).toBe("t1");
    expect(prisma.tag.create).not.toHaveBeenCalled();
  });

  it("create trims the name and assigns a wheel hue when color omitted", async () => {
    await svc.create("ws1", "  Hot Lead  ");
    expect(prisma.tag.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ name: "Hot Lead", workspaceId: "ws1", color: hueForName("Hot Lead") }),
    });
  });

  it("rename 404s on a foreign/unknown tag id", async () => {
    prisma.tag.findFirst.mockResolvedValue(null);
    await expect(svc.update("ws1", "nope", { name: "X" })).rejects.toBeInstanceOf(NotFoundException);
  });

  it("rename with an unchanged name skips contact propagation", async () => {
    prisma.tag.findFirst.mockResolvedValue({ id: "t1", name: "VIP", color: "90" });
    await svc.update("ws1", "t1", { name: "VIP", color: "120" });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it("assign validates that all contactIds belong to the workspace", async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: "c1" }]); // only 1 of 2 found
    await expect(
      svc.assign("ws1", { contactIds: ["c1", "foreign"], add: ["VIP"] }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
```

- [ ] **Step 2: Run to verify failure**

`npx jest src/tags/tags.spec.ts` → FAIL (module doesn't exist).

- [ ] **Step 3: Implement `backend/src/tags/tags.module.ts`**

```ts
import {
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import { IsArray, IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { CurrentWorkspace } from "../common/current-workspace.decorator";

/** Deterministic 12-step hue for auto-colored tags (matches the absorb
 *  migration's hashtext formula in spirit; exact parity isn't required —
 *  colors are cosmetic — but determinism per name is). */
export function hueForName(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) | 0;
  return String((Math.abs(h) % 12) * 30);
}

class CreateTagDto {
  @IsString() @IsNotEmpty() @MaxLength(40) name!: string;
  @IsOptional() @IsString() @MaxLength(16) color?: string;
}

class UpdateTagDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(40) name?: string;
  @IsOptional() @IsString() @MaxLength(16) color?: string;
}

class AssignTagsDto {
  @IsArray() @IsString({ each: true }) contactIds!: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) add?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) remove?: string[];
}

@Injectable()
export class TagsService {
  constructor(private readonly prisma: PrismaService) {}

  /** All catalog tags with live usage counts (one grouped jsonb pass). */
  async list(workspaceId: string) {
    const tags = await this.prisma.tag.findMany({
      where: { workspaceId },
      orderBy: { name: "asc" },
    });
    const counts = await this.prisma.$queryRaw<{ name: string; count: bigint }[]>`
      SELECT e AS name, count(*)::bigint AS count
      FROM "Contact" c, jsonb_array_elements_text(c."tags"::jsonb) e
      WHERE c."workspaceId" = ${workspaceId}
      GROUP BY e
    `;
    const byName = new Map(counts.map((r) => [r.name, Number(r.count)]));
    return tags.map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color,
      usageCount: byName.get(t.name) ?? 0,
    }));
  }

  /** Idempotent create — quick-create callers shouldn't 409 on races. */
  async create(workspaceId: string, rawName: string, color?: string) {
    const name = rawName.trim();
    const existing = await this.prisma.tag.findFirst({ where: { workspaceId, name } });
    if (existing) return existing;
    try {
      return await this.prisma.tag.create({
        data: { workspaceId, name, color: color ?? hueForName(name) },
      });
    } catch (e) {
      // Unique race: someone created it between the check and the insert.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        const row = await this.prisma.tag.findFirst({ where: { workspaceId, name } });
        if (row) return row;
      }
      throw e;
    }
  }

  async update(workspaceId: string, id: string, dto: { name?: string; color?: string }) {
    const tag = await this.prisma.tag.findFirst({ where: { id, workspaceId } });
    if (!tag) throw new NotFoundException("Tag not found");
    const newName = dto.name?.trim();
    let contactsUpdated = 0;
    if (newName && newName !== tag.name) {
      // Exact-element rename inside the JSON string arrays — "VIP" must never
      // touch "VIPER" (jsonb element equality, not substring).
      contactsUpdated = await this.prisma.$executeRaw`
        UPDATE "Contact"
        SET "tags" = (
          SELECT COALESCE(jsonb_agg(CASE WHEN e = ${tag.name} THEN ${newName} ELSE e END), '[]'::jsonb)::text
          FROM jsonb_array_elements_text("tags"::jsonb) e
        )
        WHERE "workspaceId" = ${workspaceId} AND "tags"::jsonb ? ${tag.name}
      `;
    }
    const updated = await this.prisma.tag.update({
      where: { id },
      data: { name: newName ?? undefined, color: dto.color ?? undefined },
    });
    return { tag: updated, contactsUpdated };
  }

  async remove(workspaceId: string, id: string) {
    const tag = await this.prisma.tag.findFirst({ where: { id, workspaceId } });
    if (!tag) throw new NotFoundException("Tag not found");
    const contactsUpdated = await this.prisma.$executeRaw`
      UPDATE "Contact"
      SET "tags" = (
        SELECT COALESCE(jsonb_agg(e) FILTER (WHERE e <> ${tag.name}), '[]'::jsonb)::text
        FROM jsonb_array_elements_text("tags"::jsonb) e
      )
      WHERE "workspaceId" = ${workspaceId} AND "tags"::jsonb ? ${tag.name}
    `;
    await this.prisma.tag.delete({ where: { id } });
    return { ok: true as const, contactsUpdated };
  }

  /** Bulk add/remove tag names on contacts; unknown names quick-create. */
  async assign(
    workspaceId: string,
    input: { contactIds: string[]; add?: string[]; remove?: string[] },
  ) {
    const ids = [...new Set(input.contactIds)];
    const found = await this.prisma.contact.findMany({
      where: { workspaceId, id: { in: ids } },
      select: { id: true, tags: true },
    });
    if (found.length !== ids.length) {
      throw new NotFoundException("One or more contacts not found in this workspace");
    }
    const add = (input.add ?? []).map((n) => n.trim()).filter(Boolean);
    const remove = new Set((input.remove ?? []).map((n) => n.trim()).filter(Boolean));
    for (const name of add) await this.create(workspaceId, name);
    let contactsUpdated = 0;
    for (const c of found) {
      let tags: string[];
      try {
        const parsed = JSON.parse(c.tags);
        tags = Array.isArray(parsed) ? parsed : [];
      } catch {
        tags = [];
      }
      const next = [...new Set([...tags.filter((t) => !remove.has(t)), ...add])];
      if (JSON.stringify(next) !== JSON.stringify(tags)) {
        await this.prisma.contact.update({
          where: { id: c.id },
          data: { tags: JSON.stringify(next) },
        });
        contactsUpdated += 1;
      }
    }
    return { contactsUpdated };
  }
}

@Controller("tags")
class TagsController {
  constructor(private readonly svc: TagsService) {}

  @Get()
  list(@CurrentWorkspace() workspaceId: string) {
    return this.svc.list(workspaceId);
  }

  @Post()
  create(@CurrentWorkspace() workspaceId: string, @Body() dto: CreateTagDto) {
    return this.svc.create(workspaceId, dto.name, dto.color);
  }

  @Patch(":id")
  update(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Body() dto: UpdateTagDto,
  ) {
    return this.svc.update(workspaceId, id, dto);
  }

  @Delete(":id")
  remove(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.remove(workspaceId, id);
  }

  @Post("assign")
  assign(@CurrentWorkspace() workspaceId: string, @Body() dto: AssignTagsDto) {
    return this.svc.assign(workspaceId, dto);
  }
}

@Module({
  controllers: [TagsController],
  providers: [TagsService],
  exports: [TagsService],
})
export class TagsModule {}
```

Register `TagsModule` in `backend/src/app.module.ts` imports (read the file; add the import + array entry alphabetically-ish with its neighbors).

**Route-order note:** `@Post("assign")` must be declared AFTER no conflicting route — it is distinct from `@Patch(":id")`/`@Delete(":id")` methods, so order is safe as written; do not move `assign` below a `@Post(":id")` (none exists).

- [ ] **Step 4: Run tests**

`npx jest src/tags/tags.spec.ts` → 6/6 PASS. `npm run build` → clean.

- [ ] **Step 5: Restart local backend**

`npx kill-port 4100` then background `node dist/main` from `backend/`; wait for `/api/health` 200.

- [ ] **Step 6: Live smoke (real SQL paths)**

Login (`yara@samemha.com`/`demo1234`) via `POST /api/auth/login`; then: `GET /api/tags` (expect absorbed rows with usage counts) → `POST /api/tags {"name":"PlanSmoke"}` → `POST /api/tags/assign {contactIds:[<one real id from GET /api/contacts>], add:["PlanSmoke"]}` → `GET /api/tags` shows usageCount 1 → `PATCH` rename to "PlanSmoke2" → verify the contact's tags via `GET /api/contacts` contains "PlanSmoke2" → `DELETE` the tag → verify stripped. Record each response in the report.

- [ ] **Step 7: Commit**

```bash
git add backend/src/tags backend/src/app.module.ts
git commit -m "feat(tags): catalog CRUD with usage counts, exact-name propagation, bulk assign"
```

---

### Task 3: Manual groups in the segments backend

**Files:**
- Modify: `backend/src/segments/segments.module.ts` (DTO origin, list counting, member endpoints)
- Test: `backend/src/segments/segments-members.spec.ts` (new)

**Interfaces:**
- Consumes: `SegmentsService.countByFilter/parseFilter` (existing), `SegmentMember` model (cascades verified).
- Produces (Tasks 4/5):
  - `POST /segments` accepts `origin?: "crm" | "manual"` (default crm); `filter` optional for manual (stored `{}`).
  - `GET /segments` rows unchanged in shape, but `count` for `origin !== "crm"` = `SegmentMember` count (fixes hjz too); rows gain `origin`.
  - `POST /segments/:id/members {contactIds: string[]}` → `{added: number}` (manual-only; idempotent via createMany skipDuplicates).
  - `DELETE /segments/:id/members/:contactId` → `{ok: true}`.
  - `GET /segments/:id/members?search=` → `[{id, name, phone, source}]` (manual-only, search on name substring, cap 100).

- [ ] **Step 1: Write the failing tests**

`backend/src/segments/segments-members.spec.ts` — test the controller-level logic by instantiating the controller with mocked prisma + real-ish service mocks (the file exports nothing today; export `SegmentsController` from the module file — add `export` keyword — so it's testable):

```ts
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { SegmentsController } from "./segments.module";

describe("SegmentsController manual-group members", () => {
  let prisma: {
    segment: { findFirst: jest.Mock; findMany: jest.Mock };
    segmentMember: { createMany: jest.Mock; deleteMany: jest.Mock; count: jest.Mock; findMany: jest.Mock };
    contact: { findMany: jest.Mock };
  };
  let svc: { countByFilter: jest.Mock; parseFilter: jest.Mock };
  let ctrl: SegmentsController;

  beforeEach(() => {
    prisma = {
      segment: {
        findFirst: jest.fn().mockResolvedValue({ id: "s1", origin: "manual" }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      segmentMember: {
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      contact: { findMany: jest.fn().mockResolvedValue([{ id: "c1" }, { id: "c2" }]) },
    };
    svc = { countByFilter: jest.fn().mockResolvedValue(5), parseFilter: jest.fn().mockReturnValue({}) };
    ctrl = new SegmentsController(prisma as never, svc as never, { emitSegmentUpserted: jest.fn(), emitSegmentDeleted: jest.fn() } as never);
  });

  it("adds members idempotently and workspace-validates contacts", async () => {
    const res = await ctrl.addMembers("ws1", "s1", { contactIds: ["c1", "c2"] });
    expect(prisma.segmentMember.createMany).toHaveBeenCalledWith({
      data: [
        { segmentId: "s1", contactId: "c1" },
        { segmentId: "s1", contactId: "c2" },
      ],
      skipDuplicates: true,
    });
    expect(res).toEqual({ added: 2 });
  });

  it("404s when a contactId is foreign to the workspace", async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: "c1" }]); // c2 missing
    await expect(ctrl.addMembers("ws1", "s1", { contactIds: ["c1", "c2"] })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.segmentMember.createMany).not.toHaveBeenCalled();
  });

  it("400s member ops on non-manual segments", async () => {
    prisma.segment.findFirst.mockResolvedValue({ id: "s1", origin: "crm" });
    await expect(ctrl.addMembers("ws1", "s1", { contactIds: ["c1"] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("list counts manual/hjz segments by membership, crm by filter", async () => {
    prisma.segment.findMany.mockResolvedValue([
      { id: "s1", origin: "manual", filter: "{}", name: "G", nameAr: null, color: null, createdAt: new Date(), updatedAt: new Date() },
      { id: "s2", origin: "crm", filter: "{}", name: "S", nameAr: null, color: null, createdAt: new Date(), updatedAt: new Date() },
    ]);
    prisma.segmentMember.count.mockResolvedValue(7);
    const rows = await ctrl.list("ws1");
    expect(rows.find((r: { id: string }) => r.id === "s1")!.count).toBe(7);
    expect(rows.find((r: { id: string }) => r.id === "s2")!.count).toBe(5);
    expect(rows[0].origin).toBeDefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

`npx jest src/segments/segments-members.spec.ts` → FAIL (`SegmentsController` not exported / methods missing).

- [ ] **Step 3: Implement in `segments.module.ts`**

1. `export class SegmentsController` (add the keyword).
2. `CreateSegmentDto`: add `@IsOptional() @IsIn(["crm", "manual"]) origin?: "crm" | "manual";` and make `filter` optional: `@IsOptional() @ValidateNested() @Type(() => SegmentFilterDto) filter?: SegmentFilterDto;` (import `IsIn` — already imported). In `create()`: `origin: dto.origin ?? "crm"`, `filter: JSON.stringify(dto.filter ?? {})`.
3. New DTO + endpoints (place after `remove`):

```ts
class AddMembersDto {
  @IsArray() @IsString({ each: true }) contactIds!: string[];
}
```

```ts
  /** Resolve a segment, asserting it's a manual group in this workspace. */
  private async requireManual(workspaceId: string, id: string) {
    const seg = await this.prisma.segment.findFirst({ where: { id, workspaceId } });
    if (!seg) throw new NotFoundException("Segment not found");
    if (seg.origin !== "manual") {
      throw new BadRequestException("Members can only be managed on manual groups");
    }
    return seg;
  }

  @Post(":id/members")
  async addMembers(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Body() dto: AddMembersDto,
  ) {
    await this.requireManual(workspaceId, id);
    const ids = [...new Set(dto.contactIds)];
    const found = await this.prisma.contact.findMany({
      where: { workspaceId, id: { in: ids } },
      select: { id: true },
    });
    if (found.length !== ids.length) {
      throw new NotFoundException("One or more contacts not found in this workspace");
    }
    const res = await this.prisma.segmentMember.createMany({
      data: ids.map((contactId) => ({ segmentId: id, contactId })),
      skipDuplicates: true,
    });
    void this.outbound.emitSegmentUpserted(workspaceId, id);
    return { added: res.count };
  }

  @Delete(":id/members/:contactId")
  async removeMember(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Param("contactId") contactId: string,
  ) {
    await this.requireManual(workspaceId, id);
    await this.prisma.segmentMember.deleteMany({ where: { segmentId: id, contactId } });
    void this.outbound.emitSegmentUpserted(workspaceId, id);
    return { ok: true };
  }

  @Get(":id/members")
  async listMembers(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Query("search") search?: string,
  ) {
    await this.requireManual(workspaceId, id);
    const members = await this.prisma.segmentMember.findMany({
      where: {
        segmentId: id,
        contact: search
          ? { name: { contains: search, mode: "insensitive" } }
          : undefined,
      },
      include: { contact: { select: { id: true, name: true, phone: true, source: true } } },
      take: 100,
      orderBy: { addedAt: "desc" },
    });
    return members.map((m) => m.contact);
  }
```

(Imports to add: `BadRequestException`, `Query` from `@nestjs/common`.)

4. Counting branch in `list()` — replace the counts block:

```ts
    const counts = await Promise.all(
      rows.map((s) =>
        s.origin === "crm"
          ? this.svc.countByFilter(workspaceId, this.svc.parseFilter(s.filter))
          : this.prisma.segmentMember.count({ where: { segmentId: s.id } }),
      ),
    );
```

and add `origin: s.origin,` to the mapped return rows.

**Route-order warning:** `@Get(":id/members")` must be declared in the controller BEFORE any hypothetical `@Get(":id")` (none exists today — verify) and the existing `@Post("preview")` stays above `@Post(":id/members")`? Nest matches static segments over params regardless of order for different methods, but keep `preview` above the param routes as it is now, and place the new routes after `remove` as instructed.

- [ ] **Step 4: Run tests + build**

`npx jest src/segments/segments-members.spec.ts` → 4/4 PASS; full `npm test` green (existing hjz spec must not break — it may assert counts; if `segments` specs exist that pin countByFilter for hjz rows, update them to the new membership expectation and say so in the report); `npm run build` clean.

- [ ] **Step 5: Restart backend + live smoke**

Restart :4100. Smoke with curl + token: `POST /api/segments {"name":"مجموعة تجريبية","origin":"manual"}` → `POST /api/segments/<id>/members {contactIds:[<2 real ids>]}` → `GET /api/segments` shows the group with count 2 and `origin:"manual"` → `GET /api/segments/<id>/members` lists both → `DELETE` one member → count 1 → delete the segment (cascade cleans members). Record responses.

- [ ] **Step 6: Commit**

```bash
git add backend/src/segments/segments.module.ts backend/src/segments/segments-members.spec.ts
git commit -m "feat(segments): manual groups — origin, member endpoints, membership counting"
```

---

### Task 4: Contacts tab shell + bulk actions upgrade

**Files:**
- Modify: `src/screens/Contacts.tsx` (tabs state + conditional render; action bar "Add to group"; BulkTagModal → catalog picker; colored chips)
- Modify: `src/lib/types.ts` (Segment gains `origin`; new `TagRow` interface)

**Interfaces:**
- Consumes: `GET /tags` `[{id,name,color,usageCount}]`; `POST /tags/assign`; `POST /segments/:id/members`; segments rows now carry `origin: string`.
- Produces (Tasks 5/6): `Contacts.tsx` renders `activeTab` state `"contacts" | "groups" | "tags"` and mounts `<GroupsTab …/>` / `<TagsTab …/>` from `src/screens/contacts/` (created in Tasks 5/6 — until then, render a placeholder `<div/>` behind the tabs so this task stays shippable; REPLACE the placeholders in Tasks 5/6).

- [ ] **Step 1: Types**

`src/lib/types.ts`: add `origin: string;` to `Segment`; add:

```ts
export interface TagRow {
  id: string;
  name: string;
  color: string;
  usageCount: number;
}
```

- [ ] **Step 2: Tabs in ContactsImpl**

Read `ContactsImpl` (Contacts.tsx:642+). Add `const [activeTab, setActiveTab] = useState<"contacts" | "groups" | "tags">("contacts");` and `const tagsQ = useFetch<TagRow[]>("/tags");`. Directly under the `PageHeader`, insert a pill row (Inbox-filter idiom — reuse the `ix-pill` class if global, else the Campaigns tab-button style):

```tsx
      <div style={{ display: "flex", gap: 6, padding: "0 24px 10px" }}>
        {(
          [
            ["contacts", tx("Contacts", "جهات الاتصال")],
            ["groups", tx("Groups", "المجموعات")],
            ["tags", tx("Tags", "الوسوم")],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`btn sm ${activeTab === id ? "primary" : "ghost"}`.trim()}
            onClick={() => setActiveTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
```

Wrap the existing body (segment chips + table + pipeline section) in `{activeTab === "contacts" && (…)}`; add `{activeTab === "groups" && <GroupsTab tx={tx} lang={t.lang} />}` and `{activeTab === "tags" && <TagsTab tx={tx} />}` (placeholder empty components inline until Tasks 5/6 replace them — define `function GroupsTab(...){return <div/>;}` / `function TagsTab(...){return <div/>;}` locally ONLY if the real files don't exist yet; Tasks 5/6 create the real files and swap the imports).

- [ ] **Step 3: "Add to group" in the bulk bar**

In `ContactsTable`'s action bar (renders when `selected.size > 0`, ~line 99): add a dropdown button. Pass new props from ContactsImpl: `manualGroups: Segment[]` (from the existing segments fetch — filter `origin === "manual"`), `onAddToGroup: (segmentId: string) => void`. Implementation in ContactsImpl:

```ts
  const addToGroup = useMutation<{ segmentId: string; contactIds: string[] }, { added: number }>(
    ({ segmentId, contactIds }) => api.post(`/segments/${segmentId}/members`, { contactIds }),
  );
  const handleAddToGroup = (segmentId: string) => {
    if (selected.size === 0) return;
    void addToGroup
      .mutate({ segmentId, contactIds: Array.from(selected) })
      .then(() => {
        setSelected(new Set());
        segmentsQ.refetch();
      })
      .catch(() => {/* error surfaces via addToGroup.error; render it in the bar */});
  };
```

Dropdown UI (in the bar, next to the existing bulk-tag button): a `<select>` styled like INPUT_STYLE-ish with a placeholder option `tx("Add to group…", "أضف إلى مجموعة…")` listing `manualGroups` by localized name; `onChange` → `onAddToGroup(value)` + reset select. Show `addToGroup.error` as a small red inline text in the bar when present. (A native select is the easy-to-use, RTL-safe choice; no new dropdown component.)

- [ ] **Step 4: BulkTagModal → catalog picker**

Read `BulkTagModal` (Contacts.tsx:1034-1101) — keep its Modal shell/props contract but replace free-text-only input with: catalog chips (from a new `tags: TagRow[]` prop) rendered as toggleable colored chips (selected = filled with `hsl(<color>,70%,45%)` background), plus the existing text input as quick-create (Enter adds the typed name to the selection, marked "new"). `onApply(selectedNames: string[])` keeps its signature. In ContactsImpl, switch the bulk-tag submit to the new endpoint:

```ts
  api.post("/tags/assign", { contactIds: ids, add: names });
```

(replacing whatever per-contact PATCH loop exists — read the current `onBulkTag` handler ~line 695-735 and swap its network call; keep its optimistic/refetch behavior). After apply: `tagsQ.refetch()` too.

- [ ] **Step 5: Colored row chips**

Row tag chips currently use `tagKind(tag)` → `Badge`. Build `const tagColorByName = useMemo(() => new Map((tagsQ.data ?? []).map(t => [t.name, t.color])), [tagsQ.data]);` in ContactsImpl, pass to `ContactsTable`, and render each chip with its hue when known:

```tsx
{c.tags.map((tg) => {
  const hue = tagColorByName.get(tg);
  return hue ? (
    <span
      key={tg}
      style={{
        fontSize: 11, padding: "2px 8px", borderRadius: 999,
        background: `hsl(${hue} 70% 45% / 0.15)`,
        color: `hsl(${hue} 70% 35%)`,
        border: `1px solid hsl(${hue} 70% 45% / 0.35)`,
      }}
    >
      {tg}
    </span>
  ) : (
    <Badge key={tg} kind={tagKind(tg)}>{tg}</Badge>
  );
})}
```

- [ ] **Step 6: Typecheck + verify + commit**

`npm run typecheck` clean. Verify skill: tabs switch; select 2 contacts → Add to group (create one manually via curl first if Task 5's UI isn't built yet) → segments refetch shows count; bulk-tag applies catalog chips + quick-created name appears colored on rows.

```bash
git add src/screens/Contacts.tsx src/lib/types.ts
git commit -m "feat(contacts): tabs shell, add-to-group bulk action, catalog-colored tag chips"
```

---

### Task 5: Groups tab

**Files:**
- Create: `src/screens/contacts/GroupsTab.tsx`
- Modify: `src/screens/Contacts.tsx` (replace the placeholder with the real import)

**Interfaces:**
- Consumes: `GET /segments` (rows with `origin`, `count`), `POST /segments {name, nameAr?, color?, origin:"manual"}`, `GET /segments/:id/members?search=`, `POST /segments/:id/members`, `DELETE /segments/:id/members/:contactId`, `GET /contacts` (for the add-member search box — reuse the already-fetched contacts list passed as a prop).

- [ ] **Step 1: Build the component** — `src/screens/contacts/GroupsTab.tsx`:

```tsx
import { useMemo, useState } from "react";
import type { Lang } from "@/lib/tx";
import type { Contact, Segment } from "@/lib/types";
import { useFetch, useMutation } from "@/api/useFetch";
import { api } from "@/api/client";
import { Modal } from "@/components/Modal";
import { IconPlus, IconX } from "@/icons";

interface MemberRow {
  id: string;
  name: string;
  phone: string | null;
  source: string;
}

interface GroupsTabProps {
  tx: (en: string, ar: string) => string;
  lang: Lang;
  contacts: Contact[];
}

const hueBg = (hue: string | null | undefined, a: number) =>
  hue ? `hsl(${hue} 70% 45% / ${a})` : "var(--bg-2)";

/** Card grid of groups (manual) and smart segments (rule-based, read-only
 *  membership) + a member-management drawer for manual groups. */
export function GroupsTab({ tx, lang, contacts }: GroupsTabProps) {
  const segmentsQ = useFetch<Segment[]>("/segments");
  const [openGroup, setOpenGroup] = useState<Segment | null>(null);
  const [creating, setCreating] = useState(false);

  const rows = segmentsQ.data ?? [];
  const groups = rows.filter((s) => s.origin === "manual");
  const smart = rows.filter((s) => s.origin !== "manual");

  return (
    <div style={{ padding: "0 24px 24px", display: "grid", gap: 18 }}>
      <section>
        <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", margin: "6px 0 10px" }}>
          {tx("Your groups", "مجموعاتك")} · {groups.length}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
          <button
            type="button"
            onClick={() => setCreating(true)}
            style={{
              border: "2px dashed var(--line)", borderRadius: 14, minHeight: 110,
              background: "transparent", cursor: "pointer", display: "grid",
              placeItems: "center", color: "var(--ink-3)", fontSize: 13,
            }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <IconPlus w={14} /> {tx("New group", "مجموعة جديدة")}
            </span>
          </button>
          {groups.map((g) => (
            <GroupCard key={g.id} seg={g} lang={lang} tx={tx} badge={tx("manual", "يدوية")} onClick={() => setOpenGroup(g)} />
          ))}
        </div>
      </section>

      {smart.length > 0 && (
        <section>
          <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", margin: "6px 0 10px" }}>
            {tx("Smart segments", "الشرائح الذكية")} · {smart.length}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
            {smart.map((g) => (
              <GroupCard key={g.id} seg={g} lang={lang} tx={tx} badge={tx("smart", "ذكية")} />
            ))}
          </div>
        </section>
      )}

      {segmentsQ.error && (
        <div style={{ fontSize: 12, color: "var(--bad)" }}>{tx("Couldn't load groups.", "تعذر تحميل المجموعات.")}</div>
      )}

      {creating && (
        <CreateGroupModal
          tx={tx}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            segmentsQ.refetch();
          }}
        />
      )}

      {openGroup && (
        <GroupMembersModal
          tx={tx}
          lang={lang}
          group={openGroup}
          contacts={contacts}
          onClose={() => setOpenGroup(null)}
          onChanged={() => segmentsQ.refetch()}
        />
      )}
    </div>
  );
}

function GroupCard({
  seg,
  lang,
  tx,
  badge,
  onClick,
}: {
  seg: Segment;
  lang: Lang;
  tx: (en: string, ar: string) => string;
  badge: string;
  onClick?: () => void;
}) {
  const name = lang === "ar" && seg.nameAr ? seg.nameAr : seg.name;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      style={{
        textAlign: "start", border: "1px solid var(--line-soft)", borderRadius: 14,
        background: "var(--bg-1)", padding: 16, cursor: onClick ? "pointer" : "default",
        display: "flex", flexDirection: "column", gap: 8, minHeight: 110,
        borderInlineStartWidth: 4,
        borderInlineStartColor: seg.color ? `hsl(${seg.color} 70% 45%)` : "var(--line)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontWeight: 600, fontSize: 14, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {name}
        </span>
        <span className="mono" style={{ fontSize: 10, textTransform: "uppercase", padding: "2px 8px", borderRadius: 999, background: hueBg(seg.color, 0.15), color: "var(--ink-2)" }}>
          {badge}
        </span>
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
        {seg.count.toLocaleString()}
      </div>
      <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)", textTransform: "uppercase" }}>
        {tx("contacts", "جهة اتصال")}
      </div>
    </button>
  );
}

function CreateGroupModal({
  tx,
  onClose,
  onCreated,
}: {
  tx: (en: string, ar: string) => string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [nameAr, setNameAr] = useState("");
  const [color, setColor] = useState("150");
  const createMut = useMutation<{ name: string; nameAr?: string; color: string; origin: "manual" }, Segment>(
    (input) => api.post("/segments", input),
  );
  const HUES = ["0", "30", "60", "90", "120", "150", "180", "210", "240", "270", "300", "330"];
  return (
    <Modal onClose={createMut.loading ? () => {} : onClose} width={420} label="New group" panelStyle={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <h3 style={{ margin: 0, fontSize: 15 }}>{tx("New group", "مجموعة جديدة")}</h3>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={tx("Group name", "اسم المجموعة")}
        style={{ height: 34, padding: "0 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--bg-1)", color: "var(--ink)", fontSize: 13 }}
      />
      <input
        value={nameAr}
        onChange={(e) => setNameAr(e.target.value)}
        placeholder={tx("Arabic name (optional)", "الاسم بالعربية (اختياري)")}
        dir="rtl"
        style={{ height: 34, padding: "0 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--bg-1)", color: "var(--ink)", fontSize: 13 }}
      />
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {HUES.map((h) => (
          <button
            key={h}
            type="button"
            onClick={() => setColor(h)}
            aria-label={`hue ${h}`}
            style={{
              width: 22, height: 22, borderRadius: "50%", cursor: "pointer",
              background: `hsl(${h} 70% 45%)`,
              border: color === h ? "2px solid var(--ink)" : "2px solid transparent",
            }}
          />
        ))}
      </div>
      {createMut.error && <div style={{ fontSize: 12, color: "var(--bad)" }}>{createMut.error}</div>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" className="btn ghost" onClick={onClose} disabled={createMut.loading}>
          {tx("Cancel", "إلغاء")}
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={!name.trim() || createMut.loading}
          onClick={() => {
            void createMut
              .mutate({ name: name.trim(), nameAr: nameAr.trim() || undefined, color, origin: "manual" })
              .then(onCreated)
              .catch(() => {});
          }}
        >
          {createMut.loading ? tx("Creating…", "جارٍ الإنشاء…") : tx("Create group", "إنشاء المجموعة")}
        </button>
      </div>
    </Modal>
  );
}

function GroupMembersModal({
  tx,
  lang,
  group,
  contacts,
  onClose,
  onChanged,
}: {
  tx: (en: string, ar: string) => string;
  lang: Lang;
  group: Segment;
  contacts: Contact[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const membersQ = useFetch<MemberRow[]>(`/segments/${group.id}/members`);
  const [search, setSearch] = useState("");
  const addMut = useMutation<{ contactIds: string[] }, { added: number }>((input) =>
    api.post(`/segments/${group.id}/members`, input),
  );
  const removeMut = useMutation<{ contactId: string }, { ok: true }>(({ contactId }) =>
    api.delete(`/segments/${group.id}/members/${contactId}`),
  );

  const memberIds = useMemo(() => new Set((membersQ.data ?? []).map((m) => m.id)), [membersQ.data]);
  const candidates = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return contacts.filter((c) => !memberIds.has(c.id) && c.name.toLowerCase().includes(q)).slice(0, 8);
  }, [search, contacts, memberIds]);

  const name = lang === "ar" && group.nameAr ? group.nameAr : group.name;
  const busy = addMut.loading || removeMut.loading;

  return (
    <Modal onClose={busy ? () => {} : onClose} width={520} label="Group members" panelStyle={{ display: "flex", flexDirection: "column", gap: 12, maxHeight: "80vh" }}>
      <h3 style={{ margin: 0, fontSize: 15 }}>
        {name} <span className="mono muted" style={{ fontSize: 11 }}>· {(membersQ.data ?? []).length} {tx("members", "عضو")}</span>
      </h3>
      <div style={{ position: "relative" }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={tx("Search contacts to add…", "ابحث عن جهات لإضافتها…")}
          style={{ width: "100%", height: 34, padding: "0 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--bg-1)", color: "var(--ink)", fontSize: 13 }}
        />
        {candidates.length > 0 && (
          <div style={{ position: "absolute", top: 38, insetInlineStart: 0, insetInlineEnd: 0, zIndex: 5, background: "var(--bg-elev)", border: "1px solid var(--line-soft)", borderRadius: 10, boxShadow: "var(--shadow-lg)", overflow: "hidden" }}>
            {candidates.map((c) => (
              <button
                key={c.id}
                type="button"
                disabled={busy}
                onClick={() => {
                  void addMut.mutate({ contactIds: [c.id] }).then(() => {
                    setSearch("");
                    membersQ.refetch();
                    onChanged();
                  }).catch(() => {});
                }}
                style={{ display: "flex", width: "100%", gap: 8, padding: "8px 12px", background: "transparent", border: 0, cursor: "pointer", textAlign: "start", fontSize: 13 }}
              >
                <span style={{ flex: 1 }}>{c.name}</span>
                <span className="mono muted" style={{ fontSize: 11 }}>{c.phone ?? c.source}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {(addMut.error || removeMut.error) && (
        <div style={{ fontSize: 12, color: "var(--bad)" }}>{addMut.error ?? removeMut.error}</div>
      )}
      <div style={{ overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
        {membersQ.loading && <div className="mono muted" style={{ fontSize: 12 }}>{tx("loading…", "جارٍ التحميل…")}</div>}
        {!membersQ.loading && (membersQ.data ?? []).length === 0 && (
          <div className="mono muted" style={{ fontSize: 12, padding: 8 }}>
            {tx("No members yet — search above or bulk-add from the Contacts tab.", "لا أعضاء بعد — ابحث أعلاه أو أضف جماعيًا من تبويب جهات الاتصال.")}
          </div>
        )}
        {(membersQ.data ?? []).map((m) => (
          <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 10px", background: "var(--bg-1)", border: "1px solid var(--line-soft)", borderRadius: 8 }}>
            <span style={{ flex: 1, fontSize: 13 }}>{m.name}</span>
            <span className="mono muted" style={{ fontSize: 11 }}>{m.phone ?? m.source}</span>
            <button
              type="button"
              className="btn ghost icon sm"
              aria-label={tx("Remove from group", "إزالة من المجموعة")}
              disabled={busy}
              onClick={() => {
                void removeMut.mutate({ contactId: m.id }).then(() => {
                  membersQ.refetch();
                  onChanged();
                }).catch(() => {});
              }}
            >
              <IconX w={12} />
            </button>
          </div>
        ))}
      </div>
    </Modal>
  );
}
```

Adapt small prop realities while wiring (Modal props as used in Media.tsx; `Lang` import path — it lives in `@/lib/tx` per Inbox's import; `Contact` type fields).

- [ ] **Step 2: Wire into Contacts.tsx** — remove the Task 4 placeholder; `import { GroupsTab } from "./contacts/GroupsTab";` and render `{activeTab === "groups" && <GroupsTab tx={tx} lang={t.lang} contacts={contacts} />}` (pass the screen's already-fetched contacts array).

- [ ] **Step 3: Typecheck + verify + commit**

`npm run typecheck` clean. Verify skill: create a group (AR name too), open it, search-add two contacts, remove one, counts update on the card; smart segments render with badges and no member editing; RTL pass.

```bash
git add src/screens/contacts/GroupsTab.tsx src/screens/Contacts.tsx
git commit -m "feat(contacts): groups tab — cards, create, member management"
```

---

### Task 6: Tags tab

**Files:**
- Create: `src/screens/contacts/TagsTab.tsx`
- Modify: `src/screens/Contacts.tsx` (replace placeholder; refetch tags on changes)

**Interfaces:**
- Consumes: Task 2's `/tags` endpoints; `TagRow` type from Task 4.

- [ ] **Step 1: Build the component** — `src/screens/contacts/TagsTab.tsx`:

```tsx
import { useState } from "react";
import type { TagRow } from "@/lib/types";
import { useFetch, useMutation } from "@/api/useFetch";
import { api } from "@/api/client";
import { Modal } from "@/components/Modal";
import { IconPlus, IconTrash } from "@/icons";

const HUES = ["0", "30", "60", "90", "120", "150", "180", "210", "240", "270", "300", "330"];

interface TagsTabProps {
  tx: (en: string, ar: string) => string;
  onCatalogChanged: () => void;
}

/** The tag catalog: colored chips with usage counts, inline rename, recolor,
 *  delete-with-impact. Contacts keep tag NAMES; this manages the metadata. */
export function TagsTab({ tx, onCatalogChanged }: TagsTabProps) {
  const tagsQ = useFetch<TagRow[]>("/tags");
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState<string | null>(null); // tag id
  const [editName, setEditName] = useState("");
  const [colorFor, setColorFor] = useState<TagRow | null>(null);
  const [deleting, setDeleting] = useState<TagRow | null>(null);

  const createMut = useMutation<{ name: string }, TagRow>((input) => api.post("/tags", input));
  const updateMut = useMutation<{ id: string; name?: string; color?: string }, { tag: TagRow; contactsUpdated: number }>(
    ({ id, ...body }) => api.patch(`/tags/${id}`, body),
  );
  const deleteMut = useMutation<{ id: string }, { ok: true; contactsUpdated: number }>(({ id }) =>
    api.delete(`/tags/${id}`),
  );

  const refresh = () => {
    tagsQ.refetch();
    onCatalogChanged();
  };
  const rows = tagsQ.data ?? [];

  return (
    <div style={{ padding: "0 24px 24px", display: "grid", gap: 12, maxWidth: 720 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && newName.trim()) {
              void createMut.mutate({ name: newName.trim() }).then(() => {
                setNewName("");
                refresh();
              }).catch(() => {});
            }
          }}
          placeholder={tx("New tag name…", "اسم وسم جديد…")}
          style={{ flex: 1, height: 34, padding: "0 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--bg-1)", color: "var(--ink)", fontSize: 13 }}
        />
        <button
          type="button"
          className="btn primary"
          disabled={!newName.trim() || createMut.loading}
          onClick={() => {
            void createMut.mutate({ name: newName.trim() }).then(() => {
              setNewName("");
              refresh();
            }).catch(() => {});
          }}
        >
          <IconPlus w={13} /> {tx("Add tag", "إضافة وسم")}
        </button>
      </div>
      {(createMut.error || updateMut.error || tagsQ.error) && (
        <div style={{ fontSize: 12, color: "var(--bad)" }}>
          {createMut.error ?? updateMut.error ?? tx("Couldn't load tags.", "تعذر تحميل الوسوم.")}
        </div>
      )}

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        {rows.length === 0 && !tagsQ.loading && (
          <div className="mono muted" style={{ fontSize: 12, padding: 16 }}>
            {tx("No tags yet — create one above.", "لا وسوم بعد — أنشئ واحدًا أعلاه.")}
          </div>
        )}
        {rows.map((t) => (
          <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", borderBottom: "1px solid var(--line-soft)" }}>
            <button
              type="button"
              aria-label={tx("Change color", "تغيير اللون")}
              onClick={() => setColorFor(t)}
              style={{ width: 16, height: 16, borderRadius: "50%", border: "2px solid var(--line-soft)", background: `hsl(${t.color} 70% 45%)`, cursor: "pointer", flexShrink: 0 }}
            />
            {editing === t.id ? (
              <input
                autoFocus
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onBlur={() => setEditing(null)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setEditing(null);
                  if (e.key === "Enter" && editName.trim() && editName.trim() !== t.name) {
                    void updateMut.mutate({ id: t.id, name: editName.trim() }).then(() => {
                      setEditing(null);
                      refresh();
                    }).catch(() => {});
                  }
                }}
                style={{ flex: 1, height: 28, padding: "0 8px", borderRadius: 6, border: "1px solid var(--accent-ring)", background: "var(--bg-1)", color: "var(--ink)", fontSize: 13 }}
              />
            ) : (
              <button
                type="button"
                onClick={() => {
                  setEditing(t.id);
                  setEditName(t.name);
                }}
                title={tx("Click to rename", "انقر لإعادة التسمية")}
                style={{ flex: 1, textAlign: "start", background: "transparent", border: 0, cursor: "text", fontSize: 13.5, color: "var(--ink)", padding: 0 }}
              >
                {t.name}
              </button>
            )}
            <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)", fontVariantNumeric: "tabular-nums" }}>
              {t.usageCount} {tx("contacts", "جهة")}
            </span>
            <button type="button" className="btn ghost icon sm" aria-label={tx("Delete tag", "حذف الوسم")} onClick={() => setDeleting(t)}>
              <IconTrash w={13} />
            </button>
          </div>
        ))}
      </div>

      {colorFor && (
        <Modal onClose={() => setColorFor(null)} width={300} label="Tag color" panelStyle={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <h3 style={{ margin: 0, fontSize: 14 }}>{colorFor.name}</h3>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {HUES.map((h) => (
              <button
                key={h}
                type="button"
                aria-label={`hue ${h}`}
                onClick={() => {
                  void updateMut.mutate({ id: colorFor.id, color: h }).then(() => {
                    setColorFor(null);
                    refresh();
                  }).catch(() => {});
                }}
                style={{ width: 26, height: 26, borderRadius: "50%", cursor: "pointer", background: `hsl(${h} 70% 45%)`, border: colorFor.color === h ? "2px solid var(--ink)" : "2px solid transparent" }}
              />
            ))}
          </div>
        </Modal>
      )}

      {deleting && (
        <Modal onClose={deleteMut.loading ? () => {} : () => setDeleting(null)} width={380} label="Delete tag" panelStyle={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>{tx("Delete this tag?", "حذف هذا الوسم؟")}</h3>
          <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5 }}>
            {tx(
              `"${deleting.name}" will be removed from ${deleting.usageCount} contact(s). This cannot be undone.`,
              `سيُزال "${deleting.name}" من ${deleting.usageCount} جهة اتصال. لا يمكن التراجع.`,
            )}
          </div>
          {deleteMut.error && <div style={{ fontSize: 12, color: "var(--bad)" }}>{deleteMut.error}</div>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" className="btn ghost" onClick={() => setDeleting(null)} disabled={deleteMut.loading}>
              {tx("Cancel", "إلغاء")}
            </button>
            <button
              type="button"
              className="btn"
              style={{ background: "var(--bad)", color: "white", borderColor: "transparent" }}
              disabled={deleteMut.loading}
              onClick={() => {
                void deleteMut.mutate({ id: deleting.id }).then(() => {
                  setDeleting(null);
                  refresh();
                }).catch(() => {});
              }}
            >
              <IconTrash w={13} /> {deleteMut.loading ? tx("Deleting…", "جارٍ الحذف…") : tx("Delete", "حذف")}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Wire into Contacts.tsx** — replace the placeholder; `<TagsTab tx={tx} onCatalogChanged={() => { tagsQ.refetch(); contactsQ.refetch(); }} />` (contacts refetch so renames/deletes reflect on row chips; use the screen's actual contacts query name).

- [ ] **Step 3: Typecheck + verify + commit**

`npm run typecheck` clean. Verify skill: create tag → shows colored with 0 count; assign via Contacts tab bulk bar → count rises; rename → row chips update after refetch; recolor → chips recolor; delete → confirm shows count, chips disappear; RTL pass.

```bash
git add src/screens/contacts/TagsTab.tsx src/screens/Contacts.tsx
git commit -m "feat(contacts): tags tab — catalog with rename, recolor, delete-with-impact"
```

---

### Task 7: Verification pass

**Files:** none new (fixups as individual `fix: <what> found in groups-tags verification` commits).

- [ ] **Step 1:** backend/: `npm test` green; `npm run build` clean. Root: `npm run typecheck && npm run build` clean.
- [ ] **Step 2: E2E sweep** (verify skill, servers up):
  1. Groups: create "عملاء الجملة" (hue 240) → bulk-select 3 contacts in the Contacts tab → Add to group → card count 3 → open members, remove 1 → count 2.
  2. **Campaign audience proof**: Campaigns → New campaign → Audience step lists the group with count 2.
  3. Tags: quick-create from the bulk bar; rename VIP-style tag and verify a similarly-prefixed tag is untouched (create "VIP" and "VIPER" first, rename "VIP"→"Gold", assert "VIPER" contacts unchanged); recolor; delete with impact count.
  4. Regression: existing segment chips filter on the Contacts tab still works; Inbox TagEditor still saves tags (names).
  5. Arabic/RTL across all three tabs.
- [ ] **Step 3:** Grep sweep on this plan's commits: no `console.log` added; no leftover placeholders (`GroupsTab(...){return <div/>`).

---

## Self-review notes (spec → plan coverage)

- Spec §1 data model → Task 1 (Tag + absorb w/ hashtext hue; Segment untouched; Contact.tags format verified live pre-plan). §2 tags endpoints → Task 2 (incl. idempotent quick-create, exact-element jsonb rename/delete, grouped usage counts, assign with workspace validation); segments/groups endpoints + counting + campaign compat → Task 3 (origin field, member CRUD incl. list-with-search, count branch also fixing hjz, existing hjz read-only guards untouched). §3 UI → Tasks 4-6 (tabs, bulk bar reuse + Add-to-group, catalog BulkTagModal upgrade, colored chips w/ Badge fallback, Groups cards + member modal, Tags catalog). §4 error handling → inline errors + styled Modals throughout. §5 testing → per-task units + Task 7 E2E incl. the VIP/VIPER exactness check and the campaign-audience proof. All three spec open-items were resolved during planning and their answers are baked into Tasks 1/3.
- Deliberate deviations from spec: member view is a Modal (not a separate page) — lighter and matches app idioms; `GET /segments/:id/members` search is client-side-boxed at 100 rows (scale-appropriate).
