import { HttpException, Logger } from "@nestjs/common";
import { ZernioBudget } from "../../campaigns/sending/zernio-budget";
import { NotificationsService } from "../../notifications/notifications.service";
import { PermissionService } from "../../permissions/permission.service";
import { makeFakePrisma } from "../test-prisma";
import { MetaGraphClient } from "../whatsapp/meta-graph.client";
import { fakeGraph, isolateEnv } from "../whatsapp/test-graph";
import { ChannelHealthScheduler } from "./channel-health.scheduler";
import { ChannelHealthService } from "./channel-health.service";
import { alertLevel, evaluateAlerts, UNLIMITED_LEVEL } from "./health-alerts";
import { mergeHealth, type ChannelHealth, type FieldName, type HealthAlerts, type RawField, type RawHealthRead } from "./health-model";
import { HealthNotifier } from "./health-notifier";
import { toChannelDto } from "../channel-dto";
import { campaignSenderOptions } from "../default-channel";

const T0 = new Date("2026-11-09T00:00:00.000Z");
const at = (i: number) => new Date(T0.getTime() + i * 3_600_000);

type State = Partial<Record<FieldName, string | null>> & { templatesBad?: number | null };

/** A health snapshot with the given values (null = a failed read). */
function health(state: State, i: number): ChannelHealth {
  const fields: RawHealthRead["fields"] = {};
  const values: Record<string, string> = {
    quality: "GREEN",
    tier: "TIER_10K",
    nameStatus: "APPROVED",
    messaging: "AVAILABLE",
    phoneStatus: "CONNECTED",
    accountReview: "APPROVED",
    verified: "VERIFIED",
    codeVerification: "VERIFIED",
  };
  for (const [k, v] of Object.entries(values)) {
    const s = k in state ? state[k as FieldName] : v;
    fields[k as FieldName] = (s === null ? { error: "check_failed" } : { value: s }) as RawField;
  }
  const bad = state.templatesBad;
  const templates: RawHealthRead["templates"] =
    bad === null
      ? { error: "check_failed" }
      : {
          items: Array.from({ length: bad ?? 0 }, (_, n) => ({ id: `t${n}`, name: `t${n}`, language: "en", status: "PAUSED", category: null })),
          truncated: false,
        };
  return mergeHealth(null, { provider: "meta", fields, templates }, { now: at(i), trigger: "sweep" });
}

