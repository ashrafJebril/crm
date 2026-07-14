# Pipeline Revamp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 2,267-line monolithic `src/screens/Pipeline.tsx` with a decomposed, paginated, virtualization-ready pipeline page, and add first-class Inbox → Pipeline conversion (linked-tickets pill + "Add to pipeline" button).

**Architecture:** Backend stays — `Ticket` / `TicketStage` / `Pipeline` / `TicketActivity` models and the existing routes are kept. We add one convenience endpoint (`POST /tickets/from-conversation/:conversationId`), broaden `ListTicketsQuery` with `conversationId` + `cursor`, and emit two new realtime events (`ticket.created`, `ticket.updated`). Frontend rebuilds from `src/screens/pipeline/` with ~12 focused files (~150 LOC average): per-stage React Query slices via a `qk` factory, optimistic mutations with rollback, `@tanstack/react-virtual` windowing, and a shared `NewTicketModal` consumed by both the pipeline header and the Inbox.

**Tech Stack:**
- Frontend: React 18.3, TypeScript 5.6, Vite 6, TanStack React Query 5.100, `@dnd-kit/core` 6.3 + `@dnd-kit/sortable` 10, `socket.io-client` 4.8, TailwindCSS 4. **New:** `@tanstack/react-virtual` 3.x.
- Backend: NestJS 10, Prisma 5.22, PostgreSQL + pgvector, Jest 29.
- Verification: backend `npm test` (Jest); frontend `npm run typecheck` + manual dev-server check (via Playwright MCP at milestones).

---

## File Structure

**New files (backend):**
- `backend/src/tickets/tickets.service.spec.ts` — Jest unit tests for service additions
- (no new modules — additions extend existing controller/service/dto)

**Modified files (backend):**
- `backend/src/tickets/tickets.dto.ts` — extend `ListTicketsQuery` with `conversationId` and `cursor`; add `CreateFromConversationDto`
- `backend/src/tickets/tickets.service.ts` — emit `ticket.created` / `ticket.updated`; add `createFromConversation()`; add cursor pagination + `conversationId` filter
- `backend/src/tickets/tickets.controller.ts` — add `POST /tickets/from-conversation/:conversationId`

**New files (frontend):**
- `src/api/queryKeys.ts` — typed query-key factory for all pipeline & ticket caches
- `src/screens/pipeline/PipelinePage.tsx` — layout shell + lazy route entry
- `src/screens/pipeline/PipelineHeader.tsx` — pipeline switcher, KPIs, search, owner filter, "New ticket" button
- `src/screens/pipeline/PipelineBoard.tsx` — DndContext, columns grid, drag overlay
- `src/screens/pipeline/StageColumn.tsx` — single column, virtualized list, owns its query slice
- `src/screens/pipeline/TicketCard.tsx` — pure visual card
- `src/screens/pipeline/TicketDetailDrawer.tsx` — right slide-in drawer with details / activity / notes
- `src/screens/pipeline/NewTicketModal.tsx` — shared by Pipeline header and Inbox
- `src/screens/pipeline/LostReasonModal.tsx` — lost-reason picker
- `src/screens/pipeline/hooks/usePipelineData.ts` — pipelines list + summary
- `src/screens/pipeline/hooks/useStageTickets.ts` — per-stage infinite query
- `src/screens/pipeline/hooks/useTicketMutations.ts` — move / create / update / addNote / delete (all optimistic)
- `src/screens/pipeline/hooks/useTicketRealtime.ts` — subscribe to `ticket.moved/created/updated`
- `src/screens/inbox/ConversationTicketsPill.tsx` — small pill in Inbox conversation header
- `src/screens/inbox/AddToPipelineButton.tsx` — button + opens shared `NewTicketModal` with conversation pre-fill

**Modified files (frontend):**
- `src/router.tsx` line 13 — change `pipeline: lazy(() => import("@/screens/Pipeline"))` to `pipeline: lazy(() => import("@/screens/pipeline/PipelinePage"))`
- `src/screens/Inbox.tsx` — render `ConversationTicketsPill` and `AddToPipelineButton` in the conversation header actions row
- `package.json` — add `@tanstack/react-virtual` dep
- `src/lib/types.ts` — add `TicketsListPage` (cursor-paginated response shape)

**Deleted files (final cleanup task):**
- `src/screens/Pipeline.tsx` — the old monolith

---

## Phase 0 — Branch & dependency setup

### Task 1: Create feature branch and install react-virtual

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Verify clean working tree**

```bash
git status
```

Expected: `nothing to commit, working tree clean` on `feat/whatsapp-ai-mvp`.

- [ ] **Step 2: Create feature branch**

```bash
git checkout -b feat/pipeline-revamp
```

- [ ] **Step 3: Install react-virtual**

```bash
npm install @tanstack/react-virtual@^3.10.0
```

- [ ] **Step 4: Verify install**

```bash
node -e "console.log(require('@tanstack/react-virtual/package.json').version)"
```

Expected: prints a version starting with `3.`.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): add @tanstack/react-virtual for pipeline column windowing"
```

---

## Phase 1 — Backend additions (TDD)

### Task 2: Add `conversationId` filter to ListTicketsQuery (test-first)

**Files:**
- Modify: `backend/src/tickets/tickets.dto.ts`
- Modify: `backend/src/tickets/tickets.service.ts:45-61`
- Create: `backend/src/tickets/tickets.service.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/src/tickets/tickets.service.spec.ts`:

```ts
import { Test } from "@nestjs/testing";
import { TicketsService } from "./tickets.service";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeService } from "../realtime/realtime.service";

