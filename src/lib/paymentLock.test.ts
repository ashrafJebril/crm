import { describe, expect, it } from "vitest";
import { billingLink, PAYMENT_OVERDUE } from "./paymentLock";

describe("billingLink", () => {
  it("returns a valid https url", () => {
    expect(billingLink("https://kewy.ai/billing")).toBe("https://kewy.ai/billing");
  });
  it("accepts https only (SP-28 M1): plain http is refused", () => {
    expect(billingLink("http://kewy.ai/billing")).toBeUndefined();
    expect(billingLink("HTTPS://kewy.ai/billing")).toBe("https://kewy.ai/billing");
    expect(billingLink("ftp://kewy.ai/billing")).toBeUndefined();
    expect(billingLink("data:text/html,hi")).toBeUndefined();
  });
  it("is undefined when unset, blank or not https", () => {
    expect(billingLink(undefined)).toBeUndefined();
    expect(billingLink("  ")).toBeUndefined();
    expect(billingLink("javascript:alert(1)")).toBeUndefined();
    expect(billingLink("not a url")).toBeUndefined();
  });
  it("uses the stable backend code", () => {
    expect(PAYMENT_OVERDUE).toBe("PAYMENT_OVERDUE");
  });
});
