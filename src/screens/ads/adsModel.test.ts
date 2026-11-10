import { describe, expect, it } from "vitest";
import { makeTx } from "@/lib/tx";
import type { AdsOverview, MetaAdsConnectionDto } from "@/lib/types";
import {
  adLabel,
  adLabelText,
  clearOauthReturn,
  connectionView,
  cooldownSeconds,
  costPerConversationView,
  dailySeries,
  formatAdMoney,
  META_ADS_STATUSES,
  oauthReturn,
  overviewDaily,
  parseRange,
  rangeToQuery,
  readTab,
  spendView,
  totalsView,
  writeRange,
} from "./adsModel";

const en = makeTx("en");
const ar = makeTx("ar");
const ARABIC = /[؀-ۿ]/;
const ARABIC_DIGITS = /[٠-٩۰-۹]/;
const plain = (s: string) => s.replace(/[  ]/g, " ");

describe("cost per conversation renders unknown when nothing started", () => {
  it("started 0 reads No conversations yet, never 0 or an amount", () => {
    for (const spend of [{ amount: 0, currency: "SAR" }, { amount: 50, currency: "SAR" }, null]) {
      const e = costPerConversationView({ started: 0, spend, costPerConversation: null }, en, "en", "not_connected");
      const a = costPerConversationView({ started: 0, spend, costPerConversation: null }, ar, "ar", "not_connected");
      expect(e.text).toBe("No conversations yet");
      expect(a.text).toBe("لا محادثات بعد");
      expect(e.unknown).toBe(true);
      expect(e.text).not.toMatch(/\d|SAR/);
    }
  });

  it("spend null is Unknown with the right reason, and cost is Unknown", () => {
    const s1 = spendView(null, en, "en", "not_connected");
    expect(s1).toEqual({ text: "Unknown", unknown: true, title: "Connect Meta Ads to see spend" });
    const s2 = spendView(null, ar, "ar", "other_account");
    expect(s2).toEqual({ text: "غير معروف", unknown: true, title: "هذا الإعلان ليس في الحساب الإعلاني المربوط" });
    const c = costPerConversationView({ started: 3, spend: null, costPerConversation: null }, en, "en", "other_account");
    expect(c.text).toBe("Unknown");
    expect(c.unknown).toBe(true);
    expect(c.title).toBe("This ad isn't in the connected ad account");
  });

  it("0 spend is a real amount, distinct from Unknown", () => {
    const z = spendView({ amount: 0, currency: "SAR" }, en, "en", "not_connected");
    expect(z.unknown).toBe(false);
    expect(plain(z.text)).toBe("SAR 0.00");
  });

  it("120.5 SAR over 4 is SAR 30.13 in Latin digits in both languages", () => {
    const card = { started: 4, spend: { amount: 120.5, currency: "SAR" }, costPerConversation: 30.125 };
    expect(plain(costPerConversationView(card, en, "en", "not_connected").text)).toBe("SAR 30.13");
    const a = costPerConversationView(card, ar, "ar", "not_connected").text;
    expect(plain(a)).toBe("SAR 30.13");
    expect(a).not.toMatch(ARABIC_DIGITS);
    // Computed locally when the backend leaves the cost out.
    expect(plain(costPerConversationView({ ...card, costPerConversation: null }, en, "en", "not_connected").text)).toBe("SAR 30.13");
  });

  it("two currencies render two figures, never one total", () => {
    const o: Pick<AdsOverview, "totals" | "connection"> = {
      connection: null,
      totals: {
        started: 7,
        byCurrency: [
          { currency: "SAR", spend: 120.5, started: 4, costPerConversation: 30.125 },
          { currency: "USD", spend: 9, started: 3, costPerConversation: 3 },
        ],
      },
    };
    const t = totalsView(o, en, "en");
    expect(t.figures).toHaveLength(2);
    expect(t.figures.map((f) => plain(f.spend.text))).toEqual(["SAR 120.50", "USD 9.00"]);
    expect(t.figures.map((f) => plain(f.cost.text))).toEqual(["SAR 30.13", "USD 3.00"]);
    expect(t.started).toBe(7);
  });
});

