# Pipeline Revamp — Design

**Date:** 2026-06-02
**Author:** Ashraf + Claude
**Status:** Approved for planning
**Branch (target):** new feature branch off `feat/whatsapp-ai-mvp`

## Problem

The current Pipeline page ([src/screens/Pipeline.tsx](../../../src/screens/Pipeline.tsx)) is a 2,267-line monolith. It has shipped multiple recent fixes (`refetchTick` removal, `keepPreviousData` flash workaround, `@dnd-kit/sortable` migration) and is still considered buggy and slow by the user.

The bigger missed opportunity: **Inbox cannot convert a chat into a pipeline item.** The data model supports it (`Ticket.conversationId` exists, `POST /tickets` accepts `conversationId`), but no UI exposes it. This is the business value behind the revamp — every WhatsApp/Instagram/Facebook conversation is a potential lead and must be promotable to the pipeline in one click.

## Goals

1. Replace the Pipeline page with a fast, decomposed, maintainable implementation.
2. Add Inbox → Pipeline conversion UI as a first-class flow.
3. Keep the existing backend, Prisma schema, and realtime infrastructure (they work).
4. Ship in a single PR — no flag, no parallel implementations.

## Non-Goals

- No changes to `Ticket`, `TicketStage`, `Pipeline`, or `TicketActivity` Prisma models.
- No new stage editor UI, no bulk actions, no analytics rework.
- No mobile-native gestures beyond horizontal scroll-snap + long-press sheet.

## What We Keep

- **Backend routes:** `/pipelines`, `/pipelines/:id`, `/tickets` (all verbs), `/tickets/:id/move`, `/tickets/:id/notes`, `/tickets/dashboard/summary`.
- **Prisma models:** `Ticket`, `TicketStage`, `Pipeline`, `TicketActivity`, `Note` — untouched.
- **Realtime:** `ticket.moved` broadcast on stage transition.
- **Realtime hook:** `src/api/useRealtime.ts`.
- **DnD lib:** `@dnd-kit/core` + `@dnd-kit/sortable` (just migrated, works smoothly).
- **Data lib:** TanStack React Query 5 via the project's `useFetch` wrapper (or direct `useQuery` where cleaner).

## What We Delete

- `src/screens/Pipeline.tsx` — entire file. The route entry in `src/router.tsx` updates to point at the new `PipelinePage`.

## What We Add

### Frontend file layout

```
src/screens/pipeline/
  PipelinePage.tsx              ~150 LOC — layout shell, mounts header + board + drawer
  PipelineHeader.tsx            ~120     — pipeline switcher, KPIs, search, owner filter
  PipelineBoard.tsx             ~180     — column grid, DndContext, DragOverlay
  StageColumn.tsx               ~120     — single column, owns its own React Query slice + virtualized list
  TicketCard.tsx                ~100     — pure visual; no drag logic
  TicketDetailDrawer.tsx        ~200     — slide-in right drawer (details, activity, notes)
  NewTicketModal.tsx            ~140     — shared by Pipeline header and Inbox "Add to pipeline" action
  LostReasonModal.tsx           ~80      — mark-lost reason picker
  hooks/usePipelineData.ts      ~100     — queries: pipelines list, summary
  hooks/useStageTickets.ts      ~80      — per-stage paginated query
  hooks/useTicketMutations.ts   ~140     — move, create, update, addNote, delete (optimistic)
  hooks/useTicketRealtime.ts    ~40      — subscribes to ticket.moved/created/updated
```

Hard rule: no file in `src/screens/pipeline/` exceeds 250 lines. If it grows past that during implementation, split before continuing.

### Backend additions

Only one new route + two new realtime events. No schema migration.

