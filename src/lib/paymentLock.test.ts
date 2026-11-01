import { describe, expect, it } from "vitest";
import { billingLink, PAYMENT_OVERDUE } from "./paymentLock";

describe("billingLink", () => {
  it("returns a valid http(s) url", () => {
    expect(billingLink("https://kewy.ai/billing")).toBe("https://kewy.ai/billing");
  });
  it("is undefined when unset, blank or not http(s)", () => {
    expect(billingLink(undefined)).toBeUndefined();
    expect(billingLink("  ")).toBeUndefined();
    expect(billingLink("javascript:alert(1)")).toBeUndefined();
    expect(billingLink("not a url")).toBeUndefined();
  });
  it("uses the stable backend code", () => {
    expect(PAYMENT_OVERDUE).toBe("PAYMENT_OVERDUE");
  });
});