describe("overview view-model: Unknown vs 0 and currency totals", () => {
  const conn = (status: MetaAdsConnectionDto["status"], currency: string | null = "SAR") =>
    ({ status, currency, lastSyncedAt: null }) as MetaAdsConnectionDto;

  it("no known spend without a connection is one Unknown figure", () => {
    const t = totalsView({ connection: null, totals: { started: 5, byCurrency: [] } }, en, "en");
    expect(t.figures).toHaveLength(1);
    expect(t.figures[0].spend).toEqual({ text: "Unknown", unknown: true, title: "Connect Meta Ads to see spend" });
    expect(t.figures[0].cost.text).toBe("No conversations yet");
  });

  it("an active connection with no ads in range reads 0 in its currency", () => {
    const t = totalsView({ connection: conn("active"), totals: { started: 0, byCurrency: [] } }, en, "en");
    expect(plain(t.figures[0].spend.text)).toBe("SAR 0.00");
    expect(t.figures[0].spend.unknown).toBe(false);
  });

  it("needs_reconnect keeps spend Unknown with the connect reason", () => {
    const t = totalsView({ connection: conn("needs_reconnect"), totals: { started: 2, byCurrency: [] } }, ar, "ar");
    expect(t.figures[0].spend.text).toBe("غير معروف");
    expect(t.figures[0].spend.title).toBe("اربط إعلانات Meta لعرض الإنفاق");
  });

  it("overview daily picks one currency; null spend stays null", () => {
    const daily: AdsOverview["daily"] = [
      { date: "2026-11-01", started: 1, spend: { SAR: 5 } },
      { date: "2026-11-02", started: 0, spend: {} },
      { date: "2026-11-03", started: 2, spend: null },
    ];
    expect(overviewDaily(daily, "SAR").map((d) => d.spend)).toEqual([5, 0, null]);
    expect(overviewDaily(daily, null).map((d) => d.spend)).toEqual([null, null, null]);
  });

  it("formats an unknown currency code as the amount plus the code", () => {
    expect(formatAdMoney(3, "XYZ1", "en")).toBe("3.00 XYZ1");
    expect(plain(formatAdMoney(30.125, "JOD", "en"))).toBe("JOD 30.125");
  });
});

describe("ad label falls back from name to headline to id", () => {
  it("prefers the name, then the headline, then the id", () => {
    expect(adLabel({ adName: "Spring sale", headline: "H", sourceId: "1" }, en)).toEqual({ kind: "name", text: "Spring sale" });
    expect(adLabel({ adName: "  ", headline: "عرض الربيع", sourceId: "1" }, en)).toEqual({ kind: "headline", text: "عرض الربيع" });
    const id = adLabel({ adName: null, headline: null, sourceId: "120208" }, ar);
    expect(id).toEqual({ kind: "id", text: "120208", prefix: "إعلان" });
    expect(adLabelText(adLabel({ adName: null, headline: "", sourceId: "9" }, en))).toBe("Ad 9");
  });

  it("is never blank", () => {
    for (const c of [
      { adName: null, headline: null, sourceId: null, id: "x1" },
      { adName: "", headline: " ", sourceId: "" },
      { adName: null, headline: null },
    ]) {
      expect(adLabelText(adLabel(c, en)).trim().length).toBeGreaterThan(0);
    }
  });
});

describe("range presets and custom dates round-trip through the hash", () => {
  it("presets round-trip, 30d is the default and leaves the hash clean", () => {
    for (const p of ["7d", "90d"] as const) {
      const h = writeRange("#/ads?tab=overview", { preset: p });
      expect(parseRange(h)).toEqual({ preset: p });
      expect(h).toContain("tab=overview");
    }
    expect(writeRange("#/ads?range=7d", { preset: "30d" })).toBe("#/ads");
    expect(parseRange("#/ads")).toEqual({ preset: "30d" });
  });

  it("custom dates round-trip; malformed ones fall back", () => {
    const h = writeRange("#/ads", { preset: "custom", from: "2026-10-01", to: "2026-10-31" });
    expect(parseRange(h)).toEqual({ preset: "custom", from: "2026-10-01", to: "2026-10-31" });
    expect(rangeToQuery(parseRange(h))).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(parseRange("#/ads?range=custom&from=2026-13-01&to=2026-10-31")).toEqual({ preset: "30d" });
    expect(parseRange("#/ads?range=custom&from=2026-11-01&to=2026-10-31")).toEqual({ preset: "30d" });
    expect(parseRange("#/ads?range=bogus")).toEqual({ preset: "30d" });
  });

  it("presets end today and span their days", () => {
    const now = new Date(2026, 10, 10, 15, 0);
    expect(rangeToQuery({ preset: "7d" }, now)).toEqual({ from: "2026-11-04", to: "2026-11-10" });
    expect(rangeToQuery({ preset: "30d" }, now)).toEqual({ from: "2026-10-12", to: "2026-11-10" });
  });

  it("reads the tab", () => {
    expect(readTab("#/ads?tab=connection")).toBe("connection");
    expect(readTab("#/ads?tab=x")).toBe("overview");
  });
});

