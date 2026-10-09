# Workflow Automation — Design

**Date:** 2026-09-15
**Status:** Approved
**Context:** Tkana (the sibling product this CRM originated from, at `/Users/aabukhadir/projects/Tkana/tkana`) has a customer-facing workflow automation builder (trigger → condition/action/delay steps) backed by Inngest, a custom tiptap rich-text variable editor, and ~16,000 LOC. This CRM has no equivalent feature today — the closest precedents are `PipelineAutomationService` (hardcoded "when X happens, do Y" hooks), `Segment.filter` (a JSON condition blob resolved server-side), and `Campaign.channel = "Trigger"` (an unbuilt placeholder). This design ports the workflow concept but corrects several usability problems identified in Tkana's implementation: conditions that kill the whole run instead of branching, a single 1,775-line mega-form covering five unrelated action types, two disconnected trigger/dedup mechanisms (event vs. cron), and shipped schema for action/step types (`http`, `wait`) with no real executor behind them. The CRM also has no Redis/queue infrastructure and no Inngest — only `@nestjs/schedule`-based DB-polling cron jobs (e.g. `segments-sync.scheduler.ts`), which this design uses instead of adopting a new durable-execution framework.

## Goals

1. Let a workspace user build a workflow: one trigger, followed by any number of condition (real if/else branch), action, and delay steps.
2. Support all four trigger types from day one: contact/conversation events, ticket/pipeline events, schedule (cron), and inbound webhook.
3. Support three action types backed by infrastructure that already works today: Send WhatsApp (via `ZernioService`), Ask AI Agent (via `LAgentService`), and Update CRM Data (tag add/remove, ticket stage move, contact field update).
4. Run workflows durably enough to survive a backend restart mid-run (persisted cursor + resumable delay), without adding Redis/BullMQ/Inngest.
5. Give the builder UI and execution history a simpler, more legible shape than Tkana's: distinct small forms per action type instead of one mega-form, visible branching instead of a linear list, and run history that stays readable after a workflow is edited.

## Non-goals

- **Send Email action** — no email-sending infrastructure (SMTP/provider) exists in this CRM. Deferred to a later phase; not present in the schema, action picker, or docs as a stub.
- **`http` (outbound webhook call) and `wait` (pause for external event) step types** — not built in v1. Nothing about them ships (no schema, no UI entry) so there's no dead surface area to discover later.
- **Parallel/fan-out execution** (multiple branches running concurrently) — branching in v1 is if/else (choose one path), not parallel execution of multiple paths.
- **Trigger-filter authoring UI beyond the basics already covered by Condition steps** — no separate "advanced filter" builder on the trigger step itself; use a Condition step immediately after the trigger for anything more specific than the trigger's own built-in fields (e.g. "only for a specific pipeline/stage").
- **A visual node-canvas editor** (react-flow/xyxflow-style). The builder stays a step-list form UI, matching Tkana's actual (non-canvas) shape, with branching shown via indentation rather than a graph.

## 1. Data model

Add to `backend/prisma/schema.prisma`:

```prisma
model Workflow {
  id          String   @id @default(cuid())
  workspaceId String
  name        String
  status      String   // "draft" | "active"
  triggerType String   // "contact_created" | "message_received" | "ticket_created" | "ticket_stage_changed" | "schedule" | "webhook" | ...
  triggerConfig Json   // e.g. { stageId } for ticket_stage_changed, { cron: "0 9 * * *", timezone } for schedule
  steps       Json      // step tree, see below
  webhookSecret String? // only set when triggerType = "webhook"
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  runs        WorkflowRun[]

  @@index([workspaceId])
  @@index([workspaceId, triggerType, status])
}

model WorkflowRun {
  id             String    @id @default(cuid())
  workflowId     String
  workspaceId    String
  status         String    // "running" | "waiting" | "completed" | "failed" | "cancelled"
  context        Json      // trigger payload + resolved variables accumulated so far
  stepsSnapshot  Json      // the workflow's step tree, copied at run start
  cursor         Json      // where execution currently is in the tree (step path)
  result         Json      // per-step outputs, keyed by step id
  resumeAt       DateTime? // set only while status = "waiting" (mid-Delay)
  isTest         Boolean   @default(false)
  error          String?
  startedAt      DateTime  @default(now())
  completedAt    DateTime?
  workflow       Workflow  @relation(fields: [workflowId], references: [id])

  @@index([workspaceId, workflowId, startedAt])
  @@index([status, resumeAt])
}
```

