/**
 * SP-16: everything the audience compiler needs from the database, loaded up
 * front so `compileAudience` stays pure. Every query carries `workspaceId`,
 * so a foreign id is simply absent (and answers 404 on save, ruling 6 at
 * evaluation time).
 */
import { DEFAULT_TZ, validTz } from "../activities/buckets";
import { audienceError } from "./audience-errors";
import { AUDIENCE_LIMITS, needsTimezone, readRules, referencedIds, type AudienceRules, type ReferencedIds } from "./audience-rules";

export interface LookupSegment {
  id: string;
  origin: string;
  rules: unknown;
  filter: string;
}

export interface AudienceLookups {
  segments: Map<string, LookupSegment>;
  pipelines: Map<string, { id: string; archivedAt: Date | null }>;
  stages: Map<string, { id: string; pipelineId: string }>;
  defs: Map<string, { id: string; type: string; archivedAt: Date | null }>;
  campaigns: Map<string, { id: string }>;
  timezone: string;
}

/** The subset of Prisma the lookups read (a transaction client works too). */
export interface LookupsPrisma {
  segment: { findMany(args: unknown): Promise<unknown[]> };
  pipeline: { findMany(args: unknown): Promise<unknown[]> };
  ticketStage: { findMany(args: unknown): Promise<unknown[]> };
  customFieldDef: { findMany(args: unknown): Promise<unknown[]> };
  campaign: { findMany(args: unknown): Promise<unknown[]> };
  workspace: { findUnique(args: unknown): Promise<unknown> };
}

export function emptyLookups(timezone = DEFAULT_TZ): AudienceLookups {
  return { segments: new Map(), pipelines: new Map(), stages: new Map(), defs: new Map(), campaigns: new Map(), timezone };
}

/**
 * Levels of referenced segments to load: hops 1..maxReferenceDepth are the
 * smart audiences the compiler may inline, and one more hop loads the groups
 * the deepest of them names (a manual group there still resolves; a smart one
 * is `too_deep` in the compiler). Same bound as save and the cycle walk (fix I2).
 */
export const LOOKUP_SEGMENT_LEVELS = AUDIENCE_LIMITS.maxReferenceDepth + 1;
/** Safety cap on the closure size; a segment cut off here compiles to `group_missing` (nobody). */
const MAX_SEGMENTS = 500;

/**
 * Load the lookups for `trees`: the referenced segments and, transitively,
 * the smart audiences they reference (one query per level), then the
 * pipelines, stages, custom-field defs and campaigns of the whole closure
 * (one query per kind), and the workspace timezone when a `created
 * before/after` rule needs it. Kinds with no ids make no query.
 */
export async function loadLookups(prisma: LookupsPrisma, ws: string, trees: AudienceRules[]): Promise<AudienceLookups> {
  const out = emptyLookups();
  const all: ReferencedIds[] = trees.map(referencedIds);
  let tz = trees.some(needsTimezone);

  let frontier = [...new Set(all.flatMap((r) => r.segmentIds))];
  for (let level = 0; frontier.length && level < LOOKUP_SEGMENT_LEVELS && out.segments.size < MAX_SEGMENTS; level++) {
    const rows = (await prisma.segment.findMany({
      where: { workspaceId: ws, id: { in: frontier } },
      select: { id: true, origin: true, rules: true, filter: true },
    })) as LookupSegment[];
    const next = new Set<string>();
    for (const row of rows) {
      out.segments.set(row.id, row);
      if (row.origin !== "crm") continue;
      const { tree } = readRules(row);
      const ids = referencedIds(tree);
      all.push(ids);
      if (needsTimezone(tree)) tz = true;
      for (const id of ids.segmentIds) if (!out.segments.has(id)) next.add(id);
    }
    frontier = [...next].filter((id) => !out.segments.has(id));
  }

  const uniq = (k: keyof ReferencedIds) => [...new Set(all.flatMap((r) => r[k]))];
  const pipelineIds = uniq("pipelineIds");
  const stageIds = uniq("stageIds");
  const defIds = uniq("defIds");
  const campaignIds = uniq("campaignIds");

  const [pipelines, stages, defs, campaigns, wsRow] = await Promise.all([
    pipelineIds.length
      ? prisma.pipeline.findMany({ where: { workspaceId: ws, id: { in: pipelineIds } }, select: { id: true, archivedAt: true } })
      : Promise.resolve([]),
    stageIds.length
      ? prisma.ticketStage.findMany({ where: { workspaceId: ws, id: { in: stageIds } }, select: { id: true, pipelineId: true } })
      : Promise.resolve([]),
    defIds.length
      ? prisma.customFieldDef.findMany({ where: { workspaceId: ws, id: { in: defIds } }, select: { id: true, type: true, archivedAt: true } })
      : Promise.resolve([]),
    campaignIds.length
      ? prisma.campaign.findMany({ where: { workspaceId: ws, id: { in: campaignIds } }, select: { id: true } })
      : Promise.resolve([]),
    tz ? prisma.workspace.findUnique({ where: { id: ws }, select: { timezone: true } }) : Promise.resolve(null),
  ]);
  for (const p of pipelines as Array<{ id: string; archivedAt: Date | null }>) out.pipelines.set(p.id, p);
  for (const s of stages as Array<{ id: string; pipelineId: string }>) out.stages.set(s.id, s);
  for (const d of defs as Array<{ id: string; type: string; archivedAt: Date | null }>) out.defs.set(d.id, d);
  for (const c of campaigns as Array<{ id: string }>) out.campaigns.set(c.id, c);
  const t = (wsRow as { timezone?: string } | null)?.timezone;
  if (t) out.timezone = validTz(t);
  return out;
}

/**
 * 404 `audiences.reference_not_found {field, id}` for the first id of a saved
 * tree that is missing from (or foreign to) the workspace. Archived pipelines
 * and fields exist, so they pass and surface as rule issues instead.
 */
export function assertReferencesExist(lookups: AudienceLookups, ids: ReferencedIds): void {
  const check = (list: string[], has: (id: string) => boolean, field: string) => {
    for (const id of list) if (!has(id)) throw audienceError("audiences.reference_not_found", { field, id });
  };
  check(ids.segmentIds, (id) => lookups.segments.has(id), "segmentId");
  check(ids.pipelineIds, (id) => lookups.pipelines.has(id), "pipelineId");
  check(ids.stageIds, (id) => lookups.stages.has(id), "stageId");
  check(ids.defIds, (id) => lookups.defs.has(id), "defId");
  check(ids.campaignIds, (id) => lookups.campaigns.has(id), "campaignId");
}
