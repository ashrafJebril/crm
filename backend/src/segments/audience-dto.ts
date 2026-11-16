import { parseLegacyFilter, readRules, type AudienceRules, type RuleIssue, type SegmentFilter } from "./audience-rules";

/** SP-16 audience row (Global Constraints → DTO; frontend `Segment` in src/lib/types.ts). */
export interface AudienceRow {
  id: string;
  name: string;
  nameAr: string | null;
  color: string | null;
  origin: "crm" | "manual" | "hjz";
  /** Unchanged legacy JSON (or the sentinel for a v2 row). */
  filter: SegmentFilter;
  /** crm: always a tree (a legacy filter converted); manual/hjz: null. */
  rules: AudienceRules | null;
  rulesSource: "rules" | "legacy" | null;
  count: number | null;
  countedAt: string | null;
  timedOut: boolean;
  /** SP-16 M4: not counted in this request (list deadline, or a pool/transaction timeout); present only when true. */
  skipped?: true;
  issues: RuleIssue[];
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface SegmentRowLike {
  id: string;
  name: string;
  nameAr?: string | null;
  color?: string | null;
  origin: string;
  filter: string;
  rules?: unknown;
  version?: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export function toAudienceRow(
  row: SegmentRowLike,
  extra: { count?: number | null; countedAt?: Date | null; timedOut?: boolean; skipped?: boolean; issues?: RuleIssue[] } = {},
): AudienceRow {
  const crm = row.origin === "crm";
  const read = crm ? readRules(row) : null;
  return {
    id: row.id,
    name: row.name,
    nameAr: row.nameAr ?? null,
    color: row.color ?? null,
    origin: row.origin as AudienceRow["origin"],
    filter: parseLegacyFilter(row.filter),
    rules: read ? read.tree : null,
    rulesSource: read ? read.source : null,
    count: extra.count ?? null,
    countedAt: extra.countedAt ? extra.countedAt.toISOString() : null,
    timedOut: extra.timedOut ?? false,
    ...(extra.skipped ? { skipped: true as const } : {}),
    issues: extra.issues ?? [],
    version: row.version ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