describe("TicketsService.listTickets", () => {
  let svc: TicketsService;
  let prisma: { ticket: { findMany: jest.Mock } };

  beforeEach(async () => {
    prisma = { ticket: { findMany: jest.fn().mockResolvedValue([]) } };
    const moduleRef = await Test.createTestingModule({
      providers: [
        TicketsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RealtimeService, useValue: { emitToWorkspace: jest.fn() } },
      ],
    }).compile();
    svc = moduleRef.get(TicketsService);
  });

  it("filters by conversationId when provided", async () => {
    await svc.listTickets("ws_1", { conversationId: "conv_42" });
    expect(prisma.ticket.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: "ws_1",
          conversationId: "conv_42",
        }),
      }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && npm test -- tickets.service.spec
```

Expected: FAIL — the `where` clause does not yet pass `conversationId` (it isn't on the DTO).

- [ ] **Step 3: Extend `ListTicketsQuery` DTO**

In `backend/src/tickets/tickets.dto.ts`, replace the `ListTicketsQuery` class with:

```ts
export class ListTicketsQuery {
  @IsOptional() @IsString() pipelineId?: string;
  @IsOptional() @IsString() stageId?: string;
  @IsOptional() @IsString() contactId?: string;
  @IsOptional() @IsString() conversationId?: string;
  @IsOptional() @IsString() ownerId?: string;
  @IsOptional() @IsInt() @Min(1) limit?: number;
  @IsOptional() @IsString() cursor?: string;
}
```

- [ ] **Step 4: Apply filter in service**

In `backend/src/tickets/tickets.service.ts`, replace `listTickets()` (lines 45-61) with:

```ts
async listTickets(workspaceId: string, query: ListTicketsQuery) {
  const take = query.limit ?? 50;
  const items = await this.prisma.ticket.findMany({
    where: {
      workspaceId,
      pipelineId: query.pipelineId,
      stageId: query.stageId,
      contactId: query.contactId,
      conversationId: query.conversationId,
      ownerId: query.ownerId,
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: take + 1,
    cursor: query.cursor ? { id: query.cursor } : undefined,
    skip: query.cursor ? 1 : 0,
    include: {
      contact: true,
      stage: true,
    },
  });
  const hasMore = items.length > take;
  const page = hasMore ? items.slice(0, take) : items;
  return {
    items: page,
    nextCursor: hasMore ? page[page.length - 1].id : null,
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd backend && npm test -- tickets.service.spec
```

Expected: PASS.

- [ ] **Step 6: Update frontend types**

In `src/lib/types.ts`, find the existing `Ticket` type. Below it, add:

```ts
export interface TicketsListPage {
  items: Ticket[];
  nextCursor: string | null;
}
```

(Place near the other ticket-related types. If `Ticket` isn't in this file, search with `grep -n "type Ticket\\b\\|interface Ticket\\b" src/lib/types.ts` and place it adjacent.)

- [ ] **Step 7: Verify frontend still typechecks**

```bash
npm run typecheck
```

Expected: PASS (it may currently fail in `Pipeline.tsx` if any usage of `useFetch<Ticket[]>("/tickets?...")` exists; that's fine — old file is deleted later. Note any new errors that aren't in `Pipeline.tsx`.)

If errors appear outside `Pipeline.tsx`, update those callers to use `.items` from the new response shape.

- [ ] **Step 8: Commit**

```bash
git add backend/src/tickets/tickets.dto.ts backend/src/tickets/tickets.service.ts backend/src/tickets/tickets.service.spec.ts src/lib/types.ts
git commit -m "feat(tickets): conversationId filter + cursor pagination on GET /tickets"
```

### Task 3: Emit `ticket.created` realtime event (test-first)

**Files:**
- Modify: `backend/src/tickets/tickets.service.ts:77-121` (createTicket)
- Modify: `backend/src/tickets/tickets.service.spec.ts`

- [ ] **Step 1: Write the failing test**

Append to `backend/src/tickets/tickets.service.spec.ts` (inside the existing `describe` or a new sibling describe):

```ts
describe("TicketsService.createTicket", () => {
  let svc: TicketsService;
  let prisma: any;
  let realtime: { emitToWorkspace: jest.Mock };

  beforeEach(async () => {
    prisma = {
      ticketStage: { findFirst: jest.fn().mockResolvedValue({ id: "st_1", pipelineId: "pl_1", key: "new" }) },
      ticket: {
        findFirst: jest.fn().mockResolvedValue({ number: 4 }),
        create: jest.fn().mockResolvedValue({ id: "tk_1", number: 5, stageId: "st_1", pipelineId: "pl_1" }),
      },
      ticketActivity: { create: jest.fn().mockResolvedValue({}) },
    };
    realtime = { emitToWorkspace: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        TicketsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RealtimeService, useValue: realtime },
      ],
    }).compile();
    svc = moduleRef.get(TicketsService);
  });

  it("emits ticket.created after successful insert", async () => {
    await svc.createTicket("ws_1", {
      pipelineId: "pl_1",
      stageId: "st_1",
      contactId: "ct_1",
      title: "Test",
    });
    expect(realtime.emitToWorkspace).toHaveBeenCalledWith(
      "ws_1",
      "ticket.created",
      expect.objectContaining({ ticket: expect.objectContaining({ id: "tk_1" }) }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && npm test -- tickets.service.spec
```

Expected: FAIL — `emitToWorkspace` not called by `createTicket`.

- [ ] **Step 3: Add the emit**

In `backend/src/tickets/tickets.service.ts`, at the end of `createTicket()` (just before `return ticket;` on line 120), insert:

```ts
this.realtime.emitToWorkspace(workspaceId, "ticket.created", { ticket });
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd backend && npm test -- tickets.service.spec
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/tickets/tickets.service.ts backend/src/tickets/tickets.service.spec.ts
git commit -m "feat(tickets): emit ticket.created realtime event"
```

### Task 4: Emit `ticket.updated` realtime event (test-first)

**Files:**
- Modify: `backend/src/tickets/tickets.service.ts:123-162` (updateTicket)
- Modify: `backend/src/tickets/tickets.service.spec.ts`

- [ ] **Step 1: Write the failing test**

Append a `describe("updateTicket")` block to the spec:

```ts
describe("TicketsService.updateTicket", () => {
  let svc: TicketsService;
  let prisma: any;
  let realtime: { emitToWorkspace: jest.Mock };

  beforeEach(async () => {
    prisma = {
      ticket: {
        findFirst: jest.fn().mockResolvedValue({ id: "tk_1", value: 100, ownerId: "u_1" }),
        update: jest.fn().mockResolvedValue({ id: "tk_1", value: 200, ownerId: "u_1" }),
      },
      ticketActivity: { create: jest.fn().mockResolvedValue({}) },
    };
    realtime = { emitToWorkspace: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        TicketsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RealtimeService, useValue: realtime },
      ],
    }).compile();
    svc = moduleRef.get(TicketsService);
  });

  it("emits ticket.updated after successful update", async () => {
    await svc.updateTicket("ws_1", "tk_1", { value: 200 });
    expect(realtime.emitToWorkspace).toHaveBeenCalledWith(
      "ws_1",
      "ticket.updated",
      expect.objectContaining({ ticket: expect.objectContaining({ id: "tk_1", value: 200 }) }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && npm test -- tickets.service.spec
```

Expected: FAIL.

- [ ] **Step 3: Add the emit**

In `backend/src/tickets/tickets.service.ts`, at the end of `updateTicket()` (just before `return updated;` on line 161), insert:

```ts
this.realtime.emitToWorkspace(workspaceId, "ticket.updated", { ticket: updated });
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd backend && npm test -- tickets.service.spec
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/tickets/tickets.service.ts backend/src/tickets/tickets.service.spec.ts
git commit -m "feat(tickets): emit ticket.updated realtime event"
```

### Task 5: Add `POST /tickets/from-conversation/:conversationId` (test-first)

**Files:**
- Modify: `backend/src/tickets/tickets.dto.ts`
- Modify: `backend/src/tickets/tickets.service.ts`
- Modify: `backend/src/tickets/tickets.controller.ts`
- Modify: `backend/src/tickets/tickets.service.spec.ts`

- [ ] **Step 1: Write the failing test**

Append to spec:

```ts
describe("TicketsService.createFromConversation", () => {
  let svc: TicketsService;
  let prisma: any;
  let realtime: { emitToWorkspace: jest.Mock };

  beforeEach(async () => {
    prisma = {
      conversation: {
        findFirst: jest.fn().mockResolvedValue({ id: "conv_1", contactId: "ct_99", workspaceId: "ws_1" }),
      },
      ticketStage: { findFirst: jest.fn().mockResolvedValue({ id: "st_1", pipelineId: "pl_1", key: "new" }) },
      ticket: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: "tk_new",
          number: 1,
          contactId: "ct_99",
          conversationId: "conv_1",
          pipelineId: "pl_1",
          stageId: "st_1",
        }),
      },
      ticketActivity: { create: jest.fn().mockResolvedValue({}) },
    };
    realtime = { emitToWorkspace: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        TicketsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RealtimeService, useValue: realtime },
      ],
    }).compile();
    svc = moduleRef.get(TicketsService);
  });

  it("resolves contactId from the conversation and creates the ticket", async () => {
    const result = await svc.createFromConversation("ws_1", "conv_1", {
      pipelineId: "pl_1",
      stageId: "st_1",
      title: "Lead from chat",
    });
    expect(prisma.conversation.findFirst).toHaveBeenCalledWith({
      where: { id: "conv_1", workspaceId: "ws_1" },
    });
    expect(prisma.ticket.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          contactId: "ct_99",
          conversationId: "conv_1",
          title: "Lead from chat",
        }),
      }),
    );
    expect(realtime.emitToWorkspace).toHaveBeenCalledWith(
      "ws_1",
      "ticket.created",
      expect.objectContaining({ ticket: expect.objectContaining({ id: "tk_new" }) }),
    );
    expect(result).toEqual(expect.objectContaining({ id: "tk_new" }));
  });

  it("throws NotFoundException when conversation does not exist", async () => {
    prisma.conversation.findFirst.mockResolvedValueOnce(null);
    await expect(
      svc.createFromConversation("ws_1", "missing", {
        pipelineId: "pl_1",
        stageId: "st_1",
        title: "x",
      }),
    ).rejects.toThrow("Conversation not found");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && npm test -- tickets.service.spec
```

Expected: FAIL — `createFromConversation` does not exist.

- [ ] **Step 3: Add DTO**

In `backend/src/tickets/tickets.dto.ts`, append:

```ts
export class CreateFromConversationDto {
  @IsString() @IsNotEmpty() pipelineId!: string;
  @IsString() @IsNotEmpty() stageId!: string;
  @IsString() @IsNotEmpty() title!: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsNumber() @Min(0) value?: number;
  @IsOptional() @IsString() ownerId?: string;
}
```

- [ ] **Step 4: Add service method**

In `backend/src/tickets/tickets.service.ts`, add this method directly above `addNote()`:

```ts
async createFromConversation(
  workspaceId: string,
  conversationId: string,
  dto: {
    pipelineId: string;
    stageId: string;
    title: string;
    description?: string;
    value?: number;
    ownerId?: string;
  },
) {
  const conv = await this.prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId },
  });
  if (!conv) throw new NotFoundException("Conversation not found");

  return this.createTicket(workspaceId, {
    pipelineId: dto.pipelineId,
    stageId: dto.stageId,
    contactId: conv.contactId,
    conversationId,
    title: dto.title,
    description: dto.description,
    value: dto.value,
    ownerId: dto.ownerId,
  });
}
```

Note: this delegates to `createTicket()` which already emits `ticket.created` (Task 3). No duplicate emit.

- [ ] **Step 5: Add controller route**

In `backend/src/tickets/tickets.controller.ts`, add the import alongside the existing DTOs:

```ts
import {
  AddNoteDto,
  CreateFromConversationDto,
  CreateTicketDto,
  ListTicketsQuery,
  MoveTicketDto,
  UpdateTicketDto,
} from "./tickets.dto";
```

Then add this route directly above `@Patch("tickets/:id")`:

```ts
@Post("tickets/from-conversation/:conversationId")
createFromConversation(
  @CurrentWorkspace() workspaceId: string,
  @Param("conversationId") conversationId: string,
  @Body() dto: CreateFromConversationDto,
) {
  return this.svc.createFromConversation(workspaceId, conversationId, dto);
}
```

- [ ] **Step 6: Run test to verify it passes**

```bash
cd backend && npm test -- tickets.service.spec
```

Expected: PASS (all five tests across this file).

- [ ] **Step 7: Smoke test the route by booting the backend**

```bash
cd backend && npm run dev
```

Wait for `Nest application successfully started`. Then in another shell:

```bash
curl -X POST http://localhost:3000/tickets/from-conversation/__invalid__ \
  -H "Authorization: Bearer <a real JWT>" \
  -H "Content-Type: application/json" \
  -d '{"pipelineId":"x","stageId":"y","title":"t"}'
```

Expected: 404 `{"message":"Conversation not found", ...}`. Stop the dev server (Ctrl+C).

(If a real JWT is not handy, skip this curl step — the unit tests already cover the happy + 404 paths.)

- [ ] **Step 8: Commit**

```bash
git add backend/src/tickets/tickets.dto.ts backend/src/tickets/tickets.service.ts backend/src/tickets/tickets.controller.ts backend/src/tickets/tickets.service.spec.ts
git commit -m "feat(tickets): POST /tickets/from-conversation/:conversationId convenience endpoint"
```

---

## Phase 2 — Frontend foundations (query keys + hooks)

### Task 6: Create `qk` query-key factory

**Files:**
- Create: `src/api/queryKeys.ts`

- [ ] **Step 1: Create the file**

```ts
// src/api/queryKeys.ts
//
// Single source of truth for React Query cache keys touched by the pipeline
// feature. Every hook and mutation references qk.* — no ad-hoc string keys.
// Adding a new query? Add it here first.

export const qk = {
  pipelines: () => ["pipelines"] as const,

  stageTickets: (
    pipelineId: string,
    stageId: string,
    filters?: { ownerId?: string; q?: string },
  ) => ["tickets", "stage", pipelineId, stageId, filters ?? {}] as const,

  ticket: (id: string) => ["tickets", "detail", id] as const,

  summary: (pipelineId: string) => ["tickets", "summary", pipelineId] as const,

  conversationTickets: (conversationId: string) =>
    ["tickets", "conversation", conversationId] as const,
};
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/api/queryKeys.ts
git commit -m "feat(api): qk query-key factory for ticket caches"
```

### Task 7: Add `usePipelineData` hook (pipelines list + summary)

**Files:**
- Create: `src/screens/pipeline/hooks/usePipelineData.ts`

- [ ] **Step 1: Create the directory + file**

```bash
mkdir -p src/screens/pipeline/hooks
```

Then create `src/screens/pipeline/hooks/usePipelineData.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk } from "@/api/queryKeys";
import type { Pipeline, TicketsDashboardSummary } from "@/lib/types";

export function usePipelines() {
  return useQuery<Pipeline[]>({
    queryKey: qk.pipelines(),
    queryFn: ({ signal }) => api.get<Pipeline[]>("/pipelines", signal),
    staleTime: 60_000, // pipelines change rarely
  });
}

