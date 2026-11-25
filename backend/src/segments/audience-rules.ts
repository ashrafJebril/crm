/**
 * SP-16 smart audience rule model (pure: no Prisma, no Nest DI).
 *
 * A smart audience (`Segment.origin = "crm"`) stores a v2 rule tree in
 * `Segment.rules`. A row whose `rules` is null is legacy: its `filter` JSON is
 * read as one `and` group (`legacyToTree`). On save, `filter` keeps the exact
 * legacy projection of the tree when one exists, otherwise `LEGACY_SENTINEL`,
 * which pre-SP-16 code resolves to nobody (ruling 2).
 */
import type { FieldOp } from "../custom-fields/custom-fields.service";
import { audienceError } from "./audience-errors";

/** The legacy saved-filter JSON (`Segment.filter`), unchanged since before SP-16. */
export interface SegmentFilter {
  lifecycle?: string[];
  industry?: string[];
  source?: string[];
  tagsAll?: string[]; // contact tags must contain ALL of these
  tagsAny?: string[]; // contact tags must contain ANY of these
  search?: string; // case-insensitive `name` substring
  hasPhone?: boolean;
  stageAny?: string[]; // contact has >=1 deal currently in any of these stage keys
}

export type RelUnit = "hours" | "days" | "weeks" | "months";
export type RelTime = { amount: number; unit: RelUnit };

export type CampaignRuleOp = "received" | "read" | "replied" | "not_replied" | "failed";
export type FollowUpRuleOp = "open" | "overdue" | "none_open";

export type AudienceRule = (
  | { field: "tag"; op: "has" | "not_has"; tag: string }
  | { field: "lifecycle"; op: "in" | "not_in"; values: string[] }
  | { field: "not_a_lead"; op: "is" | "is_not" }
  | { field: "last_active"; op: "within" | "more_than"; value: RelTime }
  | { field: "conversations"; op: "none" | "any" }
  | { field: "channel"; op: "is" | "is_not"; channel: string }
  | { field: "group"; op: "in" | "not_in"; segmentId: string }
  | { field: "created"; op: "within" | "more_than"; value: RelTime }
  | { field: "created"; op: "before" | "after"; date: string }
  | { field: "pipeline_stage"; op: "in" | "not_in"; pipelineId: string; stageId?: string }
  | { field: "custom_field"; op: FieldOp; defId: string; value?: string }
  | { field: "campaign"; op: CampaignRuleOp; campaignId: string }
  | { field: "follow_up"; op: FollowUpRuleOp }
  | { field: "industry" | "source"; op: "in"; values: string[] }
  | { field: "name"; op: "contains"; value: string }
  | { field: "phone"; op: "set" | "unset" }
  | { field: "stage_key"; op: "in"; keys: string[] }
) & { missing?: true };

export type AudienceGroup = { op: "and" | "or"; rules: AudienceNode[] };
export type AudienceNode = AudienceGroup | AudienceRule;
export type AudienceRules = AudienceGroup & { v: 2 };
export type AudienceField = AudienceRule["field"];

export type RuleIssueKind =
  | "tag_deleted"
  | "group_missing"
  | "field_missing"
  | "pipeline_missing"
  | "pipeline_archived"
  | "stage_missing"
  | "campaign_missing"
  | "cycle"
  /** SP-16 fix (I2): a reference chain longer than `AUDIENCE_LIMITS.maxReferenceDepth`. */
  | "too_deep";
export type RuleIssue = { path: number[]; kind: RuleIssueKind };

export const AUDIENCE_LIMITS = {
  /** Leaf conditions in one saved tree. */
  maxConditions: 30,
  /** Group nesting: the root plus two levels. */
  maxDepth: 3,
  /** Leaf conditions after inlining referenced smart audiences. */
  maxExpanded: 100,
  /** lifecycle / industry / source value lists (also stage_key lists). */
  maxValues: 10,
  /** Children of one group. */
  maxChildren: 30,
  /**
   * Smart → smart reference chain (ruling R5, fix I2): the saved tree may reach
   * at most 5 smart audiences in a row (T → A1 → … → A5). The ONE bound used by
   * save/preview validation, the lookups walk, the cycle walk and the compiler.
   */
  maxReferenceDepth: 5,
} as const;

