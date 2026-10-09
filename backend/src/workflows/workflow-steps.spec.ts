import { validateStepGraph, initialCursor } from "./workflow-steps";

describe("validateStepGraph", () => {
  it("accepts an empty graph", () => {
    const graph = validateStepGraph({ entry: null, steps: {} });
    expect(graph).toEqual({ entry: null, steps: {} });
  });

  it("accepts a graph with a send_whatsapp step", () => {
    const raw = {
      entry: "s1",
      steps: {
        s1: { id: "s1", type: "send_whatsapp", config: { message: "hi {{trigger.contact.name}}" } },
      },
    };
    expect(validateStepGraph(raw)).toEqual(raw);
  });

  it("accepts a condition step with thenNext/elseNext", () => {
    const raw = {
      entry: "c1",
      steps: {
        c1: {
          id: "c1",
          type: "condition",
          config: { field: "trigger.contact.lifecycle", operator: "equals", value: "lead" },
          thenNext: "s1",
          elseNext: "s2",
        },
        s1: { id: "s1", type: "delay", config: { amount: 1, unit: "hours" } },
        s2: { id: "s2", type: "delay", config: { amount: 2, unit: "days" } },
      },
    };
    expect(validateStepGraph(raw)).toEqual(raw);
  });

  it("rejects a non-object value", () => {
    expect(() => validateStepGraph("nope")).toThrow(/must be an object/);
  });

  it("rejects a step with an unknown type", () => {
    const raw = { entry: "s1", steps: { s1: { id: "s1", type: "mystery", config: {} } } };
    expect(() => validateStepGraph(raw)).toThrow(/unknown step type/);
  });

  it("rejects an entry id that isn't in steps", () => {
    const raw = { entry: "missing", steps: {} };
    expect(() => validateStepGraph(raw)).toThrow(/entry .* not found/);
  });

  it("rejects a send_whatsapp step with a non-string message", () => {
    const raw = { entry: "s1", steps: { s1: { id: "s1", type: "send_whatsapp", config: { message: 5 } } } };
    expect(() => validateStepGraph(raw)).toThrow(/message/);
  });

  it("rejects a delay step with a bad unit", () => {
    const raw = {
      entry: "s1",
      steps: { s1: { id: "s1", type: "delay", config: { amount: 1, unit: "fortnights" } } },
    };
    expect(() => validateStepGraph(raw)).toThrow(/unit/);
  });
});

describe("initialCursor", () => {
  it("points at the graph's entry step", () => {
    expect(initialCursor({ entry: "s1", steps: {} })).toEqual({ stepId: "s1" });
  });

  it("is null for an empty graph", () => {
    expect(initialCursor({ entry: null, steps: {} })).toEqual({ stepId: null });
  });
});
