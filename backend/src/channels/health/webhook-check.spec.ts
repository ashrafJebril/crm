import { HttpException, Logger } from "@nestjs/common";
import { ZernioBudget } from "../../campaigns/sending/zernio-budget";
import { makeFakePrisma } from "../test-prisma";
import { MetaGraphClient } from "../whatsapp/meta-graph.client";
import { fakeGraph, isolateEnv } from "../whatsapp/test-graph";
import { ChannelHealthService } from "./channel-health.service";
import { HEALTH_WEBHOOK_WS_PER_MIN } from "./health-config";

const T0 = new Date("2026-11-09T10:00:00.000Z");
const plus = (ms: number) => new Date(T0.getTime() + ms);

const INFO = {
  phone: { quality_rating: "GREEN", messaging_limit_tier: "TIER_1K", name_status: "APPROVED", status: "CONNECTED", health_status: { can_send_message: "AVAILABLE" } },
};

function world() {
  const prisma = makeFakePrisma();
  const zernio = {
    whatsappNumberInfo: jest.fn(async (_acc: string): Promise<unknown> => JSON.parse(JSON.stringify(INFO))),
    whatsappTemplates: jest.fn(async (_acc: string): Promise<unknown[]> => []),
  };
  const budget = new ZernioBudget({ ZERNIO_CAMPAIGN_RPM: "100000", ZERNIO_HEALTH_RPM: "100000" }, { now: () => 0, sleep: async () => undefined });
  const svc = new ChannelHealthService(prisma, zernio as never, new MetaGraphClient(fakeGraph([]).fetch), budget);
  // Deferred re-checks are captured instead of using real timers.
  const timers: Array<{ ms: number; fn: () => void }> = [];
  svc.defer = (fn, ms) => void timers.push({ fn, ms });
  const add = (n: number) =>
    Promise.all(
      Array.from({ length: n }, (_, i) =>
        prisma.channel.create({ data: { workspaceId: "wsA", kind: "whatsapp", provider: "zernio", externalId: `acc${i}`, displayName: `N${i}`, status: "active" } }),
      ),
    );
  return { prisma, zernio, svc, timers, add };
}

describe("webhook-triggered health checks", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = isolateEnv();
    for (const k of ["HEALTH_CHECK_COOLDOWN_MS", "HEALTH_CHECK_WS_PER_MIN", "HEALTH_WEBHOOK_WS_PER_MIN"]) delete process.env[k];
    for (const m of ["log", "warn", "debug"] as const) jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined);
  });
  afterEach(() => {
    restore();
    jest.restoreAllMocks();
  });

  it("webhook checks have their own workspace limiter and never crowd out Check now (m1)", async () => {
    const w = world();
    const chans = await w.add(12);
    // Ten webhook checks in one minute (a WABA-wide fan-out)...
    for (const c of chans.slice(0, 10)) expect(await w.svc.checkFromWebhook("wsA", c.id, T0)).toBe(true);
    // ...leave every manual slot free.
    const dto = await w.svc.check("wsA", chans[10].id, { now: plus(1000) });
    expect(dto.health?.trigger).toBe("manual");
    expect(w.svc.webhookLimiter.perMinute).toBe(HEALTH_WEBHOOK_WS_PER_MIN);
    // And manual checks never take webhook slots either.
    for (let i = 0; i < 10; i++) w.svc.wsLimiter.take("wsA", T0.getTime());
    expect(await w.svc.checkFromWebhook("wsA", chans[11].id, plus(2000))).toBe(true);
  });

  it("the webhook limiter caps webhook checks per workspace (HEALTH_WEBHOOK_WS_PER_MIN)", async () => {
    process.env.HEALTH_WEBHOOK_WS_PER_MIN = "2";
    const w = world();
    const chans = await w.add(3);
    expect(await w.svc.checkFromWebhook("wsA", chans[0].id, T0)).toBe(true);
    expect(await w.svc.checkFromWebhook("wsA", chans[1].id, T0)).toBe(true);
    expect(await w.svc.checkFromWebhook("wsA", chans[2].id, T0)).toBe(false);
    // The refused one is re-checked once the slot frees up.
    expect(w.timers).toHaveLength(1);
    expect(w.timers[0].ms).toBe(60_000);
  });

  it("a webhook inside the cooldown schedules exactly one deferred re-check, coalescing further events (m2)", async () => {
    const w = world();
    const [c] = await w.add(1);
    expect(await w.svc.checkFromWebhook("wsA", c.id, T0)).toBe(true);
    expect(w.zernio.whatsappNumberInfo).toHaveBeenCalledTimes(1);

    // 30 s later, inside the 60 s cooldown: refused, one re-check at the cooldown's end.
    expect(await w.svc.checkFromWebhook("wsA", c.id, plus(30_000))).toBe(false);
    expect(w.timers).toHaveLength(1);
    expect(w.timers[0].ms).toBe(30_000);
    // More events while it is pending: coalesced, no extra timer, no provider call.
    expect(await w.svc.checkFromWebhook("wsA", c.id, plus(40_000))).toBe(false);
    expect(await w.svc.checkFromWebhook("wsA", c.id, plus(50_000))).toBe(false);
    expect(w.timers).toHaveLength(1);
    expect(w.svc.pendingRechecks()).toEqual([c.id]);
    expect(w.zernio.whatsappNumberInfo).toHaveBeenCalledTimes(1);

    // The timer fires: one webhook check runs, and nothing is pending any more.
    w.timers[0].fn();
    await w.svc.idleRechecks();
    expect(w.zernio.whatsappNumberInfo).toHaveBeenCalledTimes(2);
    expect(w.prisma.db.channel[0].health.trigger).toBe("webhook");
    expect(w.svc.pendingRechecks()).toEqual([]);
    expect(w.timers).toHaveLength(1);
  });

  it("deferrals are per channel, and a pending one is cleared on shutdown", async () => {
    const w = world();
    const [a, b] = await w.add(2);
    await w.svc.checkFromWebhook("wsA", a.id, T0);
    await w.svc.checkFromWebhook("wsA", b.id, T0);
    await w.svc.checkFromWebhook("wsA", a.id, plus(10_000));
    await w.svc.checkFromWebhook("wsA", b.id, plus(10_000));
    expect(w.timers).toHaveLength(2);
    expect(w.svc.pendingRechecks().sort()).toEqual([a.id, b.id].sort());
    w.svc.onModuleDestroy();
    expect(w.svc.pendingRechecks()).toEqual([]);
  });

  it("other refusals (unsupported, disconnected, unknown) are not re-scheduled", async () => {
    const w = world();
    const off = await w.prisma.channel.create({ data: { workspaceId: "wsA", kind: "whatsapp", provider: "zernio", externalId: "x", displayName: "Off", status: "disconnected" } });
    expect(await w.svc.checkFromWebhook("wsA", off.id, T0)).toBe(false);
    expect(await w.svc.checkFromWebhook("wsA", "nope", T0)).toBe(false);
    expect(w.timers).toHaveLength(0);
  });

  it("a manual check still refuses with 429 cooldown (unchanged)", async () => {
    const w = world();
    const [c] = await w.add(1);
    await w.svc.checkFromWebhook("wsA", c.id, T0);
    const e = await w.svc.check("wsA", c.id, { now: plus(1000) }).catch((x) => x);
    expect(e).toBeInstanceOf(HttpException);
    expect((e as HttpException).getStatus()).toBe(429);
    expect(w.timers).toHaveLength(0);
  });
});
