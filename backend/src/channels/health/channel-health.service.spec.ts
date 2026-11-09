import { HttpException, Logger } from "@nestjs/common";
import { HTTP_CODE_METADATA } from "@nestjs/common/constants";
import { ZernioBudget } from "../../campaigns/sending/zernio-budget";
import { ROUTE_PERMISSIONS, routesOf } from "../../permissions/permission-map";
import { makeFakePrisma } from "../test-prisma";
import { MetaGraphClient } from "../whatsapp/meta-graph.client";
import { fakeGraph, isolateEnv } from "../whatsapp/test-graph";
import { ChannelHealthController } from "./channel-health.controller";
import { ChannelHealthService, HealthCheckLimiter } from "./channel-health.service";

const T0 = new Date("2026-11-09T10:00:00.000Z");
const plus = (ms: number) => new Date(T0.getTime() + ms);

const INFO = {
  phone: {
    quality_rating: "GREEN",
    messaging_limit_tier: "TIER_1K",
    name_status: "APPROVED",
    status: "CONNECTED",
    health_status: { can_send_message: "AVAILABLE" },
  },
};

function world() {
  const prisma = makeFakePrisma();
  const zernio = {
    whatsappNumberInfo: jest.fn(async (_id: string) => JSON.parse(JSON.stringify(INFO))),
    whatsappTemplates: jest.fn(async (_id: string) => [] as unknown[]),
  };
  const graph = fakeGraph([]);
  const budget = new ZernioBudget({ ZERNIO_CAMPAIGN_RPM: "100000", ZERNIO_HEALTH_RPM: "100000" }, { now: () => 0, sleep: async () => undefined });
  const make = () => new ChannelHealthService(prisma, zernio as never, new MetaGraphClient(graph.fetch), budget);
  const add = async (data: Record<string, unknown>) =>
    prisma.channel.create({
      data: {
        workspaceId: "wsA",
        kind: "whatsapp",
        provider: "zernio",
        displayName: "Number",
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        ...data,
      },
    });
  return { prisma, zernio, graph, make, add, svc: make() };
}

async function rejection(p: Promise<unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const e = await p.then(
    () => {
      throw new Error("expected a rejection");
    },
    (x) => x,
  );
  expect(e).toBeInstanceOf(HttpException);
  return { status: (e as HttpException).getStatus(), body: (e as HttpException).getResponse() as Record<string, unknown> };
}