/** An inert legacy filter: a ticket-stage key that cannot exist, so pre-SP-16 readers see nobody. */
export const LEGACY_SENTINEL: SegmentFilter = Object.freeze({ stageAny: ["__sp16_rules_v2__"] }) as SegmentFilter;
export const LEGACY_SENTINEL_JSON = JSON.stringify({ stageAny: ["__sp16_rules_v2__"] });

export const FIELD_OPS: readonly FieldOp[] = ["eq", "contains", "gt", "lt", "set", "unset"];

export function isGroup(n: AudienceNode): n is AudienceGroup {
  return typeof n === "object" && n !== null && Array.isArray((n as AudienceGroup).rules);
}

export function emptyTree(): AudienceRules {
  return { v: 2, op: "and", rules: [] };
}

// ─── Legacy filter ───────────────────────────────────────────────────────

/** `Segment.filter` text → object (pre-SP-16 semantics: anything unparsable is `{}`). */
export function parseLegacyFilter(raw: string | null | undefined): SegmentFilter {
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function strArr(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out = v.filter((x): x is string => typeof x === "string");
  return out.length ? out : null;
}

/**
 * Legacy filter → one `and` group, in `buildWhere`'s order. Empty arrays and
 * unknown keys are dropped exactly as `buildWhere` drops them; `{}` (and
 * `[]`, which `parseFilter` passes through) gives an empty root, which
 * matches the whole workspace, as before.
 */
export function legacyToTree(f: SegmentFilter | null | undefined): AudienceRules {
  const src = (f && typeof f === "object" ? f : {}) as Record<string, unknown>;
  const rules: AudienceNode[] = [];
  const lifecycle = strArr(src.lifecycle);
  if (lifecycle) rules.push({ field: "lifecycle", op: "in", values: lifecycle });
  const industry = strArr(src.industry);
  if (industry) rules.push({ field: "industry", op: "in", values: industry });
  const source = strArr(src.source);
  if (source) rules.push({ field: "source", op: "in", values: source });
  if (typeof src.search === "string" && src.search.trim().length > 0) {
    rules.push({ field: "name", op: "contains", value: src.search.trim() });
  }
  if (src.hasPhone === true) rules.push({ field: "phone", op: "set" });
  if (src.hasPhone === false) rules.push({ field: "phone", op: "unset" });
  const stageAny = strArr(src.stageAny);
  if (stageAny) rules.push({ field: "stage_key", op: "in", keys: stageAny });
  const tagsAll = strArr(src.tagsAll);
  if (tagsAll) for (const t of tagsAll) rules.push({ field: "tag", op: "has", tag: t });
  const tagsAny = strArr(src.tagsAny);
  if (tagsAny) rules.push({ op: "or", rules: tagsAny.map((t) => ({ field: "tag", op: "has", tag: t }) as AudienceRule) });
  return { v: 2, op: "and", rules };
}

/**
 * The legacy filter that selects exactly the same contacts as `tree`, or null
 * when the tree uses anything the legacy format cannot express (then the row
 * stores `LEGACY_SENTINEL`).
 */
export function legacyProjection(tree: AudienceRules): SegmentFilter | null {
  if (tree.op !== "and" && tree.rules.length > 1) return null;
  const f: SegmentFilter = {};
  const seen = new Set<string>();
  const once = (k: string) => {
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  };
  for (const n of tree.rules) {
    if (isGroup(n)) {
      if (n.op !== "or" || !once("tagsAny")) return null;
      const tags: string[] = [];
      for (const c of n.rules) {
        if (isGroup(c) || c.missing || c.field !== "tag" || c.op !== "has") return null;
        tags.push(c.tag);
      }
      if (!tags.length) return null;
      f.tagsAny = tags;
      continue;
    }
    if (n.missing) return null;
    switch (n.field) {
      case "lifecycle":
        if (n.op !== "in" || !once("lifecycle")) return null;
        f.lifecycle = [...n.values];
        break;
      case "industry":
      case "source":
        if (!once(n.field)) return null;
        f[n.field] = [...n.values];
        break;
      case "name":
        if (!once("name") || n.value.trim() !== n.value || !n.value) return null;
        f.search = n.value;
        break;
      case "phone":
        if (!once("phone")) return null;
        f.hasPhone = n.op === "set";
        break;
      case "stage_key":
        if (!once("stage_key")) return null;
        f.stageAny = [...n.keys];
        break;
      case "tag":
        if (n.op !== "has") return null;
        (f.tagsAll ??= []).push(n.tag);
        break;
      default:
        return null;
    }
  }
  // A root `or` with one child is the same as `and` with that child.
  return f;
}

/** The tree a stored row evaluates (crm only; manual/hjz resolve by membership). */
export function readRules(row: { filter?: string | null; rules?: unknown }): {
  tree: AudienceRules;
  source: "rules" | "legacy";
} {
  const r = row.rules as AudienceRules | null | undefined;
  if (r && typeof r === "object" && r.v === 2 && Array.isArray(r.rules)) return { tree: r, source: "rules" };
  return { tree: legacyToTree(parseLegacyFilter(row.filter ?? "{}")), source: "legacy" };
}

// ─── Validation ──────────────────────────────────────────────────────────

const REL_UNITS: readonly RelUnit[] = ["hours", "days", "weeks", "months"];
const CAMPAIGN_OPS: readonly CampaignRuleOp[] = ["received", "read", "replied", "not_replied", "failed"];
const FOLLOW_UP_OPS: readonly FollowUpRuleOp[] = ["open", "overdue", "none_open"];
const ID_MAX = 64;

function invalid(path: number[], reason: string): never {
  throw audienceError("audiences.invalid_rules", { path, reason });
}

function reqStr(v: unknown, path: number[], max: number, reason = "bad_value"): string {
  if (typeof v !== "string") invalid(path, reason);
  const t = v.trim();
  if (!t || t.length > max) invalid(path, reason);
  return t;
}

function reqId(v: unknown, path: number[]): string {
  return reqStr(v, path, ID_MAX, "bad_id");
}

function reqList(v: unknown, path: number[], max: number): string[] {
  if (!Array.isArray(v) || v.length === 0) invalid(path, "bad_value");
  if (v.length > max) invalid(path, "too_many_values");
  const out = v.map((x) => reqStr(x, path, 200));
  return [...new Set(out)];
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], path: number[], reason = "bad_op"): T {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) invalid(path, reason);
  return v as T;
}

