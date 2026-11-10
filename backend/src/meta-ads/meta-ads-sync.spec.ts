import { Logger } from "@nestjs/common";
import { ADS_TOKEN, fakeGraph, graphError, insightRow, isolateEnv, marketingHandlers, META_ADS_ENV, type GraphReply } from "../channels/whatsapp/test-graph";
import { encryptSecret } from "../common/token-crypto";
import { AdReferralService } from "../ad-attribution/ad-referral.service";
import { parseMetaReferral } from "../ad-attribution/referral";
import { syncWindows } from "./meta-ads-sync";
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
      const w = world();
      seedMany(w, 5);
      const ticks = [0, 0, 4 * 60_000, 11 * 60_000];
      w.scheduler.clock = () => ticks.shift() ?? 11 * 60_000;
      expect(await w.scheduler.sweep(T0)).toEqual({ synced: 2, skipped: 0, failed: 0 });
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
      expect(w.conn()).toMatchObject({ status: "active", lastSyncError: "partial", lastSyncedAt: null });
    });
  });

  it("sync stops on rate limit without retry", async () => {
    const { g, count } = scriptedInsights((n) => (n === 1 ? graphError(17, "User request limit reached") : undefined));
    const w = world({ graph: g });
    seedActive(w);
    await w.scheduler.sweep(T0);
    expect(count()).toBe(2);
    expect(w.conn()).toMatchObject({ status: "active", lastSyncError: "rate_limited", spendBackfilledAt: null });
    expect(w.notify).not.toHaveBeenCalled();
    // The next hourly tick resumes (and here completes the backfill).
    await w.scheduler.sweep(later(HOUR));
    expect(count()).toBe(2 + 13);
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