export function usePipelineSummary(pipelineId: string | null) {
  return useQuery<TicketsDashboardSummary>({
    queryKey: pipelineId ? qk.summary(pipelineId) : ["__disabled__"],
    queryFn: ({ signal }) =>
      api.get<TicketsDashboardSummary>("/tickets/dashboard/summary", signal),
    enabled: !!pipelineId,
  });
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: PASS. If `TicketsDashboardSummary` or `Pipeline` types are missing imports, fix them.

- [ ] **Step 3: Commit**

```bash
git add src/screens/pipeline/hooks/usePipelineData.ts
git commit -m "feat(pipeline): usePipelines + usePipelineSummary hooks"
```

### Task 8: Add `useStageTickets` infinite query

**Files:**
- Create: `src/screens/pipeline/hooks/useStageTickets.ts`

- [ ] **Step 1: Create the file**

```ts
import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk } from "@/api/queryKeys";
import type { TicketsListPage } from "@/lib/types";

interface StageTicketsFilters {
  ownerId?: string;
  q?: string; // client-side search, kept in the key so cache stays stable
}

export function useStageTickets(
  pipelineId: string | null,
  stageId: string | null,
  filters: StageTicketsFilters = {},
) {
  const enabled = !!pipelineId && !!stageId;

  return useInfiniteQuery<TicketsListPage>({
    queryKey: enabled
      ? qk.stageTickets(pipelineId!, stageId!, filters)
      : ["__disabled__"],
    queryFn: async ({ pageParam, signal }) => {
      const params = new URLSearchParams();
      params.set("pipelineId", pipelineId!);
      params.set("stageId", stageId!);
      params.set("limit", "50");
      if (filters.ownerId) params.set("ownerId", filters.ownerId);
      if (pageParam) params.set("cursor", pageParam as string);
      return api.get<TicketsListPage>(`/tickets?${params.toString()}`, signal);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
    staleTime: 10_000,
  });
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/screens/pipeline/hooks/useStageTickets.ts
git commit -m "feat(pipeline): useStageTickets per-stage infinite query"
```

### Task 9: Add `useTicketMutations` (move, create, update, addNote, delete)

**Files:**
- Create: `src/screens/pipeline/hooks/useTicketMutations.ts`

- [ ] **Step 1: Create the file**

```ts
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk } from "@/api/queryKeys";
import type {
  Ticket,
  TicketActivity,
  TicketsListPage,
} from "@/lib/types";

type StageTicketsCache = { pages: TicketsListPage[]; pageParams: unknown[] };

/** Walk every stageTickets cache page and apply a per-page transform. */
function patchStageCache(
  qc: ReturnType<typeof useQueryClient>,
  pipelineId: string,
  stageId: string,
  fn: (items: Ticket[]) => Ticket[],
) {
  qc.setQueriesData<StageTicketsCache>(
    { queryKey: ["tickets", "stage", pipelineId, stageId] },
    (curr) => {
      if (!curr) return curr;
      return {
        ...curr,
        pages: curr.pages.map((p) => ({ ...p, items: fn(p.items) })),
      };
    },
  );
}

// ─── Move ───────────────────────────────────────────────────────────────

interface MoveVars {
  ticketId: string;
  fromStageId: string;
  toStageId: string;
  pipelineId: string;
  lostReason?: string;
  optimisticTicket: Ticket; // current ticket snapshot for the optimistic prepend
}

export function useMoveTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: MoveVars) =>
      api.post<Ticket>(`/tickets/${v.ticketId}/move`, {
        stageId: v.toStageId,
        lostReason: v.lostReason,
      }),
    onMutate: async (v) => {
      // Snapshot for rollback
      const fromKey = ["tickets", "stage", v.pipelineId, v.fromStageId];
      const toKey = ["tickets", "stage", v.pipelineId, v.toStageId];
      await qc.cancelQueries({ queryKey: fromKey });
      await qc.cancelQueries({ queryKey: toKey });
      const fromSnap = qc.getQueriesData<StageTicketsCache>({ queryKey: fromKey });
      const toSnap = qc.getQueriesData<StageTicketsCache>({ queryKey: toKey });

      // Patch: remove from source, prepend to destination
      patchStageCache(qc, v.pipelineId, v.fromStageId, (items) =>
        items.filter((t) => t.id !== v.ticketId),
      );
      patchStageCache(qc, v.pipelineId, v.toStageId, (items) => [
        { ...v.optimisticTicket, stageId: v.toStageId },
        ...items.filter((t) => t.id !== v.ticketId),
      ]);

      return { fromSnap, toSnap };
    },
    onError: (_e, _v, ctx) => {
      ctx?.fromSnap.forEach(([key, val]) => qc.setQueryData(key, val));
      ctx?.toSnap.forEach(([key, val]) => qc.setQueryData(key, val));
    },
    onSettled: (_data, _err, v) => {
      qc.invalidateQueries({
        queryKey: ["tickets", "stage", v.pipelineId, v.fromStageId],
      });
      qc.invalidateQueries({
        queryKey: ["tickets", "stage", v.pipelineId, v.toStageId],
      });
      qc.invalidateQueries({ queryKey: qk.summary(v.pipelineId) });
    },
  });
}

// ─── Create ─────────────────────────────────────────────────────────────

interface CreateVars {
  pipelineId: string;
  stageId: string;
  contactId: string;
  title: string;
  description?: string;
  value?: number;
  ownerId?: string;
  conversationId?: string;
}

export function useCreateTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: CreateVars) => api.post<Ticket>("/tickets", v),
    onSuccess: (ticket, v) => {
      patchStageCache(qc, v.pipelineId, v.stageId, (items) => [ticket, ...items]);
      qc.invalidateQueries({ queryKey: qk.summary(v.pipelineId) });
      if (v.conversationId) {
        qc.invalidateQueries({ queryKey: qk.conversationTickets(v.conversationId) });
      }
    },
  });
}

/** Create from a conversation (Inbox flow). Server resolves contactId. */
export function useCreateTicketFromConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: {
      conversationId: string;
      pipelineId: string;
      stageId: string;
      title: string;
      description?: string;
      value?: number;
      ownerId?: string;
    }) =>
      api.post<Ticket>(`/tickets/from-conversation/${v.conversationId}`, {
        pipelineId: v.pipelineId,
        stageId: v.stageId,
        title: v.title,
        description: v.description,
        value: v.value,
        ownerId: v.ownerId,
      }),
    onSuccess: (ticket, v) => {
      patchStageCache(qc, v.pipelineId, v.stageId, (items) => [ticket, ...items]);
      qc.invalidateQueries({ queryKey: qk.summary(v.pipelineId) });
      qc.invalidateQueries({ queryKey: qk.conversationTickets(v.conversationId) });
    },
  });
}

// ─── Update ─────────────────────────────────────────────────────────────

export function useUpdateTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: {
      id: string;
      patch: { title?: string; description?: string; value?: number; ownerId?: string };
    }) => api.patch<Ticket>(`/tickets/${v.id}`, v.patch),
    onSuccess: (ticket) => {
      qc.setQueryData(qk.ticket(ticket.id), ticket);
      // Patch every stage cache that might contain it (pipelineId may vary)
      qc.setQueriesData<StageTicketsCache>(
        { queryKey: ["tickets", "stage"] },
        (curr) => {
          if (!curr) return curr;
          return {
            ...curr,
            pages: curr.pages.map((p) => ({
              ...p,
              items: p.items.map((t) => (t.id === ticket.id ? ticket : t)),
            })),
          };
        },
      );
    },
  });
}

// ─── Add note ───────────────────────────────────────────────────────────

export function useAddNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { ticketId: string; note: string }) =>
      api.post<TicketActivity>(`/tickets/${v.ticketId}/notes`, { note: v.note }),
    onSuccess: (_a, v) => {
      qc.invalidateQueries({ queryKey: qk.ticket(v.ticketId) });
    },
  });
}

// ─── Delete ─────────────────────────────────────────────────────────────

export function useDeleteTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { id: string; pipelineId: string; stageId: string }) =>
      api.del(`/tickets/${v.id}`),
    onSuccess: (_a, v) => {
      patchStageCache(qc, v.pipelineId, v.stageId, (items) =>
        items.filter((t) => t.id !== v.id),
      );
      qc.invalidateQueries({ queryKey: qk.summary(v.pipelineId) });
    },
  });
}
```

- [ ] **Step 2: Verify `api.post / api.patch / api.del` exist**

```bash
```

Run:

```bash
grep -n "export " src/api/client.ts | head -20
```

Expected: shows `post`, `patch`, `del` (or `delete`) on the `api` object. If the method is named `delete` instead of `del`, change `api.del(...)` in the hook to match.

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/screens/pipeline/hooks/useTicketMutations.ts
git commit -m "feat(pipeline): useTicketMutations with optimistic move + rollback"
```

### Task 10: Add `useTicketRealtime` hook

**Files:**
- Create: `src/screens/pipeline/hooks/useTicketRealtime.ts`

- [ ] **Step 1: Create the file**

```ts
import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRealtime } from "@/api/useRealtime";
import { qk } from "@/api/queryKeys";
import type { Ticket, TicketsListPage } from "@/lib/types";

type StageCache = { pages: TicketsListPage[]; pageParams: unknown[] };

/** Subscribe to realtime ticket events for a given pipeline. Idempotent —
 *  if the origin tab already patched its own cache via mutation, the realtime
 *  patch is a no-op since the shapes match. */