describe("ChannelHealthService", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = isolateEnv();
    delete process.env.HEALTH_CHECK_COOLDOWN_MS;
    delete process.env.HEALTH_CHECK_WS_PER_MIN;
    for (const m of ["log", "warn"] as const) jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined);
  });
  afterEach(() => {
    restore();
    jest.restoreAllMocks();
  });

  it("a check reads the provider, writes the health and returns the DTO", async () => {
    const w = world();
    const ch = await w.add({ externalId: "accA" });
    const dto = await w.svc.check("wsA", ch.id, { now: T0 });
    expect(w.zernio.whatsappNumberInfo).toHaveBeenCalledWith("accA");
    expect(dto.health?.quality.value).toBe("GREEN");
    expect(dto.health?.trigger).toBe("manual");
    expect(dto.health).not.toHaveProperty("alerts");
    expect(dto.healthCheckedAt).toBe(T0.toISOString());
    expect(dto.healthNextCheckAt).toBe(plus(60_000).toISOString());
    const row = w.prisma.db.channel[0];
    expect(row.healthAttemptedAt).toEqual(T0);
    expect(row.health.alerts).toEqual({ baselineAt: T0.toISOString(), levels: expect.objectContaining({ quality: 0 }) });
  });

  describe("live check cooldown is per channel and survives restart", () => {
    it("second check within 60 s → 429 cooldown with no provider call; restart still refuses; other channel unaffected; after 60 s passes", async () => {
      const w = world();
      const a = await w.add({ externalId: "accA" });
      const b = await w.add({ externalId: "accB" });
      await w.svc.check("wsA", a.id, { now: T0 });
      expect(w.zernio.whatsappNumberInfo).toHaveBeenCalledTimes(1);

      const r = await rejection(w.svc.check("wsA", a.id, { now: plus(20_000) }));
      expect(r.status).toBe(429);
      expect(r.body).toEqual({ statusCode: 429, message: "channels.health_check_cooldown", retryAfter: 40, nextAt: plus(60_000).toISOString() });
      expect(w.zernio.whatsappNumberInfo).toHaveBeenCalledTimes(1);

      // A new instance (a restart, or another machine) reads the cooldown from the DB.
      const restarted = w.make();
      const r2 = await rejection(restarted.check("wsA", a.id, { now: plus(59_999) }));
      expect(r2.body.message).toBe("channels.health_check_cooldown");
      expect(r2.body.retryAfter).toBe(1);
      expect(w.zernio.whatsappNumberInfo).toHaveBeenCalledTimes(1);

      await restarted.check("wsA", b.id, { now: plus(30_000) });
      expect(w.zernio.whatsappNumberInfo).toHaveBeenLastCalledWith("accB");

      const ok = await restarted.check("wsA", a.id, { now: plus(60_000) });
      expect(ok.healthCheckedAt).toBe(plus(60_000).toISOString());
      expect(w.zernio.whatsappNumberInfo).toHaveBeenCalledTimes(3);
    });

    it("HEALTH_CHECK_COOLDOWN_MS overrides the 60 s", async () => {
      process.env.HEALTH_CHECK_COOLDOWN_MS = "5000";
      const w = world();
      const a = await w.add({ externalId: "accA" });
      await w.svc.check("wsA", a.id, { now: T0 });
      await w.svc.check("wsA", a.id, { now: plus(5_000) });
      expect(w.zernio.whatsappNumberInfo).toHaveBeenCalledTimes(2);
    });
  });

  describe("workspace check cap", () => {
    it("the 11th check in a minute across different channels → 429 channels.health_check_busy", async () => {
      const w = world();
      const ids: string[] = [];
      for (let i = 0; i < 12; i++) ids.push((await w.add({ externalId: `acc${i}` })).id);
      for (let i = 0; i < 10; i++) await w.svc.check("wsA", ids[i], { now: plus(i * 1000) });
      const r = await rejection(w.svc.check("wsA", ids[10], { now: plus(10_000) }));
      expect(r.status).toBe(429);
      expect(r.body).toEqual({ statusCode: 429, message: "channels.health_check_busy", retryAfter: 50 });
      expect(w.zernio.whatsappNumberInfo).toHaveBeenCalledTimes(10);
      // Nothing was claimed for the refused one.
      expect(w.prisma.db.channel.find((c: { id: string }) => c.id === ids[10]).healthAttemptedAt).toBeNull();
      // Another workspace is unaffected; a minute later this one may check again.
      const other = await w.add({ workspaceId: "wsB", externalId: "accZ" });
      await w.svc.check("wsB", other.id, { now: plus(10_000) });
      await w.svc.check("wsA", ids[10], { now: plus(60_001) });
      expect(w.zernio.whatsappNumberInfo).toHaveBeenCalledTimes(12);
    });

    it("a cooldown refusal does not use up a workspace slot", () => {
      const l = new HealthCheckLimiter(2);
      expect(l.take("ws", 0).ok).toBe(true);
      expect(l.take("ws", 1).ok).toBe(true);
      expect(l.take("ws", 2)).toEqual({ ok: false, retryAfter: 60 });
      l.refund("ws", 1);
      expect(l.take("ws", 3).ok).toBe(true);
    });
  });

  describe("concurrent checks write once", () => {
    it("two claims race: the loser gets 429 and writes nothing", async () => {
      const w = world();
      const a = await w.add({ externalId: "accA" });
      const [x, y] = await Promise.allSettled([w.svc.check("wsA", a.id, { now: T0 }), w.make().check("wsA", a.id, { now: T0 })]);
      const statuses = [x, y].map((r) => (r.status === "fulfilled" ? 200 : (r.reason as HttpException).getStatus()));
      expect(statuses.sort()).toEqual([200, 429]);
      expect(w.zernio.whatsappNumberInfo).toHaveBeenCalledTimes(1);
      const writes = (w.prisma.$executeRaw as jest.Mock).mock.calls.filter((c) => c[0].join("?").includes('SET "health"'));
      expect(writes).toHaveLength(1);
    });

    it("a check whose claim was superseded mid-read writes nothing (fenced) and does not notify", async () => {
      const w = world();
      const a = await w.add({ externalId: "accA" });
      const onDowngrade = jest.fn();
      w.svc.onDowngrade = onDowngrade;
      w.zernio.whatsappNumberInfo.mockImplementationOnce(async () => {
        // Another machine claims after our claim went stale.
        w.prisma.db.channel[0].healthAttemptedAt = plus(120_000);
        return { phone: { ...INFO.phone, quality_rating: "RED" } };
      });
      const dto = await w.svc.check("wsA", a.id, { now: T0 });
      expect(w.prisma.db.channel[0].health).toBeNull();
      expect(w.prisma.db.channel[0].healthCheckedAt).toBeNull();
      expect(dto.health).toBeNull();

      // With a baseline stored, a superseded check that saw a drop neither writes nor notifies.
      await w.svc.check("wsA", a.id, { now: plus(180_000) }); // GREEN baseline
      const stored = JSON.stringify(w.prisma.db.channel[0].health);
      w.zernio.whatsappNumberInfo.mockImplementationOnce(async () => {
        w.prisma.db.channel[0].healthAttemptedAt = plus(400_000);
        return { phone: { ...INFO.phone, quality_rating: "RED" } };
      });
      await w.svc.check("wsA", a.id, { now: plus(240_000) });
      expect(JSON.stringify(w.prisma.db.channel[0].health)).toBe(stored);
      expect(onDowngrade).not.toHaveBeenCalled();
    });

    it("checkClaimed reports whether it wrote", async () => {
      const w = world();
      const a = await w.add({ externalId: "accA" });
      const token = await w.svc.claim(a.id, "wsA", T0, 24 * 3_600_000);
      expect(token).toEqual(T0);
      expect(await w.svc.claim(a.id, "wsA", plus(1), 24 * 3_600_000)).toBeNull();
      const res = await w.svc.checkClaimed(a, token!, "sweep");
      expect(res.written).toBe(true);
      expect(res.channel.health?.trigger).toBe("sweep");
      const stale = await w.svc.checkClaimed(a, plus(-1), "sweep");
      expect(stale.written).toBe(false);
    });
  });

  it("health writes do not touch updatedAt", async () => {
    const w = world();
    const a = await w.add({ externalId: "accA" });
    const before = new Date(w.prisma.db.channel[0].updatedAt);
    await w.svc.check("wsA", a.id, { now: T0 });
    await w.svc.check("wsA", a.id, { now: plus(60_000) });
    expect(w.prisma.db.channel[0].health).not.toBeNull();
    expect(w.prisma.db.channel[0].updatedAt).toEqual(before);
    // Only raw SQL wrote the row: no Prisma update/updateMany on Channel.
    expect(w.prisma.channel.update).not.toHaveBeenCalled();
    expect(w.prisma.channel.updateMany).not.toHaveBeenCalled();
    for (const c of (w.prisma.$executeRaw as jest.Mock).mock.calls) expect(c[0].join("?")).not.toContain("updatedAt");
  });

  it("downgrades reach the hook once, after the won write; the first check is a silent baseline", async () => {
    const w = world();
    const a = await w.add({ externalId: "accA" });
    const onDowngrade = jest.fn();
    w.svc.onDowngrade = onDowngrade;
    await w.svc.check("wsA", a.id, { now: T0 });
    expect(onDowngrade).not.toHaveBeenCalled();
    w.zernio.whatsappNumberInfo.mockImplementation(async () => ({ phone: { ...INFO.phone, quality_rating: "YELLOW" } }));
    await w.svc.check("wsA", a.id, { now: plus(60_000) });
    expect(onDowngrade).toHaveBeenCalledTimes(1);
    expect(onDowngrade.mock.calls[0][0].changes).toEqual([{ signal: "quality", from: 0, to: "YELLOW" }]);
    expect(w.prisma.db.channel[0].health.quality.value).toBe("YELLOW"); // written before the hook
    await w.svc.check("wsA", a.id, { now: plus(120_000) });
    expect(onDowngrade).toHaveBeenCalledTimes(1);
  });

  describe("check refuses non-whatsapp, unsupported provider and disconnected channels", () => {
    it.each([
      [{ kind: "telegram", provider: "telegram" }, "telegram"],
      [{ kind: "webchat", provider: "native" }, "native"],
      [{ kind: "whatsapp", provider: "kapso" }, "kapso"],
    ])("%j → 400 channels.health_unsupported", async (data, provider) => {
      const w = world();
      const c = await w.add(data);
      const r = await rejection(w.svc.check("wsA", c.id, { now: T0 }));
      expect(r).toEqual({ status: 400, body: { statusCode: 400, message: "channels.health_unsupported", provider } });
      expect(w.prisma.db.channel[0].healthAttemptedAt).toBeNull();
    });

    it("disconnected → 409 channels.disconnected", async () => {
      const w = world();
      const c = await w.add({ externalId: "accA", status: "disconnected" });
      const r = await rejection(w.svc.check("wsA", c.id, { now: T0 }));
      expect(r).toEqual({ status: 409, body: { statusCode: 409, message: "channels.disconnected", channelId: c.id } });
      expect(w.zernio.whatsappNumberInfo).not.toHaveBeenCalled();
    });
  });

  it("foreign ids return 404 on SP-14 routes (part 1): POST /channels/:id/health/check with workspace B's id from A", async () => {
    const w = world();
    const b = await w.add({ workspaceId: "wsB", externalId: "accB" });
    const ctrl = new ChannelHealthController(w.svc);
    const r = await rejection(ctrl.check("wsA", b.id));
    expect(r).toEqual({ status: 404, body: { statusCode: 404, message: "channels.not_found" } });
    expect(w.zernio.whatsappNumberInfo).not.toHaveBeenCalled();
    expect(w.prisma.db.channel[0].healthAttemptedAt).toBeNull();
    // The claim itself is workspace-scoped too.
    expect(await w.svc.claim(b.id, "wsA", T0, 0)).toBeNull();
    expect((await rejection(ctrl.check("wsA", "nope"))).status).toBe(404);
  });

  it("the controller route is POST /channels/:id/health/check, answers 200 and needs channels.update", () => {
    const keys = routesOf(ChannelHealthController).map((r) => r.key);
    expect(keys).toEqual(["POST /channels/:id/health/check"]);
    expect(ROUTE_PERMISSIONS["POST /channels/:id/health/check"]).toBe("channels.update");
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, ChannelHealthController.prototype.check)).toBe(200);
  });

  it("a Meta number reads Graph with its credentials and the WABA from the legacy Integration", async () => {
    const w = world();
    await w.prisma.integration.create({
      data: { id: "int1", workspaceId: "wsA", platform: "whatsapp", provider: "meta", pageId: "pn1", accessToken: "TOK-123456", raw: JSON.stringify({ wabaId: "waba9" }) },
    });
    const c = await w.add({ provider: "meta", externalId: "pn1", integrationId: "int1" });
    w.graph.prepend(
      [/message_templates/, { body: { data: [{ id: "t", name: "x", language: "en", status: "DISABLED" }] } }],
      [/\?fields=/, (url) => {
        const f = new URL(url).searchParams.get("fields")!;
        const v: Record<string, unknown> = {
          quality_rating: "GREEN",
          whatsapp_business_manager_messaging_limit: "TIER_2K",
          name_status: "APPROVED",
          code_verification_status: "VERIFIED",
          health_status: { can_send_message: "AVAILABLE" },
          status: "CONNECTED",
          business_verification_status: "VERIFIED",
          account_review_status: "APPROVED",
        };
        return { body: { [f]: v[f] } };
      }],
    );
    const dto = await w.svc.check("wsA", c.id, { now: T0 });
    expect(w.graph.calls.some((x) => x.url.includes("/waba9/message_templates"))).toBe(true);
    expect(w.graph.calls.every((x) => x.headers.Authorization === "Bearer TOK-123456")).toBe(true);
    expect(dto.health?.provider).toBe("meta");
    expect(dto.health?.templates.value).toMatchObject({ disabled: 1, rejected: 0 });
    expect(dto.health?.issues).toEqual(["templates_disabled"]);
    expect(dto.health?.overall).toBe("attention");
    expect(JSON.stringify(w.prisma.db.channel[0].health)).not.toContain("TOK-123456");
  });

  it("a provider failure never 5xx's: failing fields are unknown with check_failed", async () => {
    const w = world();
    const a = await w.add({ externalId: "accA" });
    await w.svc.check("wsA", a.id, { now: T0 });
    w.zernio.whatsappNumberInfo.mockRejectedValue(new HttpException("upstream", 502));
    const dto = await w.svc.check("wsA", a.id, { now: plus(60_000) });
    expect(dto.health?.quality).toEqual({ value: "unknown", checkedAt: plus(60_000).toISOString(), error: "check_failed" });
    expect(dto.health?.lastKnown.quality).toEqual({ value: "GREEN", checkedAt: T0.toISOString() });
  });
});
