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
 * 409 instead of writing the old rule back) and clears the count cache.
 */
import type { Prisma } from "@prisma/client";
import { LEGACY_SENTINEL_JSON, markRules, readRules, type AudienceRule, type AudienceRules } from "./audience-rules";

/** The Prisma surface needed (the app client or an interactive transaction). */
export interface MarkingClient {
  segment: {
    findMany(args: unknown): Promise<unknown[]>;
    update(args: unknown): Promise<unknown>;
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

/** Write the marked trees (one update per audience). Returns how many audiences were written. */
export async function writeMarkedAudiences(client: MarkingClient, ws: string, list: ReferencingAudience[]): Promise<number> {
  for (const a of list) {
    await client.segment.update({
      where: { id: a.id, workspaceId: ws },
      data: {
        rules: a.marked as unknown as Prisma.InputJsonValue,
        filter: LEGACY_SENTINEL_JSON,
        version: { increment: 1 },
        memberCount: null,
        countedAt: null,
      },
    });
  }
  return list.length;
}

/** `{id, name, nameAr}` for 409 bodies and reference lists. */
export function audienceRefs(list: ReferencingAudience[]): Array<{ id: string; name: string; nameAr: string | null }> {
  return list.map((a) => ({ id: a.id, name: a.name, nameAr: a.nameAr }));
}
