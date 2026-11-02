import { PaymentLockService } from "./payment-lock.service";
import { PAYMENT_GRACE_DAYS } from "./payment-lock";

const DAY = 86_400_000;

describe("PaymentLockService", () => {
  let findUnique: jest.Mock;
  let svc: PaymentLockService;
  let now: number;

  beforeEach(() => {
    now = Date.parse("2026-11-01T12:00:00Z");
    jest.spyOn(Date, "now").mockImplementation(() => now);
    findUnique = jest.fn();
    svc = new PaymentLockService({ raw: { workspace: { findUnique } } } as never);
  });
  afterEach(() => jest.restoreAllMocks());

  const dueSince = (days: number) => ({ paymentDueSince: new Date(now - days * DAY) });

  it("is locked once the grace period has passed", async () => {
    findUnique.mockResolvedValue(dueSince(PAYMENT_GRACE_DAYS));
    expect(await svc.isLocked("w1")).toBe(true);
  });

  it("is not locked inside the grace period or with no clock", async () => {
    findUnique.mockResolvedValueOnce(dueSince(1));
    expect(await svc.isLocked("w1")).toBe(false);
    findUnique.mockResolvedValueOnce({ paymentDueSince: null });
    expect(await svc.isLocked("w2")).toBe(false);
  });

  it("is not locked for an unknown workspace", async () => {
    findUnique.mockResolvedValue(null);
    expect(await svc.isLocked("nope")).toBe(false);
  });

  it("caches the lookup for 60 seconds, then refreshes", async () => {
    findUnique.mockResolvedValue(dueSince(5));
    await svc.isLocked("w1");
    now += 59_000;
    await svc.isLocked("w1");
    expect(findUnique).toHaveBeenCalledTimes(1);
    findUnique.mockResolvedValue({ paymentDueSince: null });
    now += 2_000;
    expect(await svc.isLocked("w1")).toBe(false);
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it("caches per workspace", async () => {
    findUnique.mockResolvedValue(dueSince(5));
    await svc.isLocked("a");
    await svc.isLocked("b");
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it("propagates a lookup failure and does not cache it", async () => {
    findUnique.mockRejectedValueOnce(new Error("db down"));
    await expect(svc.isLocked("w1")).rejects.toThrow("db down");
    findUnique.mockResolvedValue(dueSince(5));
    expect(await svc.isLocked("w1")).toBe(true);
  });
});