describe("daily series fills idle days and folds long ranges", () => {
  it("fills missing days (spend 0 when the series has known spend)", () => {
    const s = dailySeries([
      { date: "2026-11-01", started: 2, spend: 10 },
      { date: "2026-11-04", started: 1, spend: 5 },
    ]);
    expect(s.map((b) => b.from)).toEqual(["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"]);
    expect(s.map((b) => b.spend)).toEqual([10, 0, 0, 5]);
    expect(dailySeries([{ date: "2026-11-01", started: 1, spend: null }, { date: "2026-11-03", started: 0, spend: null }]).map((b) => b.spend)).toEqual([null, null, null]);
  });

  it("folds a 90-day range into at most 31 bars and preserves sums", () => {
    const daily = Array.from({ length: 90 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10);
      return { date: d, started: i % 3, spend: i % 2 ? 1.25 : 0 };
    });
    const s = dailySeries(daily, 31);
    expect(s.length).toBeLessThanOrEqual(31);
    expect(s.reduce((a, b) => a + b.started, 0)).toBe(daily.reduce((a, b) => a + b.started, 0));
    expect(s.reduce((a, b) => a + (b.spend ?? 0), 0)).toBeCloseTo(daily.reduce((a, b) => a + b.spend, 0), 6);
    expect(s[0].from).toBe("2026-08-01");
    expect(s[s.length - 1].to).toBe(daily[89].date);
  });

  it("is empty for no rows", () => {
    expect(dailySeries([])).toEqual([]);
  });
});

describe("connection status words and tones cover every status in both languages", () => {
  it("has a label and tone for every status", () => {
    for (const status of META_ADS_STATUSES) {
      const e = connectionView({ status, lastSyncedAt: "2026-11-01T00:00:00Z" }, en);
      const a = connectionView({ status, lastSyncedAt: "2026-11-01T00:00:00Z" }, ar);
      expect(e.status).toBe(status);
      expect(e.label).toMatch(/[A-Za-z]/);
      expect(a.label).toMatch(ARABIC);
      expect(["ok", "warn", "bad", "info", "muted"]).toContain(e.tone);
    }
    expect(connectionView({ status: "active", lastSyncedAt: "x" }, en).tone).toBe("ok");
    expect(connectionView({ status: "needs_reconnect", lastSyncedAt: null }, en).tone).toBe("bad");
    expect(connectionView(null, en).status).toBe("not_connected");
  });

  it("flags the first sync pending only for an active connection never synced", () => {
    expect(connectionView({ status: "active", lastSyncedAt: null }, en).firstSyncPending).toBe(true);
    expect(connectionView({ status: "active", lastSyncedAt: "2026-11-01T00:00:00Z" }, en).firstSyncPending).toBe(false);
    expect(connectionView({ status: "pending", lastSyncedAt: null }, en).firstSyncPending).toBe(false);
  });
});

describe("oauth return reads choose and error codes", () => {
  it("reads choose, error codes, and nothing", () => {
    expect(oauthReturn("#/ads?tab=connection&metaAds=choose")).toEqual({ kind: "choose" });
    expect(oauthReturn("#/ads?tab=connection&metaAds=error&code=cancelled")).toEqual({ kind: "error", code: "cancelled" });
    expect(oauthReturn("#/ads?tab=connection&metaAds=error")).toEqual({ kind: "error", code: "unknown" });
    expect(oauthReturn("#/ads?metaAds=error&code=%3Cscript%3E")).toEqual({ kind: "error", code: "unknown" });
    expect(oauthReturn("#/ads?tab=connection")).toBeNull();
    expect(oauthReturn("#/ads?metaAds=other")).toBeNull();
  });

  it("clears only the one-shot params", () => {
    expect(clearOauthReturn("#/ads?tab=connection&metaAds=error&code=forbidden")).toBe("#/ads?tab=connection");
  });

  it("reads the check cooldown", () => {
    expect(cooldownSeconds({ retryAfter: 41.2 })).toBe(42);
    expect(cooldownSeconds({ nextAt: new Date(10_000 + 30_000).toISOString() }, 10_000)).toBe(30);
    expect(cooldownSeconds({})).toBeNull();
  });
});
