import { describe, expect, it } from "vitest";
import { lifecycleLabel, lifecycleOptions, normalizeLifecycle } from "./lifecycle";

const en = (a: string) => a;
describe("lifecycle", () => {
  it("normalises legacy casing", () => {
    expect(normalizeLifecycle("Lead")).toBe("lead");
    expect(normalizeLifecycle("VIP")).toBe("VIP");
  });
  it("labels case-insensitively", () => {
    expect(lifecycleLabel(en, "Customer")).toBe("Customer");
    expect(lifecycleLabel((_a, b) => b, "churned")).toBe("متوقف");
  });
  it("does not duplicate a legacy value as a custom option", () => {
    expect(lifecycleOptions("Lead")).toEqual(["lead", "customer", "churned", "patient"]);
    expect(lifecycleOptions("prospect")[0]).toBe("prospect");
  });
});