describe("evaluateAlerts table", () => {
  // Each step: the state read, then the changes expected (signal:to).
  const steps: Array<[string, State, string[]]> = [
    ["baseline is silent (even when bad)", { quality: "GREEN", tier: "TIER_10K", templatesBad: 0 }, []],
    ["GREEN→YELLOW is one change", { quality: "YELLOW" }, ["quality:YELLOW"]],
    ["YELLOW→YELLOW none", { quality: "YELLOW" }, []],
    ["YELLOW→RED one", { quality: "RED" }, ["quality:RED"]],
    ["RED→unknown none", { quality: null }, []],
    ["unknown→RED none (unknown did not re-arm)", { quality: "RED" }, []],
    ["RED→GREEN none, re-armed", { quality: "GREEN" }, []],
    ["GREEN→YELLOW one again", { quality: "YELLOW" }, ["quality:YELLOW"]],
    ["tier 10K→2K one", { quality: "YELLOW", tier: "TIER_2K" }, ["tier:TIER_2K"]],
    ["tier 2K→UNLIMITED none", { quality: "YELLOW", tier: "TIER_UNLIMITED" }, []],
    ["tier UNLIMITED→NOT_SET ignored", { quality: "YELLOW", tier: "TIER_NOT_SET" }, []],
    ["templatesBad 0→2 one", { quality: "YELLOW", tier: "TIER_UNLIMITED", templatesBad: 2 }, ["templatesBad:2"]],
    ["templatesBad 2→1 none", { quality: "YELLOW", tier: "TIER_UNLIMITED", templatesBad: 1 }, []],
    ["templatesBad 1→3 one", { quality: "YELLOW", tier: "TIER_UNLIMITED", templatesBad: 3 }, ["templatesBad:3"]],
    ["templates unknown none", { quality: "YELLOW", tier: "TIER_UNLIMITED", templatesBad: null }, []],
    [
      "several drops in one check list every one",
      { quality: "RED", messaging: "BLOCKED", phoneStatus: "FLAGGED", nameStatus: "DECLINED", accountReview: "REJECTED", tier: "TIER_UNLIMITED", templatesBad: 3 },
      ["quality:RED", "messaging:BLOCKED", "phoneStatus:FLAGGED", "nameStatus:DECLINED", "accountReview:REJECTED"],
    ],
    [
      "phone FLAGGED→BANNED one",
      { quality: "RED", messaging: "BLOCKED", phoneStatus: "BANNED", nameStatus: "DECLINED", accountReview: "REJECTED", tier: "TIER_UNLIMITED", templatesBad: 3 },
      ["phoneStatus:BANNED"],
    ],
  ];

  it("walks the table in order", () => {
    let alerts: HealthAlerts | null = null;
    steps.forEach(([name, state, expected], i) => {
      const h = health(state, i);
      const before: HealthAlerts | null = alerts ? JSON.parse(JSON.stringify(alerts)) : null;
      const out = evaluateAlerts(alerts, h, at(i));
      expect({ name, changes: out.changes.map((c) => `${c.signal}:${c.to}`) }).toEqual({ name, changes: expected });
      if (name === "RED→unknown none") expect(out.alerts).toEqual(before); // alerts unchanged
      if (name.startsWith("RED→GREEN")) expect(out.alerts.levels.quality).toBe(0); // re-armed
      alerts = out.alerts;
    });
    expect(alerts!.baselineAt).toBe(at(0).toISOString());
  });

  it("baseline sets levels silently even for a bad first state", () => {
    const out = evaluateAlerts(null, health({ quality: "RED", messaging: "BLOCKED", tier: "TIER_250", templatesBad: 4 }, 0), T0);
    expect(out.changes).toEqual([]);
    expect(out.alerts.levels).toMatchObject({ quality: 2, messaging: 2, tier: 250, templatesBad: 4 });
    expect(out.alerts.baselineAt).toBe(T0.toISOString());
  });

  it("a change carries the previous level and the new value", () => {
    const base = evaluateAlerts(null, health({}, 0), T0).alerts;
    const out = evaluateAlerts(base, health({ tier: "TIER_2K" }, 1), at(1));
    expect(out.changes).toEqual([{ signal: "tier", from: 10_000, to: "TIER_2K" }]);
    const up = evaluateAlerts(base, health({ tier: "TIER_UNLIMITED" }, 1), at(1)).alerts;
    expect(up.levels.tier).toBe(UNLIMITED_LEVEL);
    expect(JSON.parse(JSON.stringify(up)).levels.tier).toBe(UNLIMITED_LEVEL); // JSON-safe
    expect(evaluateAlerts(up, health({ tier: "TIER_100K" }, 2), at(2)).changes).toEqual([
      { signal: "tier", from: UNLIMITED_LEVEL, to: "TIER_100K" },
    ]);
  });

  it("alert levels per signal", () => {
    expect(alertLevel("quality", "GREEN")).toBe(0);
    expect(alertLevel("quality", "YELLOW")).toBe(1);
    expect(alertLevel("quality", "RED")).toBe(2);
    expect(alertLevel("quality", "unknown")).toBeNull();
    expect(alertLevel("messaging", "LIMITED")).toBe(1);
    expect(alertLevel("phoneStatus", "RATE_LIMITED")).toBe(1);
    expect(alertLevel("phoneStatus", "MESSAGING_LIMIT_REACHED")).toBe(1);
    expect(alertLevel("phoneStatus", "RESTRICTED")).toBe(2);
    // Final review M4: a deleted number is critical, as the UI shows it.
    expect(alertLevel("phoneStatus", "DELETED")).toBe(2);
    expect(alertLevel("phoneStatus", "PENDING")).toBe(0);
    expect(alertLevel("nameStatus", "EXPIRED")).toBe(2);
    expect(alertLevel("nameStatus", "PENDING_REVIEW")).toBe(0);
    expect(alertLevel("accountReview", "REJECTED")).toBe(2);
    expect(alertLevel("accountReview", "PENDING")).toBe(0);
    expect(alertLevel("tier", "TIER_NOT_SET")).toBeNull();
    expect(alertLevel("tier", "TIER_1K")).toBe(1000);
    expect(alertLevel("templatesBad", 0)).toBe(0);
    expect(alertLevel("templatesBad", null)).toBeNull();
  });
});

// ─── SP-14 Task 2: downgrade notifications through the service and the sweep ─

const DAY = 24 * 3_600_000;

