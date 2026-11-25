import { makeFakePrisma } from "../channels/test-prisma";
import { UsageService, localDay, usageKey } from "./usage.service";

const WS = "ws1";

function build() {
  const prisma = makeFakePrisma({ workspace: [{ id: WS, timezone: "Asia/Amman", plan: "free" }], usageEvent: [] });
  return { prisma, db: prisma.db as Record<string, any[]>, svc: new UsageService(prisma as never) };
}

describe("SP-28 usage metering", () => {
  it("usage recorded once per message", async () => {
    const { db, svc } = build();
    expect(await svc.record(WS, { meter: "ai_reply", sourceKind: "message", sourceId: "m1" })).toBe(true);
    expect(await svc.record(WS, { meter: "ai_reply", sourceKind: "message", sourceId: "m1" })).toBe(false);
    expect(await svc.recordMany(WS, "campaign_message", "campaign_recipient", ["r1", "r2", "r1"])).toBe(2);
    expect(await svc.recordMany(WS, "campaign_message", "campaign_recipient", ["r2", "r3"])).toBe(1);
    expect(db.usageEvent.map((e) => e.idempotencyKey).sort()).toEqual([
      usageKey("ai_reply", "message", "m1"),
      usageKey("campaign_message", "campaign_recipient", "r1"),
      usageKey("campaign_message", "campaign_recipient", "r2"),
      usageKey("campaign_message", "campaign_recipient", "r3"),
    ].sort());
    expect(db.usageEvent.every((e) => e.workspaceId === WS && e.qty === 1)).toBe(true);
  });

  it("a metering failure is logged, never thrown", async () => {
    const { prisma, svc } = build();
    (prisma as any).usageEvent.create = jest.fn(async () => {
      throw new Error("db down");
    });
    (prisma as any).usageEvent.createMany = jest.fn(async () => {
      throw new Error("db down");
    });
    await expect(svc.record(WS, { meter: "ai_reply", sourceKind: "message", sourceId: "m9" })).resolves.toBe(false);
    await expect(svc.recordMany(WS, "campaign_message", "campaign_recipient", ["r9"])).resolves.toBe(0);
  });

  it("summary totals per meter; allowances stay hidden until the user sets them", async () => {
    const { db, svc } = build();
    const at = (iso: string) => new Date(iso);
    db.usageEvent.push(
      { id: "e1", workspaceId: WS, meter: "ai_reply", qty: 1, at: at("2026-11-10T10:00:00Z"), idempotencyKey: "k1" },
      { id: "e2", workspaceId: WS, meter: "ai_reply", qty: 2, at: at("2026-11-11T10:00:00Z"), idempotencyKey: "k2" },
      { id: "e3", workspaceId: WS, meter: "campaign_message", qty: 1, at: at("2026-11-11T10:00:00Z"), idempotencyKey: "k3" },
      { id: "e4", workspaceId: "other", meter: "ai_reply", qty: 5, at: at("2026-11-11T10:00:00Z"), idempotencyKey: "k4" },
      { id: "e5", workspaceId: WS, meter: "ai_reply", qty: 7, at: at("2026-12-20T10:00:00Z"), idempotencyKey: "k5" },
    );
    const s = await svc.summary(WS, at("2026-11-01T00:00:00Z"), at("2026-12-01T00:00:00Z"), "free");
    expect(s.meters).toEqual([
      { meter: "ai_reply", used: 3, allowance: null },
      { meter: "campaign_message", used: 1, allowance: null },
      { meter: "ads_ai", used: 0, allowance: null },
    ]);
    await expect(svc.summary(WS, at("2026-01-01T00:00:00Z"), at("2026-12-01T00:00:00Z"), "free")).rejects.toMatchObject({
      response: { message: "billing.invalid_range" },
    });
  });

  it("usage summary buckets by workspace timezone", async () => {
    const { db, svc } = build();
    // 21:30Z on the 10th is 00:30 on the 11th in Amman (UTC+3).
    db.usageEvent.push(
      { id: "e1", workspaceId: WS, meter: "ai_reply", qty: 1, at: new Date("2026-11-10T20:30:00Z"), idempotencyKey: "a" },
      { id: "e2", workspaceId: WS, meter: "ai_reply", qty: 1, at: new Date("2026-11-10T21:30:00Z"), idempotencyKey: "b" },
      { id: "e3", workspaceId: WS, meter: "ai_reply", qty: 2, at: new Date("2026-11-11T08:00:00Z"), idempotencyKey: "c" },
    );
    const tz = await svc.timezoneOf(WS);
    expect(tz).toBe("Asia/Amman");
    const d = await svc.daily(WS, "ai_reply", new Date("2026-11-01T00:00:00Z"), new Date("2026-11-30T00:00:00Z"), tz);
    expect(d.days).toEqual([
      { day: "2026-11-10", qty: 1 },
      { day: "2026-11-11", qty: 3 },
    ]);
    expect(localDay(new Date("2026-11-10T21:30:00Z"), "UTC")).toBe("2026-11-10");
    await expect(svc.daily(WS, "bogus", new Date(), new Date(), tz)).rejects.toMatchObject({ response: { message: "billing.invalid_meter" } });
  });
});