1. **`POST /tickets/from-conversation/:conversationId`** — convenience endpoint that:
   - Reads the `Conversation` by id (scoped by workspaceId via the existing tenancy extension).
   - Pulls `contactId` from the conversation server-side.
   - Accepts body: `{ pipelineId, stageId, title, description?, value?, ownerId? }`.
   - Creates the `Ticket` with `conversationId` linked.
   - Emits `ticket.created` to the workspace.
   - Returns the created ticket.

2. **Emit `ticket.created`** in `TicketsService.createTicket()` after successful insert. Currently only `ticket.moved` is emitted.

3. **Emit `ticket.updated`** in `TicketsService.updateTicket()` and `addNote()`. Same workspace-scoped broadcast.

4. **Add `conversationId` to `ListTicketsQuery` DTO** and filter on it in `TicketsService.list()`. Enables `GET /tickets?conversationId=X` for the Inbox linked-tickets pill.

5. **Add `cursor` to `ListTicketsQuery` DTO** and apply cursor-based pagination in `TicketsService.list()` when present (returns `{ items, nextCursor }`).

## Data Fetching & Cache

### Query keys factory

New file `src/api/queryKeys.ts`:

```ts
export const qk = {
  pipelines: () => ['pipelines'] as const,
  stageTickets: (pipelineId: string, stageId: string, filters?: { ownerId?: string }) =>
    ['tickets', 'stage', pipelineId, stageId, filters ?? {}] as const,
  ticket: (id: string) => ['tickets', 'detail', id] as const,
  summary: (pipelineId: string) => ['tickets', 'summary', pipelineId] as const,
  conversationTickets: (conversationId: string) =>
    ['tickets', 'conversation', conversationId] as const,
};
```

Every hook and mutation references `qk.*`. No string-literal cache keys anywhere in pipeline code.

### Per-stage queries

Each `StageColumn` calls `useStageTickets(pipelineId, stageId)` independently. Benefits:
- Each column has its own loading state — moving a ticket only re-fetches the source + destination stage, not the whole board.
- Lets us paginate per-column without rewriting fetch logic.
- Realtime patches target the specific stage's cache.

### Mutation pattern

`useTicketMutations.ts` exports hooks: `useMoveTicket`, `useCreateTicket`, `useUpdateTicket`, `useAddNote`, `useDeleteTicket`.

Each follows the same shape:
- `onMutate`: snapshot affected queries, patch cache optimistically, return `{ rollback }`.
- `onError`: invoke rollback.
- `onSettled`: invalidate affected query keys.

No manual `queryClient.setQueryData(["/tickets?..."], ...)` like the current code does. All cache touches go through `qk.*`.

### Pagination

Backend already accepts `limit` on `GET /tickets`. We add `cursor` (ticket id) for stable pagination:

```
GET /tickets?pipelineId=X&stageId=Y&limit=50&cursor=<id>
```

Use React Query's `useInfiniteQuery` per stage. Default page size 50. Most stages won't hit page 2.

### Virtualization

`@tanstack/react-virtual` for column lists when they exceed 30 visible items. Card height is fixed (or measured once and cached), so windowing is straightforward.

## Drag & Drop

- Keep `@dnd-kit/core` + `@dnd-kit/sortable`.
- `DndContext` lives in `PipelineBoard.tsx`.
- `DragOverlay` renders a single floating `TicketCard` while dragging.
- Drop targets are stage columns (column-level drop, not insertion-position-aware).
- On drop: call `useMoveTicket` mutation. Optimistic patch removes from source stage cache, prepends to destination stage cache.

## Realtime

Subscriptions in `useTicketRealtime.ts`, mounted once in `PipelinePage`:

- `ticket.moved` → patch source + destination stage caches (idempotent — skip if origin tab).
- `ticket.created` → prepend to destination stage cache.
- `ticket.updated` → patch single `ticket.detail` cache + the list it lives in.

Idempotency check: each event payload carries `eventId` or `socketId` of origin. The origin tab's mutation already wrote the same shape, so the realtime handler no-ops.

## Inbox → Pipeline Conversion (The Business Unlock)

### In the Inbox conversation header