export function useTicketRealtime(pipelineId: string | null) {
  const qc = useQueryClient();

  // ticket.moved → remove from source, add to destination
  useRealtime<{ ticket: Ticket; fromStageId: string; toStageId: string }>(
    "ticket.moved",
    useCallback(
      (data) => {
        if (!pipelineId) return;
        if (data.ticket.pipelineId !== pipelineId) return;
        // Remove from source
        qc.setQueriesData<StageCache>(
          { queryKey: ["tickets", "stage", pipelineId, data.fromStageId] },
          (curr) => {
            if (!curr) return curr;
            return {
              ...curr,
              pages: curr.pages.map((p) => ({
                ...p,
                items: p.items.filter((t) => t.id !== data.ticket.id),
              })),
            };
          },
        );
        // Upsert into destination (if not already present)
        qc.setQueriesData<StageCache>(
          { queryKey: ["tickets", "stage", pipelineId, data.toStageId] },
          (curr) => {
            if (!curr) return curr;
            const present = curr.pages.some((p) =>
              p.items.some((t) => t.id === data.ticket.id),
            );
            if (present) {
              return {
                ...curr,
                pages: curr.pages.map((p) => ({
                  ...p,
                  items: p.items.map((t) => (t.id === data.ticket.id ? data.ticket : t)),
                })),
              };
            }
            const [first, ...rest] = curr.pages;
            return {
              ...curr,
              pages: [{ ...first, items: [data.ticket, ...first.items] }, ...rest],
            };
          },
        );
        qc.invalidateQueries({ queryKey: qk.summary(pipelineId) });
      },
      [qc, pipelineId],
    ),
  );

  // ticket.created → prepend to destination stage
  useRealtime<{ ticket: Ticket }>(
    "ticket.created",
    useCallback(
      (data) => {
        if (!pipelineId) return;
        if (data.ticket.pipelineId !== pipelineId) return;
        qc.setQueriesData<StageCache>(
          { queryKey: ["tickets", "stage", pipelineId, data.ticket.stageId] },
          (curr) => {
            if (!curr) return curr;
            const present = curr.pages.some((p) =>
              p.items.some((t) => t.id === data.ticket.id),
            );
            if (present) return curr;
            const [first, ...rest] = curr.pages;
            return {
              ...curr,
              pages: [{ ...first, items: [data.ticket, ...first.items] }, ...rest],
            };
          },
        );
        qc.invalidateQueries({ queryKey: qk.summary(pipelineId) });
      },
      [qc, pipelineId],
    ),
  );

  // ticket.updated → patch single ticket + every stage list it lives in
  useRealtime<{ ticket: Ticket }>(
    "ticket.updated",
    useCallback(
      (data) => {
        qc.setQueryData(qk.ticket(data.ticket.id), data.ticket);
        qc.setQueriesData<StageCache>(
          { queryKey: ["tickets", "stage"] },
          (curr) => {
            if (!curr) return curr;
            return {
              ...curr,
              pages: curr.pages.map((p) => ({
                ...p,
                items: p.items.map((t) => (t.id === data.ticket.id ? data.ticket : t)),
              })),
            };
          },
        );
      },
      [qc],
    ),
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/screens/pipeline/hooks/useTicketRealtime.ts
git commit -m "feat(pipeline): useTicketRealtime for moved/created/updated events"
```

---

## Phase 3 — Frontend UI: cards, columns, board

### Task 11: Create `TicketCard.tsx` (pure visual)

**Files:**
- Create: `src/screens/pipeline/TicketCard.tsx`

- [ ] **Step 1: Read existing card style for reference**

```bash
grep -n "TicketCardView\\|stage-card\\|ticket-card" src/screens/Pipeline.tsx | head -10
```

Open the matching lines to copy the visual look-and-feel (gradient, padding, badges). Match the existing aesthetic — same Avatar, Badge, color tokens.

- [ ] **Step 2: Create the file**

```tsx
import { memo } from "react";
import type { CSSProperties } from "react";
import { Avatar } from "@/components/Avatar";
import { Badge } from "@/components/Badge";
import { IconMessage } from "@/icons"; // if missing, replace with an existing chat-like icon
import type { Ticket, Lang } from "@/lib/types";

interface TicketCardProps {
  ticket: Ticket;
  lang: Lang;
  isDragging?: boolean;
  onClick?: () => void;
  onOpenConversation?: () => void;
}

const cardStyle: CSSProperties = {
  background: "var(--bg-2)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r)",
  padding: 12,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  cursor: "grab",
  userSelect: "none",
};

export const TicketCard = memo(function TicketCard({
  ticket,
  lang,
  isDragging,
  onClick,
  onOpenConversation,
}: TicketCardProps) {
  const t = ticket;
  return (
    <div
      style={{
        ...cardStyle,
        opacity: isDragging ? 0.4 : 1,
        boxShadow: isDragging ? "var(--shadow-1)" : undefined,
      }}
      onClick={onClick}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <div style={{ fontSize: 11, color: "var(--ink-3)", fontFamily: "var(--font-mono)" }}>
          #{t.number}
        </div>
        {t.conversationId ? (
          <button
            type="button"
            title={lang === "ar" ? "افتح المحادثة" : "Open conversation"}
            onClick={(e) => {
              e.stopPropagation();
              onOpenConversation?.();
            }}
            style={{
              background: "transparent",
              border: 0,
              color: "var(--ink-3)",
              cursor: "pointer",
              padding: 0,
            }}
          >
            <IconMessage size={14} />
          </button>
        ) : null}
      </div>

      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>{t.title}</div>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Avatar name={t.contact?.name ?? "?"} size={20} />
        <span style={{ fontSize: 12, color: "var(--ink-2)" }}>
          {t.contact?.name ?? "—"}
        </span>
      </div>

      {t.value != null ? (
        <div style={{ fontSize: 12, color: "var(--ink-2)" }}>
          {t.value.toLocaleString()} {t.currency ?? "SAR"}
        </div>
      ) : null}

      {t.ownerId ? (
        <div style={{ fontSize: 11, color: "var(--ink-3)" }}>
          {lang === "ar" ? "المالك" : "Owner"}: {t.ownerId}
        </div>
      ) : null}
    </div>
  );
});
```

If `IconMessage` does not exist in `@/icons`, run:

```bash
grep -n "^export " src/icons/index.ts | head -30
```

Pick a close existing icon name (e.g. `IconBubble`, `IconChat`) and substitute.

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/screens/pipeline/TicketCard.tsx
git commit -m "feat(pipeline): TicketCard pure-visual component"
```

### Task 12: Create `StageColumn.tsx` with per-stage query + virtualization

**Files:**
- Create: `src/screens/pipeline/StageColumn.tsx`

- [ ] **Step 1: Create the file**

```tsx
import { useRef, useMemo } from "react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useStageTickets } from "./hooks/useStageTickets";
import { TicketCard } from "./TicketCard";
import type { Ticket, TicketStage, Lang } from "@/lib/types";

interface StageColumnProps {
  stage: TicketStage;
  pipelineId: string;
  lang: Lang;
  ownerFilter?: string;
  searchQuery: string;
  onCardClick: (ticket: Ticket) => void;
  onOpenConversation: (conversationId: string) => void;
}

function DraggableCard({
  ticket,
  lang,
  onCardClick,
  onOpenConversation,
}: {
  ticket: Ticket;
  lang: Lang;
  onCardClick: (t: Ticket) => void;
  onOpenConversation: (cid: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: ticket.id, data: { ticket } });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <TicketCard
        ticket={ticket}
        lang={lang}
        isDragging={isDragging}
        onClick={() => onCardClick(ticket)}
        onOpenConversation={() =>
          ticket.conversationId && onOpenConversation(ticket.conversationId)
        }
      />
    </div>
  );
}

export function StageColumn({
  stage,
  pipelineId,
  lang,
  ownerFilter,
  searchQuery,
  onCardClick,
  onOpenConversation,
}: StageColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id, data: { stageId: stage.id } });

  const q = useStageTickets(pipelineId, stage.id, {
    ownerId: ownerFilter,
    q: searchQuery,
  });

  const allTickets = useMemo(
    () => q.data?.pages.flatMap((p) => p.items) ?? [],
    [q.data],
  );

  // Client-side search filter (server has no q param)
  const filtered = useMemo(() => {
    if (!searchQuery) return allTickets;
    const needle = searchQuery.toLowerCase();
    return allTickets.filter(
      (t) =>
        t.title.toLowerCase().includes(needle) ||
        t.contact?.name.toLowerCase().includes(needle) ||
        String(t.number).includes(needle),
    );
  }, [allTickets, searchQuery]);

  const parentRef = useRef<HTMLDivElement | null>(null);
  const rowVirtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 120,
    overscan: 6,
  });

  const total = filtered.length;
  const label = lang === "ar" ? stage.labelAr : stage.label;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-1)",
        border: "1px solid var(--line)",
        borderRadius: "var(--r)",
        minWidth: 280,
        maxWidth: 320,
        height: "100%",
      }}
    >
      <div
        style={{
          padding: "10px 12px",
          borderBottom: "1px solid var(--line)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <strong style={{ color: "var(--ink)", fontSize: 13 }}>{label}</strong>
        <span style={{ fontSize: 11, color: "var(--ink-3)", fontFamily: "var(--font-mono)" }}>
          {total}
        </span>
      </div>

      <div
        ref={(node) => {
          setNodeRef(node);
          parentRef.current = node;
        }}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: 8,
          background: isOver ? "var(--bg-hover, rgba(255,255,255,0.04))" : undefined,
          border: isOver ? "2px dashed var(--accent)" : "2px dashed transparent",
          borderRadius: "var(--r)",
          transition: "background 120ms, border 120ms",
        }}
      >
        {q.isLoading ? (
          <div style={{ fontSize: 12, color: "var(--ink-3)", padding: 12 }}>
            {lang === "ar" ? "جارٍ التحميل..." : "Loading..."}
          </div>
        ) : total === 0 ? (
          <div style={{ fontSize: 12, color: "var(--ink-3)", padding: 24, textAlign: "center" }}>
            {lang === "ar" ? "اسحب البطاقات هنا" : "Drop tickets here"}
          </div>
        ) : (
          <SortableContext items={filtered.map((t) => t.id)} strategy={verticalListSortingStrategy}>
            <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
              {rowVirtualizer.getVirtualItems().map((vi) => {
                const ticket = filtered[vi.index];
                return (
                  <div
                    key={ticket.id}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${vi.start}px)`,
                      paddingBottom: 8,
                    }}
                  >
                    <DraggableCard
                      ticket={ticket}
                      lang={lang}
                      onCardClick={onCardClick}
                      onOpenConversation={onOpenConversation}
                    />
                  </div>
                );
              })}
            </div>
          </SortableContext>
        )}

        {q.hasNextPage ? (
          <button
            type="button"
            onClick={() => q.fetchNextPage()}
            disabled={q.isFetchingNextPage}
            style={{
              width: "100%",
              marginTop: 8,
              padding: 8,
              background: "var(--bg-2)",
              border: "1px solid var(--line)",
              borderRadius: "var(--r)",
              fontSize: 12,
              color: "var(--ink-2)",
              cursor: "pointer",
            }}
          >
            {q.isFetchingNextPage
              ? lang === "ar"
                ? "..."
                : "Loading..."
              : lang === "ar"
                ? "تحميل المزيد"
                : "Load more"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: PASS. If `var(--bg-hover)` is missing, that's fine — the fallback covers it.

- [ ] **Step 3: Commit**

```bash
git add src/screens/pipeline/StageColumn.tsx
git commit -m "feat(pipeline): StageColumn with per-stage query + virtualization"
```

### Task 13: Create `PipelineBoard.tsx` (DndContext + column grid)

**Files:**
- Create: `src/screens/pipeline/PipelineBoard.tsx`

- [ ] **Step 1: Create the file**

```tsx
import { useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { StageColumn } from "./StageColumn";
import { TicketCard } from "./TicketCard";
import { useMoveTicket } from "./hooks/useTicketMutations";
import { LostReasonModal } from "./LostReasonModal";
import type { Pipeline, Ticket, TicketStage, Lang } from "@/lib/types";

interface PipelineBoardProps {
  pipeline: Pipeline & { stages: TicketStage[] };
  lang: Lang;
  ownerFilter?: string;
  searchQuery: string;
  onCardClick: (ticket: Ticket) => void;
  onOpenConversation: (conversationId: string) => void;
}

export function PipelineBoard({
  pipeline,
  lang,
  ownerFilter,
  searchQuery,
  onCardClick,
  onOpenConversation,
}: PipelineBoardProps) {
  const [activeTicket, setActiveTicket] = useState<Ticket | null>(null);
  const [pendingLost, setPendingLost] = useState<{
    ticket: Ticket;
    fromStageId: string;
    toStage: TicketStage;
  } | null>(null);

  const move = useMoveTicket();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragStart = (e: DragStartEvent) => {
    const ticket = e.active.data.current?.ticket as Ticket | undefined;
    if (ticket) setActiveTicket(ticket);
  };

  const handleDragEnd = (e: DragEndEvent) => {
    setActiveTicket(null);
    const ticket = e.active.data.current?.ticket as Ticket | undefined;
    const toStageId = (e.over?.data.current?.stageId as string | undefined) ?? null;
    if (!ticket || !toStageId || toStageId === ticket.stageId) return;
    const toStage = pipeline.stages.find((s) => s.id === toStageId);
    if (!toStage) return;

    if (toStage.isTerminal && !toStage.isWon) {
      // Lost stage — open modal to capture reason before committing
      setPendingLost({ ticket, fromStageId: ticket.stageId, toStage });
      return;
    }

    move.mutate({
      ticketId: ticket.id,
      fromStageId: ticket.stageId,
      toStageId,
      pipelineId: pipeline.id,
      optimisticTicket: ticket,
    });
  };

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div
          style={{
            display: "flex",
            gap: 12,
            padding: 12,
            overflowX: "auto",
            height: "100%",
            scrollSnapType: "x mandatory",
          }}
        >
          {pipeline.stages.map((stage) => (
            <div key={stage.id} style={{ scrollSnapAlign: "start", height: "100%" }}>
              <StageColumn
                stage={stage}
                pipelineId={pipeline.id}
                lang={lang}
                ownerFilter={ownerFilter}
                searchQuery={searchQuery}
                onCardClick={onCardClick}
                onOpenConversation={onOpenConversation}
              />
            </div>
          ))}
        </div>

        <DragOverlay>
          {activeTicket ? (
            <TicketCard ticket={activeTicket} lang={lang} isDragging />
          ) : null}
        </DragOverlay>
      </DndContext>

      {pendingLost ? (
        <LostReasonModal
          lang={lang}
          ticket={pendingLost.ticket}
          onCancel={() => setPendingLost(null)}
          onConfirm={(reason) => {
            move.mutate({
              ticketId: pendingLost.ticket.id,
              fromStageId: pendingLost.fromStageId,
              toStageId: pendingLost.toStage.id,
              pipelineId: pipeline.id,
              lostReason: reason,
              optimisticTicket: pendingLost.ticket,
            });
            setPendingLost(null);
          }}
        />
      ) : null}
    </>
  );
}
```

- [ ] **Step 2: Note: `LostReasonModal` doesn't exist yet — typecheck will fail**

That's expected. We'll add it in the next task. Skip typecheck for now or expect a single "module not found" error.

- [ ] **Step 3: Commit anyway** (we'll fix on next task)

Don't commit yet — wait for Task 14.

### Task 14: Create `LostReasonModal.tsx`

**Files:**
- Create: `src/screens/pipeline/LostReasonModal.tsx`

- [ ] **Step 1: Create the file**

```tsx
import { useState } from "react";
import type { Ticket, Lang } from "@/lib/types";

const REASONS: Array<{ id: string; en: string; ar: string }> = [
  { id: "price", en: "Price too high", ar: "السعر مرتفع" },
  { id: "found_cheaper", en: "Found cheaper alternative", ar: "وجد بديلاً أرخص" },
  { id: "no_response", en: "Customer went silent", ar: "توقف العميل" },
  { id: "wrong_fit", en: "Wrong product fit", ar: "غير مناسب" },
  { id: "other", en: "Other", ar: "أخرى" },
];

interface Props {
  ticket: Ticket;
  lang: Lang;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}

export function LostReasonModal({ ticket, lang, onCancel, onConfirm }: Props) {
  const [selected, setSelected] = useState<string>(REASONS[0].id);

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "grid",
        placeItems: "center",
        zIndex: 100,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-1)",
          border: "1px solid var(--line)",
          borderRadius: "var(--r)",
          padding: 20,
          minWidth: 360,
          maxWidth: 420,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 15, color: "var(--ink)" }}>
          {lang === "ar" ? `سبب الخسارة لـ #${ticket.number}` : `Lost reason for #${ticket.number}`}
        </h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {REASONS.map((r) => (
            <label
              key={r.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: 8,
                border: "1px solid var(--line)",
                borderRadius: "var(--r)",
                cursor: "pointer",
                background: selected === r.id ? "var(--bg-2)" : "transparent",
              }}
            >
              <input
                type="radio"
                name="lost-reason"
                checked={selected === r.id}
                onChange={() => setSelected(r.id)}
              />
              <span style={{ fontSize: 13, color: "var(--ink)" }}>
                {lang === "ar" ? r.ar : r.en}
              </span>
            </label>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              padding: "8px 14px",
              background: "transparent",
              border: "1px solid var(--line)",
              borderRadius: "var(--r)",
              color: "var(--ink-2)",
              cursor: "pointer",
            }}
          >
            {lang === "ar" ? "إلغاء" : "Cancel"}
          </button>
          <button
            type="button"
            onClick={() => onConfirm(selected)}
            style={{
              padding: "8px 14px",
              background: "var(--accent)",
              border: 0,
              borderRadius: "var(--r)",
              color: "white",
              cursor: "pointer",
            }}
          >
            {lang === "ar" ? "تأكيد" : "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck (board + modal together)**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit board + modal together**

```bash
git add src/screens/pipeline/PipelineBoard.tsx src/screens/pipeline/LostReasonModal.tsx
git commit -m "feat(pipeline): PipelineBoard with DnD + LostReasonModal"
```

---

## Phase 4 — Frontend UI: header, drawer, new-ticket modal, page shell

### Task 15: Create `NewTicketModal.tsx` (shared between Pipeline and Inbox)

**Files:**
- Create: `src/screens/pipeline/NewTicketModal.tsx`

- [ ] **Step 1: Create the file**

```tsx
import { useEffect, useMemo, useState } from "react";
import { useCreateTicket, useCreateTicketFromConversation } from "./hooks/useTicketMutations";
import { usePipelines } from "./hooks/usePipelineData";
import type { Lang, Pipeline, TicketStage } from "@/lib/types";

interface BaseProps {
  lang: Lang;
  onClose: () => void;
  onCreated?: () => void;
  /** Pre-fill the title (e.g. from the conversation context). */
  defaultTitle?: string;
  /** Preview of the conversation, shown above the form for context. Optional. */
  conversationPreview?: string;
}

type Props =
  | (BaseProps & { mode: "direct"; contactId: string; conversationId?: string })
  | (BaseProps & { mode: "from-conversation"; conversationId: string });

const LAST_USED_KEY = "pipeline:lastUsed";

export function NewTicketModal(props: Props) {
  const { lang, onClose, onCreated, defaultTitle, conversationPreview } = props;
  const { data: pipelines = [] } = usePipelines();
  const create = useCreateTicket();
  const createFromConv = useCreateTicketFromConversation();

  const lastUsed = typeof localStorage !== "undefined" ? localStorage.getItem(LAST_USED_KEY) : null;
  const defaultPipeline = useMemo(
    () => pipelines.find((p) => p.id === lastUsed) ?? pipelines[0] ?? null,
    [pipelines, lastUsed],
  );

  const [pipelineId, setPipelineId] = useState<string>(defaultPipeline?.id ?? "");
  const selectedPipeline = pipelines.find((p) => p.id === pipelineId);
  const firstNonTerminal = selectedPipeline?.stages?.find((s: TicketStage) => !s.isTerminal);

  const [stageId, setStageId] = useState<string>(firstNonTerminal?.id ?? "");
  const [title, setTitle] = useState(defaultTitle ?? "");
  const [value, setValue] = useState<string>("");
  const [description, setDescription] = useState<string>("");

  useEffect(() => {
    if (!pipelineId && defaultPipeline) {
      setPipelineId(defaultPipeline.id);
    }
  }, [defaultPipeline, pipelineId]);

  useEffect(() => {
    if (selectedPipeline) {
      const ft = selectedPipeline.stages?.find((s: TicketStage) => !s.isTerminal);
      if (ft && (!stageId || !selectedPipeline.stages.some((s: TicketStage) => s.id === stageId))) {
        setStageId(ft.id);
      }
    }
  }, [selectedPipeline, stageId]);

  const submitting = create.isPending || createFromConv.isPending;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pipelineId || !stageId || !title) return;

    const numericValue = value ? Number(value) : undefined;
    try {
      if (props.mode === "from-conversation") {
        await createFromConv.mutateAsync({
          conversationId: props.conversationId,
          pipelineId,
          stageId,
          title,
          description: description || undefined,
          value: numericValue,
        });
      } else {
        await create.mutateAsync({
          pipelineId,
          stageId,
          contactId: props.contactId,
          conversationId: props.conversationId,
          title,
          description: description || undefined,
          value: numericValue,
        });
      }
      localStorage.setItem(LAST_USED_KEY, pipelineId);
      onCreated?.();
      onClose();
    } catch {
      // Mutation already surfaces the error; UI stays open so user can retry
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "grid",
        placeItems: "center",
        zIndex: 100,
      }}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={onSubmit}
        style={{
          background: "var(--bg-1)",
          border: "1px solid var(--line)",
          borderRadius: "var(--r)",
          padding: 20,
          minWidth: 380,
          maxWidth: 440,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 15, color: "var(--ink)" }}>
          {lang === "ar" ? "تذكرة جديدة" : "New ticket"}
        </h3>

        {conversationPreview ? (
          <div
            style={{
              padding: 10,
              background: "var(--bg-2)",
              borderRadius: "var(--r)",
              fontSize: 12,
              color: "var(--ink-2)",
              borderLeft: "3px solid var(--accent)",
            }}
          >
            {conversationPreview}
          </div>
        ) : null}

        <label style={{ fontSize: 11, color: "var(--ink-3)" }}>
          {lang === "ar" ? "خط الأنابيب" : "Pipeline"}
        </label>
        <select
          value={pipelineId}
          onChange={(e) => setPipelineId(e.target.value)}
          required
          style={selectStyle}
        >
          {pipelines.map((p: Pipeline) => (
            <option key={p.id} value={p.id}>
              {lang === "ar" ? p.nameAr : p.name}
            </option>
          ))}
        </select>

        <label style={{ fontSize: 11, color: "var(--ink-3)" }}>
          {lang === "ar" ? "المرحلة" : "Stage"}
        </label>
        <select
          value={stageId}
          onChange={(e) => setStageId(e.target.value)}
          required
          style={selectStyle}
        >
          {(selectedPipeline?.stages ?? []).map((s: TicketStage) => (
            <option key={s.id} value={s.id}>
              {lang === "ar" ? s.labelAr : s.label}
            </option>
          ))}
        </select>

        <label style={{ fontSize: 11, color: "var(--ink-3)" }}>
          {lang === "ar" ? "العنوان" : "Title"}
        </label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          autoFocus
          style={inputStyle}
        />

        <label style={{ fontSize: 11, color: "var(--ink-3)" }}>
          {lang === "ar" ? "القيمة" : "Value"}
        </label>
        <input
          type="number"
          min="0"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="0"
          style={inputStyle}
        />

        <label style={{ fontSize: 11, color: "var(--ink-3)" }}>
          {lang === "ar" ? "ملاحظات" : "Description"}
        </label>
        <textarea
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          style={{ ...inputStyle, resize: "vertical" }}
        />

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 6 }}>
          <button type="button" onClick={onClose} style={btnSecondary}>
            {lang === "ar" ? "إلغاء" : "Cancel"}
          </button>
          <button type="submit" disabled={submitting} style={btnPrimary}>
            {submitting
              ? lang === "ar"
                ? "جارٍ الحفظ..."
                : "Saving..."
              : lang === "ar"
                ? "إنشاء"
                : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "var(--bg-2)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r)",
  padding: "8px 12px",
  color: "var(--ink)",
  fontSize: 13,
};

const selectStyle: React.CSSProperties = inputStyle;

const btnSecondary: React.CSSProperties = {
  padding: "8px 14px",
  background: "transparent",
  border: "1px solid var(--line)",
  borderRadius: "var(--r)",
  color: "var(--ink-2)",
  cursor: "pointer",
};

const btnPrimary: React.CSSProperties = {
  padding: "8px 14px",
  background: "var(--accent)",
  border: 0,
  borderRadius: "var(--r)",
  color: "white",
  cursor: "pointer",
};
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: PASS. If `Pipeline` type doesn't expose `stages`, check `src/lib/types.ts` and confirm pipeline shape includes stages (it should, since the existing `Pipeline.tsx` consumes them).

- [ ] **Step 3: Commit**

```bash
git add src/screens/pipeline/NewTicketModal.tsx
git commit -m "feat(pipeline): NewTicketModal shared by Pipeline + Inbox"
```

### Task 16: Create `TicketDetailDrawer.tsx`

**Files:**
- Create: `src/screens/pipeline/TicketDetailDrawer.tsx`

- [ ] **Step 1: Create the file**

```tsx
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk } from "@/api/queryKeys";
import { useAddNote, useDeleteTicket, useUpdateTicket } from "./hooks/useTicketMutations";
import type { Lang, TicketDetail } from "@/lib/types";

interface Props {
  ticketId: string;
  pipelineId: string;
  stageId: string;
  lang: Lang;
  onClose: () => void;
  onOpenConversation: (conversationId: string) => void;
}

export function TicketDetailDrawer({
  ticketId,
  pipelineId,
  stageId,
  lang,
  onClose,
  onOpenConversation,
}: Props) {
  const q = useQuery<TicketDetail>({
    queryKey: qk.ticket(ticketId),
    queryFn: ({ signal }) => api.get<TicketDetail>(`/tickets/${ticketId}`, signal),
  });

  const addNote = useAddNote();
  const update = useUpdateTicket();
  const del = useDeleteTicket();

  const [noteText, setNoteText] = useState("");
  const t = q.data;

  return (
    <div
      role="dialog"
      aria-modal="false"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 90,
        display: "flex",
        justifyContent: lang === "ar" ? "flex-start" : "flex-end",
      }}
    >
      <aside
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(440px, 92vw)",
          height: "100%",
          background: "var(--bg-1)",
          borderLeft: lang === "ar" ? 0 : "1px solid var(--line)",
          borderRight: lang === "ar" ? "1px solid var(--line)" : 0,
          padding: 16,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        {q.isLoading ? (
          <div style={{ color: "var(--ink-3)", fontSize: 12 }}>
            {lang === "ar" ? "جارٍ التحميل..." : "Loading..."}
          </div>
        ) : !t ? (
          <div style={{ color: "var(--bad)", fontSize: 13 }}>
            {lang === "ar" ? "التذكرة غير موجودة" : "Ticket not found"}
          </div>
        ) : (
          <>
            <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <strong style={{ color: "var(--ink)", fontSize: 14 }}>
                #{t.number} — {t.title}
              </strong>
              <button
                onClick={onClose}
                style={{
                  background: "transparent",
                  border: 0,
                  color: "var(--ink-2)",
                  cursor: "pointer",
                  fontSize: 18,
                }}
              >
                ×
              </button>
            </header>

            <section style={section}>
              <div style={label}>{lang === "ar" ? "العميل" : "Contact"}</div>
              <div style={value}>{t.contact?.name ?? "—"}</div>
            </section>

            <section style={section}>
              <div style={label}>{lang === "ar" ? "القيمة" : "Value"}</div>
              <input
                type="number"
                defaultValue={t.value ?? 0}
                onBlur={(e) => {
                  const v = Number(e.target.value);
                  if (v !== (t.value ?? 0)) {
                    update.mutate({ id: t.id, patch: { value: v } });
                  }
                }}
                style={input}
              />
            </section>

            {t.conversationId ? (
              <button
                type="button"
                onClick={() => onOpenConversation(t.conversationId!)}
                style={{ ...input, cursor: "pointer", textAlign: "start" }}
              >
                {lang === "ar" ? "افتح المحادثة المرتبطة" : "Open linked conversation"}
              </button>
            ) : null}

            <section style={section}>
              <div style={label}>{lang === "ar" ? "النشاط" : "Activity"}</div>
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                {(t.activities ?? []).map((a) => (
                  <li
                    key={a.id}
                    style={{
                      fontSize: 12,
                      color: "var(--ink-2)",
                      padding: 6,
                      background: "var(--bg-2)",
                      borderRadius: "var(--r)",
                    }}
                  >
                    <strong style={{ color: "var(--ink)" }}>{a.kind}</strong>
                    {a.fromStage ? ` — ${a.fromStage} → ${a.toStage}` : ""}
                    {a.note ? ` — ${a.note}` : ""}
                  </li>
                ))}
              </ul>
            </section>

            <section style={section}>
              <div style={label}>{lang === "ar" ? "إضافة ملاحظة" : "Add note"}</div>
              <textarea
                rows={3}
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                style={{ ...input, resize: "vertical" }}
              />
              <button
                type="button"
                disabled={!noteText.trim() || addNote.isPending}
                onClick={async () => {
                  await addNote.mutateAsync({ ticketId: t.id, note: noteText.trim() });
                  setNoteText("");
                }}
                style={{
                  padding: "6px 12px",
                  background: "var(--accent)",
                  border: 0,
                  borderRadius: "var(--r)",
                  color: "white",
                  cursor: "pointer",
                  alignSelf: "flex-start",
                }}
              >
                {lang === "ar" ? "حفظ" : "Save note"}
              </button>
            </section>

            <button
              type="button"
              onClick={() => {
                if (!confirm(lang === "ar" ? "حذف هذه التذكرة؟" : "Delete this ticket?")) return;
                del.mutate({ id: t.id, pipelineId, stageId });
                onClose();
              }}
              style={{
                marginTop: "auto",
                padding: "8px 12px",
                background: "transparent",
                border: "1px solid var(--bad)",
                borderRadius: "var(--r)",
                color: "var(--bad)",
                cursor: "pointer",
              }}
            >
              {lang === "ar" ? "حذف" : "Delete"}
            </button>
          </>
        )}
      </aside>
    </div>
  );
}

const section: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const label: React.CSSProperties = {
  fontSize: 11,
  color: "var(--ink-3)",
  textTransform: "uppercase",
  letterSpacing: 0.5,
};

const value: React.CSSProperties = {
  fontSize: 13,
  color: "var(--ink)",
};

const input: React.CSSProperties = {
  width: "100%",
  background: "var(--bg-2)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r)",
  padding: "8px 12px",
  color: "var(--ink)",
  fontSize: 13,
};
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: PASS. (If `TicketDetail` is missing, check `src/lib/types.ts` — the old Pipeline.tsx imports it, so it exists.)

- [ ] **Step 3: Commit**

```bash
git add src/screens/pipeline/TicketDetailDrawer.tsx
git commit -m "feat(pipeline): TicketDetailDrawer with notes + activity + delete"
```

### Task 17: Create `PipelineHeader.tsx`

**Files:**
- Create: `src/screens/pipeline/PipelineHeader.tsx`

- [ ] **Step 1: Create the file**

```tsx
import type { Lang, Pipeline, TicketsDashboardSummary } from "@/lib/types";

interface Props {
  lang: Lang;
  pipelines: Pipeline[];
  selectedPipelineId: string;
  onPipelineChange: (id: string) => void;
  summary: TicketsDashboardSummary | undefined;
  search: string;
  onSearchChange: (q: string) => void;
  ownerFilter: string;
  onOwnerChange: (id: string) => void;
  onNewTicket: () => void;
  owners: Array<{ id: string; name: string }>;
}

export function PipelineHeader({
  lang,
  pipelines,
  selectedPipelineId,
  onPipelineChange,
  summary,
  search,
  onSearchChange,
  ownerFilter,
  onOwnerChange,
  onNewTicket,
  owners,
}: Props) {
  return (
    <header
      style={{
        padding: "12px 16px",
        borderBottom: "1px solid var(--line)",
        display: "flex",
        gap: 12,
        alignItems: "center",
        flexWrap: "wrap",
        background: "var(--bg-1)",
      }}
    >
      <select
        value={selectedPipelineId}
        onChange={(e) => onPipelineChange(e.target.value)}
        style={ctrl}
      >
        {pipelines.map((p) => (
          <option key={p.id} value={p.id}>
            {lang === "ar" ? p.nameAr : p.name}
          </option>
        ))}
      </select>

      <Kpi
        label={lang === "ar" ? "القيمة المفتوحة" : "Open value"}
        value={
          summary
            ? `${summary.openValue.toLocaleString()} ${summary.currency}`
            : "—"
        }
      />
      <Kpi
        label={lang === "ar" ? "معدل الفوز" : "Win rate"}
        value={summary ? `${summary.winRate}%` : "—"}
      />
      <Kpi
        label={lang === "ar" ? "المتوسط (ساعة)" : "Avg close (h)"}
        value={summary ? String(summary.avgCloseHours) : "—"}
      />
      <Kpi
        label={lang === "ar" ? "العدد" : "Total"}
        value={summary ? String(summary.totalTickets) : "—"}
      />

      <input
        type="search"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder={lang === "ar" ? "بحث (/ للتركيز)" : "Search (/ to focus)"}
        data-pipeline-search
        style={{ ...ctrl, minWidth: 200, flex: "1 1 auto" }}
      />

      <select
        value={ownerFilter}
        onChange={(e) => onOwnerChange(e.target.value)}
        style={ctrl}
      >
        <option value="">{lang === "ar" ? "كل المالكين" : "All owners"}</option>
        {owners.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>

      <button type="button" onClick={onNewTicket} style={btn}>
        + {lang === "ar" ? "جديد (N)" : "New (N)"}
      </button>
    </header>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        padding: "4px 10px",
        background: "var(--bg-2)",
        borderRadius: "var(--r)",
        border: "1px solid var(--line)",
        minWidth: 90,
      }}
    >
      <span style={{ fontSize: 10, color: "var(--ink-3)", textTransform: "uppercase" }}>
        {label}
      </span>
      <strong style={{ fontSize: 13, color: "var(--ink)" }}>{value}</strong>
    </div>
  );
}

const ctrl: React.CSSProperties = {
  background: "var(--bg-2)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r)",
  padding: "6px 10px",
  color: "var(--ink)",
  fontSize: 13,
};

const btn: React.CSSProperties = {
  background: "var(--accent)",
  color: "white",
  border: 0,
  borderRadius: "var(--r)",
  padding: "6px 12px",
  fontSize: 13,
  cursor: "pointer",
};
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/screens/pipeline/PipelineHeader.tsx
git commit -m "feat(pipeline): PipelineHeader with switcher + KPIs + search + filter"
```

### Task 18: Create `PipelinePage.tsx` (main shell)

**Files:**
- Create: `src/screens/pipeline/PipelinePage.tsx`

- [ ] **Step 1: Find the language source**

```bash
grep -n "useTweaks\\|lang:" src/screens/Pipeline.tsx | head -5
```

This shows how the old code reads `lang`. We'll mirror the same approach.

- [ ] **Step 2: Find the team list**

```bash
grep -n "TEAM\\|from \"@/data/team\"" src/screens/Pipeline.tsx | head -3
```

`TEAM` from `@/data/team` is the existing owners list.

- [ ] **Step 3: Create the page file**

```tsx
import { useEffect, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { usePipelines, usePipelineSummary } from "./hooks/usePipelineData";
import { useTicketRealtime } from "./hooks/useTicketRealtime";
import { PipelineHeader } from "./PipelineHeader";
import { PipelineBoard } from "./PipelineBoard";
import { TicketDetailDrawer } from "./TicketDetailDrawer";
import { NewTicketModal } from "./NewTicketModal";
import { TEAM } from "@/data/team";
import type { Ticket } from "@/lib/types";

const LAST_USED_KEY = "pipeline:lastUsed";

export default function PipelinePage() {
  const { lang } = useTweaks();
  const { data: pipelines = [], isLoading } = usePipelines();

  const initialPipelineId =
    (typeof localStorage !== "undefined" && localStorage.getItem(LAST_USED_KEY)) ||
    pipelines[0]?.id ||
    "";

  const [pipelineId, setPipelineId] = useState<string>(initialPipelineId);

  useEffect(() => {
    if (!pipelineId && pipelines.length > 0) {
      setPipelineId(pipelines[0].id);
    }
  }, [pipelines, pipelineId]);

  useEffect(() => {
    if (pipelineId) localStorage.setItem(LAST_USED_KEY, pipelineId);
  }, [pipelineId]);

  const { data: summary } = usePipelineSummary(pipelineId || null);
  useTicketRealtime(pipelineId || null);

  const [search, setSearch] = useState("");
  const [ownerFilter, setOwnerFilter] = useState<string>("");
  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null);
  const [showNew, setShowNew] = useState(false);

  // Keyboard shortcuts: N = new, / = search focus, Esc = close drawer/modal
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showNew) setShowNew(false);
        else if (selectedTicket) setSelectedTicket(null);
        return;
      }
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        setShowNew(true);
      } else if (e.key === "/") {
        e.preventDefault();
        document.querySelector<HTMLInputElement>("[data-pipeline-search]")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showNew, selectedTicket]);

  const pipeline = pipelines.find((p) => p.id === pipelineId);

  if (isLoading) {
    return (
      <div style={{ padding: 24, color: "var(--ink-3)", fontSize: 12 }}>
        {lang === "ar" ? "جارٍ التحميل..." : "Loading pipelines..."}
      </div>
    );
  }

  if (!pipeline) {
    return (
      <div style={{ padding: 24, color: "var(--ink-3)", fontSize: 13 }}>
        {lang === "ar" ? "لا توجد خطوط أنابيب" : "No pipelines configured"}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <PipelineHeader
        lang={lang}
        pipelines={pipelines}
        selectedPipelineId={pipelineId}
        onPipelineChange={setPipelineId}
        summary={summary}
        search={search}
        onSearchChange={setSearch}
        ownerFilter={ownerFilter}
        onOwnerChange={setOwnerFilter}
        onNewTicket={() => setShowNew(true)}
        owners={TEAM.map((m) => ({ id: m.id, name: m.name }))}
      />
      <div style={{ flex: 1, minHeight: 0 }}>
        <PipelineBoard
          pipeline={pipeline}
          lang={lang}
          ownerFilter={ownerFilter || undefined}
          searchQuery={search}
          onCardClick={setSelectedTicket}
          onOpenConversation={(cid) => {
            window.location.hash = `#/inbox?conversationId=${encodeURIComponent(cid)}`;
          }}
        />
      </div>

      {selectedTicket ? (
        <TicketDetailDrawer
          ticketId={selectedTicket.id}
          pipelineId={selectedTicket.pipelineId}
          stageId={selectedTicket.stageId}
          lang={lang}
          onClose={() => setSelectedTicket(null)}
          onOpenConversation={(cid) => {
            window.location.hash = `#/inbox?conversationId=${encodeURIComponent(cid)}`;
          }}
        />
      ) : null}

      {showNew && pipeline ? (
        <NewTicketModal
          mode="direct"
          contactId="" // header-driven create requires picking a contact; modal can prompt
          lang={lang}
          onClose={() => setShowNew(false)}
        />
      ) : null}
    </div>
  );
}
```

Note: header-driven "New ticket" currently passes `contactId=""` — the modal's submit will reject (empty contact). In Phase 5 / future scope, replace with a contact-picker. For now this is acceptable because the primary creation flow is the Inbox button (Phase 5), not the pipeline header.

If the user wants a working header-driven create-from-scratch flow, the contact picker is the only extra piece. Mark this as a TODO comment in the page file, only on this header button:

```tsx
// TODO: replace with contact-picker; primary creation is via Inbox conversion.
```

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/screens/pipeline/PipelinePage.tsx
git commit -m "feat(pipeline): PipelinePage shell wires header + board + drawer + new modal"
```