/** A workspace with six members, a scripted Zernio and the real notifier. */
function alertWorld() {
  const prisma = makeFakePrisma({
    workspace: [{ id: "wsA", plan: "pro", zernioProfileId: "prof" }],
    role: [
      { id: "r_lead", workspaceId: "wsA", key: null, name: "Channel lead", nameAr: "Channel lead", isSystem: false, permissions: { channels: ["view", "update"] }, conversationVisibility: "all" },
    ],
    workspaceMember: [
      { id: "m1", workspaceId: "wsA", userId: "u_owner", role: "owner", roleId: null },
      { id: "m2", workspaceId: "wsA", userId: "u_admin", role: "admin", roleId: null },
      { id: "m3", workspaceId: "wsA", userId: "u_agent", role: "agent", roleId: null },
      { id: "m4", workspaceId: "wsA", userId: "u_viewer", role: "viewer", roleId: null },
      { id: "m5", workspaceId: "wsA", userId: "u_lead", role: "agent", roleId: "r_lead" },
      // An admin who turned this notification type off in-app (SP-05 preference).
      { id: "m6", workspaceId: "wsA", userId: "u_quiet", role: "admin", roleId: null },
    ],
    notificationPreference: [{ id: "p1", workspaceId: "wsA", userId: "u_quiet", type: "connector_needs_attention", inApp: false, sound: true }],
  } as never);
  const script = { quality: "GREEN", tier: "TIER_1K", fail: false };
  const zernio = {
    whatsappNumberInfo: jest.fn(async (_acc: string): Promise<unknown> => {
      if (script.fail) throw new HttpException("Bad gateway", 502);
      return {
        phone: {
          quality_rating: script.quality,
          messaging_limit_tier: script.tier,
          name_status: "APPROVED",
          status: "CONNECTED",
          health_status: { can_send_message: "AVAILABLE" },
        },
      };
    }),
    whatsappTemplates: jest.fn(async (_acc: string): Promise<unknown[]> => {
      if (script.fail) throw new HttpException("Bad gateway", 502);
      return [];
    }),
  };
  const budget = new ZernioBudget({ ZERNIO_CAMPAIGN_RPM: "100000", ZERNIO_HEALTH_RPM: "100000" }, { now: () => 0, sleep: async () => undefined });
  const health = new ChannelHealthService(prisma, zernio as never, new MetaGraphClient(fakeGraph([]).fetch), budget);
  const realtime = { emitToUser: jest.fn(), emitToWorkspace: jest.fn() };
  const notifications = new NotificationsService(prisma, realtime as never);
  const notify = jest.spyOn(notifications, "notify");
  const notifier = new HealthNotifier(health, notifications, new PermissionService(prisma));
  notifier.onModuleInit();
  const scheduler = new ChannelHealthScheduler(prisma, health);
  return { prisma, zernio, script, health, notify, scheduler };
}

