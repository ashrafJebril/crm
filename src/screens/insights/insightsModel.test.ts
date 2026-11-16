import { describe, expect, it } from "vitest";
import { ApiError } from "@/api/client";
import { makeTx } from "@/lib/tx";
import backendErrors from "../../../backend/src/insights/insights-errors.ts?raw";
import backendConstants from "../../../backend/src/insights/insights-constants.ts?raw";
import backendFormat from "../../../backend/src/insights/insights-format.ts?raw";
import { decodeJson, getHashParam } from "@/lib/hashState";
import {
  DASH,
  NO_DATA,
  adHref,
  followUpsHref,
  formatDay,
  SPEED_BUCKETS,
  formatCount,
  formatDuration,
  formatHours,
  formatRate,
  lostReasonLabel,
  memberLabel,
  numberLabel,
  peaksScale,
  salesAllForbidden,
  SALES_NO_ACCESS,
  pipelineName,
  sectionView,
  sourceLabel,
  speedBucketLabel,
} from "./insightsModel";
import { INSIGHTS_ERROR_COPY, insightsErrorText } from "./insightsErrors";
import {
  DEFAULT_INSIGHTS_PARAMS,
  customRangeOk,
  insightsPath,
  parseInsightsParams,
  rangeDays,
  withInsightsParams,
} from "./insightsParams";

const ARABIC = /[؀-ۿ]/;
const ARABIC_DIGITS = /[٠-٩]/;

describe("insights durations and rates format in both languages with Latin digits", () => {
  it("durations", () => {
    expect(formatDuration(45, "en")).toBe("45 s");
    expect(formatDuration(720, "en")).toBe("12 min");
    expect(formatDuration(3900, "en")).toBe("1 h 5 min");
    expect(formatDuration(7200, "en")).toBe("2 h");
    expect(formatDuration(97200, "en")).toBe("1 d 3 h");
    expect(formatDuration(3900, "ar")).toBe("1 س 5 د");
    expect(formatDuration(45, "ar")).toBe("45 ث");
    for (const v of [45, 720, 3900, 97200]) expect(formatDuration(v, "ar")).not.toMatch(ARABIC_DIGITS);
  });

  it("rates, counts and hours", () => {
    expect(formatRate(37.5)).toBe("37.5%");
    expect(formatRate(40)).toBe("40%");
    expect(formatRate(0)).toBe("0%");
    expect(formatCount(12345)).toBe("12,345");
    expect(formatHours(12.5, "ar")).toBe("12.5 س");
  });

  it("null is no data (\"—\", never 0)", () => {
    expect(formatDuration(null, "en")).toBe(DASH);
    expect(formatRate(null)).toBe(DASH);
    expect(formatRate(undefined)).toBe(DASH);
    expect(NO_DATA).toEqual(["No data yet", "لا توجد بيانات بعد"]);
  });
});

describe("section states render unavailable and hide forbidden", () => {
  it("ok renders, unavailable says so, forbidden and missing hide", () => {
    expect(sectionView({ status: "ok", data: 3 })).toEqual({ kind: "ok", data: 3 });
    expect(sectionView({ status: "unavailable" })).toEqual({ kind: "unavailable" });
    expect(sectionView({ status: "forbidden" })).toEqual({ kind: "hidden" });
    expect(sectionView(undefined)).toEqual({ kind: "hidden" });
  });
});

describe("insights tab, range, channel and pipeline round-trip through the hash", () => {
  it("defaults: an old #/analytics is Overview, last 30 days", () => {
    expect(parseInsightsParams("#/analytics")).toEqual(DEFAULT_INSIGHTS_PARAMS);
    expect(parseInsightsParams("#/analytics?tab=x&range=12&channel=%3Cb%3E")).toEqual(DEFAULT_INSIGHTS_PARAMS);
  });

  it("round-trips; defaults stay out; other params are kept", () => {
    let h = "#/analytics?record=contact:c1";
    h = withInsightsParams(h, { tab: "support", team: true, range: "90", channel: "ch_1" });
    expect(parseInsightsParams(h)).toEqual({ ...DEFAULT_INSIGHTS_PARAMS, tab: "support", team: true, range: "90", channel: "ch_1" });
    expect(h).toContain("record=contact");
    h = withInsightsParams(h, { tab: "sales", team: false, range: "custom", from: "2026-10-01", to: "2026-10-31", channel: null, pipeline: "p_2" });
    expect(parseInsightsParams(h)).toEqual({ tab: "sales", team: false, range: "custom", from: "2026-10-01", to: "2026-10-31", channel: null, pipeline: "p_2" });
    h = withInsightsParams(h, { tab: "overview", range: "30", pipeline: null });
    expect(h).toBe("#/analytics?record=contact%3Ac1");
  });

  it("a custom range needs valid ordered days; requests carry the range and the filter", () => {
    expect(parseInsightsParams("#/analytics?range=custom&from=2026-10-31&to=2026-10-01").range).toBe("30");
    expect(parseInsightsParams("#/analytics?range=custom&from=2026-02-30&to=2026-03-01").range).toBe("30");
    expect(rangeDays({ ...DEFAULT_INSIGHTS_PARAMS, range: "7" }, "2026-11-17")).toEqual({ from: "2026-11-11", to: "2026-11-17" });
    expect(insightsPath("support", { ...DEFAULT_INSIGHTS_PARAMS, channel: "c1", pipeline: "p1" }, "2026-11-17")).toBe(
      "/insights/support?from=2026-10-19&to=2026-11-17&channelId=c1",
    );
    expect(insightsPath("sales", { ...DEFAULT_INSIGHTS_PARAMS, channel: "c1", pipeline: "p1" }, "2026-11-17")).toBe(
      "/insights/sales?from=2026-10-19&to=2026-11-17&pipelineId=p1",
    );
    expect(customRangeOk("2026-01-01", "2026-12-31")).toBe(true); // 365 days
    expect(customRangeOk("2025-01-01", "2026-12-31")).toBe(false);
    expect(customRangeOk("2026-02-01", "2026-01-01")).toBe(false);
  });
});

