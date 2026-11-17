import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SP-28: a 402 PLAN_REQUIRED opens the global notice; that error alone skips
 * the toast. Nothing is time-based: an unrelated error right after still toasts.
 */
async function load() {
  vi.resetModules();
  const client = await import("./client");
  const filter = await import("@/components/toastFilter");
  return { c: client, shouldShowToast: filter.shouldShowToast };
}

const res = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const PLAN_402 = { statusCode: 402, code: "PLAN_REQUIRED", message: "billing.plan_required", feature: "campaigns", requiredPlan: "starter" };

beforeEach(() => {
  const mem = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("global PLAN_REQUIRED handling", () => {
  it("the plan-required error opens the notice and shows no toast; an unrelated error right after still toasts", async () => {
    const { c, shouldShowToast } = await load();
    const seen = vi.fn();
    c.setPlanRequiredHandler(seen);
    vi.stubGlobal("fetch", vi.fn(async () => res(402, PLAN_402)));
    const planErr = await c.api.get("/campaigns").catch((e) => e);
    expect(planErr).toMatchObject({ status: 402, code: "PLAN_REQUIRED", planRequired: true });
    expect(seen).toHaveBeenCalledWith({ feature: "campaigns", requiredPlan: "starter" });
    expect(c.isPlanRequiredError(planErr)).toBe(true);
    // The screen's own error toast for it stays quiet (by cause, or by its raw key).
    expect(shouldShowToast("Something went wrong. Try again.", "error", planErr)).toBe(false);
    expect(shouldShowToast("billing.plan_required", "error")).toBe(false);

    // Within the same second, an unrelated failure still shows its toast.
    vi.stubGlobal("fetch", vi.fn(async () => res(500, { statusCode: 500, message: "Internal server error" })));
    const other = await c.api.get("/contacts").catch((e) => e);
    expect(c.isPlanRequiredError(other)).toBe(false);
    expect(shouldShowToast("Couldn't save the contact.", "error", other)).toBe(true);
    expect(shouldShowToast("Couldn't save the contact.", "error")).toBe(true);
    expect(shouldShowToast("Saved", "success")).toBe(true);
  });

  it("other 402s (WALLET_EMPTY) and 403s are not plan-required and do not open the notice", async () => {
    const { c, shouldShowToast } = await load();
    const seen = vi.fn();
    c.setPlanRequiredHandler(seen);
    vi.stubGlobal("fetch", vi.fn(async () => res(402, { statusCode: 402, code: "WALLET_EMPTY", message: "billing.wallet_empty" })));
    const wallet = await c.api.get("/x").catch((e) => e);
    vi.stubGlobal("fetch", vi.fn(async () => res(403, { statusCode: 403, message: "Missing permission" })));
    const denied = await c.api.get("/y").catch((e) => e);
    expect(seen).not.toHaveBeenCalled();
    expect(c.isPlanRequiredError(wallet)).toBe(false);
    expect(shouldShowToast("x", "error", wallet)).toBe(true);
    expect(shouldShowToast("x", "error", denied)).toBe(true);
  });
});
