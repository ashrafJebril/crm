/**
 * FROZEN verbatim copy of `SegmentsService.buildWhere` (and `parseFilter`) as
 * of d152351, before SP-16. Used only by the SP-16 equivalence specs, so later
 * edits to the live code cannot move the baseline. Never edit the bodies.
 */
import type { Prisma } from "@prisma/client";
import type { SegmentFilter } from "../audience-rules";

export function legacyBuildWhere(workspaceId: string, f: SegmentFilter): Prisma.ContactWhereInput {
  const where: Prisma.ContactWhereInput = { workspaceId };
  const lifecycleClauses: Prisma.ContactWhereInput[] = [];
  if (f.lifecycle && f.lifecycle.length > 0) {
    // Known values are stored lower-case, but saved filters and legacy rows
    // may be capitalised ("Lead") — match case-insensitively.
    lifecycleClauses.push({
      OR: f.lifecycle.map((v) => ({ lifecycle: { equals: v, mode: "insensitive" as const } })),
    });
  }
  if (f.industry && f.industry.length > 0) where.industry = { in: f.industry };
  if (f.source && f.source.length > 0) where.source = { in: f.source };
  if (f.search && f.search.trim().length > 0) {
    where.name = { contains: f.search.trim(), mode: "insensitive" };
  }
  if (f.hasPhone === true) where.phone = { not: null };
  if (f.hasPhone === false) where.phone = null;

  // A ticket sits in exactly one stage at a time, so "deal currently in
  // stage X" is just a stage-key match on the contact's tickets. Stage keys
  // are only unique per pipeline, but tickets are workspace-scoped already.
  if (f.stageAny && f.stageAny.length > 0) {
    where.tickets = { some: { stage: { key: { in: f.stageAny } } } };
  }

  // tags is a TEXT column holding a JSON-encoded string array like ["VIP","Pro"].
  // We don't normalize it (yet) so we match via substring on the quoted form.
  // It's not perfect — "VIP" matches "VIPER" — but in practice tag names are
  // short and curated. If false positives ever bite we'll move to a join table.
  const tagClauses: Prisma.ContactWhereInput[] = [];
  if (f.tagsAll && f.tagsAll.length > 0) {
    for (const t of f.tagsAll) {
      tagClauses.push({ tags: { contains: JSON.stringify(t) } });
    }
  }
  if (f.tagsAny && f.tagsAny.length > 0) {
    tagClauses.push({
      OR: f.tagsAny.map((t) => ({ tags: { contains: JSON.stringify(t) } })),
    });
  }
  const andClauses = [...lifecycleClauses, ...tagClauses];
  if (andClauses.length > 0) {
    where.AND = [...(Array.isArray(where.AND) ? where.AND : []), ...andClauses];
  }
  return where;
}

export function legacyParseFilter(raw: string): SegmentFilter {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}
