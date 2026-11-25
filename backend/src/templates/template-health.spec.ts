import { HttpException, Logger } from "@nestjs/common";
import { ZernioBudget } from "../campaigns/sending/zernio-budget";
import { ChannelHealthController } from "../channels/health/channel-health.controller";
import { ChannelHealthService } from "../channels/health/channel-health.service";
import { mergeHealth, type RawTemplate } from "../channels/health/health-model";
import { makeFakePrisma } from "../channels/test-prisma";
import { MetaGraphClient } from "../channels/whatsapp/meta-graph.client";
import { fakeGraph } from "../channels/whatsapp/test-graph";
import { TemplatesService } from "./templates.service";

const T0 = new Date("2026-11-10T08:00:00.000Z");

/** A stored health snapshot holding these templates (or an unknown template list). */
const snapshot = (items: RawTemplate[] | "failed", opts: { truncated?: boolean } = {}) => {
  const h = mergeHealth(
    null,
    {
      provider: "zernio",
      fields: { quality: { value: "GREEN" } },
      templates: items === "failed" ? { error: "check_failed" } : { items, truncated: !!opts.truncated },
    },
    { now: T0, trigger: "sweep" },
  );
  h.alerts = { baselineAt: T0.toISOString(), levels: {} };
  return JSON.parse(JSON.stringify(h));
};

const tpl = (name: string, language: string, status: string, extra: Partial<RawTemplate> = {}): RawTemplate => ({
  id: `m_${name}_${language}`,
  name,
  language,
  status,
  category: "MARKETING",
  ...extra,
});

function world() {
  // A stored snapshot is the one read from that row's own account (final review I1).
  const own = (row: Record<string, unknown>) =>
    row.health ? { ...row, health: { ...(row.health as object), provider: row.provider, accountId: row.externalId } } : row;
  const channel = (id: string, over: Record<string, unknown> = {}) => own({
    id,
    workspaceId: "wsA",
    kind: "whatsapp",
    provider: "zernio",
    externalId: `acc_${id}`,
    displayName: `Number ${id}`,
    phoneNumber: `+96279000000${id.length}`,
    status: "active",
    isDefault: false,
    health: null,
    healthCheckedAt: null,
    healthAttemptedAt: null,
    createdAt: new Date(`2026-01-0${1 + "ABCDEFGH".indexOf(id[0])}T00:00:00.000Z`),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...over,
  });
  const prisma = makeFakePrisma({
    channel: [
      channel("A", { isDefault: true, health: snapshot([tpl("promo", "en_US", "APPROVED", { qualityScore: "GREEN" }), tpl("other", "ar", "APPROVED")]), healthCheckedAt: T0 }),
      channel("B", { health: snapshot([tpl("promo", "en", "PAUSED", { qualityScore: "YELLOW" })]), healthCheckedAt: T0 }),
      channel("C", { health: snapshot([tpl("other", "en", "APPROVED")]), healthCheckedAt: T0 }),
      channel("D"), // never checked
      channel("E", { provider: "meta", externalId: "pn_E", health: snapshot("failed") }),
      channel("F", { health: snapshot([tpl("x", "en", "APPROVED")], { truncated: true }) }),
      channel("G", { status: "disconnected", health: snapshot([tpl("promo", "en", "APPROVED")]) }),
      channel("H", { kind: "telegram", provider: "telegram", externalId: "tg" }),
      channel("Z", { workspaceId: "wsB", health: snapshot([tpl("promo", "en", "DISABLED")]) }),
    ],
    template: [
      { id: "tpl_promo", workspaceId: "wsA", name: "promo", lang: "en", category: "MARKETING", status: "approved", quality: "GREEN", uses: 0, reviewedAt: T0 },
      { id: "tpl_b", workspaceId: "wsB", name: "promo", lang: "en", category: "MARKETING", status: "disabled", quality: null, uses: 0, reviewedAt: null },
    ],
  } as never);
  const zernio = { whatsappTemplates: jest.fn(), whatsappNumberInfo: jest.fn() };
  const graph = fakeGraph([]);
  const templates = new TemplatesService(prisma, zernio as never);
  const budget = new ZernioBudget({ ZERNIO_CAMPAIGN_RPM: "100000", ZERNIO_HEALTH_RPM: "100000" }, { now: () => 0, sleep: async () => undefined });
  const health = new ChannelHealthService(prisma, zernio as never, new MetaGraphClient(graph.fetch), budget);
  return { prisma, zernio, graph, templates, health, controller: new ChannelHealthController(health) };
}

