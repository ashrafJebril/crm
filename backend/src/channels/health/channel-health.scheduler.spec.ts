import { Logger } from "@nestjs/common";
import { ZernioBudget } from "../../campaigns/sending/zernio-budget";
import { TemplatesService } from "../../templates/templates.service";
import { makeFakePrisma } from "../test-prisma";
import { MetaGraphClient } from "../whatsapp/meta-graph.client";
import { fakeGraph, isolateEnv } from "../whatsapp/test-graph";
import { ChannelHealthScheduler } from "./channel-health.scheduler";
import { ChannelHealthService } from "./channel-health.service";
import { HEALTH_SWEEP_BATCH, HEALTH_SWEEP_INTERVAL_MS, HEALTH_SWEEP_MAX_MS } from "./health-config";

const T0 = new Date("2026-11-10T03:00:00.000Z");
const MIN = 60_000;

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
    whatsappNumberInfo: jest.fn(async (_acc: string): Promise<unknown> => JSON.parse(JSON.stringify(INFO))),
    whatsappTemplates: jest.fn(async (_acc: string): Promise<unknown[]> => []),
  };
  const budget = new ZernioBudget({ ZERNIO_CAMPAIGN_RPM: "100000", ZERNIO_HEALTH_RPM: "100000" }, { now: () => 0, sleep: async () => undefined });
  const health = new ChannelHealthService(prisma, zernio as never, new MetaGraphClient(fakeGraph([]).fetch), budget);
  const templates = new TemplatesService(prisma, zernio as never);
  const scheduler = new ChannelHealthScheduler(prisma, health, templates);
  let seq = 0;
  const add = (data: Record<string, unknown> = {}) => {
    seq++;
    const row = {
      id: `ch_${String(seq).padStart(3, "0")}`,
      workspaceId: "wsA",
      kind: "whatsapp",
      provider: "zernio",
      externalId: `acc_${seq}`,
      displayName: `Number ${seq}`,
      status: "active",
      isDefault: false,
      config: null,
      integrationId: null,
      health: null,
      healthCheckedAt: null,
      healthAttemptedAt: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      ...data,
    };
    prisma.db.channel.push(row);
    return row;
  };
  const attempted = () => prisma.db.channel.filter((c: { healthAttemptedAt: Date | null }) => c.healthAttemptedAt).map((c: { id: string }) => c.id);
  return { prisma, zernio, health, templates, scheduler, add, attempted };
}