Two additions:

1. **Linked-tickets pill** — displays `2 open · 1 won` when the conversation has linked tickets. Queries `qk.conversationTickets(conversationId)` (backend: `GET /tickets?conversationId=X` — already supported via the existing `contactId` filter pattern, just add `conversationId` to `ListTicketsQuery`). Clicking the pill opens the most recent ticket's `TicketDetailDrawer` over the Inbox screen (not a navigation — drawer mounts in-place).

2. **"Add to pipeline" button** in the conversation actions row. Opens the shared `NewTicketModal` with pre-fill:
   - `contactId`: locked (from conversation).
   - `title`: defaults to `${contact.name} — ${conversation.intent}`.
   - `pipelineId`: defaults to user's last-used pipeline (read from `localStorage`, key `pipeline:lastUsed`).
   - `stageId`: defaults to first non-terminal stage of selected pipeline.
   - `conversationId`: passed through, hidden field.
   - `description`: empty, with a quoted block above the form showing the conversation's last preview message for context.
   - `value`, `ownerId`: editable, empty defaults.
   - Submit calls `POST /tickets/from-conversation/:conversationId`.

### On the Pipeline side

Every `TicketCard` with a non-null `conversationId` shows a chat icon. Clicking it navigates to `/inbox?conversationId=<id>` and the Inbox screen opens that conversation. The Inbox already supports deep-linking via URL params (verify during implementation; if not, add it as a tiny scope item).

## UX Details

- **Loading:** skeleton ticket cards in columns, shimmer KPIs. No full-page spinner.
- **Empty stage:** dashed border, "Drop here" label.
- **Search:** client-side filter across loaded ticket slices (title, contact name, ticket number).
- **Owner filter:** part of query key, so cache is per-owner.
- **Keyboard:** `N` opens new-ticket modal, `/` focuses search, `Esc` closes drawer/modal.
- **Mobile (< 768px):**
  - Columns horizontally scroll-snap.
  - No drag on touch — long-press on a card opens an action sheet with "Move to…" stage picker.
- **RTL:** respect `dir="rtl"` from existing locale plumbing. Columns mirror, drawer slides from the left in RTL.

## Error Handling

- Mutation failures: rollback optimistic patch, toast the error message.
- Realtime disconnect: rely on existing `useRealtime` reconnect logic. On reconnect, invalidate all stage queries to resync.
- 404 on ticket detail (e.g., another user deleted it): close drawer, toast "Ticket no longer exists".

## Testing Strategy

- **Unit:** mutation hooks with React Query test wrapper — verify optimistic patch shape and rollback behavior.
- **Component:** `TicketCard`, `StageColumn` (empty / loading / populated states).
- **Integration:** Pipeline page with mocked backend — drag a ticket, verify cache shape; create a ticket from the Inbox modal, verify it appears in the right column.
- **Manual:** open Pipeline in two browser tabs, move a ticket in one, confirm the other updates within 1 second via realtime.

## Rollout

- Single PR off `feat/whatsapp-ai-mvp` (current branch) or a new feature branch `feat/pipeline-revamp`.
- Replace `Pipeline.tsx` wholesale; update `src/router.tsx` lazy import to point at `src/screens/pipeline/PipelinePage.tsx`.
- No feature flag. Current page is broken enough that there's nothing worth A/B-ing.
- Inbox conversion button ships in the same PR.

## Open Decisions Deferred to Implementation

- Whether to add `lastUsedPipelineId` to a backend model or keep it in `localStorage`. Default: `localStorage` until a real cross-device need surfaces.
- Whether `GET /tickets?conversationId=X` needs a dedicated index. Check `EXPLAIN ANALYZE` on a populated workspace before adding migration.
- Exact `cursor` shape: `id`-based (simple, stable) vs. `(createdAt, id)`-composite (needed only if we sort by createdAt within a stage). Pick during implementation based on the sort order we land on.
