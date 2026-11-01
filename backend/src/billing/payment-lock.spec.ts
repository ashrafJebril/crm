import {
  PAYMENT_GRACE_DAYS,
  applyBillingState,
  isPaymentLocked,
} from "./payment-lock";
import { JoteckService } from "../joteck/joteck.service";

const HOUR = 3600_000;
const now = new Date("2026-11-10T12:00:00Z");

describe("payment lock", () => {
  it("grace is 2 days", () => expect(PAYMENT_GRACE_DAYS).toBe(2));

  it("is not locked at 47h59m", () => {
    const since = new Date(now.getTime() - 48 * HOUR + 60_000);
    expect(isPaymentLocked(since, now)).toBe(false);
  });
  it("is locked at 48h", () => {
    expect(isPaymentLocked(new Date(now.getTime() - 48 * HOUR), now)).toBe(true);
  });
  it("null is never locked", () => expect(isPaymentLocked(null, now)).toBe(false));

  it("repeated due keeps the first time", () => {
    const first = applyBillingState(null, "due", now);
    expect(first).toEqual(now);
    const later = new Date(now.getTime() + 5 * HOUR);
    expect(applyBillingState(first, "due", later)).toEqual(now);
  });
  it("ok clears", () => {
    expect(applyBillingState(now, "ok", now)).toBeNull();
  });
  it("ended locks at once", () => {
    const r = applyBillingState(null, "ended", now);
    expect(isPaymentLocked(r, now)).toBe(true);
  });
  it("ended keeps an older clock", () => {
    const old = new Date(now.getTime() - 10 * 24 * HOUR);
    expect(applyBillingState(old, "ended", now)).toEqual(old);
  });
  it("ended after recent due pulls the clock back", () => {
    const r = applyBillingState(new Date(now.getTime() - HOUR), "ended", now);
    expect(isPaymentLocked(r, now)).toBe(true);
  });
});

describe("JoteckService.setBillingState", () => {
  it("writes only paymentDueSince and 404s unknown ids", async () => {
    const update = jest.fn().mockResolvedValue({});
    const findUnique = jest
      .fn()
      .mockResolvedValueOnce({ paymentDueSince: null })
      .mockResolvedValueOnce(null);
    const svc = new JoteckService(
      { raw: { workspace: { findUnique, update } } } as any,
      {} as any,
      {} as any,
    );
    await svc.setBillingState("w1", "due");
    const arg = update.mock.calls[0][0];
    expect(Object.keys(arg.data)).toEqual(["paymentDueSince"]);
    expect(arg.data.paymentDueSince).toBeInstanceOf(Date);
    await expect(svc.setBillingState("nope", "ok")).rejects.toThrow("Workspace not found");
  });
});
