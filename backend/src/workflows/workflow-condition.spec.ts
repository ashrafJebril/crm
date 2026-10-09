import { evaluateCondition, interpretYesNo } from "./workflow-condition";

const context = { trigger: { contact: { lifecycle: "lead" } }, steps: {} };

describe("evaluateCondition", () => {
  it("equals — true", () => {
    expect(
      evaluateCondition({ field: "trigger.contact.lifecycle", operator: "equals", value: "lead" }, context),
    ).toBe(true);
  });

  it("equals — false", () => {
    expect(
      evaluateCondition({ field: "trigger.contact.lifecycle", operator: "equals", value: "customer" }, context),
    ).toBe(false);
  });

  it("not_equals", () => {
    expect(
      evaluateCondition({ field: "trigger.contact.lifecycle", operator: "not_equals", value: "customer" }, context),
    ).toBe(true);
  });

  it("contains", () => {
    expect(evaluateCondition({ field: "trigger.contact.lifecycle", operator: "contains", value: "ea" }, context)).toBe(
      true,
    );
  });

  it("not_contains", () => {
    expect(
      evaluateCondition({ field: "trigger.contact.lifecycle", operator: "not_contains", value: "zzz" }, context),
    ).toBe(true);
  });

  it("treats a missing field as an empty string", () => {
    expect(evaluateCondition({ field: "trigger.contact.missing", operator: "equals", value: "" }, context)).toBe(
      true,
    );
  });
});

describe("interpretYesNo", () => {
  it("treats 'Yes' as true", () => expect(interpretYesNo("Yes, it does")).toBe(true));
  it("treats 'true' as true", () => expect(interpretYesNo("true")).toBe(true));
  it("treats 'No' as false", () => expect(interpretYesNo("No")).toBe(false));
  it("treats null as false", () => expect(interpretYesNo(null)).toBe(false));
});