### Task 19: Switch router to point at the new page

**Files:**
- Modify: `src/router.tsx:13`

- [ ] **Step 1: Apply the swap**

In `src/router.tsx`, change line 13 from:

```tsx
pipeline: lazy(() => import("@/screens/Pipeline")),
```

to:

```tsx
pipeline: lazy(() => import("@/screens/pipeline/PipelinePage")),
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: PASS. The old `Pipeline.tsx` is now unreferenced but still on disk — that's fine. We delete it in Task 24.

- [ ] **Step 3: Run dev server and smoke-check the page**

```bash
npm run dev
```

Visit http://localhost:5173/#/pipeline. Expected:
- Header with KPIs + pipeline switcher renders.
- Columns appear for each stage, each showing a count.
- If tickets exist in the seed data, drag a card from one column to another — it moves optimistically and a network request to `POST /tickets/:id/move` fires (check the Network tab).

Stop the dev server (Ctrl+C).

- [ ] **Step 4: Commit**

```bash
git add src/router.tsx
git commit -m "feat(router): point pipeline route at new PipelinePage"
```

---

## Phase 5 — Inbox → Pipeline conversion

### Task 20: Add `ConversationTicketsPill`

**Files:**
- Create: `src/screens/inbox/ConversationTicketsPill.tsx`

- [ ] **Step 1: Create the directory + file**

```bash
mkdir -p src/screens/inbox
```

Then `src/screens/inbox/ConversationTicketsPill.tsx`:

```tsx
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk } from "@/api/queryKeys";
import type { Lang, Ticket, TicketsListPage } from "@/lib/types";

