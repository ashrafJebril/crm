// Pure edits on the workflow step graph. The backend runner walks `entry` →
// `next`, and a condition step ends its chain by forking into `thenNext` /
// `elseNext` lanes that never rejoin — every helper here keeps that shape.
import type { WorkflowStep, WorkflowStepGraph } from "@/lib/types";

type BranchStep = Extract<WorkflowStep, { type: "condition" | "ai_condition" }>;

export type InsertPoint =
  | { kind: "entry" }
  | { kind: "after"; stepId: string }
  | { kind: "branch"; conditionId: string; branch: "then" | "else" };

/** Where a step is linked from: the graph entry, or a pointer on another step. */
type IncomingRef = { kind: "entry" } | { kind: "next" | "then" | "else"; from: string };

export const isBranchStep = (step: WorkflowStep): step is BranchStep =>
  step.type === "condition" || step.type === "ai_condition";

/** Ids a step points at, Yes lane before No lane. */
function childrenOf(step: WorkflowStep): string[] {
  const ids = isBranchStep(step) ? [step.thenNext, step.elseNext] : [step.next];
  return ids.filter((id): id is string => Boolean(id));
}

function readRef(graph: WorkflowStepGraph, ref: IncomingRef): string | undefined {
  if (ref.kind === "entry") return graph.entry ?? undefined;
  const from = graph.steps[ref.from];
  if (!from) return undefined;
  if (ref.kind === "next") return isBranchStep(from) ? undefined : from.next;
  if (!isBranchStep(from)) return undefined;
  return ref.kind === "then" ? from.thenNext : from.elseNext;
}

/** Returns a copy of `steps` with the pointer `ref` set to `target`. */
function writeRef(graph: WorkflowStepGraph, ref: IncomingRef, target: string | undefined): WorkflowStepGraph {
  if (ref.kind === "entry") return { ...graph, entry: target ?? null };
  const from = graph.steps[ref.from];
  const key = ref.kind === "next" ? "next" : ref.kind === "then" ? "thenNext" : "elseNext";
  return { ...graph, steps: { ...graph.steps, [ref.from]: { ...from, [key]: target } as WorkflowStep } };
}

function incomingRef(graph: WorkflowStepGraph, id: string): IncomingRef | null {
  if (graph.entry === id) return { kind: "entry" };
  for (const step of Object.values(graph.steps)) {
    if (isBranchStep(step)) {
      if (step.thenNext === id) return { kind: "then", from: step.id };
      if (step.elseNext === id) return { kind: "else", from: step.id };
    } else if (step.next === id) {
      return { kind: "next", from: step.id };
    }
  }
  return null;
}

function refForInsertPoint(graph: WorkflowStepGraph, at: InsertPoint): IncomingRef | null {
  if (at.kind === "entry") return { kind: "entry" };
  if (at.kind === "after") {
    const parent = graph.steps[at.stepId];
    return parent && !isBranchStep(parent) ? { kind: "next", from: at.stepId } : null;
  }
  const cond = graph.steps[at.conditionId];
  return cond && isBranchStep(cond) ? { kind: at.branch, from: at.conditionId } : null;
}

/** Ids reachable from `start`, depth-first, Yes lane before No lane. */
function collect(graph: WorkflowStepGraph, start: string | undefined | null, seen = new Set<string>()): string[] {
  const out: string[] = [];
  const stack = start ? [start] : [];
  while (stack.length) {
    const id = stack.pop()!;
    const step = graph.steps[id];
    if (!step || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    stack.push(...childrenOf(step).reverse());
  }
  return out;
}

/**
 * Links `step` in at `at`, moving whatever was there to come after it. A new
 * condition inherits the rest of the chain on its Yes lane, so nothing is lost.
 */
export function insertStep(graph: WorkflowStepGraph, at: InsertPoint, step: WorkflowStep): WorkflowStepGraph {
  const ref = refForInsertPoint(graph, at);
  if (!ref) return graph;
  const successor = readRef(graph, ref);
  const linked = (isBranchStep(step) ? { ...step, thenNext: successor } : { ...step, next: successor }) as WorkflowStep;
  const withStep = { ...graph, steps: { ...graph.steps, [linked.id]: linked } };
  return writeRef(withStep, ref, linked.id);
}

/** Steps that removing `id` would also delete (a condition's No lane), excluding `id`. */
export function removalImpact(graph: WorkflowStepGraph, id: string): string[] {
  const step = graph.steps[id];
  if (!step || !isBranchStep(step) || !step.thenNext) return [];
  return collect(graph, step.elseNext);
}

/**
 * Removes a step and reconnects its parent to whatever came after it. For a
 * condition, the Yes lane takes its place (or the No lane, if Yes is empty) and
 * the other lane is deleted.
 */
export function removeStep(graph: WorkflowStepGraph, id: string): { graph: WorkflowStepGraph; removed: string[] } {
  const step = graph.steps[id];
  if (!step) return { graph, removed: [] };

  const dropped = removalImpact(graph, id);
  const continuation = isBranchStep(step) ? (step.thenNext ?? step.elseNext) : step.next;
  const ref = incomingRef(graph, id);
  const relinked = ref ? writeRef(graph, ref, continuation) : graph;

  const steps = { ...relinked.steps };
  for (const gone of [id, ...dropped]) delete steps[gone];
  return { graph: { ...relinked, steps }, removed: [id, ...dropped] };
}

/** Inserts a copy of a non-branch step directly after it. */
export function duplicateStep(graph: WorkflowStepGraph, id: string, newId: string): WorkflowStepGraph {
  const step = graph.steps[id];
  if (!step || isBranchStep(step)) return graph;
  const copy = { id: newId, type: step.type, config: structuredClone(step.config) } as WorkflowStep;
  return insertStep(graph, { kind: "after", stepId: id }, copy);
}

/** Every reachable step id in reading order: top-down, Yes lane before No lane. */
export function orderedStepIds(graph: WorkflowStepGraph): string[] {
  return collect(graph, graph.entry);
}

/** Ids of the steps that run before `id` on its path from the entry. */
export function ancestorIds(graph: WorkflowStepGraph, id: string): string[] {
  const path: string[] = [];
  let ref = incomingRef(graph, id);
  const seen = new Set<string>([id]);
  while (ref && ref.kind !== "entry" && !seen.has(ref.from)) {
    seen.add(ref.from);
    path.unshift(ref.from);
    ref = incomingRef(graph, ref.from);
  }
  return path;
}

/** Drops steps the runner can never reach (leftovers from older editors). */
export function pruneUnreachable(graph: WorkflowStepGraph): WorkflowStepGraph {
  const keep = new Set(orderedStepIds(graph));
  return { ...graph, steps: Object.fromEntries(Object.entries(graph.steps).filter(([id]) => keep.has(id))) };
}
