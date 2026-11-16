import type { Prisma } from "@prisma/client";
import {
  distributionRows,
  funnelRows,
  lostReasonRows,
  repRows,
  sourceRows,
  weeklyRows,
  wholeSeconds,
  type RepTotals,
} from "./insights-format";
import type { InsightsRange } from "./insights-range";
import type { ConversationScope } from "./insights-scope";
import {
  funnelSql,
  leadsSql,
  lostReasonsSql,
  repliedSql,
  repsSql,
  sourcesSql,
  speedDistributionSql,
  speedToReplySql,
  UNASSIGNED_KEY,
  waitingSql,
  weeklySql,
  wonSql,
  type SalesOpts,
} from "./sales-metrics.sql";
import { teamMembersSql } from "./support-metrics.sql";

/** What a sales section runs on (the section runner's transaction). */
interface Tx {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
}

const one = <T>(rows: T[] | undefined): Partial<T> => (rows && rows[0]) || {};
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

export interface SalesHeadlineRows {
  leads: { leads: number };
  replied: { replied: number };
  speed: { median: number | null };
  waiting: { waiting: number };
  won: { won: number };
}

/** The sales headline from its five statements' rows. */
export function assembleSalesHeadline(
  leads: Partial<SalesHeadlineRows["leads"]>,
  replied: Partial<SalesHeadlineRows["replied"]>,
  speed: Partial<SalesHeadlineRows["speed"]>,
  waiting: Partial<SalesHeadlineRows["waiting"]>,
  won: Partial<SalesHeadlineRows["won"]>,
) {
  return {
    leads: num(leads.leads),
    replied: num(replied.replied),
    medianSpeedToReplySec: wholeSeconds(speed.median),
    waiting: num(waiting.waiting),
    won: num(won.won),
  };
}

/**
 * The sales sections as functions of a section transaction. Each runs one
 * statement except `reps` (members + totals: 2), which the caller must
 * declare to the section runner.
 */
export function salesSections(ws: string, range: InsightsRange, scope: ConversationScope, opts: SalesOpts) {
  const q = <T>(tx: Tx, sql: Prisma.Sql) => tx.$queryRaw<T[]>(sql);
  return {
    headlineParts: {
      leads: async (tx: Tx) => one(await q<SalesHeadlineRows["leads"]>(tx, leadsSql(ws, range, scope, opts))),
      replied: async (tx: Tx) => one(await q<SalesHeadlineRows["replied"]>(tx, repliedSql(ws, range, scope, opts))),
      speed: async (tx: Tx) => one(await q<SalesHeadlineRows["speed"]>(tx, speedToReplySql(ws, range, scope, opts))),
      waiting: async (tx: Tx) => one(await q<SalesHeadlineRows["waiting"]>(tx, waitingSql(ws, range, scope, opts))),
      won: async (tx: Tx) => one(await q<SalesHeadlineRows["won"]>(tx, wonSql(ws, range, scope, opts))),
    },
    distribution: async (tx: Tx) => distributionRows(await q<{ bucket: string; n: number }>(tx, speedDistributionSql(ws, range, scope, opts))),
    weekly: async (tx: Tx) =>
      weeklyRows(await q<{ week: string; leads: number; won: number }>(tx, weeklySql(ws, range, scope, opts)), range.from, range.to, opts.lang),
    sources: async (tx: Tx) =>
      sourceRows(await q<{ kind: string; key: string; label: string | null; leads: number; won: number }>(tx, sourcesSql(ws, range, scope, opts))),
    funnel: async (tx: Tx) =>
      funnelRows(
        await q<{ stageId: string; key: string; label: string; labelAr: string; isWon: boolean; isTerminal: boolean; order: number; reached: number }>(
          tx,
          funnelSql(ws, range, scope, opts),
        ),
      ),
    lostReasons: async (tx: Tx) =>
      lostReasonRows(
        await q<{ reasonId: string | null; label: string | null; labelAr: string | null; snapshot: string | null; n: number }>(
          tx,
          lostReasonsSql(ws, range, scope, opts),
        ),
      ),
    /** Two statements. */
    reps: async (tx: Tx) => {
      const members = await q<{ userId: string; name: string }>(tx, teamMembersSql(ws));
      const rows = await q<{ key: string } & RepTotals>(tx, repsSql(ws, range, scope, opts));
      const totals = new Map<string, RepTotals>();
      for (const r of rows) {
        totals.set(r.key, {
          leads: num(r.leads),
          won: num(r.won),
          lost: num(r.lost),
          median: r.median ?? null,
          done: num(r.done),
          overdue: num(r.overdue),
          dueToday: num(r.dueToday),
        });
      }
      return repRows(members, totals, UNASSIGNED_KEY);
    },
  };
}
