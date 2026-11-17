import { Prisma } from "@prisma/client";
import { makeFakePrisma } from "../channels/test-prisma";
import { BillingController } from "./billing.controller";
import { BillingStatusService, bannersFor, reduceStatus } from "./billing-status.service";
import { UsageService } from "./usage.service";
import { WalletService } from "./wallet.service";

const WS = "ws1";
const NOW = new Date("2026-11-18T10:00:00Z");

function build(ws: Record<string, unknown> = {}, balance = "3.0000") {
  const prisma = makeFakePrisma({
    workspace: [{ id: WS, plan: "Ultimate", planOverriddenAt: null, paymentDueSince: null, timezone: "Asia/Amman", ...ws }],
    usageEvent: [],
    adsWallet: [{ id: "w1", workspaceId: WS, balanceJod: new Prisma.Decimal(balance) }],
  });
  const usage = new UsageService(prisma as never);
  const svc = new BillingStatusService(prisma as never, new WalletService(prisma as never), usage);
  svc.now = () => NOW;
  return { prisma, svc, usage };
}

describe("SP-28 credit status (Kewy data)", () => {
  it("full status: Kewy plan, every feature, no banners when paid up", async () => {
    const { svc, usage } = build();
    await usage.record(WS, { meter: "ai_reply", sourceKind: "message", sourceId: "m1", at: new Date("2026-11-17T10:00:00Z") });
    const s = await svc.status(WS, true);
    expect(s).toMatchObject({
      billedBy: "kewy",
      plan: { key: null, name: "Ultimate" },
      overridden: false,
      payment: { dueSince: null, locksAt: null, locked: false },
      banners: [],
      wallet: { balanceJod: "3.0000", lowBalance: false },
    });
    expect(s.features).toContain("campaigns");
    expect(s.usage?.meters.find((m) => m.meter === "ai_reply")).toEqual({ meter: "ai_reply", used: 1, allowance: null });
  });

  it("credit status reduced without billing.view", async () => {
    const { svc } = build({}, "0.1000");
    const full = await svc.status(WS, true);
    expect(full.banners).toEqual(["low_balance"]);
    const reduced = await svc.status(WS, false);
    expect(reduced).not.toHaveProperty("wallet");
    expect(reduced).not.toHaveProperty("usage");
    expect(reduced.banners).toEqual([]); // the low balance is billing.view-only information
    expect(reduced.features).toEqual(full.features);
    expect(reduceStatus(full)).toEqual(reduced);
  });

  it("banners computed from the payment clock (grace until the lock) and the balance", async () => {
    const due = new Date("2026-11-17T09:00:00Z"); // 25 h ago: due, not locked (2-day grace)
    const { svc } = build({ paymentDueSince: due, planOverriddenAt: new Date() });
    const s = await svc.status(WS, true);
    expect(s.overridden).toBe(true);
    expect(s.payment).toEqual({ dueSince: due.toISOString(), locksAt: "2026-11-19T09:00:00.000Z", locked: false });
    expect(s.banners).toEqual(["grace"]);
    const D = (v: string) => new Prisma.Decimal(v);
    expect(bannersFor({ dueSince: due, locked: true, balance: D("9"), threshold: D("0.5") })).toEqual([]);
    expect(bannersFor({ dueSince: null, locked: false, balance: D("0.4"), threshold: D("0.5") })).toEqual(["low_balance"]);
    expect(bannersFor({ dueSince: null, locked: false, balance: null, threshold: D("0.5") })).toEqual([]);
  });

  it("is cached per workspace (30 s) and can be invalidated", async () => {
    const { svc, prisma } = build();
    await svc.status(WS, true);
    (prisma.db as any).workspace[0].plan = "growth";
    expect((await svc.status(WS, true)).plan.name).toBe("Ultimate");
    svc.invalidate(WS);
    expect((await svc.status(WS, true)).plan).toEqual({ key: "growth", name: "growth" });
  });

  it("the route gives the full status to billing.view holders and super-admins, never to impersonators", async () => {
    const status = { status: jest.fn(async (_ws: string, can: boolean) => ({ can })) };
    const perms = { can: jest.fn((eff: any, p: string) => !!eff?.permissions?.billing?.includes(p.split(".")[1])) };
    const ctrl = new BillingController(status as never, {} as never, {} as never, perms as never, {} as never);
    const req = (user: Record<string, unknown>, billing?: string[]) =>
      ({ user, permissions: billing ? { permissions: { billing } } : undefined }) as never;
    expect(await ctrl.getStatus(WS, req({ sub: "u" }, ["view"]))).toEqual({ can: true });
    expect(await ctrl.getStatus(WS, req({ sub: "u" }, []))).toEqual({ can: false });
    expect(await ctrl.getStatus(WS, req({ sub: "u", isSuperAdmin: true }))).toEqual({ can: true });
    expect(await ctrl.getStatus(WS, req({ sub: "u", impersonating: true }, ["view"]))).toEqual({ can: false });
  });
});