describe("speed buckets label every bucket in both languages", () => {
  it("the backend's bucket keys, in order, each with distinct copy", () => {
    const m = /SPEED_BUCKET_KEYS = \[([^\]]*)\]/.exec(backendConstants);
    const backend = [...m![1].matchAll(/"([a-z0-9_]+)"/g)].map((x) => x[1]);
    expect([...SPEED_BUCKETS]).toEqual(backend);
    const en = SPEED_BUCKETS.map((b) => speedBucketLabel(b, "en"));
    const ar = SPEED_BUCKETS.map((b) => speedBucketLabel(b, "ar"));
    expect(new Set(en).size).toBe(7);
    expect(new Set(ar).size).toBe(7);
    for (const a of ar) {
      expect(a).toMatch(ARABIC);
      expect(a).not.toMatch(ARABIC_DIGITS);
    }
    expect(speedBucketLabel("5_15m", "en")).toBe("5–15 min");
  });
});

describe("insights error copy covers every SP-11 key in both languages", () => {
  it("matches the backend key list; distinct English and Arabic", () => {
    const keys = [...backendErrors.matchAll(/"(insights\.[a-z_]+)":/g)].map((x) => x[1]);
    expect(keys.length).toBe(3);
    expect(Object.keys(INSIGHTS_ERROR_COPY).sort()).toEqual([...new Set(keys)].sort());
    for (const k of keys) {
      const err = new ApiError(k, 400, undefined, { message: k });
      expect(insightsErrorText(err, makeTx("en"))).not.toMatch(ARABIC);
      expect(insightsErrorText(err, makeTx("ar"))).toMatch(ARABIC);
      expect(insightsErrorText(err, makeTx("en"))).not.toBe(k);
      // useFetch hands the screen the message string.
      expect(insightsErrorText(k, makeTx("ar"))).toBe(insightsErrorText(err, makeTx("ar")));
    }
    expect(insightsErrorText(new ApiError("Forbidden", 403), makeTx("en"))).toMatch(/permission/);
    expect(insightsErrorText("boom", makeTx("en"))).toBe("The report couldn't load. Try again.");
  });
});

describe("server labels are translated", () => {
  it("numbers: unassigned (null id) and removed arrive in English", () => {
    expect(numberLabel({ channelId: null, label: "Unassigned number" }, "ar")).toBe("رقم غير مخصص");
    expect(numberLabel({ channelId: "c9", label: "Removed number" }, "ar")).toBe("رقم محذوف");
    expect(numberLabel({ channelId: "c1", label: "Riyadh branch" }, "ar")).toBe("Riyadh branch");
    expect(backendFormat).toContain('UNASSIGNED_NUMBER = "Unassigned number"');
    expect(backendFormat).toContain('REMOVED_NUMBER = "Removed number"');
  });

  it("members: former, unattributed and unassigned rows have no user id", () => {
    expect(memberLabel({ userId: null, name: "Former member", former: true }, "ar")).toBe("عضو سابق");
    expect(memberLabel({ userId: null, name: "Unattributed", former: false }, "ar")).toBe("غير منسوب");
    expect(memberLabel({ userId: null, name: "Unassigned", former: false }, "en")).toBe("Unassigned");
    expect(memberLabel({ userId: "u1", name: "Sara", former: false }, "ar")).toBe("Sara");
  });

  it("sources: raw keys translated, ads keep their name", () => {
    expect(sourceLabel({ kind: "channel", key: "whatsapp", label: "whatsapp" }, "ar")).toBe("واتساب");
    expect(sourceLabel({ kind: "contact_source", key: "meta_lead_form", label: "meta_lead_form" }, "en")).toBe("Meta lead form");
    expect(sourceLabel({ kind: "ad", key: "ad_1", label: "Summer promo" }, "ar")).toBe("Summer promo");
    expect(sourceLabel({ kind: "contact_source", key: "google_ads", label: "google_ads" }, "en")).toBe("google ads");
  });

  it("lost reasons fall back to No reason; a pipeline with only an id gets a neutral name", () => {
    expect(lostReasonLabel({ reasonId: null, label: "No reason", labelAr: "بدون سبب" }, "ar")).toBe("بدون سبب");
    expect(lostReasonLabel({ reasonId: null, label: "", labelAr: "" }, "en")).toBe("No reason");
    expect(pipelineName({ id: "p1" }, "ar")).toBe("المسار");
    expect(pipelineName({ id: "p1", name: "Leads", nameAr: "العملاء المحتملون" }, "ar")).toBe("العملاء المحتملون");
  });
});