`Workflow.steps` is a JSON tree, not a flat array, so branching is structural:

```ts
type Step =
  | { id: string; type: "condition"; config: ConditionConfig; thenSteps: Step[]; elseSteps: Step[]; next?: Step[] }
  | { id: string; type: "send_whatsapp" | "ask_agent" | "update_data" | "delay"; config: ActionConfig; next?: Step[] }
```

A condition's `thenSteps`/`elseSteps` each run to completion and then continue into the condition's own `next` — i.e. both branches rejoin the same continuation, avoiding the need for an explicit merge-node concept.

`WorkflowRun.stepsSnapshot` is copied from `Workflow.steps` when the run starts. Execution and later inspection both read the snapshot, never the live `Workflow.steps` — this is the direct fix for Tkana's orphaned-step-result bug (`execution-detail.tsx` zipping live steps against historical results by id).

## 2. Execution engine (DB-polling, no new infra)

`backend/src/workflows/workflow-runner.service.ts`:
- `run(runId)` loads the `WorkflowRun`, walks `stepsSnapshot` from `cursor`, executing steps synchronously in-process:
  - `condition` → evaluate against `context`, pick `thenSteps` or `elseSteps`, continue.
  - `send_whatsapp` / `ask_agent` / `update_data` → call the relevant existing service (§4), write the result into `context` and `result[step.id]`.
  - `delay` → compute `resumeAt`, persist `cursor` + `status = "waiting"`, return.
