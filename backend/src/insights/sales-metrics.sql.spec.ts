import type { Prisma } from "@prisma/client";
import * as sql from "./sales-metrics.sql";
import { parseRange } from "./insights-range";

/** Structural checks on every sales builder (the DB spec runs them for real). */
const range = parseRange("2026-11-08", "2026-11-28", "Asia/Riyadh", new Date("2026-11-30T09:00:00Z"));
const opts: sql.SalesOpts = {
  pipelineId: "pl1",
  now: new Date("2026-11-30T09:00:00Z"),
  todayEnd: new Date("2026-11-30T21:00:00Z"),
  lang: "ar",
};
const builders = Object.entries(sql).filter(([name, v]) => name.endsWith("Sql") && typeof v === "function") as [
  string,
  (ws: string, r: typeof range, scope: object, o: sql.SalesOpts) => Prisma.Sql,
][];
const CONVERSATION_DERIVED = ["repliedSql", "speedToReplySql", "speedDistributionSql", "waitingSql", "sourcesSql", "repsSql"];

describe("sales metric SQL builders", () => {
  it("one tagged, well-formed, workspace- and pipeline-bound statement per metric", () => {
    expect(builders.map(([n]) => n).sort()).toEqual(
      [
        "funnelSql",
        "leadsSql",
        "lostReasonsSql",
        "repliedSql",
        "repsSql",
        "sourcesSql",
        "speedDistributionSql",
        "speedToReplySql",
        "waitingSql",
        "weeklySql",
        "wonSql",
      ].sort(),
    );
    const tags = new Set<string>();
    for (const [name, build] of builders) {
      const s = build("ws1", range, { assigneeId: "u1" }, opts);
      const text = s.strings.join("$?");
      const tag = /^\s*\/\* insights:sales\.(\w+) \*\//.exec(s.strings[0])?.[1];
      expect({ name, tag: !!tag }).toEqual({ name, tag: true });
      tags.add(tag as string);
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
      expect(s.values).toContain("pl1");
      // The viewer's scope on exactly the conversation-derived metrics.
      expect({ name, scoped: s.values.includes("u1") }).toEqual({ name, scoped: CONVERSATION_DERIVED.includes(name) });
    }
    expect(tags.size).toBe(builders.length);
  });

  it("speed buckets: edges go to the higher bucket; AI replies never count as staff", () => {
    const text = sql.speedDistributionSql("ws1", range, {}, opts).strings.join("?");
    expect(text).toContain(
      `CASE WHEN s."sec" IS NULL THEN 'not_replied' WHEN s."sec" < 300 THEN 'lt_5m' WHEN s."sec" < 900 THEN '5_15m' ` +
        `WHEN s."sec" < 3600 THEN '15_60m' WHEN s."sec" < 14400 THEN '1_4h' WHEN s."sec" < 86400 THEN '4_24h' ELSE 'gt_24h' END`,
    );
    expect(text).toContain(`m."from" = 'human'`);
    expect(sql.repliedSql("ws1", range, {}, opts).strings.join("?")).toContain(`m."from" IN ('ai', 'human')`);
  });

  it("reps never read follow-ups done before (or after) the range", () => {
    const s = sql.repsSql("ws1", range, {}, opts);
    const text = s.strings.join("?");
    expect(text).toContain('AND (f."doneAt" IS NULL OR (f."doneAt" >= ');
    expect(s.values).toContain(range.fromUtc.toISOString());
  });

  it("weeks follow the workspace language (ruling 10)", () => {
    const ar = sql.weeklySql("ws1", range, {}, opts).strings.join("?");
    const en = sql.weeklySql("ws1", range, {}, { ...opts, lang: "en" }).strings.join("?");
    expect(ar).toContain("+ interval '1 day') - interval '1 day')::date");
    expect(en).not.toContain("interval '1 day'");
  });
});