async function rejection(p: Promise<unknown>) {
  const e = await p.then(
    () => {
      throw new Error("expected a rejection");
    },
    (x) => x,
  );
  expect(e).toBeInstanceOf(HttpException);
  return { status: (e as HttpException).getStatus(), body: (e as HttpException).getResponse() as Record<string, unknown> };
}

describe("SP-14 per-number templates", () => {
  beforeEach(() => {
    for (const m of ["log", "warn", "debug"] as const) jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it("template health lists the template on every number", async () => {
    const w = world();
    const res = await w.templates.healthFor("wsA", "tpl_promo");
    expect(res.template).toEqual({ id: "tpl_promo", name: "promo", lang: "en", status: "approved", quality: "GREEN", reviewedAt: T0.toISOString() });
    const by = Object.fromEntries(res.numbers.map((n) => [n.channelId, n]));
    // Default first, then by creation; disconnected and non-WhatsApp numbers excluded; never another workspace's.
    expect(res.numbers.map((n) => n.channelId)).toEqual(["A", "B", "C", "D", "E", "F"]);
    // Base-language match: the row is "en", A's copy is "en_US".
    expect(by.A).toEqual({ channelId: "A", displayName: "Number A", phoneNumber: "+962790000001", provider: "zernio", isDefault: true, status: "approved", quality: "GREEN", checkedAt: T0.toISOString() });
    expect(by.B).toMatchObject({ status: "paused", quality: "YELLOW", isDefault: false });
    // The snapshot is known and lacks it.
    expect(by.C).toMatchObject({ status: "missing", quality: "unknown", checkedAt: T0.toISOString() });
    // Never checked, or the template list failed: unknown, never "missing".
    expect(by.D).toMatchObject({ status: "unknown", quality: "unknown", checkedAt: null });
    expect(by.E).toMatchObject({ status: "unknown", quality: "unknown", provider: "meta" });
    // A truncated snapshot that lacks it cannot say "missing".
    expect(by.F).toMatchObject({ status: "unknown" });
    // No provider call.
    expect(w.zernio.whatsappTemplates).not.toHaveBeenCalled();
    expect(w.graph.calls).toHaveLength(0);
  });

  it("a different base language is not the same template", async () => {
    const w = world();
    w.prisma.db.template[0].lang = "ar";
    const res = await w.templates.healthFor("wsA", "tpl_promo");
    expect(res.numbers.find((n) => n.channelId === "A")?.status).toBe("missing");
  });

  it("per-number template list reads the snapshot without a provider call", async () => {
    const w = world();
    const b = await w.controller.templates("wsA", "B");
    expect(b).toEqual({
      channelId: "B",
      checkedAt: T0.toISOString(),
      error: null,
      truncated: false,
      known: true,
      items: [{ id: "m_promo_en", name: "promo", language: "en", status: "PAUSED", quality: "YELLOW", category: "MARKETING" }],
    });
    expect(await w.controller.templates("wsA", "D")).toEqual({ channelId: "D", checkedAt: null, error: null, truncated: false, known: false, items: [] });
    expect(await w.controller.templates("wsA", "E")).toMatchObject({ known: false, error: "check_failed", items: [] });
    expect(await w.controller.templates("wsA", "F")).toMatchObject({ known: true, truncated: true });
    expect(w.zernio.whatsappTemplates).not.toHaveBeenCalled();
    expect(w.zernio.whatsappNumberInfo).not.toHaveBeenCalled();
    expect(w.graph.calls).toHaveLength(0);
  });

  describe("foreign ids return 404 on SP-14 routes (part 2)", () => {
    it("GET /channels/:id/templates", async () => {
      const w = world();
      const r = await rejection(w.controller.templates("wsA", "Z"));
      expect(r).toEqual({ status: 404, body: { statusCode: 404, message: "channels.not_found" } });
      expect((await rejection(w.controller.templates("wsA", "nope"))).status).toBe(404);
    });

    it("GET /templates/:id/health", async () => {
      const w = world();
      const r = await rejection(w.templates.healthFor("wsA", "tpl_b"));
      expect(r).toEqual({ status: 404, body: { statusCode: 404, message: "templates.not_found" } });
      expect((await rejection(w.templates.healthFor("wsA", "nope"))).body.message).toBe("templates.not_found");
    });
  });
});