describe("ChannelHealthScheduler", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = isolateEnv();
    for (const k of ["HEALTH_CHECK_COOLDOWN_MS", "HEALTH_CHECK_WS_PER_MIN", "HEALTH_SWEEP_BATCH", "HEALTH_SWEEP_INTERVAL_MS", "HEALTH_SWEEP_MAX_MS"]) delete process.env[k];
    for (const m of ["log", "warn", "debug", "error"] as const) jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined);
  });
  afterEach(() => {
    restore();
    jest.restoreAllMocks();
  });

  it("defaults: hourly batches of 50, a 24 h interval and a 10 minute budget", () => {
    expect(HEALTH_SWEEP_BATCH).toBe(50);
    expect(HEALTH_SWEEP_INTERVAL_MS).toBe(24 * 3_600_000);
    expect(HEALTH_SWEEP_MAX_MS).toBe(10 * MIN);
    const cron = Reflect.getMetadataKeys(ChannelHealthScheduler.prototype.sweep);
    expect(cron.length).toBeGreaterThan(0); // @Cron is attached to sweep
  });

  describe("sweep is bounded, idempotent and re-entrancy guarded", () => {
    it("120 due numbers: 50, then the next 50, then 20, then nothing", async () => {
      const w = world();
      for (let i = 0; i < 120; i++) w.add();
      const first = await w.scheduler.sweep(T0);
      expect(first).toEqual({ checked: 50, skipped: 0, failed: 0 });
      const batch1 = w.attempted();
      expect(batch1).toHaveLength(50);
      expect(batch1).toEqual(Array.from({ length: 50 }, (_, i) => `ch_${String(i + 1).padStart(3, "0")}`));

      const second = await w.scheduler.sweep(T0);
      expect(second).toEqual({ checked: 50, skipped: 0, failed: 0 });
      expect(w.attempted()).toHaveLength(100);
      expect(w.zernio.whatsappNumberInfo).toHaveBeenCalledTimes(100); // nobody twice

      expect(await w.scheduler.sweep(T0)).toEqual({ checked: 20, skipped: 0, failed: 0 });
      // Idempotent: a further tick finds nothing due.
      expect(await w.scheduler.sweep(T0)).toEqual({ checked: 0, skipped: 0, failed: 0 });
      expect(w.zernio.whatsappNumberInfo).toHaveBeenCalledTimes(120);
    });

    it("HEALTH_SWEEP_BATCH overrides the batch", async () => {
      process.env.HEALTH_SWEEP_BATCH = "7";
      const w = world();
      for (let i = 0; i < 10; i++) w.add();
      expect((await w.scheduler.sweep(T0)).checked).toBe(7);
    });

    it("never-checked numbers go first, then the oldest attempt", async () => {
      const w = world();
      const old = w.add({ healthAttemptedAt: new Date(T0.getTime() - 3 * 24 * 3_600_000) });
      const older = w.add({ healthAttemptedAt: new Date(T0.getTime() - 5 * 24 * 3_600_000) });
      const never = w.add();
      await w.scheduler.sweep(T0);
      expect(w.zernio.whatsappNumberInfo.mock.calls.map((c) => c[0])).toEqual([never.externalId, older.externalId, old.externalId]);
    });

    it("a tick while one is running returns at once", async () => {
      const w = world();
      w.add();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      w.zernio.whatsappNumberInfo.mockImplementationOnce(async () => {
        await gate;
        return JSON.parse(JSON.stringify(INFO));
      });
      const running = w.scheduler.sweep(T0);
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
      expect(await w.scheduler.sweep(T0)).toEqual({ checked: 0, skipped: 0, failed: 0 });
      release();
      expect(await running).toEqual({ checked: 1, skipped: 0, failed: 0 });
      // The guard is released afterwards (a failed tick would release it too).
      expect(await w.scheduler.sweep(T0)).toEqual({ checked: 0, skipped: 0, failed: 0 });
    });

    it("HEALTH_SWEEP_MAX_MS stops the tick early; each number is claimed with its own time", async () => {
      const w = world();
      for (let i = 0; i < 6; i++) w.add();
      let clock = 1_000;
      w.scheduler.clock = () => clock;
      w.zernio.whatsappNumberInfo.mockImplementation(async () => {
        clock += 4 * MIN; // each check takes 4 minutes
        return JSON.parse(JSON.stringify(INFO));
      });
      // Starts at 0, 4 and 8 minutes; the fourth would start at 12 > 10.
      expect(await w.scheduler.sweep(T0)).toEqual({ checked: 3, skipped: 0, failed: 0 });
      const at = w.prisma.db.channel.slice(0, 3).map((c: { healthAttemptedAt: Date }) => c.healthAttemptedAt.getTime() - T0.getTime());
      expect(at).toEqual([0, 4 * MIN, 8 * MIN]);
      // checkedAt follows the claim of that number, not the tick's start.
      expect(w.prisma.db.channel[2].healthCheckedAt.getTime()).toBe(T0.getTime() + 8 * MIN);

      process.env.HEALTH_SWEEP_MAX_MS = String(30 * MIN);
      expect((await w.scheduler.sweep(T0)).checked).toBe(3);
    });

    it("only connected Zernio / Meta WhatsApp numbers are selected", async () => {
      const w = world();
      const ok = [
        w.add(),
        w.add({ status: "needs_attention" }),
        w.add({ provider: "meta", externalId: "pn_1" }), // no credentials: still checked (Unknown with missing_credentials)
      ];
      w.add({ status: "disconnected" });
      w.add({ status: "pending" });
      w.add({ status: "error" });
      w.add({ kind: "telegram", provider: "telegram" });
      w.add({ kind: "webchat", provider: "webchat" });
      w.add({ provider: "twilio" });
      const res = await w.scheduler.sweep(T0);
      expect(res).toEqual({ checked: 3, skipped: 0, failed: 0 });
      expect(w.attempted().sort()).toEqual(ok.map((c) => c.id).sort());
    });

    it("a number checked manually 10 minutes ago is not due", async () => {
      const w = world();
      const recent = w.add();
      const due = w.add();
      await w.health.check("wsA", recent.id, { now: new Date(T0.getTime() - 10 * MIN) });
      w.zernio.whatsappNumberInfo.mockClear();
      expect(await w.scheduler.sweep(T0)).toEqual({ checked: 1, skipped: 0, failed: 0 });
      expect(w.zernio.whatsappNumberInfo.mock.calls.map((c) => c[0])).toEqual([due.externalId]);
    });

    it("a number claimed by another machine meanwhile is skipped", async () => {
      const w = world();
      const a = w.add();
      w.add();
      const real = w.health.claim.bind(w.health);
      jest.spyOn(w.health, "claim").mockImplementation(async (id, ws, now, minAge) => (id === a.id ? null : real(id, ws, now, minAge)));
      expect(await w.scheduler.sweep(T0)).toEqual({ checked: 1, skipped: 1, failed: 0 });
    });

    it("one row throwing does not stop the rest", async () => {
      const w = world();
      w.add();
      const bad = w.add();
      w.add();
      const real = w.health.checkClaimed.bind(w.health);
      jest.spyOn(w.health, "checkClaimed").mockImplementation(async (row, token, trigger, now, opts) => {
        if (row.id === bad.id) throw new Error("boom");
        return real(row, token, trigger, now, opts);
      });
      expect(await w.scheduler.sweep(T0)).toEqual({ checked: 2, skipped: 0, failed: 1 });
    });

    it("the sweep's trigger is recorded on the health", async () => {
      const w = world();
      w.add();
      await w.scheduler.sweep(T0);
      expect(w.prisma.db.channel[0].health.trigger).toBe("sweep");
    });
  });

  it("sweep reconciles default-number templates without an extra call", async () => {
    const w = world();
    const def = w.add({ isDefault: true, externalId: "acc_def" });
    w.add({ externalId: "acc_other" });
    w.add({ workspaceId: "wsB", externalId: "acc_b", isDefault: true });
    w.prisma.db.template.push(
      { id: "tpl_promo", workspaceId: "wsA", name: "promo", lang: "en", category: "MARKETING", status: "approved", uses: 0, metaTemplateId: "m_promo", quality: null },
      { id: "tpl_b", workspaceId: "wsB", name: "promo", lang: "en", category: "MARKETING", status: "approved", uses: 0, metaTemplateId: "m_b", quality: null },
    );
    const list = (status: string, score?: string) => [
      { id: "m_promo", name: "promo", language: "en_US", status, category: "MARKETING", components: [{ type: "BODY", text: "Hi" }], ...(score ? { quality_score: { score } } : {}) },
    ];
    w.zernio.whatsappTemplates.mockImplementation(async (acc: string) => {
      if (acc === "acc_def") return list("PAUSED", "YELLOW");
      if (acc === "acc_other") return list("DISABLED", "RED"); // another number's copy never rewrites the rows
      return [{ ...list("APPROVED", "UNKNOWN")[0], id: "m_b" }];
    });

    const res = await w.scheduler.sweep(T0);
    expect(res.checked).toBe(3);
    // One template list per Zernio number checked: no extra call for the reconcile.
    expect(w.zernio.whatsappTemplates).toHaveBeenCalledTimes(3);
    expect(w.zernio.whatsappNumberInfo).toHaveBeenCalledTimes(3);
    const row = (id: string) => w.prisma.db.template.find((t: { id: string }) => t.id === id);
    expect(row("tpl_promo")).toMatchObject({ status: "paused", quality: "YELLOW", lang: "en_US" });
    // Workspace B's own default number: UNKNOWN quality is stored as NOT_RATED.
    expect(row("tpl_b")).toMatchObject({ status: "approved", quality: "NOT_RATED" });
    // The default number's snapshot holds the template too.
    expect(w.prisma.db.channel.find((c: { id: string }) => c.id === def.id).health.templates.value.paused).toBe(1);
  });

  it("a failed template read reconciles nothing", async () => {
    const w = world();
    w.add({ isDefault: true, externalId: "acc_def" });
    w.prisma.db.template.push({ id: "tpl_promo", workspaceId: "wsA", name: "promo", lang: "en", category: "MARKETING", status: "approved", uses: 0, metaTemplateId: "m_promo", quality: null });
    w.zernio.whatsappTemplates.mockRejectedValue(new Error("Zernio down"));
    await w.scheduler.sweep(T0);
    expect(w.prisma.db.template[0]).toMatchObject({ status: "approved", metaTemplateId: "m_promo" });
  });
});