- On completion, sets `status = "completed"`, `completedAt`. On a thrown error from a step, sets `status = "failed"`, `error`, and stops (matches Tkana's `failed` semantics — no partial-continue).

`backend/src/workflows/workflow-dispatch.service.ts`:
- `emit(workspaceId, triggerType, payload)` — finds active `Workflow`s matching `workspaceId` + `triggerType`, creates a `WorkflowRun` per match, and immediately calls `WorkflowRunnerService.run()` in-process (not queued) so the common case — no `delay` step — completes within the same tick, not after a poll interval.
- Called directly from existing service call sites, the same style as today's `PipelineAutomationService.onInboundMessage()`/`onOutboundReply()` (`backend/src/tickets/pipeline-automation.service.ts`), which are themselves called from `backend/src/integrations/zernio.service.ts`:
  - `contacts.service.ts` `create()` → `emit(..., "contact_created", ...)`
  - inbound-message path in `zernio.service.ts` (same call site that already invokes `onInboundMessage`) → `emit(..., "message_received", ...)`
  - `tickets.service.ts` ticket creation and `moveTicket()` → `emit(..., "ticket_created" | "ticket_stage_changed", ...)`

`backend/src/workflows/workflow-run-poller.scheduler.ts` (modeled directly on `backend/src/segments/segments-sync.scheduler.ts`):
- `@Cron(CronExpression.EVERY_MINUTE)` — claims `WorkflowRun`s where `status = "waiting" AND resumeAt <= now()`, resumes each via `WorkflowRunnerService.run()`.
- Same job also checks `Workflow`s with `triggerType = "schedule"` for due cron occurrences (using a small cron-parsing helper, e.g. `cron-parser`) and calls `emit()` for each due one, tracking last-fired time on the workflow to avoid double-firing within a minute window. This keeps schedule-triggered workflows on the *same* dedup/run model as event-triggered ones — deliberately avoiding Tkana's split between event dispatch and a separate `workflow_schedules` arm/claim/execute ledger.

## 3. Triggers

Single `TriggerType` string enum + a `triggerConfig: Json` per workflow, not one hand-written dispatcher function per event (Tkana's `workflow-dispatcher.function.ts` is 1,293 lines of ~20 near-duplicate functions). Adding a future trigger type means adding an enum value + a call to `emit()` at the relevant existing call site, not a new file.

- **Contact/conversation events**: `contact_created`, `message_received`.
- **Ticket/pipeline events**: `ticket_created`, `ticket_stage_changed` (config: optional `stageId` filter, matched in `emit()` before creating a run).
- **Schedule**: `triggerConfig = { cron, timezone }`, handled by the poller as above.
- **Webhook**: `triggerConfig = {}`, `Workflow.webhookSecret` generated on creation. New public endpoint `POST /webhooks/workflows/:workflowId`, guarded by `@Public()` + a new `WorkflowWebhookSignatureGuard` verifying `X-Workflow-Signature` (HMAC-SHA256 over the raw body, keyed by `webhookSecret`, `crypto.timingSafeEqual`) — same verification approach as `ZernioWebhookSignatureGuard` (`backend/src/common/zernio-webhook-signature.guard.ts`), written fresh rather than copied, since that guard currently has an unresolved, in-progress diagnostic-logging block (`f550e56`) that shouldn't be carried into new code.

## 4. Actions and conditions

Each action type is its own small config shape and its own executor branch — no shared mega-form:

- **Send WhatsApp** (`send_whatsapp`): `{ recipient: "contact" | "trigger", message: string }` (message contains `{{variable}}` tokens). Executor calls `ZernioService.sendInConversation(...)` (or `sendInDbConversation`, depending on which conversation context the trigger provides) after resolving variables.
- **Ask AI Agent** (`ask_agent`): `{ prompt: string, structuredOutput?: boolean }`. Executor calls `LAgentService.ask(...)`, writes the response into `context` under the step id so later steps/conditions can reference it.
- **Update CRM Data** (`update_data`): `{ operation: "add_tag" | "remove_tag" | "move_ticket_stage" | "update_contact_field", ...operation-specific fields }`. Executor dispatches to the existing `contacts.service.ts` tag-array update (same `tags: JSON.stringify([...])` pattern already used in `create()`/`update()`) or `tickets.service.ts` `moveTicket()` — no new business logic, just calling what already exists.
- **Delay** (`delay`): `{ amount: number, unit: "minutes" | "hours" | "days" }`.
- **Condition** (`condition`): `{ field: string, operator: "equals" | "not_equals" | "contains" | ..., value: string }`, evaluated against `context` — a real if/else producing `thenSteps`/`elseSteps`, not a kill-switch. An **AI Condition** variant (`{ prompt: string }`, evaluated true/false via `LAgentService.ask()`) reuses the same branch shape.

## 5. Backend API

New flat module `backend/src/workflows/` (matching the `contacts`/`tickets` pattern — `workflows.module.ts`, `.controller.ts`, `.service.ts`, `.dto.ts`, plus the two extra services above and a `workflow-webhook-signature.guard.ts`), registered in `app.module.ts`.

- `GET/POST /workflows`, `GET/PUT/DELETE /workflows/:id`
- `POST /workflows/:id/activate`, `POST /workflows/:id/deactivate`
- `POST /workflows/:id/test` — accepts a sample payload (or a real contact/ticket id to build one from), creates a `WorkflowRun` with `isTest = true`, runs it immediately regardless of `status`.
- `GET /workflows/:id/runs`, `GET /workflows/:id/runs/:runId`
- `POST /webhooks/workflows/:workflowId` — public, signature-guarded (§3).

All endpoints scoped by `@CurrentWorkspace()`, following the existing global `WorkspaceInterceptor` convention.

## 6. Frontend

`src/screens/workflows/`, following the `pipeline`/`kewy-agent` structure (screen shell + subcomponents + a `hooks/` folder of React Query hooks), registered as a new `RouteId` + nav entry + lazy `screens` map entry per the existing router convention (`src/router.tsx`, `src/lib/types.ts`, `src/shell/nav.ts`).

- **`WorkflowsPage.tsx`** — list (name, status badge, trigger type, last run time), "New workflow" entry point.
- **`WorkflowBuilder.tsx`** — two-pane layout. Left pane renders the step **tree**: a condition step shows two indented branch columns (Then / Else) directly in the list, rather than a single flat vertical line — branching is visible without a canvas. Right pane renders the selected step's config form: `config/Trigger.tsx`, `config/Condition.tsx`, `config/SendWhatsapp.tsx`, `config/AskAgent.tsx`, `config/UpdateData.tsx`, `config/Delay.tsx` — each small and single-purpose, the direct fix for Tkana's 1,775-line `action.tsx`.
- **`ExecutionsTab.tsx`** — run list (status, duration, trigger payload preview) + a detail view walking `stepsSnapshot` zipped with `result`, so a run stays fully readable after the workflow is later edited.
- **`TestWorkflowModal.tsx`** — pick a real contact/ticket (live search, same pattern as Tkana's test modal) or paste a JSON payload; fires `POST /workflows/:id/test`.
- Built entirely from this CRM's existing hand-built components (`Modal`, `Toggle`, `Badge`, `Skeleton`, etc.) and the Tailwind token system — no new UI library. Every string via the existing `tx(en, ar)` helper, RTL-safe.

**Variable insertion**: plain `{{contact.name}}`-style tokens stored in step config, but presented as chips using tiptap's built-in **Mention extension** (the standard "@mention" pattern, not a fully custom node type + serialization codec like Tkana's `reference-editor.codec.ts`). This keeps the visual chip affordance you asked to preserve while avoiding the bespoke round-trip-corruption bug class flagged in the Tkana exploration — the Mention extension's suggestion-and-insert behavior is a well-tested, off-the-shelf tiptap feature, not something built from scratch.

## 7. Error handling

- A step executor throwing (e.g. `ZernioService` call fails) marks the run `failed` with `error` set to the thrown message; no partial-continue, no retry in v1.
- `emit()` failing to create a run (e.g. workspace lookup error) logs and swallows, matching `PipelineAutomationService`'s existing "never break the caller's request" convention — trigger dispatch must never fail the contact-creation/message-ingestion request it's attached to.
- Webhook endpoint: missing/invalid signature → 401, matching `ZernioWebhookSignatureGuard`'s fail-closed behavior when the secret is unset.
- Builder UI: Save is allowed with an incomplete step (draft state); Activate is blocked client-side with a specific "step N is incomplete" message, with the server re-validating on `activate` as the real backstop (422 with the offending step id).

## 8. Testing

- Backend: unit tests per action executor (mocking `ZernioService`/`LAgentService`/tag-update/ticket-move calls), `workflow-runner.service.spec.ts` covering condition branching, delay-then-resume, and failure handling; `workflow-dispatch.service.spec.ts` covering trigger matching and the "never throws" contract; webhook signature guard tests mirroring `zernio-webhook-signature.guard.spec.ts`'s structure (valid/invalid/missing-secret cases) without carrying over its in-progress diagnostics.
- Frontend: component tests per step config form (following existing screen test conventions), a builder test covering add/remove/branch step operations, an executions-tab test covering the snapshot-vs-live-workflow scenario (edit a workflow, confirm an old run's detail view still renders correctly).
- End-to-end manual pass via the `verify` skill: build a workflow with a condition branch and a delay step, trigger it for real, confirm both the immediate-execution path and the poller-resumed path work.

## Open verification items (resolve during implementation, before dependent code)

1. Confirm which `ZernioService` send method (`sendInConversation` vs `sendInDbConversation`) is correct for a workflow-triggered message, depending on whether the triggering context always has a live Zernio conversation id or sometimes only a DB conversation — check both call sites' preconditions before wiring `send_whatsapp`.
2. Confirm the exact `LAgentService.ask()` signature and return shape (`backend/src/integrations/l-agent.service.ts:38`) before wiring `ask_agent` and AI Condition, including its 60s timeout and swallow-all-errors behavior — the workflow runner needs to distinguish "AI call failed" (should this fail the step, or treat as a false condition?) since `LAgentService` itself never throws.
3. Pick a cron-parsing library for the schedule trigger (e.g. `cron-parser`) and confirm it's not already present under a different name in `backend/package.json`.
4. Confirm the tag-update pattern in `contacts.service.ts` (`tags: JSON.stringify(dto.tags ?? [])`) can be safely read-modify-written concurrently with a workflow's `add_tag`/`remove_tag` action without a race against a simultaneous user edit — decide whether it needs a transaction.
