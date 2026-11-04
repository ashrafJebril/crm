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

describe("send_whatsapp_template steps", () => {
  const graphWith = (config: unknown) => ({
    entry: "t1",
    steps: { t1: { id: "t1", type: "send_whatsapp_template", config } },
  });

  it("accepts a complete template step", () => {
    const raw = graphWith({ name: "receipt", language: "en", variables: ["{{trigger.contact.name}}", "R-12"] });
    expect(validateStepGraph(raw)).toEqual(raw);
  });

  it("lets a draft save with the template not picked yet", () => {
    expect(() => validateStepGraph(graphWith({ name: "", language: "", variables: [] }), { strict: false })).not.toThrow();
  });

  it("refuses to activate without a template", () => {
    expect(() => validateStepGraph(graphWith({ name: "", language: "en", variables: [] }))).toThrow(/name/);
  });

  it("refuses to activate with an empty variable", () => {
    expect(() => validateStepGraph(graphWith({ name: "receipt", language: "en", variables: ["x", " "] }))).toThrow(
      /variables/,
    );
  });

  it("rejects variables that are not strings, even in a draft", () => {
    expect(() =>
      validateStepGraph(graphWith({ name: "receipt", language: "en", variables: [1] }), { strict: false }),
    ).toThrow(/variables/);
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