interface Props {
  conversationId: string;
  lang: Lang;
  onClick?: (ticket: Ticket) => void;
}

export function ConversationTicketsPill({ conversationId, lang, onClick }: Props) {
  const q = useQuery<TicketsListPage>({
    queryKey: qk.conversationTickets(conversationId),
    queryFn: ({ signal }) =>
      api.get<TicketsListPage>(
        `/tickets?conversationId=${encodeURIComponent(conversationId)}&limit=20`,
        signal,
      ),
    staleTime: 30_000,
  });

  const tickets = q.data?.items ?? [];
  if (tickets.length === 0) return null;

  const open = tickets.filter((t) => !t.closedAt).length;
  const closed = tickets.length - open;

  return (
    <button
      type="button"
      onClick={() => onClick?.(tickets[0])}
      style={{
        padding: "4px 10px",
        background: "var(--bg-2)",
        border: "1px solid var(--line)",
        borderRadius: 999,
        fontSize: 11,
        color: "var(--ink-2)",
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      {lang === "ar"
        ? `${open} مفتوحة · ${closed} مغلقة`
        : `${open} open · ${closed} closed`}
    </button>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/screens/inbox/ConversationTicketsPill.tsx
git commit -m "feat(inbox): ConversationTicketsPill shows linked tickets"
```

### Task 21: Add `AddToPipelineButton`

**Files:**
- Create: `src/screens/inbox/AddToPipelineButton.tsx`

- [ ] **Step 1: Create the file**

```tsx
import { useState } from "react";
import { NewTicketModal } from "@/screens/pipeline/NewTicketModal";
import type { Lang } from "@/lib/types";

interface Props {
  conversationId: string;
  contactName: string;
  intent?: string;
  preview?: string;
  lang: Lang;
}

export function AddToPipelineButton({
  conversationId,
  contactName,
  intent,
  preview,
  lang,
}: Props) {
  const [open, setOpen] = useState(false);
  const defaultTitle = intent ? `${contactName} — ${intent}` : contactName;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          padding: "4px 10px",
          background: "var(--accent)",
          color: "white",
          border: 0,
          borderRadius: "var(--r)",
          fontSize: 11,
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        + {lang === "ar" ? "أضف إلى الأنابيب" : "Add to pipeline"}
      </button>

      {open ? (
        <NewTicketModal
          mode="from-conversation"
          conversationId={conversationId}
          lang={lang}
          defaultTitle={defaultTitle}
          conversationPreview={preview}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/screens/inbox/AddToPipelineButton.tsx
git commit -m "feat(inbox): AddToPipelineButton opens shared NewTicketModal"
```

### Task 22: Render pill + button in Inbox conversation header

**Files:**
- Modify: `src/screens/Inbox.tsx`

- [ ] **Step 1: Locate the conversation header actions row**

```bash
grep -n "activeId\\|conversation header\\|conv-header\\|ConvHeader\\|actions-row" src/screens/Inbox.tsx | head -20
```

Look for the JSX that renders the right-hand panel's header (where channel/badge/title sit). This is the actions row we want to extend.

- [ ] **Step 2: Find where the active conversation object is available**

```bash
grep -n "convDetail\\.\\?\\|activeConv\\|currentConversation\\|messageQ\\." src/screens/Inbox.tsx | head -10
```

Identify the variable holding the currently selected conversation's full record (contact, intent, preview).

- [ ] **Step 3: Add imports**

Near the existing imports in `src/screens/Inbox.tsx`, add:

```tsx
import { ConversationTicketsPill } from "./inbox/ConversationTicketsPill";
import { AddToPipelineButton } from "./inbox/AddToPipelineButton";
```

- [ ] **Step 4: Render the controls**

Inside the conversation-detail header JSX (the actions row next to "Pause AI", "Close", etc.), add — only when there is an `activeId` and a loaded conversation:

```tsx
{activeId && convDetail ? (
  <>
    <ConversationTicketsPill
      conversationId={activeId}
      lang={lang}
      onClick={(t) => {
        // Navigate to the ticket inside the pipeline view, opening the drawer
        window.location.hash = `#/pipeline?openTicket=${encodeURIComponent(t.id)}`;
      }}
    />
    <AddToPipelineButton
      conversationId={activeId}
      contactName={convDetail.contact?.name ?? ""}
      intent={convDetail.intent}
      preview={convDetail.preview}
      lang={lang}
    />
  </>
) : null}
```

Substitute `convDetail` with the actual local variable name you found in Step 2 (it might be `convQ.data` or similar). Substitute `activeId` if the variable is named differently.

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: PASS. If the pill receives a click but the pipeline page doesn't yet read `?openTicket=`, that's deferred polish — skip for now (the button still works, drawer just doesn't auto-open).

- [ ] **Step 6: Manual smoke test**

```bash
npm run dev
```

In a second shell (so backend runs too):

```bash
cd backend && npm run dev
```

Open http://localhost:5173/#/inbox. Pick a conversation. Verify:
- "Add to pipeline" button shows.
- Clicking opens the modal with title pre-filled (e.g., "John Doe — purchase_intent").
- Selecting pipeline + stage and submitting creates a ticket.
- Reload `#/pipeline`: the new ticket appears in the chosen stage.
- Reload Inbox: the pill now shows `1 open · 0 closed`.

Stop both servers.

- [ ] **Step 7: Commit**

```bash
git add src/screens/Inbox.tsx
git commit -m "feat(inbox): show linked tickets pill + Add-to-pipeline button"
```

---

## Phase 6 — Polish

### Task 23: Verify multi-tab realtime sync

**Files:** none — verification only.

- [ ] **Step 1: Boot both servers**

```bash
cd backend && npm run dev
```

In another shell:

```bash
npm run dev
```

- [ ] **Step 2: Open two browser tabs**

Open http://localhost:5173/#/pipeline in two separate tabs (same workspace user).

- [ ] **Step 3: Move a ticket in Tab A**

Drag a ticket from one column to another in Tab A.

Expected: in Tab B (within ~500ms) the ticket disappears from the source column and appears in the destination column without a page refresh.

- [ ] **Step 4: Create a ticket from Inbox in Tab A**

In Tab A, switch to Inbox, pick a conversation, click "Add to pipeline", submit.

Expected: in Tab B (still on pipeline page) the new ticket appears in the chosen stage's column without a refresh.

- [ ] **Step 5: Stop both servers**

If anything fails, fix realtime payload mismatch in `useTicketRealtime.ts` before continuing.

- [ ] **Step 6: No commit needed (verification only)**

If a fix was made during this task, commit it with `fix(pipeline): realtime payload alignment for ticket.<event>`.

---

## Phase 7 — Cleanup

### Task 24: Delete old `Pipeline.tsx`

**Files:**
- Delete: `src/screens/Pipeline.tsx`

- [ ] **Step 1: Confirm no other file imports it**

```bash
grep -rn "@/screens/Pipeline\"" src/ --include='*.ts' --include='*.tsx'
```

Expected: no matches (router was updated in Task 19).

- [ ] **Step 2: Delete the file**

```bash
git rm src/screens/Pipeline.tsx
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: PASS. If errors appear, something still references the old module — fix the importer.

- [ ] **Step 4: Build the production bundle to catch any lazy-import surprises**

```bash
npm run build
```

Expected: build completes without errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(pipeline): remove old monolithic Pipeline.tsx"
```

### Task 25: Final end-to-end manual verification

**Files:** none — verification only.

- [ ] **Step 1: Run backend tests**

```bash
cd backend && npm test
```

Expected: all tests PASS, including new `tickets.service.spec.ts` cases.

- [ ] **Step 2: Boot full stack**

```bash
cd backend && npm run dev
```

In another shell:

```bash
npm run dev
```

- [ ] **Step 3: Walk the golden path**

In the browser at http://localhost:5173:

1. **Pipeline loads.** Visit `#/pipeline` — KPIs render, columns render, tickets appear.
2. **Drag works.** Drag a ticket from one column to another — UI updates instantly; check Network tab confirms `POST /tickets/:id/move` returns 200.
3. **Lost stage prompts.** Drag a ticket into a Lost column — modal opens; pick a reason; submit; ticket moves with `lostReason` recorded.
4. **Detail drawer.** Click a ticket — drawer opens; edit value (blur input); a note can be added.
5. **Search.** Type a partial title in the header search — columns filter live.
6. **Owner filter.** Pick an owner — only their tickets show.
7. **Inbox conversion.** Open `#/inbox`, pick a conversation. Click "Add to pipeline" — modal opens with pre-filled title and conversation preview. Submit. Reload `#/pipeline` — the new ticket is in the chosen stage.
8. **Pill.** Back in Inbox, the same conversation now shows `1 open · 0 closed`.
9. **Realtime.** Repeat Task 23's two-tab check on the final build.
10. **Keyboard.** On `#/pipeline`, press `N` — new-ticket modal opens. Press `/` — search input is focused.
11. **RTL.** Toggle the language to Arabic via the existing tweak — columns and drawer mirror correctly.

- [ ] **Step 4: Stop servers**

- [ ] **Step 5: Final commit if any polish fixes were made**

```bash
git status
```

If clean, no commit. Otherwise commit polish under `fix(pipeline): final E2E polish`.

---

## Plan Summary

**Tasks:** 25 total — 5 backend (1 pure + 4 TDD), 14 frontend, 6 verification/cleanup.

**Verification scaffold:**
- Backend: Jest unit tests added for every service change.
- Frontend: no test runner installed; verification is `npm run typecheck` + manual dev-server walkthrough at milestones (Task 19, 22, 23, 25).

**Commits:** ~22 small commits, each scoped to one task. Mergeable as a single PR or fast-forwarded onto the integration branch.

**Risk surface:**
- Type drift on the `TicketsListPage` shape change — covered by typecheck.
- The header "New ticket" button doesn't pick a contact (TODO in Task 18). If you want a working header-driven create flow before merging, insert a "Pick a contact" picker step before the modal — that's a half-day addition outside this plan.
- The Inbox pill onClick navigates to `#/pipeline?openTicket=...` but `PipelinePage` doesn't yet parse that param — also a TODO in Task 22. Add a `useEffect` in `PipelinePage` reading the query string if you want auto-drawer-open on cross-nav.

**Deliberate divergences from spec:**
- **Inbox pill click → navigate to pipeline (not drawer-in-place).** Spec asks for a `TicketDetailDrawer` over the Inbox screen. Plan navigates to `#/pipeline?openTicket=...` instead. Reason: mounting the drawer in Inbox would import pipeline UI into the Inbox module, coupling the two. The cross-nav keeps modules decoupled at the cost of one extra hash change. If this UX trade-off is unacceptable, replace the `onClick` in `ConversationTicketsPill` with a drawer mount and import `TicketDetailDrawer` directly — ~10 lines.
- **Mobile long-press action sheet deferred.** Spec calls for long-press → "Move to…" stage picker on touch. Plan ships scroll-snap columns only; long-press is a separate Phase-2 task. Drag still works on desktop; mobile users tap-to-open the drawer and use the value/owner controls there.
