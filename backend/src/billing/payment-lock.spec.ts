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
  function make(after: Date | null = null, exists = true) {
    const update = jest.fn().mockResolvedValue({});
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const findUnique = jest.fn().mockImplementation(({ select }: any) =>
      Promise.resolve(
        !exists ? null : select.id ? { id: "w1" } : { paymentDueSince: after, suspendedAt: new Date() },
      ),
    );
    const svc = new JoteckService(
      { raw: { workspace: { findUnique, update, updateMany } } } as any,
      {} as any,
      {} as any,
    );
    return { svc, update, updateMany };
  }

  it("404s unknown ids without writing", async () => {
    const { svc, update, updateMany } = make(null, false);
    await expect(svc.setBillingState("nope", "due")).rejects.toThrow("Workspace not found");
    expect(update).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("due only writes when the clock is null (repeat keeps stored time)", async () => {
    const { svc, updateMany, update } = make();
    await svc.setBillingState("w1", "due");
    const arg = updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({ id: "w1", paymentDueSince: null });
    expect(Object.keys(arg.data)).toEqual(["paymentDueSince"]);
    expect(update).not.toHaveBeenCalled();
  });

  it("ended only writes when clock is null or newer than the backdate", async () => {
    const { svc, updateMany } = make();
    await svc.setBillingState("w1", "ended");
    const arg = updateMany.mock.calls[0][0];
    const backdated = arg.data.paymentDueSince as Date;
    expect(arg.where).toEqual({
      id: "w1",
      OR: [{ paymentDueSince: null }, { paymentDueSince: { gt: backdated } }],
    });
    expect(Date.now() - backdated.getTime()).toBeGreaterThanOrEqual(PAYMENT_GRACE_DAYS * 86_400_000);
  });

  it("ok writes exactly { paymentDueSince: null } and leaves suspendedAt alone", async () => {
    const { svc, update, updateMany } = make();
    await svc.setBillingState("w1", "ok");
    expect(update.mock.calls[0][0].data).toStrictEqual({ paymentDueSince: null });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("strips newlines from reason before logging", async () => {
    const { svc } = make();
    const log = jest.spyOn((svc as any).logger, "log").mockImplementation();
    await svc.setBillingState("w1", "ok", "a\nFAKE line\r");
    expect(log.mock.calls[0][0]).not.toMatch(/[\r\n]/);
  });
});
