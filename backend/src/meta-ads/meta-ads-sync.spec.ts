import { Logger } from "@nestjs/common";
import { ADS_TOKEN, fakeGraph, graphError, insightRow, isolateEnv, marketingHandlers, META_ADS_ENV, type GraphReply } from "../channels/whatsapp/test-graph";
import { encryptSecret } from "../common/token-crypto";
import { AdReferralService } from "../ad-attribution/ad-referral.service";
import { parseMetaReferral } from "../ad-attribution/referral";
import { resumeWindows, syncSpan, syncWindows } from "./meta-ads-sync";
import { resetMetaAdsTokenWarning } from "./meta-ads-token";
import { ENC_KEY, seedActive, T0, world } from "./test-meta-ads";

const HOUR = 3_600_000;
const later = (ms: number) => new Date(T0.getTime() + ms);

/** Insights replies scripted per call (call index from 0); the default is an empty page. */
function scriptedInsights(script: (n: number, url: string) => GraphReply | undefined) {
  let n = 0;
  const g = fakeGraph([
    [/\/act_\d+\/insights/, (url) => script(n++, url) ?? { body: { data: [] } }],
    ...marketingHandlers(),
  ]);
  return { g, count: () => n };
}

describe("Meta Ads spend sync", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = isolateEnv({ ...META_ADS_ENV, TOKEN_ENC_KEY: ENC_KEY });
    resetMetaAdsTokenWarning();
    for (const m of ["log", "warn", "error", "debug"] as const) jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined);
  });
  afterEach(() => {
    restore();
    jest.restoreAllMocks();
  });

  it("windows: 13 seven-day windows over 90 account-local days, then the last 3 days", () => {
    const first = syncWindows({ spendBackfilledAt: null, timezone: "Asia/Riyadh" }, new Date("2026-11-09T22:30:00.000Z"));
    expect(first).toHaveLength(13);
    // 22:30Z is already 11-10 in Riyadh.
    expect(first[0]).toEqual({ since: "2026-11-04", until: "2026-11-10" });
    expect(first[12]).toEqual({ since: "2026-08-13", until: "2026-08-18" });
    const days = first.reduce((s, w) => s + (Date.parse(w.until) - Date.parse(w.since)) / 86_400_000 + 1, 0);
    expect(days).toBe(90);
    expect(syncWindows({ spendBackfilledAt: T0, timezone: "UTC" }, new Date("2026-11-09T22:30:00.000Z"))).toEqual([
      { since: "2026-11-07", until: "2026-11-09" },
    ]);
  });

  it("windows after the backfill start at the last successful sync, capped at 90 days", () => {
    const now = new Date("2026-11-20T09:00:00.000Z");
    const base = { spendBackfilledAt: T0, timezone: "UTC" };
    // Synced an hour ago: the last 3 days only.
    expect(syncWindows({ ...base, lastSyncedAt: new Date(now.getTime() - HOUR) }, now)).toEqual([{ since: "2026-11-18", until: "2026-11-20" }]);
    // Last synced 11-10: 11-08 (3-day overlap) through 11-20, in 7-day windows.
    expect(syncWindows({ ...base, lastSyncedAt: T0 }, now)).toEqual([
      { since: "2026-11-14", until: "2026-11-20" },
      { since: "2026-11-08", until: "2026-11-13" },
    ]);
    // A gap older than 90 days reads the last 90 only, and says so.
    const old = { ...base, lastSyncedAt: new Date("2026-05-01T00:00:00.000Z") };
    const capped = syncWindows(old, now);
    expect(capped).toHaveLength(13);
    expect(capped[12].since).toBe("2026-08-23");
    expect(syncSpan(old, now).gapCapped).toBe(true);
    expect(syncSpan({ ...base, lastSyncedAt: T0 }, now).gapCapped).toBe(false);
    // Resume cuts a straddling window instead of skipping it.
    expect(resumeWindows([{ since: "2026-11-14", until: "2026-11-20" }, { since: "2026-11-08", until: "2026-11-13" }], "2026-11-10")).toEqual([
      { since: "2026-11-08", until: "2026-11-09" },
    ]);
  });

  it("sync re-reads the days missed while parked: a 10-day outage then a same-account reconnect fills all 10 days", async () => {
    const ranges: Array<{ since: string; until: string }> = [];
    const { g } = scriptedInsights((_n, url) => {
      const r = JSON.parse(new URL(url).searchParams.get("time_range")!) as { since: string; until: string };
      ranges.push(r);
      return { body: { data: [insightRow("6001", r.until, "1.00"), insightRow("6001", r.since, "1.00")] } };
    });
    const w = world({ graph: g });
    // Backfilled and last synced at T0 (11-10 in Riyadh), then parked.
    seedActive(w, { spendBackfilledAt: T0, lastSyncedAt: T0, status: "needs_reconnect", statusReason: "token_refused" });
    const outageEnd = later(10 * 24 * HOUR); // 11-20
    await w.scheduler.sweep(later(5 * 24 * HOUR));
    expect(ranges).toHaveLength(0);

    // Reconnect the same ad account: lastSyncedAt and spendBackfilledAt are kept.
    await w.svc.callback({ code: "CODE-9", state: w.stateOf(w.svc.start("wsA", "u_owner").url) });
    await w.svc.save("wsA", "u_owner", { adAccountId: "act_111" });
    expect(w.conn()).toMatchObject({ status: "active", lastSyncedAt: T0, spendBackfilledAt: T0 });

    await w.scheduler.sweep(outageEnd);
    // Newest first, 7-day windows, from 11-08 (the 3-day overlap) through 11-20.
    expect(ranges).toEqual([
      { since: "2026-11-14", until: "2026-11-20" },
      { since: "2026-11-08", until: "2026-11-13" },
    ]);
    const read = new Set<string>();
    for (const r of ranges) for (let d = r.since; d <= r.until; d = new Date(Date.parse(d) + 86_400_000).toISOString().slice(0, 10)) read.add(d);
    for (let i = 11; i <= 20; i++) expect(read.has(`2026-11-${i}`)).toBe(true);
    expect(w.conn()).toMatchObject({ lastSyncedAt: outageEnd, lastSyncError: null, spendBackfilledAt: T0 });

    // Then back to the last 3 days.
    await w.scheduler.sweep(new Date(outageEnd.getTime() + HOUR));
    expect(ranges.slice(2)).toEqual([{ since: "2026-11-18", until: "2026-11-20" }]);
  });

  it("a gap fill stopped by a rate limit resumes at the unread window, and a gap over 90 days restarts the covered span", async () => {
    const ranges: string[] = [];
    let n = 0;
    const { g } = scriptedInsights((_i, url) => {
      const r = JSON.parse(new URL(url).searchParams.get("time_range")!) as { since: string; until: string };
      ranges.push(r.since);
      if (n++ === 1) return graphError(17, "User request limit reached");
      return { body: { data: [insightRow("6001", r.since, "1.00")] } };
    });
    const w = world({ graph: g });
    seedActive(w, { spendBackfilledAt: T0, lastSyncedAt: T0 });
    const at = later(10 * 24 * HOUR);
    await w.scheduler.sweep(at);
    expect(ranges).toEqual(["2026-11-14", "2026-11-08"]);
    expect(w.conn()).toMatchObject({ lastSyncError: "rate_limited", lastSyncedAt: T0 });
    await w.scheduler.sweep(new Date(at.getTime() + HOUR));
    // The newest window was written by the stopped run: only the older one is read.
    expect(ranges.slice(2)).toEqual(["2026-11-08"]);
    expect(w.conn()).toMatchObject({ lastSyncError: null, lastSyncedAt: new Date(at.getTime() + HOUR), spendBackfilledAt: T0 });

    const w2 = world();
    seedActive(w2, { spendBackfilledAt: new Date("2026-01-01T00:00:00.000Z"), lastSyncedAt: new Date("2026-05-01T00:00:00.000Z") });
    await w2.scheduler.sweep(T0);
    expect(w2.graph.called("/insights")).toHaveLength(13);
    expect(w2.conn()).toMatchObject({ lastSyncedAt: T0, spendBackfilledAt: T0 });
  });

  it("a failed batch rolls back only the rows this run created and restores the rows it refreshed", async () => {
    const days = ["2026-11-08", "2026-11-09", "2026-11-10"];
    const rows = Array.from({ length: 450 }, (_, i) => insightRow(String(7000 + (i % 150)), days[Math.floor(i / 150)], "1.25"));
    const w = world({ graph: fakeGraph([[/insights/, { body: { data: rows } }], ...marketingHandlers()]) });
    seedActive(w, { spendBackfilledAt: T0, lastSyncedAt: T0 });
    // A good row from an earlier sync on the newest day (in the first batch).
    const before = new Date(T0.getTime() - HOUR);
    w.prisma.db.adSource.push({ id: "ad_7000", workspaceId: "wsA", sourceType: "ad", sourceId: "7000", adAccountId: "act_111" });
    w.prisma.db.adSpendDaily.push({
      id: "kept",
      workspaceId: "wsA",
      adSourceId: "ad_7000",
      adAccountId: "act_111",
      date: new Date("2026-11-10T00:00:00.000Z"),
      spend: "9.5",
      currency: "USD",
      syncedAt: before,
    });
    const tx = w.prisma.$transaction as jest.Mock;
    const inner = tx.getMockImplementation()!;
    let arrays = 0;
    tx.mockImplementation(async (arg: unknown) => {
      if (Array.isArray(arg) && ++arrays === 2) throw new Error("connection reset");
      return inner(arg);
    });
    await w.scheduler.sweep(later(HOUR));
    expect(w.conn()).toMatchObject({ lastSyncError: "sync_failed", lastSyncedAt: T0 });
    // Batch 1 (200 rows, the kept one among them) was undone: no new row is left, the old one is back.
    expect(w.prisma.db.adSpendDaily).toHaveLength(1);
    expect(w.prisma.db.adSpendDaily[0]).toMatchObject({ id: "kept", spend: "9.5", syncedAt: before, currency: "USD" });
  });

  describe("sync is bounded, idempotent and re-entrancy guarded", () => {
    const seedMany = (w: ReturnType<typeof world>, n: number) => {
      for (let i = 0; i < n; i++) {
        const ws = `ws_${String(i).padStart(2, "0")}`;
        seedActive(w, { id: `mac_${String(i).padStart(2, "0")}`, workspaceId: ws, spendBackfilledAt: T0 });
      }
    };

    it("30 due connections with batch 20 → 20, then the other 10, then none", async () => {
      const w = world();
      seedMany(w, 30);
      w.scheduler.clock = () => 0;
      expect(await w.scheduler.sweep(T0)).toEqual({ synced: 20, skipped: 0, failed: 0 });
      expect(await w.scheduler.sweep(T0)).toEqual({ synced: 10, skipped: 0, failed: 0 });
      expect(await w.scheduler.sweep(T0)).toEqual({ synced: 0, skipped: 0, failed: 0 });
      expect(w.graph.called("/insights")).toHaveLength(30);
      expect(w.prisma.db.metaAdsConnection.every((c: { lastSyncedAt: Date | null }) => c.lastSyncedAt)).toBe(true);
    });

    it("a tick while one runs returns {synced:0}", async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const g = fakeGraph(marketingHandlers());
      const inner = g.fetch.getMockImplementation()!;
      g.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
        await gate;
        return inner(url, init);
      });
      const w = world({ graph: g });
      seedActive(w, { spendBackfilledAt: T0 });
      // A second due connection the running tick has not claimed yet: only the
      // in-process flag keeps the overlapping tick away from it.
      seedActive(w, { id: "mac_2", workspaceId: "wsZ", spendBackfilledAt: T0 });
      const first = w.scheduler.sweep(T0);
      await new Promise((r) => setImmediate(r));
      expect(await w.scheduler.sweep(T0)).toEqual({ synced: 0, skipped: 0, failed: 0 });
      release();
      expect(await first).toEqual({ synced: 2, skipped: 0, failed: 0 });
    });

    it("META_ADS_SYNC_MAX_MS stops early", async () => {
      process.env.META_ADS_SYNC_MAX_MS = String(10 * 60_000);
      // Each Graph read takes 4 minutes of the tick's time.
      let t = 0;
      const { g } = scriptedInsights(() => {
        t += 4 * 60_000;
        return undefined;
      });
      const w = world({ graph: g });
      seedMany(w, 5);
      w.scheduler.clock = () => t;
      // Starts at 0, 4 and 8 minutes; at 12 minutes no new connection starts.
      expect(await w.scheduler.sweep(T0)).toEqual({ synced: 3, skipped: 0, failed: 0 });
      expect(g.called("/insights")).toHaveLength(3);
    });

    it("pending, needs_reconnect and disconnected are never selected", async () => {
      const w = world();
      seedActive(w, { id: "p", workspaceId: "w1", status: "pending", tokenEnc: null, pendingTokenEnc: encryptSecret(ADS_TOKEN) });
      seedActive(w, { id: "n", workspaceId: "w2", status: "needs_reconnect" });
      seedActive(w, { id: "d", workspaceId: "w3", status: "disconnected", tokenEnc: null });
      expect(await w.scheduler.sweep(T0)).toEqual({ synced: 0, skipped: 0, failed: 0 });
      expect(w.graph.calls).toHaveLength(0);
    });

    it("the first run reads 13 windows and sets spendBackfilledAt; the next reads 3 days; a re-read replaces a day", async () => {
      const { g } = scriptedInsights((_n, url) => {
        const since = JSON.parse(new URL(url).searchParams.get("time_range")!).since as string;
        if (since === "2026-11-04") return { body: { data: [insightRow("6001", "2026-11-09", "3.50", { ad_name: "Spring" })] } };
        if (since === "2026-11-08") return { body: { data: [insightRow("6001", "2026-11-09", "4.25", { ad_name: "Spring" })] } };
        return undefined;
      });
      const w = world({ graph: g });
      seedActive(w);
      await w.scheduler.sweep(T0);
      expect(g.called("/insights")).toHaveLength(13);
      expect(w.conn().spendBackfilledAt).toEqual(T0);
      expect(w.conn().lastSyncedAt).toEqual(T0);
      expect(w.prisma.db.adSpendDaily).toHaveLength(1);
      expect(String(w.prisma.db.adSpendDaily[0].spend)).toBe("3.5");

      await w.scheduler.sweep(later(HOUR));
      const recent = g.called("/insights").slice(13);
      expect(recent).toHaveLength(1);
      expect(JSON.parse(new URL(recent[0].url).searchParams.get("time_range")!)).toEqual({ since: "2026-11-08", until: "2026-11-10" });
      expect(w.prisma.db.adSpendDaily).toHaveLength(1);
      expect(String(w.prisma.db.adSpendDaily[0].spend)).toBe("4.25");
      expect(w.prisma.db.adSpendDaily[0]).toMatchObject({ workspaceId: "wsA", adAccountId: "act_111", currency: "USD", date: new Date("2026-11-09T00:00:00.000Z") });
    });

    it("a read capped by META_ADS_MAX_PAGES is partial and writes nothing for that window", async () => {
      process.env.META_ADS_MAX_PAGES = "2";
      const w = world({
        graph: fakeGraph([
          [/insights/, { body: { data: [insightRow("6001", "2026-11-09", "1.00")], paging: { cursors: { after: "NEXT" }, next: "https://x" } } }],
          ...marketingHandlers(),
        ]),
      });
      seedActive(w, { spendBackfilledAt: T0 });
      await w.scheduler.sweep(T0);
      expect(w.graph.called("/insights")).toHaveLength(2);
      expect(w.prisma.db.adSpendDaily).toHaveLength(0);
      // The skipped days were never read: no successful sync is recorded.
      expect(w.conn()).toMatchObject({ status: "active", lastSyncError: "partial", lastSyncedAt: null, spendBackfilledAt: T0 });
    });

    it("a backfill with a window over the page budget stays incomplete and Unknown; a later tick reads that window and completes", async () => {
      process.env.META_ADS_MAX_PAGES = "2";
      // Windows (Riyadh): 11-04..11-10, 10-28..11-03, 10-21..10-27, ... Every
      // window has spend on its first day; on the first tick the third window
      // always has another page (over the budget), on the next it fits.
      let tick = 1;
      const sinces: string[] = [];
      const { g } = scriptedInsights((_i, url) => {
        const { since } = JSON.parse(new URL(url).searchParams.get("time_range")!);
        sinces.push(since);
        const data = [insightRow("6001", since, "2.00")];
        if (tick === 1 && since === "2026-10-21") return { body: { data, paging: { cursors: { after: "NEXT" }, next: "https://x" } } };
        return { body: { data } };
      });
      const w = world({ graph: g });
      seedActive(w);
      const capped = { from: "2026-10-21", to: "2026-10-27" };

      await w.scheduler.sweep(T0);
      // The capped window wrote nothing, and nothing older was read past it.
      expect(sinces).toEqual(["2026-11-04", "2026-10-28", "2026-10-21", "2026-10-21"]);
      expect(w.prisma.db.adSpendDaily.some((r: { date: Date }) => r.date.toISOString() >= "2026-10-21" && r.date.toISOString() < "2026-10-28")).toBe(false);
      // Not backfilled, no successful sync: every figure is Unknown, never 0.
      expect(w.conn()).toMatchObject({ status: "active", lastSyncError: "partial", spendBackfilledAt: null, lastSyncedAt: null });
      const during = await w.metrics.overview("wsA", capped, T0);
      expect(during.range.spendCoverage).toBeNull();
      expect(during.daily.map((d) => d.spend)).toEqual([null, null, null, null, null, null, null]);
      expect(during.totals.byCurrency).toEqual([]);
      const ad = w.prisma.db.adSource.find((a: { sourceId: string }) => a.sourceId === "6001");
      expect((await w.metrics.detail("wsA", ad.id, capped, T0)).spend).toBeNull();
      expect((await w.metrics.detail("wsA", ad.id, { from: "2026-10-15", to: "2026-10-21" }, T0)).spend).toBeNull();

      // The next tick resumes at the capped window, reads it and the older ones, and completes.
      tick = 2;
      await w.scheduler.sweep(later(HOUR));
      const windows = syncWindows({ spendBackfilledAt: null, timezone: "Asia/Riyadh" }, T0).map((x) => x.since);
      expect(sinces.slice(4)).toEqual(windows.slice(2));
      expect(w.conn()).toMatchObject({ lastSyncError: null, spendBackfilledAt: later(HOUR), lastSyncedAt: later(HOUR) });
      expect(w.prisma.db.adSpendDaily).toHaveLength(13);
      const after = await w.metrics.overview("wsA", capped, later(HOUR));
      expect(after.range.spendCoverage).not.toBeNull();
      expect(after.daily.map((d) => d.spend)).toEqual([{ USD: 2 }, { USD: 0 }, { USD: 0 }, { USD: 0 }, { USD: 0 }, { USD: 0 }, { USD: 0 }]);
      expect((await w.metrics.detail("wsA", ad.id, capped, later(HOUR))).spend).toEqual({ amount: 2, currency: "USD" });
    });

    it("a gap fill with a window over the page budget keeps lastSyncedAt, stays Unknown past it, and the next tick fills it", async () => {
      process.env.META_ADS_MAX_PAGES = "2";
      let tick = 1;
      const sinces: string[] = [];
      const { g } = scriptedInsights((_i, url) => {
        const { since } = JSON.parse(new URL(url).searchParams.get("time_range")!);
        sinces.push(since);
        const data = [insightRow("6001", since, "1.00")];
        if (tick === 1 && since === "2026-11-12") return { body: { data, paging: { cursors: { after: "NEXT" }, next: "https://x" } } };
        return { body: { data } };
      });
      const w = world({ graph: g });
      // Backfilled and last synced at T0 (11-10 in Riyadh); the next sweep is 15 days later.
      seedActive(w, { spendBackfilledAt: T0, lastSyncedAt: T0 });
      const at = later(15 * 24 * HOUR); // 11-25
      await w.scheduler.sweep(at);
      // 11-19..11-25 is written, 11-12..11-18 is over the budget, 11-08..11-11 is not read.
      expect(sinces).toEqual(["2026-11-19", "2026-11-12", "2026-11-12"]);
      expect(w.conn()).toMatchObject({ status: "active", lastSyncError: "partial", spendBackfilledAt: T0, lastSyncedAt: T0 });
      const o = await w.metrics.overview("wsA", { from: "2026-11-12", to: "2026-11-18" }, at);
      expect(o.range.spendCoverage).toEqual({ from: "2026-08-13", to: "2026-11-10" });
      expect(o.daily.every((d) => d.spend === null)).toBe(true);
      expect(o.totals.byCurrency).toEqual([]);

      tick = 2;
      const next = new Date(at.getTime() + HOUR);
      await w.scheduler.sweep(next);
      // Resumes at the skipped window (the newest one was written by the stopped run).
      expect(sinces.slice(3)).toEqual(["2026-11-12", "2026-11-08"]);
      expect(w.conn()).toMatchObject({ lastSyncError: null, spendBackfilledAt: T0, lastSyncedAt: next });
      const filled = await w.metrics.overview("wsA", { from: "2026-11-12", to: "2026-11-18" }, next);
      expect(filled.daily.map((d) => d.spend)).toEqual([{ USD: 1 }, { USD: 0 }, { USD: 0 }, { USD: 0 }, { USD: 0 }, { USD: 0 }, { USD: 0 }]);
    });

    it("the backfill resumes across ticks without re-reading finished windows", async () => {
      // Every window has spend on its first day; Meta throttles the 5th and the 10th read.
      let n = 0;
      const sinces: string[] = [];
      const { g } = scriptedInsights((_i, url) => {
        const { since } = JSON.parse(new URL(url).searchParams.get("time_range")!);
        const call = n++;
        sinces.push(since);
        if (call === 4 || call === 9) return graphError(80004, "ad account throttled");
        return { body: { data: [insightRow("6001", since, "1.00")] } };
      });
      const w = world({ graph: g });
      seedActive(w);

      await w.scheduler.sweep(T0);
      expect(w.conn()).toMatchObject({ lastSyncError: "rate_limited", spendBackfilledAt: null });
      await w.scheduler.sweep(later(HOUR));
      expect(w.conn()).toMatchObject({ lastSyncError: "rate_limited", spendBackfilledAt: null });
      await w.scheduler.sweep(later(2 * HOUR));
      expect(w.conn()).toMatchObject({ lastSyncError: null, spendBackfilledAt: later(2 * HOUR), lastSyncedAt: later(2 * HOUR) });

      // 13 windows read to completion once each; only the two throttled reads repeat.
      const windows = syncWindows({ spendBackfilledAt: null, timezone: "Asia/Riyadh" }, T0).map((x) => x.since);
      const throttled = [sinces[4], sinces[9]];
      expect(sinces).toHaveLength(13 + 2);
      for (const since of windows) {
        expect({ since, reads: sinces.filter((x) => x === since).length }).toEqual({ since, reads: throttled.includes(since) ? 2 : 1 });
      }
      expect(w.prisma.db.adSpendDaily).toHaveLength(13);

      // Then the 3-day mode.
      await w.scheduler.sweep(later(3 * HOUR));
      expect(sinces).toHaveLength(16);
      expect(sinces[15]).toBe("2026-11-08");
    });

    it("the resume point counts only spend written since the connection was made", async () => {
      const w = world();
      seedActive(w, { connectedAt: T0 });
      // Spend from an earlier connection to the same account (older than this connect).
      w.prisma.db.adSource.push({ id: "ad_old", workspaceId: "wsA", sourceType: "ad", sourceId: "5000", adAccountId: "act_111" });
      w.prisma.db.adSpendDaily.push({
        id: "old",
        workspaceId: "wsA",
        adSourceId: "ad_old",
        adAccountId: "act_111",
        date: new Date("2026-08-14T00:00:00.000Z"),
        spend: "1",
        currency: "USD",
        syncedAt: new Date(T0.getTime() - 86_400_000),
      });
      await w.scheduler.sweep(T0);
      expect(w.graph.called("/insights")).toHaveLength(13);
    });

    it("the sync stops at the tick's deadline and the next tick resumes after the last finished window", async () => {
      process.env.META_ADS_SYNC_MAX_MS = String(10 * 60_000);
      let t = 0;
      const sinces: string[] = [];
      const { g } = scriptedInsights((_i, url) => {
        t += 4 * 60_000;
        const { since } = JSON.parse(new URL(url).searchParams.get("time_range")!);
        sinces.push(since);
        return { body: { data: [insightRow("6001", since, "1.00")] } };
      });
      const w = world({ graph: g });
      w.scheduler.clock = () => t;
      seedActive(w);
      await w.scheduler.sweep(T0);
      // Reads start at 0, 4 and 8 minutes; the 4th would start past the deadline.
      expect(sinces).toEqual(["2026-11-04", "2026-10-28", "2026-10-21"]);
      expect(w.conn()).toMatchObject({ status: "active", lastSyncError: "partial", spendBackfilledAt: null });
      await w.scheduler.sweep(later(HOUR));
      expect(sinces.slice(3)).toEqual(["2026-10-14", "2026-10-07", "2026-09-30"]);
    });

    it("spend upserts are written in batches", async () => {
      const days = ["2026-11-08", "2026-11-09", "2026-11-10"];
      const rows = Array.from({ length: 450 }, (_, i) => insightRow(String(7000 + (i % 150)), days[Math.floor(i / 150)], "1.25"));
      const w = world({ graph: fakeGraph([[/insights/, { body: { data: rows } }], ...marketingHandlers()]) });
      seedActive(w, { spendBackfilledAt: T0 });
      const tx = w.prisma.$transaction as jest.Mock;
      tx.mockClear();
      await w.scheduler.sweep(T0);
      expect(w.prisma.db.adSpendDaily).toHaveLength(450);
      const batches = tx.mock.calls.filter((c: unknown[]) => Array.isArray(c[0])).map((c: unknown[]) => (c[0] as unknown[]).length);
      expect(batches).toEqual([200, 200, 50]);
    });
  });

  it("sync stops on rate limit without retry", async () => {
    const { g, count } = scriptedInsights((n) =>
      n === 1 ? graphError(17, "User request limit reached") : n === 0 ? { body: { data: [insightRow("6001", "2026-11-04", "1.00")] } } : undefined,
    );
    const w = world({ graph: g });
    seedActive(w);
    await w.scheduler.sweep(T0);
    expect(count()).toBe(2);
    expect(w.conn()).toMatchObject({ status: "active", lastSyncError: "rate_limited", spendBackfilledAt: null });
    expect(w.notify).not.toHaveBeenCalled();
    // The next hourly tick resumes after the finished newest window (and completes the backfill).
    await w.scheduler.sweep(later(HOUR));
    expect(count()).toBe(2 + 12);
    expect(w.conn()).toMatchObject({ status: "active", lastSyncError: null, spendBackfilledAt: later(HOUR) });
  });

  it("other failures record sync_failed and stay active", async () => {
    const { g } = scriptedInsights(() => ({ status: 500, body: { error: { code: 1 } } }));
    const w = world({ graph: g });
    seedActive(w);
    await w.scheduler.sweep(T0);
    expect(g.called("/insights")).toHaveLength(1);
    expect(w.conn()).toMatchObject({ status: "active", lastSyncError: "sync_failed" });
  });

  it("token refusal notifies once", async () => {
    const { g, count } = scriptedInsights(() => graphError(190, "Error validating access token"));
    const w = world({ graph: g });
    seedActive(w);
    await w.scheduler.sweep(T0);
    expect(w.conn()).toMatchObject({ status: "needs_reconnect", statusReason: "token_refused" });
    expect(w.notify).toHaveBeenCalledTimes(1);
    const [ws, users, n] = w.notify.mock.calls[0];
    expect(ws).toBe("wsA");
    expect([...(users as string[])].sort()).toEqual(["u_admin", "u_lead", "u_owner"]);
    expect(n).toEqual({
      type: "connector_needs_attention",
      title: "meta_ads.needs_reconnect",
      body: JSON.stringify({ reason: "token_refused", adAccountName: "Main account" }),
    });
    expect(w.prisma.db.notification.map((r: { userId: string }) => r.userId).sort()).toEqual(["u_admin", "u_lead", "u_owner"]);

    // A second sweep selects nothing; a second 190 (from a check) finds it parked.
    await w.scheduler.sweep(later(2 * HOUR));
    expect(count()).toBe(1);
    w.graph.prepend(["/me?", graphError(190)]);
    expect((await w.svc.check("wsA", later(2 * HOUR))).status).toBe("needs_reconnect");
    expect(w.notify).toHaveBeenCalledTimes(1);

    // A reconnect (save) re-arms it.
    await w.svc.callback({ code: "CODE-9", state: w.stateOf(w.svc.start("wsA", "u_owner").url) });
    await w.svc.save("wsA", "u_owner", { adAccountId: "act_111" });
    expect(w.conn()).toMatchObject({ status: "active", statusReason: null });
    await w.scheduler.sweep(later(3 * HOUR));
    expect(w.conn().status).toBe("needs_reconnect");
    expect(w.notify).toHaveBeenCalledTimes(2);
  });

  it("account refusal parks the connection", async () => {
    const { g } = scriptedInsights(() => ({ status: 403, body: { error: { code: 200, message: "no access to act" } } }));
    const w = world({ graph: g });
    seedActive(w);
    await w.scheduler.sweep(T0);
    expect(w.conn()).toMatchObject({ status: "needs_reconnect", statusReason: "account_refused" });
    expect(w.notify).toHaveBeenCalledTimes(1);
    expect(JSON.parse(w.notify.mock.calls[0][2].body as string)).toEqual({ reason: "account_refused", adAccountName: "Main account" });

    const w10 = world({ graph: scriptedInsights(() => ({ status: 403, body: { error: { code: 10 } } })).g });
    seedActive(w10);
    await w10.scheduler.sweep(T0);
    expect(w10.conn()).toMatchObject({ status: "needs_reconnect", statusReason: "account_refused" });
    expect(w10.notify).toHaveBeenCalledTimes(1);
  });

  it("a refusal of an old token never parks a reconnected connection", async () => {
    const w = world();
    const row = { ...seedActive(w) };
    // A reconnect stored a new token after this sync read the row.
    w.conn().tokenEnc = encryptSecret("EAAB-new-token");
    const notifier = (w.scheduler as unknown as { notifier: { park: (c: unknown, r: string) => Promise<boolean> } }).notifier;
    expect(await notifier.park(row, "token_refused")).toBe(false);
    expect(w.conn().status).toBe("active");
    expect(w.notify).not.toHaveBeenCalled();
  });

  it("sync upserts ads it has never seen with names only", async () => {
    const { g } = scriptedInsights((n) =>
      n === 0
        ? { body: { data: [insightRow("6001", "2026-11-09", "3.50", { ad_name: "Spring", adset_name: "Riyadh 25-34", campaign_name: "Q4" })] } }
        : undefined,
    );
    const w = world({ graph: g });
    seedActive(w);
    await w.scheduler.sweep(T0);
    expect(w.prisma.db.adSource).toHaveLength(1);
    expect(w.prisma.db.adSource[0]).toMatchObject({
      workspaceId: "wsA",
      sourceType: "ad",
      sourceId: "6001",
      adName: "Spring",
      adSetName: "Riyadh 25-34",
      campaignName: "Q4",
      adAccountId: "act_111",
      namesFrom: "meta_sync",
      headline: null,
      body: null,
      mediaType: null,
      mediaUrl: null,
      mediaId: null,
    });

    // A later referral fills the creative fields without clearing the names.
    w.prisma.db.conversation.push({ id: "cv1", workspaceId: "wsA", contactId: "c1", channel: "whatsapp", adSourceId: null, adReferredAt: null });
    const referral = parseMetaReferral({ source_id: "6001", source_type: "ad", headline: "Spring sale", body: "20% off", source_url: "https://fb.me/x" })!;
    const capture = new AdReferralService(w.prisma);
    await capture.capture({ workspaceId: "wsA", channelId: null, conversationId: "cv1", contactId: "c1", messageId: "msg1", provider: "meta", referral, at: T0 });
    expect(w.prisma.db.adSource).toHaveLength(1);
    expect(w.prisma.db.adSource[0]).toMatchObject({
      headline: "Spring sale",
      body: "20% off",
      sourceUrl: "https://fb.me/x",
      adName: "Spring",
      adSetName: "Riyadh 25-34",
      campaignName: "Q4",
      namesFrom: "meta_sync",
    });
  });

  it("the sync writes only its connection's workspace", async () => {
    const { g } = scriptedInsights((n) => (n === 0 ? { body: { data: [insightRow("6001", "2026-11-09", "1.00")] } } : undefined));
    const w = world({ graph: g });
    w.prisma.db.adSource.push({ id: "foreign", workspaceId: "wsB", sourceType: "ad", sourceId: "6001", adName: "B's ad" });
    seedActive(w);
    await w.scheduler.sweep(T0);
    const mine = w.prisma.db.adSource.filter((a: { workspaceId: string }) => a.workspaceId === "wsA");
    expect(mine).toHaveLength(1);
    expect(w.prisma.db.adSource.find((a: { id: string }) => a.id === "foreign").adName).toBe("B's ad");
    expect(w.prisma.db.adSpendDaily.every((s: { workspaceId: string; adSourceId: string }) => s.workspaceId === "wsA" && s.adSourceId === mine[0].id)).toBe(true);
  });
});
