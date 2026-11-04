import { describe, expect, it } from "vitest";
import type { WorkflowStep, WorkflowStepGraph } from "@/lib/types";
import {
  ancestorIds,
  duplicateStep,
  insertStep,
  orderedStepIds,
  pruneUnreachable,
  removalImpact,
  removeStep,
} from "./graph";

const msg = (id: string, next?: string): WorkflowStep => ({ id, type: "send_whatsapp", config: { message: id }, next });
const cond = (id: string, thenNext?: string, elseNext?: string): WorkflowStep => ({
  id,
  type: "condition",
  config: { field: "trigger.contact.lifecycle", operator: "equals", value: "lead" },
  thenNext,
  elseNext,
});
const graphOf = (entry: string | null, ...steps: WorkflowStep[]): WorkflowStepGraph => ({
  entry,
  steps: Object.fromEntries(steps.map((s) => [s.id, s])),
});

describe("insertStep", () => {
  it("inserts at the entry of an empty graph", () => {
    const g = insertStep(graphOf(null), { kind: "entry" }, msg("a"));
    expect(g.entry).toBe("a");
    expect(g.steps.a.next).toBeUndefined();
  });

  it("inserts at the entry and keeps the old first step after it", () => {
    const g = insertStep(graphOf("a", msg("a")), { kind: "entry" }, msg("n"));
    expect(g.entry).toBe("n");
    expect(g.steps.n.next).toBe("a");
  });

  it("inserts in the middle of a chain", () => {
    const g = insertStep(graphOf("a", msg("a", "b"), msg("b")), { kind: "after", stepId: "a" }, msg("n"));
    expect(g.steps.a.next).toBe("n");
    expect(g.steps.n.next).toBe("b");
  });

  it("inserts at the start of a branch lane", () => {
    const g = insertStep(graphOf("c", cond("c", "y"), msg("y")), { kind: "branch", conditionId: "c", branch: "then" }, msg("n"));
    const c = g.steps.c as Extract<WorkflowStep, { type: "condition" }>;
    expect(c.thenNext).toBe("n");
    expect(g.steps.n.next).toBe("y");
  });

  it("hangs the rest of the chain off the Yes lane when inserting a condition mid-chain", () => {
    const g = insertStep(graphOf("a", msg("a", "b"), msg("b")), { kind: "after", stepId: "a" }, cond("c"));
    const c = g.steps.c as Extract<WorkflowStep, { type: "condition" }>;
    expect(g.steps.a.next).toBe("c");
    expect(c.thenNext).toBe("b");
    expect(c.elseNext).toBeUndefined();
  });

  it("refuses to insert 'after' a condition, which has no single next", () => {
    const before = graphOf("c", cond("c"));
    expect(insertStep(before, { kind: "after", stepId: "c" }, msg("n"))).toBe(before);
  });

  it("does not mutate the input graph", () => {
    const before = graphOf("a", msg("a"));
    insertStep(before, { kind: "after", stepId: "a" }, msg("n"));
    expect(before.steps.a.next).toBeUndefined();
    expect(before.steps.n).toBeUndefined();
  });
});

describe("removeStep", () => {
  it("removes a middle step and reconnects its neighbours", () => {
    const { graph, removed } = removeStep(graphOf("a", msg("a", "b"), msg("b", "c"), msg("c")), "b");
    expect(removed).toEqual(["b"]);
    expect(graph.steps.a.next).toBe("c");
    expect(graph.steps.b).toBeUndefined();
  });

  it("removes the entry step and promotes the next one", () => {
    const { graph } = removeStep(graphOf("a", msg("a", "b"), msg("b")), "a");
    expect(graph.entry).toBe("b");
  });

  it("removes the only step", () => {
    const { graph } = removeStep(graphOf("a", msg("a")), "a");
    expect(graph).toEqual({ entry: null, steps: {} });
  });

  it("reconnects a step inside a branch lane", () => {
    const { graph } = removeStep(graphOf("c", cond("c", "y1", "n1"), msg("y1", "y2"), msg("y2"), msg("n1")), "y1");
    const c = graph.steps.c as Extract<WorkflowStep, { type: "condition" }>;
    expect(c.thenNext).toBe("y2");
    expect(c.elseNext).toBe("n1");
  });

  it("removing a condition keeps the Yes lane and drops the No lane", () => {
    const g = graphOf("a", msg("a", "c"), cond("c", "y1", "n1"), msg("y1"), msg("n1", "n2"), msg("n2"));
    expect(removalImpact(g, "c")).toEqual(["n1", "n2"]);
    const { graph, removed } = removeStep(g, "c");
    expect(removed.sort()).toEqual(["c", "n1", "n2"]);
    expect(graph.steps.a.next).toBe("y1");
    expect(Object.keys(graph.steps).sort()).toEqual(["a", "y1"]);
  });

  it("removing a condition with only a No lane keeps the No lane", () => {
    const { graph } = removeStep(graphOf("c", cond("c", undefined, "n1"), msg("n1")), "c");
    expect(graph.entry).toBe("n1");
  });

  it("returns the same graph for an unknown id", () => {
    const g = graphOf("a", msg("a"));
    expect(removeStep(g, "zz").graph).toBe(g);
  });
});

describe("duplicateStep", () => {
  it("copies a step right after itself with a deep-copied config", () => {
    const g = duplicateStep(graphOf("a", msg("a", "b"), msg("b")), "a", "a2");
    expect(g.steps.a.next).toBe("a2");
    expect(g.steps.a2.next).toBe("b");
    expect(g.steps.a2.config).toEqual(g.steps.a.config);
    expect(g.steps.a2.config).not.toBe(g.steps.a.config);
  });

  it("does not duplicate conditions", () => {
    const g = graphOf("c", cond("c"));
    expect(duplicateStep(g, "c", "c2")).toBe(g);
  });
});

describe("ordering helpers", () => {
  const g = graphOf("a", msg("a", "c"), cond("c", "y1", "n1"), msg("y1", "y2"), msg("y2"), msg("n1"));

  it("orders steps top-down, Yes lane before No lane", () => {
    expect(orderedStepIds(g)).toEqual(["a", "c", "y1", "y2", "n1"]);
  });

  it("lists the steps that run before a given step", () => {
    expect(ancestorIds(g, "y2")).toEqual(["a", "c", "y1"]);
    expect(ancestorIds(g, "n1")).toEqual(["a", "c"]);
    expect(ancestorIds(g, "a")).toEqual([]);
  });

  it("survives cycles in malformed graphs", () => {
    const loop = graphOf("a", msg("a", "b"), msg("b", "a"));
    expect(orderedStepIds(loop)).toEqual(["a", "b"]);
  });

  it("prunes steps that cannot be reached from the entry", () => {
    const pruned = pruneUnreachable(graphOf("a", msg("a"), msg("orphan")));
    expect(Object.keys(pruned.steps)).toEqual(["a"]);
  });
});
