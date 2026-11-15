/**
 * SP-16 Task 2 (ruling 7): find and mark the smart audiences that reference
 * something being deleted (a tag, an audience). Shared by the tag delete and
 * the audience delete, so "references" and "what a confirmed delete marks"
 * are the same set by construction.
 *
 * A rule is never removed: it is marked `missing: true` (ruling 6), which
 * compiles to nobody for every operator. A legacy row (no `rules`) is
 * converted with `legacyToTree` first, so its other conditions survive. The
 * marked row stores the nobody-sentinel in `filter` (a tree with a missing
 * rule has no legacy projection), bumps `version` (an open editor then gets
 * 409 instead of writing the old rule back). The caller then clears the
 * count cache of the marked rows and their group referrers
 * (`clearAffectedCounts`, F2). Every write is one statement, whatever the
 * number of audiences.
 */
import {
  AUDIENCE_LIMITS,
  LEGACY_SENTINEL_JSON,
  markRules,
  readRules,
  referencedIds,
  type AudienceRule,
  type AudienceRules,
} from "./audience-rules";

/** The Prisma surface needed (the app client or an interactive transaction). */
export interface MarkingClient {
  segment: {
    findMany(args: unknown): Promise<unknown[]>;
  };
}

export interface ReferencingAudience {
  id: string;
  name: string;
  nameAr: string | null;
  /** The row's tree with the matching rules marked. */
  marked: AudienceRules;
  /** Rules that `marked` newly marks. */
  count: number;
}

/** Smart (`crm`) audiences of `ws` with at least one non-missing rule matching `predicate`, oldest first. */
export async function findReferencingAudiences(
  client: MarkingClient,
  ws: string,
  predicate: (r: AudienceRule) => boolean,
  opts: { excludeId?: string } = {},
): Promise<ReferencingAudience[]> {
  const rows = (await client.segment.findMany({
    where: { workspaceId: ws, origin: "crm" },
    select: { id: true, name: true, nameAr: true, rules: true, filter: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  })) as Array<{ id: string; name: string; nameAr: string | null; rules: unknown; filter: string }>;
  const out: ReferencingAudience[] = [];
  for (const row of rows) {
    if (row.id === opts.excludeId) continue;
    const { tree, marked } = markRules(readRules(row).tree, predicate);
    if (marked > 0) out.push({ id: row.id, name: row.name, nameAr: row.nameAr ?? null, marked: tree, count: marked });
  }
  return out;
}

/** A raw-SQL capable client (the app client or an interactive transaction). */
export interface RawClient {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}

/** One audience row to rewrite: its new rules (null keeps a legacy row legacy) and filter. */
export interface AudienceWrite {
  id: string;
  rules: AudienceRules | null;
  filter: string;
}

/**
 * Rewrite many audience rows in ONE statement (live verification: one
 * update per audience made a tag operation's transaction grow with the
 * number of audiences). Each row gets `rules`, `filter`, `version + 1` and a
 * fresh `updatedAt`; scoped by `workspaceId`. Returns the rows written.
 */
export async function writeAudiencesBatch(client: RawClient, ws: string, rows: AudienceWrite[]): Promise<number> {
  if (!rows.length) return 0;
  const payload = JSON.stringify(rows.map((r) => ({ id: r.id, rules: r.rules, filter: r.filter })));
  return client.$executeRaw`
    UPDATE "Segment" AS s
    SET "rules" = v."rules", "filter" = v."filter", "version" = s."version" + 1, "updatedAt" = CURRENT_TIMESTAMP
    FROM jsonb_to_recordset(${payload}::jsonb) AS v("id" text, "rules" jsonb, "filter" text)
    WHERE s."id" = v."id" AND s."workspaceId" = ${ws}
  `;
}

/** Write the marked trees (one statement); `filter` becomes the nobody-sentinel. Returns how many audiences were written. */
export async function writeMarkedAudiences(client: RawClient, ws: string, list: ReferencingAudience[]): Promise<number> {
  return writeAudiencesBatch(
    client,
    ws,
    list.map((a) => ({ id: a.id, rules: a.marked, filter: LEGACY_SENTINEL_JSON })),
  );
}

/**
 * F2 (live verification): clear the cached count of every audience whose
 * membership may have changed, in two statements whatever their number:
 * - `seedIds` (rewritten or marked rows, a deleted audience);
 * - every smart audience naming one of `tagNames` (a merge target: its
 *   holders grew although its rules did not change);
 * - every smart audience reaching any of those through a `group` rule
 *   (`in` or `not_in`), transitively, up to `maxReferenceDepth` hops.
 * Written by raw SQL so `updatedAt` does not move (as `writeCountCache`).
 * Returns the cleared ids (for the HJZ re-sync after commit).
 */
export async function clearAffectedCounts(
  client: MarkingClient & RawClient,
  ws: string,
  seedIds: Iterable<string>,
  opts: { tagNames?: string[] } = {},
): Promise<string[]> {
  const rows = (await client.segment.findMany({
    where: { workspaceId: ws, origin: "crm" },
    select: { id: true, rules: true, filter: true },
  })) as Array<{ id: string; rules: unknown; filter: string }>;
  const names = new Set(opts.tagNames ?? []);
  const affected = new Set(seedIds);
  const referrers = new Map<string, string[]>();
  for (const row of rows) {
    const ids = referencedIds(readRules(row).tree);
    if (ids.tagNames.some((n) => names.has(n))) affected.add(row.id);
    for (const target of ids.segmentIds) {
      const list = referrers.get(target) ?? [];
      list.push(row.id);
      referrers.set(target, list);
    }
  }
  let frontier = [...affected];
  for (let hop = 0; hop < AUDIENCE_LIMITS.maxReferenceDepth && frontier.length; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const r of referrers.get(id) ?? []) {
        if (affected.has(r)) continue;
        affected.add(r);
        next.push(r);
      }
    }
    frontier = next;
  }
  const ids = [...affected];
  if (ids.length) {
    await client.$executeRaw`
      UPDATE "Segment" SET "memberCount" = NULL, "countedAt" = NULL
      WHERE "workspaceId" = ${ws} AND "id" = ANY(${ids}::text[])
    `;
  }
  return ids;
}

/** `{id, name, nameAr}` for 409 bodies and reference lists. */
export function audienceRefs(list: ReferencingAudience[]): Array<{ id: string; name: string; nameAr: string | null }> {
  return list.map((a) => ({ id: a.id, name: a.name, nameAr: a.nameAr }));
}