function relTime(v: unknown, path: number[]): RelTime {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object") invalid(path, "bad_reltime");
  const amount = o.amount;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 1 || amount > 1000) invalid(path, "bad_reltime");
  if (typeof o.unit !== "string" || !(REL_UNITS as readonly string[]).includes(o.unit)) invalid(path, "bad_reltime");
  return { amount, unit: o.unit as RelUnit };
}

/** A real calendar date `YYYY-MM-DD` (workspace time). */
export function isCalendarDate(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d && y >= 1970 && y <= 2999;
}

function validateRule(o: Record<string, unknown>, path: number[]): AudienceRule {
  const missing = o.missing === true ? ({ missing: true } as const) : {};
  if (o.missing !== undefined && o.missing !== true) invalid(path, "bad_value");
  const field = o.field;
  switch (field) {
    case "tag":
      return { field, op: oneOf(o.op, ["has", "not_has"] as const, path), tag: reqStr(o.tag, path, 100), ...missing };
    case "lifecycle":
      return { field, op: oneOf(o.op, ["in", "not_in"] as const, path), values: reqList(o.values, path, AUDIENCE_LIMITS.maxValues), ...missing };
    case "not_a_lead":
      return { field, op: oneOf(o.op, ["is", "is_not"] as const, path), ...missing };
    case "last_active":
      return { field, op: oneOf(o.op, ["within", "more_than"] as const, path), value: relTime(o.value, path), ...missing };
    case "conversations":
      return { field, op: oneOf(o.op, ["none", "any"] as const, path), ...missing };
    case "channel": {
      const op = oneOf(o.op, ["is", "is_not"] as const, path);
      if (typeof o.channel !== "string" || !/^[a-z_]{1,32}$/.test(o.channel)) invalid(path, "bad_value");
      return { field, op, channel: o.channel, ...missing };
    }
    case "group":
      return { field, op: oneOf(o.op, ["in", "not_in"] as const, path), segmentId: reqId(o.segmentId, path), ...missing };
    case "created": {
      const op = oneOf(o.op, ["within", "more_than", "before", "after"] as const, path);
      if (op === "within" || op === "more_than") return { field, op, value: relTime(o.value, path), ...missing };
      if (!isCalendarDate(o.date)) invalid(path, "bad_date");
      return { field, op, date: o.date as string, ...missing };
    }
    case "pipeline_stage": {
      const op = oneOf(o.op, ["in", "not_in"] as const, path);
      const pipelineId = reqId(o.pipelineId, path);
      if (o.stageId === undefined || o.stageId === null || o.stageId === "") return { field, op, pipelineId, ...missing };
      return { field, op, pipelineId, stageId: reqId(o.stageId, path), ...missing };
    }
    case "custom_field": {
      const op = oneOf(o.op, FIELD_OPS, path);
      const defId = reqId(o.defId, path);
      if (op === "set" || op === "unset") return { field, op, defId, ...missing };
      if (typeof o.value !== "string" || o.value.length > 500) invalid(path, "bad_value");
      return { field, op, defId, value: o.value as string, ...missing };
    }
    case "campaign":
      return { field, op: oneOf(o.op, CAMPAIGN_OPS, path), campaignId: reqId(o.campaignId, path), ...missing };
    case "follow_up":
      return { field, op: oneOf(o.op, FOLLOW_UP_OPS, path), ...missing };
    case "industry":
    case "source":
      return { field, op: oneOf(o.op, ["in"] as const, path), values: reqList(o.values, path, AUDIENCE_LIMITS.maxValues), ...missing };
    case "name":
      return { field, op: oneOf(o.op, ["contains"] as const, path), value: reqStr(o.value, path, 200), ...missing };
    case "phone":
      return { field, op: oneOf(o.op, ["set", "unset"] as const, path), ...missing };
    case "stage_key":
      return { field, op: oneOf(o.op, ["in"] as const, path), keys: reqList(o.keys, path, 20), ...missing };
    default:
      return invalid(path, "unknown_field");
  }
}

