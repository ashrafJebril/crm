import { Prisma } from "@prisma/client";
import * as sql from "./support-metrics.sql";
import { parseRange } from "./insights-range";
import { INSIGHTS_HOME_MIGRATION } from "./insights-constants";

/** Structural checks on every support builder (the DB spec runs them for real). */
const range = parseRange("2026-11-01", "2026-11-07", "Asia/Riyadh", new Date("2026-11-10T09:00:00Z"));
const builders = Object.entries(sql).filter(([name]) => name.endsWith("Sql") && !["utcTimestampSql", "inRangeSql", "teamMembersSql", "medianSecondsSql", "attributionSinceSql"].includes(name)) as [
  string,
  (ws: string, r: typeof range, scope: object, opts: { channelId: string | null }) => Prisma.Sql,
][];

describe("support metric SQL builders", () => {
  it("one tagged, well-formed, workspace-bound statement per metric", () => {
    expect(builders.map(([n]) => n).sort()).toEqual(
      [
        "aiResolutionSql",
        "byNumberSql",
        "conversationsSql",
        "firstResponseSql",
        "handlingSql",
        "peaksSql",
        "resolutionMixSql",
        "teamSql",
        "ticketShareSql",
        "timeSavedSql",
        "topicFrictionSql",
      ].sort(),
    );
    const tags = new Set<string>();
    for (const [name, build] of builders) {
      const s = build("ws1", range, { assigneeId: "u1" }, { channelId: "ch1" });
      const text = s.strings.join("$?");
      const tag = /^\s*\/\* insights:support\.(\w+) \*\//.exec(s.strings[0])?.[1];
      expect({ name, tag: !!tag }).toEqual({ name, tag: true });
      tags.add(tag as string);
      // Balanced parentheses, no unfilled template, the workspace bound.
      let depth = 0;
      for (const ch of text) {
        if (ch === "(") depth += 1;
        if (ch === ")") depth -= 1;
        expect(depth).toBeGreaterThanOrEqual(0);
      }
      expect({ name, depth }).toEqual({ name, depth: 0 });
      expect(text).not.toContain("${");
      expect(text).not.toContain("undefined");
      expect(s.values).toContain("ws1");
      // The range is bound as UTC instants, the channel filter applied.
      expect(s.values).toContain("2026-10-31T21:00:00.000Z");
      expect(s.values).toContain("2026-11-07T21:00:00.000Z");
      expect(s.values).toContain("ch1");
      expect(s.values).toContain("u1");
    }
    expect(tags.size).toBe(builders.length);
  });

  it("first response keeps only exchanges with a staff reply; the AI-only rule is in the SQL", () => {
    const text = sql.firstResponseSql("ws1", range, {}, { channelId: null }).strings.join("?");
    expect(text).toContain(`FILTER (WHERE x."humanAt" IS NOT NULL)`);
    expect(text).toContain(`n."from" = 'human'`);
    expect(text).toContain(`FILTER (WHERE x."replyFrom" IS NULL)`);
  });

  it("the attribution date reads the migration row and the workspace, never Message", () => {
    const s = sql.attributionSinceSql("ws1", "Asia/Riyadh");
    const text = s.strings.join("?");
    expect(s.strings[0]).toMatch(/^\s*\/\* insights:support\.attributionSince \*\//);
    expect(text).toContain(`FROM "_prisma_migrations" pm`);
    expect(text).toContain(`pm."migration_name" = ?`);
    expect(text).toContain(`pm."finished_at" IS NOT NULL AND pm."rolled_back_at" IS NULL`);
    expect(text).toContain(`GREATEST(mig."at", w."createdAt")`);
    expect(text).toContain(`CASE WHEN mig."at" IS NULL THEN NULL`);
    expect(text).toContain("'YYYY-MM-DD'");
    expect(text).not.toContain(`"Message"`);
    // The migration name is bound, never spliced into the text.
    expect(text).not.toContain(INSIGHTS_HOME_MIGRATION);
    expect(s.values).toEqual(expect.arrayContaining(["ws1", "Asia/Riyadh", INSIGHTS_HOME_MIGRATION]));
    expect(sql.attributionSinceSql("ws1", "Asia/Riyadh", "x_missing").values).toContain("x_missing");
  });
});