describe("SP-14 downgrade notifications", () => {
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

  it("quality drop emits one notification", async () => {
    const w = alertWorld();
    const ch = await w.prisma.channel.create({
      data: { workspaceId: "wsA", kind: "whatsapp", provider: "zernio", externalId: "accA", displayName: "Sales line", phoneNumber: "+962790000001", status: "active" },
    });
    // Sweeps are 25 h apart, so the manual check in between never leaves the number not due.
    let t = T0.getTime();
    const sweep = async (quality: string | null) => {
      w.script.fail = quality === null;
      if (quality) w.script.quality = quality;
      const r = await w.scheduler.sweep(new Date(t));
      t += DAY + 3_600_000;
      return r;
    };
    const rows = () => (w.prisma.db.notification as Array<{ userId: string }>).map((r) => r.userId).sort();

    // 1. GREEN: the silent baseline.
    expect(await sweep("GREEN")).toEqual({ checked: 1, skipped: 0, failed: 0 });
    expect(w.notify).not.toHaveBeenCalled();

    // 2–4. YELLOW on three sweeps: exactly one notification.
    await sweep("YELLOW");
    await sweep("YELLOW");
    await sweep("YELLOW");
    expect(w.notify).toHaveBeenCalledTimes(1);
    const [ws, userIds, n] = w.notify.mock.calls[0];
    expect(ws).toBe("wsA");
    // channels.update holders: owner, admins and the custom role; not the agent or viewer.
    expect([...userIds].sort()).toEqual(["u_admin", "u_lead", "u_owner", "u_quiet"]);
    expect(n).toMatchObject({ type: "connector_needs_attention", title: "channel.health_downgraded" });
    expect(n.recordKind).toBeUndefined();
    expect(JSON.parse(n.body as string)).toEqual({
      channelId: ch.id,
      name: "Sales line",
      phone: "+962790000001",
      changes: [{ signal: "quality", from: "GREEN", to: "YELLOW" }],
    });
    // SP-05 unchanged: the member with inApp=false gets no row.
    expect(rows()).toEqual(["u_admin", "u_lead", "u_owner"]);

    // 5. Zernio 502: every field unknown, nothing more.
    await sweep(null);
    expect(w.notify).toHaveBeenCalledTimes(1);

    // A manual check in between follows the same rules: RED is one more.
    w.script.fail = false;
    w.script.quality = "RED";
    await w.health.check("wsA", ch.id, { now: new Date(t - DAY) });
    expect(w.notify).toHaveBeenCalledTimes(2);
    expect(JSON.parse(w.notify.mock.calls[1][2].body as string).changes).toEqual([{ signal: "quality", from: "YELLOW", to: "RED" }]);

    // 6. RED on the sweep: none. 7. GREEN: none (re-armed). 8. YELLOW: one more.
    await sweep("RED");
    expect(w.notify).toHaveBeenCalledTimes(2);
    await sweep("GREEN");
    expect(w.notify).toHaveBeenCalledTimes(2);
    await sweep("YELLOW");
    expect(w.notify).toHaveBeenCalledTimes(3);
    expect(JSON.parse(w.notify.mock.calls[2][2].body as string).changes).toEqual([{ signal: "quality", from: "GREEN", to: "YELLOW" }]);
    expect(rows()).toEqual(["u_admin", "u_admin", "u_admin", "u_lead", "u_lead", "u_lead", "u_owner", "u_owner", "u_owner"]);
  });

  it("concurrent checks notify once", async () => {
    const w = alertWorld();
    const ch = await w.prisma.channel.create({
      data: { workspaceId: "wsA", kind: "whatsapp", provider: "zernio", externalId: "accA", displayName: "Sales line", status: "active" },
    });
    await w.health.check("wsA", ch.id, { now: T0 }); // GREEN baseline
    w.script.quality = "YELLOW";

    // Check A claims first and stalls on its provider read; check B claims once
    // A's claim has aged past the cooldown, reads YELLOW and wins the write.
    // A then finishes with YELLOW too, but its fenced write loses.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const real = w.zernio.whatsappNumberInfo.getMockImplementation()!;
    w.zernio.whatsappNumberInfo.mockImplementationOnce(async (acc: string) => {
      await gate;
      return real(acc);
    });
    const a = w.health.check("wsA", ch.id, { now: new Date(T0.getTime() + 2 * 60_000) });
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    const b = await w.health.check("wsA", ch.id, { now: new Date(T0.getTime() + 4 * 60_000) });
    expect(b.health?.quality.value).toBe("YELLOW");
    release();
    await a;
    expect(w.notify).toHaveBeenCalledTimes(1);
  });
});

describe("SP-14 final review I1: health is tied to the account it read", () => {
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

  it("after a move the UI health is null and the next check is a silent baseline", async () => {
    const w = alertWorld();
    const ch = await w.prisma.channel.create({
      data: { workspaceId: "wsA", kind: "whatsapp", provider: "zernio", externalId: "accA", displayName: "Sales line", status: "active" },
    });
    // Number A: GREEN at TIER_10K, the baseline.
    w.script.tier = "TIER_10K";
    const a = await w.health.check("wsA", ch.id, { now: T0 });
    expect(a.health).toMatchObject({ accountId: "accA" });
    expect(a.health?.quality.value).toBe("GREEN");

    // The slot is re-pointed to account B by any path (here: no health clear at all).
    const row = w.prisma.db.channel.find((c: { id: string }) => c.id === ch.id);
    row.externalId = "accB";
    const moved = toChannelDto(row);
    expect(moved.health).toBeNull();
    expect(moved.healthCheckedAt).toBeNull();
    const senders = await campaignSenderOptions(w.prisma as never, "wsA");
    expect(senders.senders.find((s) => s.channelId === ch.id)).toMatchObject({ tier: "unknown", quality: "unknown", healthCheckedAt: null });
    expect((await w.health.templates("wsA", ch.id)).known).toBe(false);

    // B is really YELLOW at TIER_250: its first check is a silent baseline.
    w.script.quality = "YELLOW";
    w.script.tier = "TIER_250";
    const b = await w.health.check("wsA", ch.id, { now: new Date(T0.getTime() + DAY) });
    expect(b.health).toMatchObject({ accountId: "accB" });
    expect(b.health?.quality.value).toBe("YELLOW");
    expect(b.health?.lastKnown).toEqual({});
    expect(w.notify).not.toHaveBeenCalled();

    // B's own downgrade still notifies once (its baseline is B's levels).
    w.script.quality = "RED";
    await w.health.check("wsA", ch.id, { now: new Date(T0.getTime() + 2 * DAY) });
    expect(w.notify).toHaveBeenCalledTimes(1);
    expect(JSON.parse(w.notify.mock.calls[0][2].body as string).changes).toEqual([{ signal: "quality", from: "YELLOW", to: "RED" }]);
  });
});