/**
 * Validate a client-sent tree: shape, operators, value formats, size (at
 * most 30 leaf conditions) and depth (root plus two levels). Returns a
 * normalized copy (trimmed strings, unknown keys dropped). Reference
 * existence is checked separately (`assertReferencesExist`).
 */
export function validateRules(input: unknown): AudienceRules {
  const root = input as Record<string, unknown> | null;
  if (!root || typeof root !== "object" || Array.isArray(root)) invalid([], "not_object");
  if (root.v !== 2) invalid([], "bad_version");
  let conditions = 0;

  const group = (o: Record<string, unknown>, path: number[], depth: number, isRoot: boolean): AudienceGroup => {
    if (depth > AUDIENCE_LIMITS.maxDepth) throw audienceError("audiences.rule_too_deep", { max: AUDIENCE_LIMITS.maxDepth });
    const op = oneOf(o.op, ["and", "or"] as const, path);
    if (!Array.isArray(o.rules)) invalid(path, "bad_group");
    if (o.rules.length === 0 && !isRoot) invalid(path, "empty_group");
    if (o.rules.length > AUDIENCE_LIMITS.maxChildren) {
      throw audienceError("audiences.rules_too_large", { max: AUDIENCE_LIMITS.maxConditions });
    }
    const rules = o.rules.map((c: unknown, i: number): AudienceNode => {
      const p = [...path, i];
      if (!c || typeof c !== "object" || Array.isArray(c)) invalid(p, "not_object");
      const co = c as Record<string, unknown>;
      if (Array.isArray(co.rules) || co.field === undefined) return group(co, p, depth + 1, false);
      conditions += 1;
      if (conditions > AUDIENCE_LIMITS.maxConditions) {
        throw audienceError("audiences.rules_too_large", { max: AUDIENCE_LIMITS.maxConditions });
      }
      return validateRule(co, p);
    });
    return { op, rules };
  };

  const g = group(root, [], 1, true);
  return { v: 2, op: g.rules.length ? g.op : "and", rules: g.rules };
}

// ─── Walking and rewriting ───────────────────────────────────────────────

/** Visit every leaf rule with its child-index path. */
export function walkRules(tree: AudienceGroup, fn: (rule: AudienceRule, path: number[]) => void, base: number[] = []): void {
  tree.rules.forEach((n, i) => {
    const p = [...base, i];
    if (isGroup(n)) walkRules(n, fn, p);
    else fn(n, p);
  });
}

/** Leaf rule count. */
export function countConditions(tree: AudienceGroup): number {
  let n = 0;
  walkRules(tree, () => (n += 1));
  return n;
}

export interface ReferencedIds {
  segmentIds: string[];
  pipelineIds: string[];
  stageIds: string[];
  defIds: string[];
  campaignIds: string[];
  tagNames: string[];
}