describe("peaks follow the workspace's week start (row 0 = Sunday)", () => {
  it("an Arabic workspace starts on Sunday, others on Monday; intensities 0..1", () => {
    const matrix = Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => (d === 0 && h === 10 ? 4 : d === 1 && h === 9 ? 2 : 0)));
    const ar = peaksScale(matrix, "ar", "ar");
    expect(ar.rows.map((r) => r.dow)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(ar.rows[0].label).toBe("الأحد");
    const en = peaksScale(matrix, "en", "en");
    expect(en.rows.map((r) => r.dow)).toEqual([1, 2, 3, 4, 5, 6, 0]);
    expect(en.rows[6].cells[10]).toEqual({ hour: 10, count: 4, intensity: 1 });
    expect(en.rows[0].cells[9].intensity).toBe(0.5);
    expect(en.max).toBe(4);
    expect(en.total).toBe(6);
    expect(peaksScale(Array.from({ length: 7 }, () => new Array(24).fill(0)), "en", "en").rows[0].cells[0].intensity).toBe(0);
  });

  it("the week start follows the workspace language, not the UI language (R10)", () => {
    const matrix = Array.from({ length: 7 }, () => new Array(24).fill(0));
    // An English UI in an Arabic workspace: Sunday first, English day names.
    const enInAr = peaksScale(matrix, "en", "ar");
    expect(enInAr.rows.map((r) => r.dow)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(enInAr.rows[0].label).toBe("Sun");
    // An Arabic UI in an English workspace: Monday first, Arabic day names.
    const arInEn = peaksScale(matrix, "ar", "en");
    expect(arInEn.rows.map((r) => r.dow)).toEqual([1, 2, 3, 4, 5, 6, 0]);
    expect(arInEn.rows[0].label).toBe("الاثنين");
  });
});

describe("team attribution and links", () => {
  it("the attribution day (from the server) formats with Latin digits", () => {
    expect(formatDay("2026-10-20", "en")).toBe("20 Oct 2026");
    expect(formatDay("2026-10-20", "ar")).toMatch(ARABIC);
    expect(formatDay("2026-10-20", "ar")).toContain("20");
    expect(formatDay("2026-10-20", "ar")).not.toMatch(ARABIC_DIGITS);
  });

  it("follow-ups link opens the member's team follow-ups; ad link opens the ad", () => {
    const href = followUpsHref("u1");
    expect(href.startsWith("#/followups?fu=")).toBe(true);
    expect(decodeJson(getHashParam(href, "fu"))).toEqual({ scope: "team", assigneeId: "u1", kind: "", pipelineId: "" });
    expect(adHref("ad 1")).toBe("#/ads?ad=ad+1");
    expect(getHashParam(adHref("ad 1"), "ad")).toBe("ad 1");
  });
});

describe("sales tab without ticket access shows a notice when every section is forbidden", () => {
  const forbidden = { status: "forbidden" } as const;
  const all = {
    headline: forbidden,
    distribution: forbidden,
    weekly: forbidden,
    sources: forbidden,
    funnel: forbidden,
    lostReasons: forbidden,
    reps: forbidden,
  };

  it("all forbidden → notice; any other state → the sections render", () => {
    expect(salesAllForbidden(all)).toBe(true);
    expect(salesAllForbidden({ ...all, reps: { status: "unavailable" } })).toBe(false);
    expect(salesAllForbidden({ ...all, weekly: { status: "ok", data: [] } })).toBe(false);
  });

  it("the notice is bilingual", () => {
    expect(SALES_NO_ACCESS).toEqual(["You don't have access to sales data", "ليست لديك صلاحية الوصول إلى بيانات المبيعات"]);
    expect(makeTx("ar")(...SALES_NO_ACCESS)).toMatch(ARABIC);
    expect(makeTx("en")(...SALES_NO_ACCESS)).not.toMatch(ARABIC);
  });
});
