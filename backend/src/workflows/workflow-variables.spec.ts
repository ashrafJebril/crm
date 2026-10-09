import { getByPath, resolveVariables } from "./workflow-variables";

describe("getByPath", () => {
  it("walks a nested path", () => {
    expect(getByPath({ a: { b: { c: 5 } } }, "a.b.c")).toBe(5);
  });

  it("returns undefined for a missing path", () => {
    expect(getByPath({ a: {} }, "a.b.c")).toBeUndefined();
  });

  it("returns undefined when walking through a non-object", () => {
    expect(getByPath({ a: 5 }, "a.b")).toBeUndefined();
  });
});

describe("resolveVariables", () => {
  const context = { trigger: { contact: { name: "Sara" } }, steps: { s1: { answer: "yes" } } };

  it("substitutes a trigger variable", () => {
    expect(resolveVariables("Hi {{trigger.contact.name}}!", context)).toBe("Hi Sara!");
  });

  it("substitutes a step-output variable", () => {
    expect(resolveVariables("Agent said: {{steps.s1.answer}}", context)).toBe("Agent said: yes");
  });

  it("substitutes multiple variables in one template", () => {
    expect(resolveVariables("{{trigger.contact.name}} / {{steps.s1.answer}}", context)).toBe("Sara / yes");
  });

  it("replaces an unresolved variable with an empty string", () => {
    expect(resolveVariables("Hi {{trigger.contact.missing}}", context)).toBe("Hi ");
  });

  it("leaves plain text without braces untouched", () => {
    expect(resolveVariables("No variables here", context)).toBe("No variables here");
  });
});
