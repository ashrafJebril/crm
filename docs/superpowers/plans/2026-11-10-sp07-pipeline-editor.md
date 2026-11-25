# SP-07 Pipeline & Stage Editor: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Owners and admins manage pipelines end to end:
- create, rename and archive pipelines;
- add, reorder, recolour and remove stages, choosing where a removed stage's cards move;
- save every change at once as one draft, with a conflict check;
- keep a bilingual lost-reasons catalogue per pipeline, which the "mark lost" dialog uses;
- set a stale-card threshold, after which a card turns amber;
- set two flags: whether agents may move cards, and whether a ticket assignment also assigns its conversation.

**Architecture:**
- **Pipeline fields:** `Pipeline` gains `version`, `archivedAt`, `staleDays`, `agentCanMove`, `assignsConversations` and `kind`.
- **Lost reasons:** a new `LostReason` table, plus `Ticket.lostReasonId`. The free-text `lostReason` stays, as the label snapshot shown on old tickets.
- **Saving:** one endpoint, `PUT /pipelines/:id/draft`, carries the whole edited pipeline.
  - It checks the version, then runs one transaction: upsert the stages, move cards out of removed stages (each move logged as a `TicketActivity`), remove the stages, upsert the lost reasons, and bump the version.
  - A version mismatch returns 409 with the current pipeline.
- **UI:** the editor lives in Settings → Pipelines. The board reads the stale threshold and the catalogue.

**Tech Stack:** NestJS 10, Prisma 5, jest; React 18, vitest.

**Spec:** roadmap §SP-07, Review Focus 2 and 4. Tkana reference: `apps/web/app/routes/settings.pipelines.tsx`, `lib/pipeline/stage-draft.ts`, `components/pipeline/customers/lost-reasons-editor.tsx`.

## Global Constraints
- **Permissions (SP-25):**
  - `GET /pipelines*`: `pipelines.view`.
  - Create, draft-save and archive: `pipelines.manage`, which only owner and admin hold by default.
  - Moving a ticket when `agentCanMove=false` additionally requires `pipelines.update`. Owners and admins have it; agents don't.
  - Every new route is added to `permission-map.ts`.
- **Stage keys:** created from the English label as a slug, unique per pipeline, and immutable once created, because workflows and automations may reference them.
- **Stage colours:** the existing semantic keys `ink|info|ok|warn|bad|accent|human`.
- **Draft rules, validated server-side:**
  - at least one non-terminal stage;
  - exactly one won stage (`isWon=true`, which implies terminal);
  - at most one non-won terminal "lost" stage. Today's schema has `isTerminal`/`isWon`; a lost stage is `isTerminal && !isWon`;
  - `order` values are contiguous from 0;
  - labels are 1–60 characters, in EN and AR;
  - every removed stage that still has cards needs `moveTo`, pointing at a stage that survives in this draft. Otherwise: 400 `pipelines.move_target_required`.
- **Lost reasons:** 1–50 per pipeline, labels in EN and AR. A reason that tickets already reference is archived, never deleted.
- **Default pipeline:** it cannot be archived. 400 `pipelines.cannot_archive_default`.
- **Migration:** hand-written `backend/prisma/migrations/20261110180000_pipeline_editor/migration.sql`, additive and idempotent.
  - Backfill: for each existing pipeline, seed lost reasons from the current hardcoded `REASONS` list in `src/screens/pipeline/LostReasonModal.tsx`, with the same EN and AR text.
  - `kind` defaults to `"deals"`, except the support pipeline seeded by `resolution/support-pipeline.ts`, which is identified by its key and set to `"support"`.
- **Copy:** every user-facing string goes through `tx("English","العربية")` with real Arabic.
- **Tests:**
  - backend: `npx jest src/tickets src/pipelines src/permissions` plus tsc;
  - frontend: `npx vitest run` plus `npm run typecheck`.
- **Commits:** selective `git add`; trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus
1. **Concurrent edits:** two owners save drafts from the same version. The first wins; the second gets 409 with the current pipeline, and nothing is half-applied. Test: `pipeline-draft-conflict.spec.ts`.
2. **Removing a stage that has cards:** the cards move to `moveTo`, each move logs a `TicketActivity` (`stage_changed`, note `"stage removed"`), `enteredStageAt` is reset, the stage is deleted, and the whole thing is one transaction. Test: `delete-stage-with-references.spec.ts`.
3. **Stage rules:** removing the only won stage, adding a second won stage, and leaving no open stage each fail with 400 and a specific key.
4. **Archived pipelines:** hidden from the pipeline picker and from new-ticket creation (400), but their tickets stay readable.
5. **Lost reason in use:** deleting it from the draft archives it rather than deleting it, and old tickets still show their snapshot label.

