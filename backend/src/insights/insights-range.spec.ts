import { Prisma } from "@prisma/client";
import { localDate, localWeekStart, localWeekStartSql, parseRange, weekStartsOn } from "./insights-range";
import { INSIGHTS_ERROR_KEYS, insightsError } from "./insights-errors";
import { conversationScopeSql, inConversationScope } from "./insights-scope";

const RIYADH = "Asia/Riyadh";
const NOW = new Date("2026-11-10T09:00:00Z"); // 12:00 in Riyadh, Tuesday 10 Nov

function invalid(fn: () => unknown) {
  try {
    fn();
  } catch (e: any) {
    return { status: e.getStatus?.(), body: e.getResponse?.() };
  }
  return null;
}

describe("insights range", () => {
  it("range parsing is workspace-local and bounded", () => {
    // Default: the last 30 local days ending today.
    const def = parseRange(undefined, undefined, RIYADH, NOW);
    expect(def).toEqual({
      from: "2026-10-12",
      to: "2026-11-10",
      tz: RIYADH,
      fromUtc: new Date("2026-10-11T21:00:00Z"),
      toUtcExclusive: new Date("2026-11-10T21:00:00Z"),
      days: 30,
    });

    // Riyadh day boundaries fall at 21:00Z.
    const r = parseRange("2026-11-01", "2026-11-07", RIYADH, NOW);
    expect(r.fromUtc.toISOString()).toBe("2026-10-31T21:00:00.000Z");
    expect(r.toUtcExclusive.toISOString()).toBe("2026-11-07T21:00:00.000Z");
    expect(r.days).toBe(7);

    // "Today" is local: 22:30Z on the 10th is already the 11th in Riyadh.
    expect(parseRange(undefined, undefined, RIYADH, new Date("2026-11-10T22:30:00Z")).to).toBe("2026-11-11");

    // One day; exactly 366 days is allowed.
    expect(parseRange("2026-11-05", "2026-11-05", RIYADH, NOW).days).toBe(1);
    expect(parseRange("2025-11-11", "2026-11-11", RIYADH, NOW).days).toBe(366);
    // Only `to`: the 30 days ending there. Empty strings read as missing.
    expect(parseRange("", "2026-11-30", RIYADH, NOW).from).toBe("2026-11-01");

    // An invalid zone falls back to Asia/Riyadh (SP-04 validTz).
    expect(parseRange("2026-11-01", "2026-11-01", "Mars/Olympus", NOW).tz).toBe(RIYADH);
    // Another zone: New York midnight in November is 05:00Z.
    expect(parseRange("2026-11-02", "2026-11-02", "America/New_York", NOW).fromUtc.toISOString()).toBe("2026-11-02T05:00:00.000Z");

    const expected400 = { status: 400, body: { statusCode: 400, message: "insights.range_invalid" } };
    for (const [from, to] of [
      ["2026-11-08", "2026-11-07"], // from > to
      ["2025-11-10", "2026-11-11"], // 367 days
      ["2026-13-01", "2026-12-01"], // malformed
      ["2026-02-30", "2026-03-01"], // not a date
      ["yesterday", undefined],
      [undefined, "2026/11/07"],
      [["2026-11-01", "2026-11-02"], undefined], // repeated query param
    ] as const) {
      expect({ from, to, err: invalid(() => parseRange(from, to, RIYADH, NOW)) }).toEqual({ from, to, err: expected400 });
    }
  });

  it("local dates and week starts follow the workspace (ruling 10)", () => {
    expect(localDate(new Date("2026-11-04T20:59:59Z"), RIYADH)).toBe("2026-11-04");
    expect(localDate(new Date("2026-11-04T21:00:00Z"), RIYADH)).toBe("2026-11-05");
    expect(weekStartsOn("ar")).toBe(0);
    expect(weekStartsOn("en")).toBe(1);
    // 2026-11-04 is a Wednesday.
    expect(localWeekStart("2026-11-04", "ar")).toBe("2026-11-01"); // Sunday
    expect(localWeekStart("2026-11-04", "en")).toBe("2026-11-02"); // Monday
    expect(localWeekStart("2026-11-01", "ar")).toBe("2026-11-01");
    expect(localWeekStart("2026-11-01", "en")).toBe("2026-10-26");
    const sql = (s: Prisma.Sql) => s.strings.join("?");
    expect(sql(localWeekStartSql(Prisma.sql`m."createdAt"`, RIYADH, "ar"))).toContain("+ interval '1 day') - interval '1 day')::date");
    expect(sql(localWeekStartSql(Prisma.sql`m."createdAt"`, RIYADH, "en"))).not.toContain("interval");
    expect(localWeekStartSql(Prisma.sql`m."createdAt"`, "Bad/Zone", "en").values).toEqual([RIYADH]);
  });

  it("insights error keys carry their status and key", () => {
    expect(INSIGHTS_ERROR_KEYS).toEqual(["insights.range_invalid", "insights.channel_not_found", "insights.pipeline_not_found"]);
    expect(insightsError("insights.channel_not_found").getStatus()).toBe(404);
    expect(insightsError("insights.pipeline_not_found").getResponse()).toEqual({ statusCode: 404, message: "insights.pipeline_not_found" });
    expect(insightsError("insights.range_invalid").getStatus()).toBe(400);
  });

  it("the scope fragment matches the dashboard's former sqlScope", () => {
    expect(conversationScopeSql({}, "c")).toBe(Prisma.empty);
    const mine = conversationScopeSql({ assigneeId: "u1" }, "c");
    expect(mine.strings.join("?")).toBe('AND c."assigneeId" = ?');
    expect(mine.values).toEqual(["u1"]);
    expect(conversationScopeSql({ id: { in: [] } }, "c").strings.join("")).toBe("AND FALSE");
    expect(inConversationScope({}, null)).toBe(true);
    expect(inConversationScope({ assigneeId: "u1" }, "u1")).toBe(true);
    expect(inConversationScope({ assigneeId: "u1" }, null)).toBe(false);
    expect(inConversationScope({ id: { in: [] } }, "u1")).toBe(false);
  });
});
