import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** SP-28: a 402 PLAN_REQUIRED opens the global notice and quiets the error toast. */
async function load() {
  vi.resetModules();
  return import("./client");
}

const res = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

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
  it("a 402 PLAN_REQUIRED calls the handler with feature and plan, then quiets toasts for a moment", async () => {
    const c = await load();
    const seen = vi.fn();
    c.setPlanRequiredHandler(seen);
    vi.stubGlobal("fetch", vi.fn(async () => res(402, { statusCode: 402, code: "PLAN_REQUIRED", message: "billing.plan_required", feature: "campaigns", requiredPlan: "starter" })));
    expect(c.recentlyPlanRequired()).toBe(false);
    await expect(c.api.get("/campaigns")).rejects.toMatchObject({ status: 402, code: "PLAN_REQUIRED" });
    expect(seen).toHaveBeenCalledWith({ feature: "campaigns", requiredPlan: "starter" });
    expect(c.recentlyPlanRequired()).toBe(true);
    expect(c.recentlyPlanRequired(Date.now() + 5000)).toBe(false);
  });

  it("other 402s (WALLET_EMPTY) and 403s do not open it", async () => {
    const c = await load();
    const seen = vi.fn();
    c.setPlanRequiredHandler(seen);
    vi.stubGlobal("fetch", vi.fn(async () => res(402, { statusCode: 402, code: "WALLET_EMPTY", message: "billing.wallet_empty" })));
    await expect(c.api.get("/x")).rejects.toMatchObject({ status: 402 });
    vi.stubGlobal("fetch", vi.fn(async () => res(403, { statusCode: 403, message: "Missing permission" })));
    await expect(c.api.get("/y")).rejects.toMatchObject({ status: 403 });
    expect(seen).not.toHaveBeenCalled();
    expect(c.recentlyPlanRequired()).toBe(false);
  });
});