---

### Task 1: Schema, migration, draft service
**Files:**
- Schema and migration.
- `backend/src/pipelines/{pipelines.module.ts,pipelines.service.ts,pipelines.controller.ts,pipelines.dto.ts,stage-draft.ts}` with their specs. Move the GET pipelines routes out of `tickets.controller.ts` into the new controller, keeping the same paths, or keep them and add the new routes. Pick whichever avoids route clashes, and document it.
- Permission map.

**Produces:**
- `Pipeline` gains:
  - `version Int @default(0)`
  - `archivedAt DateTime?`
  - `staleDays Int?`
  - `agentCanMove Boolean @default(true)`
  - `assignsConversations Boolean @default(false)`
  - `kind String @default("deals")`
- `LostReason {id, workspaceId, pipelineId, label, labelAr, order, archivedAt?, createdAt}`, with FKs cascading from pipeline and workspace.
- `Ticket.lostReasonId String?`, with FK `SetNull`.
- `stage-draft.ts`: `validateDraft(current, draft): {ok:true, plan} | {ok:false, key}` is pure. `plan` lists stage creates, updates and deletes with their move targets, plus lost-reason upserts and archives.
- Endpoints:
  - `POST /pipelines {name, nameAr, kind}`: creates the pipeline with a default stage set (New, In progress, Won, Lost), all bilingual.
  - `PUT /pipelines/:id/draft {version, name, nameAr, staleDays, agentCanMove, assignsConversations, stages:[{id?, label, labelAr, color, order, slaMinutes?, isWon, isTerminal}], removed:[{stageId, moveTo}], lostReasons:[{id?, label, labelAr, order, archived?}]}`: returns the updated pipeline, or 409 `{current}`.
  - `POST /pipelines/:id/archive` and `/unarchive`.
  - `GET /pipelines?includeArchived=1`.
  - `GET /pipelines/:id/lost-reasons` returns non-archived reasons ordered by `order`.
- Ticket mark-lost (find the existing lost flow in `tickets.service.ts`, the move to a lost stage) accepts `lostReasonId`, validated against the pipeline, and stores `lostReason` as the label snapshot.
- Moves are gated by `agentCanMove` as described in Global Constraints.

- [ ] **Failing tests:** `validateDraft` covers every rule in Review Focus 3, plus Review Focus 1, 2, 4 and 5, plus the move gate and the default pipeline that cannot be archived.
- [ ] Implement, run them green, then run the full jest once.
- [ ] Commit `feat(pipelines): pipeline editor API with draft save, lost reasons, stale threshold`.

### Task 2: Frontend
**Files:**
- Create `src/screens/settings/PipelinesTab.tsx` and `src/screens/settings/pipelines/{StageListEditor.tsx, LostReasonsEditor.tsx, draft.ts}`, with `draft.test.ts`.
- Register the new tab in Settings. Gate it on `pipelines.manage` for editing and `pipelines.view` for read-only.
- Modify:
  - `LostReasonModal.tsx`: reads `GET /pipelines/:id/lost-reasons` and sends `lostReasonId`.
  - `TicketCard.tsx` / `StageColumn.tsx`: show a stale (amber) card when `staleDays` is set and the card has been in its stage longer than that (`enteredStageAt`).
  - Pipeline picker: hides archived pipelines.
  - Drag/move: disabled with a tooltip when `!agentCanMove` and the user lacks `pipelines.update`.

**Produces:**
- **Editor:** a pipeline list with Create and Archive/Unarchive. A pipeline's draft editor has:
  - name in EN and AR, and kind;
  - stages: reorder with drag (dnd-kit, as on the pipeline board) or up/down buttons, colour swatches, label EN/AR, won/lost toggles and SLA minutes;
  - remove, which opens a "Move cards to…" select whenever the stage has cards;
  - the lost-reasons list;
  - settings: stale days, agentCanMove and assignsConversations.
- **Save:** sends the draft. A 409 shows "Someone else changed this pipeline — reload to see their changes" in EN and AR, with a Reload button that keeps a copy of the local draft for comparison.
- **`draft.ts`:** pure helpers that mirror the server rules, so errors show before saving. They are tested.

- [ ] Write failing vitest tests for `draft.ts`, then implement until they pass.
- [ ] Build the components. typecheck and vitest must be clean.
- [ ] Commit `feat(pipelines): pipeline editor, lost reasons, stale cards`.

### Task 3: Verification
- Apply the migration once it's safe.
- **Live checks:**
  - create a pipeline; add and reorder stages; remove a stage with cards and check they moved;
  - conflict between two tabs;
  - lost reason flow;
  - stale cards turn amber;
  - archive.
- Revert the test data, then tick SP-07.