/** Everything a tree references by id or name. Rules marked `missing` are skipped. */
export function referencedIds(tree: AudienceGroup): ReferencedIds {
  const s = { segmentIds: new Set<string>(), pipelineIds: new Set<string>(), stageIds: new Set<string>(), defIds: new Set<string>(), campaignIds: new Set<string>(), tagNames: new Set<string>() };
  walkRules(tree, (r) => {
    if (r.missing) return;
    if (r.field === "group") s.segmentIds.add(r.segmentId);
    else if (r.field === "pipeline_stage") {
      s.pipelineIds.add(r.pipelineId);
      if (r.stageId) s.stageIds.add(r.stageId);
    } else if (r.field === "custom_field") s.defIds.add(r.defId);
    else if (r.field === "campaign") s.campaignIds.add(r.campaignId);
    else if (r.field === "tag") s.tagNames.add(r.tag);
  });
  return {
    segmentIds: [...s.segmentIds],
    pipelineIds: [...s.pipelineIds],
    stageIds: [...s.stageIds],
    defIds: [...s.defIds],
    campaignIds: [...s.campaignIds],
    tagNames: [...s.tagNames],
  };
}

/** True when the tree has a `created before/after` rule (needs the workspace timezone). */
export function needsTimezone(tree: AudienceGroup): boolean {
  let yes = false;
  walkRules(tree, (r) => {
    if (r.field === "created" && (r.op === "before" || r.op === "after")) yes = true;
  });
  return yes;
}

function mapGroup<T extends AudienceGroup>(g: T, fn: (r: AudienceRule) => AudienceRule | null): T {
  const rules: AudienceNode[] = [];
  for (const n of g.rules) {
    if (isGroup(n)) rules.push(mapGroup(n, fn));
    else {
      const m = fn(n);
      if (m) rules.push(m);
    }
  }
  return { ...g, rules };
}

/**
 * Rename a tag inside the rules (exact name). Returns the new tree, or null
 * when nothing changed. Sibling tag rules that become identical (a merge of
 * two tags into one) are deduplicated; a group never becomes empty, because
 * the first of the duplicates is kept. `missing` rules are left alone.
 */
export function rewriteRulesTagName(tree: AudienceRules, from: string, to: string): AudienceRules | null {
  if (from === to) return null;
  let changed = false;
  const visit = (g: AudienceGroup): AudienceGroup => {
    let touched = false;
    const rules = g.rules.map((n): AudienceNode => {
      if (isGroup(n)) return visit(n);
      if (n.field === "tag" && !n.missing && n.tag === from) {
        changed = true;
        touched = true;
        return { ...n, tag: to };
      }
      return n;
    });
    if (!touched) return { ...g, rules };
    const seen = new Set<string>();
    const deduped = rules.filter((n) => {
      if (isGroup(n) || n.field !== "tag" || n.missing) return true;
      const k = `${n.op}\u0000${n.tag}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return { ...g, rules: deduped };
  };
  const out = visit(tree) as AudienceRules;
  return changed ? { ...out, v: 2 } : null;
}

/** Mark every rule matching `predicate` as `missing: true` (never removes a rule). */
export function markRules(tree: AudienceRules, predicate: (r: AudienceRule) => boolean): { tree: AudienceRules; marked: number } {
  let marked = 0;
  const out = mapGroup(tree, (r) => {
    if (r.missing || !predicate(r)) return r;
    marked += 1;
    return { ...r, missing: true };
  });
  return { tree: out, marked };
}

// ─── Time ────────────────────────────────────────────────────────────────

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * The instant `value` before `now`. Months are calendar months in UTC; a
 * day that does not exist in the target month clamps to its last day
 * (Mar 31 minus 1 month is Feb 28, not Mar 3).
 */
export function relativeSince(now: Date, value: RelTime): Date {
  const t = now.getTime();
  switch (value.unit) {
    case "hours":
      return new Date(t - value.amount * HOUR);
    case "days":
      return new Date(t - value.amount * DAY);
    case "weeks":
      return new Date(t - value.amount * 7 * DAY);
    case "months": {
      const y = now.getUTCFullYear();
      const m = now.getUTCMonth() - value.amount;
      const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      const d = Math.min(now.getUTCDate(), last);
      return new Date(Date.UTC(y, m, d, now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds(), now.getUTCMilliseconds()));
    }
  }
}
