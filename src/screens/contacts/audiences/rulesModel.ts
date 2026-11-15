/**
 * SP-16 smart audience rule model: the frontend mirror of backend
 * `segments/audience-rules.ts`. Pure (no React, no fetch), so it is unit
 * tested. The server stays authoritative: `legacyToTree` here is for display
 * and editing only, and every save or preview is validated again server-side.
 */
import type {
  AudienceField,
  AudienceGroup,
  AudienceNode,
  AudienceRule,
  AudienceRules,
  CustomFieldType,
  RelTime,
  RelUnit,
  RuleIssue,
  RuleIssueKind,
  SegmentFilter,
} from "@/lib/types";
import type { Tx } from "@/lib/tx";
import { lifecycleLabel } from "../lifecycle";

export const AUDIENCE_LIMITS = {
  /** Leaf conditions in one saved tree. */
  maxConditions: 30,
  /** Group nesting: the root plus two levels. */
  maxDepth: 3,
  /** Leaf conditions after inlining referenced smart audiences (server-side check). */
  maxExpanded: 100,
  /** lifecycle / industry / source value lists. */
  maxValues: 10,
  /** Children of one group. */
  maxChildren: 30,
  /** Smart → smart reference chain (server-side check, reason `too_deep`). */
  maxReferenceDepth: 5,
} as const;

export const RULE_ISSUE_KINDS: readonly RuleIssueKind[] = [
  "tag_deleted",
  "group_missing",
  "field_missing",
  "pipeline_missing",
  "pipeline_archived",
  "stage_missing",
  "campaign_missing",
  "cycle",
  "too_deep",
];

export const REL_UNITS: readonly RelUnit[] = ["hours", "days", "weeks", "months"];

export function isGroup(n: AudienceNode): n is AudienceGroup {
  return typeof n === "object" && n !== null && Array.isArray((n as AudienceGroup).rules);
}

export function emptyTree(): AudienceRules {
  return { v: 2, op: "and", rules: [] };
}

const isArabic = (tx: Tx): boolean => tx("en", "ar") === "ar";
const fmtNum = (n: number, tx: Tx): string => n.toLocaleString(isArabic(tx) ? "ar" : "en-US");

// ─── Legacy filter (display only; the server converts the same way) ──────

function strArr(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out = v.filter((x): x is string => typeof x === "string");
  return out.length ? out : null;
}

/** Legacy filter → one `and` group, in the backend `buildWhere` order. `{}` is the whole workspace. */
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
  if (tagsAny) rules.push({ op: "or", rules: tagsAny.map((t): AudienceRule => ({ field: "tag", op: "has", tag: t })) });
  return { v: 2, op: "and", rules };
}

/**
 * True when pre-SP-16 code can still read this audience exactly (the server
 * then stores the legacy projection instead of the "nobody" sentinel). Shown
 * in developer tools only, never to users.
 */
export function isLegacyExpressible(tree: AudienceRules): boolean {
  if (tree.op !== "and" && tree.rules.length > 1) return false;
  const seen = new Set<string>();
  const once = (k: string) => (seen.has(k) ? false : (seen.add(k), true));
  for (const n of tree.rules) {
    if (isGroup(n)) {
      if (n.op !== "or" || !once("tagsAny") || n.rules.length === 0) return false;
      for (const c of n.rules) if (isGroup(c) || c.missing || c.field !== "tag" || c.op !== "has") return false;
      continue;
    }
    if (n.missing) return false;
    switch (n.field) {
      case "lifecycle":
        if (n.op !== "in" || !once("lifecycle")) return false;
        break;
      case "industry":
      case "source":
      case "phone":
      case "stage_key":
        if (!once(n.field)) return false;
        break;
      case "name":
        if (!once("name") || !n.value || n.value.trim() !== n.value) return false;
        break;
      case "tag":
        if (n.op !== "has") return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

// ─── Fields and operators ────────────────────────────────────────────────

export type ValueKind =
  | "tag"
  | "lifecycle"
  | "none"
  | "reltime"
  | "channel"
  | "group"
  | "created"
  | "pipeline"
  | "custom_field"
  | "campaign"
  | "values"
  | "text"
  | "keys";

export interface FieldDef {
  ops: readonly string[];
  kind: ValueKind;
  label: [en: string, ar: string];
  /** Legacy fields: shown and kept, not offered for new conditions. */
  legacy?: boolean;
}

export const FIELD_DEFS: Record<AudienceField, FieldDef> = {
  tag: { ops: ["has", "not_has"], kind: "tag", label: ["Tag", "الوسم"] },
  lifecycle: { ops: ["in", "not_in"], kind: "lifecycle", label: ["Lifecycle", "مرحلة العميل"] },
  not_a_lead: { ops: ["is", "is_not"], kind: "none", label: ["Not a lead", "ليس عميلًا محتملًا"] },
  last_active: { ops: ["within", "more_than"], kind: "reltime", label: ["Last active", "آخر نشاط"] },
  conversations: { ops: ["any", "none"], kind: "none", label: ["Conversations", "المحادثات"] },
  channel: { ops: ["is", "is_not"], kind: "channel", label: ["Channel", "القناة"] },
  group: { ops: ["in", "not_in"], kind: "group", label: ["Group or audience", "مجموعة أو جمهور"] },
  created: { ops: ["within", "more_than", "before", "after"], kind: "created", label: ["Created", "تاريخ الإنشاء"] },
  pipeline_stage: { ops: ["in", "not_in"], kind: "pipeline", label: ["Pipeline stage", "مرحلة المسار"] },
  custom_field: { ops: ["eq", "contains", "gt", "lt", "set", "unset"], kind: "custom_field", label: ["Custom field", "حقل مخصص"] },
  campaign: { ops: ["received", "read", "replied", "not_replied", "failed"], kind: "campaign", label: ["Campaign", "حملة"] },
  follow_up: { ops: ["open", "overdue", "none_open"], kind: "none", label: ["Follow-ups", "المتابعات"] },
  industry: { ops: ["in"], kind: "values", label: ["Industry", "القطاع"], legacy: true },
  source: { ops: ["in"], kind: "values", label: ["Source", "المصدر"], legacy: true },
  name: { ops: ["contains"], kind: "text", label: ["Name", "الاسم"], legacy: true },
  phone: { ops: ["set", "unset"], kind: "none", label: ["Phone", "الهاتف"], legacy: true },
  stage_key: { ops: ["in"], kind: "keys", label: ["Deal stage key", "مفتاح مرحلة الصفقة"], legacy: true },
};

/** Fields offered when adding a condition (legacy ones are kept when present, not offered). */
export const NEW_RULE_FIELDS = (Object.keys(FIELD_DEFS) as AudienceField[]).filter((f) => !FIELD_DEFS[f].legacy);

export const fieldLabel = (field: AudienceField, tx: Tx): string => tx(...FIELD_DEFS[field].label);

/** Custom-field operators allowed for a field type (same as the contacts filter). */
export function customOpsForType(type: CustomFieldType | undefined): string[] {
  switch (type) {
    case "text": return ["eq", "contains", "set", "unset"];
    case "number":
    case "date": return ["eq", "gt", "lt", "set", "unset"];
    default: return ["eq", "set", "unset"];
  }
}

/** The operator as the editor's select shows it. */
export function opLabel(field: AudienceField, op: string, tx: Tx, valueType?: CustomFieldType): string {
  const k = `${field}:${op}`;
  switch (k) {
    case "tag:has": return tx("has", "لديه");
    case "tag:not_has": return tx("doesn't have", "ليس لديه");
    case "lifecycle:in": return tx("is any of", "أيٌّ من");
    case "lifecycle:not_in": return tx("is none of", "ليست أيًّا من");
    case "not_a_lead:is": return tx("is marked", "مُعلَّم");
    case "not_a_lead:is_not": return tx("isn't marked", "غير مُعلَّم");
    case "last_active:within":
    case "created:within": return tx("within the last", "خلال آخر");
    case "last_active:more_than": return tx("more than … ago, or never", "قبل أكثر من … أو أبدًا");
    case "created:more_than": return tx("more than … ago", "قبل أكثر من …");
    case "created:before": return tx("before", "قبل");
    case "created:after": return tx("after", "بعد");
    case "conversations:any": return tx("at least one", "واحدة على الأقل");
    case "conversations:none": return tx("none", "لا توجد");
    case "channel:is": return tx("has a conversation on", "لديه محادثة على");
    case "channel:is_not": return tx("has no conversation on", "ليست لديه محادثة على");
    case "group:in": return tx("is in", "ضمن");
    case "group:not_in": return tx("is not in", "ليس ضمن");
    case "pipeline_stage:in": return tx("has a card in", "لديه بطاقة في");
    case "pipeline_stage:not_in": return tx("has no card in", "ليست لديه بطاقة في");
    case "custom_field:eq": return tx("is", "يساوي");
    case "custom_field:contains": return tx("contains", "يحتوي على");
    case "custom_field:gt": return valueType === "date" ? tx("is after", "بعد") : tx("is greater than", "أكبر من");
    case "custom_field:lt": return valueType === "date" ? tx("is before", "قبل") : tx("is less than", "أقل من");
    case "custom_field:set": return tx("has a value", "له قيمة");
    case "custom_field:unset": return tx("is empty", "فارغ");
    case "campaign:received": return tx("received", "استلم");
    case "campaign:read": return tx("read", "قرأ");
    case "campaign:replied": return tx("replied to", "ردّ على");
    case "campaign:not_replied": return tx("received and didn't reply to", "استلم ولم يردّ على");
    case "campaign:failed": return tx("failed to reach them", "فشل الإرسال إليه");
    case "follow_up:open": return tx("has an open one", "توجد متابعة مفتوحة");
    case "follow_up:overdue": return tx("has an overdue one", "توجد متابعة متأخرة");
    case "follow_up:none_open": return tx("has no open one", "لا توجد متابعة مفتوحة");
    case "industry:in":
    case "source:in":
    case "stage_key:in": return tx("is any of", "أيٌّ من");
    case "name:contains": return tx("contains", "يحتوي على");
    case "phone:set": return tx("is set", "موجود");
    case "phone:unset": return tx("is missing", "غير موجود");
    default: return op;
  }
}

/** A fresh condition for a field, with an empty value the user still has to fill in. */
export function emptyRule(field: AudienceField): AudienceRule {
  switch (field) {
    case "tag": return { field, op: "has", tag: "" };
    case "lifecycle": return { field, op: "in", values: [] };
    case "not_a_lead": return { field, op: "is" };
    case "last_active": return { field, op: "within", value: { amount: 7, unit: "days" } };
    case "conversations": return { field, op: "any" };
    case "channel": return { field, op: "is", channel: "whatsapp" };
    case "group": return { field, op: "in", segmentId: "" };
    case "created": return { field, op: "within", value: { amount: 30, unit: "days" } };
    case "pipeline_stage": return { field, op: "in", pipelineId: "" };
    case "custom_field": return { field, op: "eq", defId: "", value: "" };
    case "campaign": return { field, op: "replied", campaignId: "" };
    case "follow_up": return { field, op: "open" };
    case "industry":
    case "source": return { field, op: "in", values: [] };
    case "name": return { field, op: "contains", value: "" };
    case "phone": return { field, op: "set" };
    case "stage_key": return { field, op: "in", keys: [] };
  }
}

/** The rule with a new operator; `created` switches between a relative time and a date. */
export function withOp(rule: AudienceRule, op: string): AudienceRule {
  if (rule.field === "created") {
    const rel = op === "within" || op === "more_than";
    if (rel) return { field: "created", op, value: "value" in rule ? rule.value : { amount: 30, unit: "days" } } as AudienceRule;
    return { field: "created", op, date: "date" in rule ? rule.date : "" } as AudienceRule;
  }
  if (rule.field === "custom_field" && (op === "set" || op === "unset")) {
    return { field: "custom_field", op, defId: rule.defId };
  }
  if (rule.field === "custom_field") return { ...rule, op: op as AudienceRule["op"], value: rule.value ?? "" } as AudienceRule;
  return { ...rule, op } as AudienceRule;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const relOk = (v: RelTime | undefined) => !!v && Number.isInteger(v.amount) && v.amount >= 1 && v.amount <= 1000 && REL_UNITS.includes(v.unit);

/** True when the condition has every value it needs (the server checks again). */
export function isRuleComplete(r: AudienceRule): boolean {
  switch (r.field) {
    case "tag": return r.tag.trim().length > 0;
    case "lifecycle":
    case "industry":
    case "source": return r.values.length > 0 && r.values.length <= AUDIENCE_LIMITS.maxValues;
    case "last_active": return relOk(r.value);
    case "created": return "value" in r ? relOk(r.value) : DATE_RE.test(r.date);
    case "channel": return /^[a-z_]{1,32}$/.test(r.channel);
    case "group": return !!r.segmentId;
    case "pipeline_stage": return !!r.pipelineId;
    case "custom_field": return !!r.defId && (r.op === "set" || r.op === "unset" || (typeof r.value === "string" && r.value !== ""));
    case "campaign": return !!r.campaignId;
    case "name": return r.value.trim().length > 0;
    case "stage_key": return r.keys.length > 0;
    default: return true;
  }
}

/** Every condition is filled in and no nested group is empty. */
export function treeComplete(g: AudienceGroup, isRoot = true): boolean {
  if (!isRoot && g.rules.length === 0) return false;
  return g.rules.every((n) => (isGroup(n) ? treeComplete(n, false) : isRuleComplete(n)));
}

// ─── Tree editing (immutable, path based) ────────────────────────────────

export type Path = number[];

export function nodeAt(tree: AudienceGroup, path: Path): AudienceNode | null {
  let cur: AudienceNode = tree;
  for (const i of path) {
    if (!isGroup(cur)) return null;
    const next: AudienceNode | undefined = cur.rules[i];
    if (!next) return null;
    cur = next;
  }
  return cur;
}

function mapGroup<T extends AudienceGroup>(g: T, path: Path, fn: (g: AudienceGroup) => AudienceGroup): T {
  if (path.length === 0) return { ...g, ...fn(g) } as T;
  const [i, ...rest] = path;
  const child = g.rules[i!];
  if (!child || !isGroup(child)) return g;
  const rules = g.rules.slice();
  rules[i!] = mapGroup(child, rest, fn);
  return { ...g, rules };
}

export function addRule(tree: AudienceRules, groupPath: Path, rule: AudienceRule = emptyRule("tag")): AudienceRules {
  return mapGroup(tree, groupPath, (g) => ({ ...g, rules: [...g.rules, rule] }));
}

/** A nested group starts with one condition (the server refuses empty nested groups). */
export function addGroup(tree: AudienceRules, groupPath: Path, rule: AudienceRule = emptyRule("tag")): AudienceRules {
  return mapGroup(tree, groupPath, (g) => ({ ...g, rules: [...g.rules, { op: g.op === "and" ? "or" : "and", rules: [rule] }] }));
}

export function replaceAt(tree: AudienceRules, path: Path, node: AudienceNode): AudienceRules {
  if (path.length === 0) return tree;
  const parent = path.slice(0, -1);
  const idx = path[path.length - 1]!;
  return mapGroup(tree, parent, (g) => ({ ...g, rules: g.rules.map((n, i) => (i === idx ? node : n)) }));
}

export function setGroupOp(tree: AudienceRules, groupPath: Path, op: "and" | "or"): AudienceRules {
  return mapGroup(tree, groupPath, (g) => ({ ...g, op }));
}

/** Removes the node; a nested group left empty is removed too. */
export function removeAt(tree: AudienceRules, path: Path): AudienceRules {
  if (path.length === 0) return tree;
  const parent = path.slice(0, -1);
  const idx = path[path.length - 1]!;
  const next = mapGroup(tree, parent, (g) => ({ ...g, rules: g.rules.filter((_, i) => i !== idx) }));
  const p = nodeAt(next, parent);
  if (parent.length > 0 && p && isGroup(p) && p.rules.length === 0) return removeAt(next, parent);
  return next;
}

export function countConditions(g: AudienceGroup): number {
  return g.rules.reduce((n, c) => n + (isGroup(c) ? countConditions(c) : 1), 0);
}

/** Group nesting depth: the root alone is 1. */
export function depthOf(g: AudienceGroup): number {
  return 1 + Math.max(0, ...g.rules.filter(isGroup).map(depthOf));
}

export function canAddRule(tree: AudienceRules, groupPath: Path): boolean {
  const g = nodeAt(tree, groupPath);
  if (!g || !isGroup(g)) return false;
  return countConditions(tree) < AUDIENCE_LIMITS.maxConditions && g.rules.length < AUDIENCE_LIMITS.maxChildren;
}

/** A new group inside the group at `groupPath` sits at depth `groupPath.length + 2`. */
export function canAddGroup(tree: AudienceRules, groupPath: Path): boolean {
  return groupPath.length + 2 <= AUDIENCE_LIMITS.maxDepth && canAddRule(tree, groupPath);
}

/** Visit every leaf rule with its path. */
export function walkRules(g: AudienceGroup, fn: (r: AudienceRule, path: Path) => void, base: Path = []): void {
  g.rules.forEach((n, i) => {
    const p = [...base, i];
    if (isGroup(n)) walkRules(n, fn, p);
    else fn(n, p);
  });
}

/** The first rule whose reference field equals `id` (maps a server 404 to its rule). */
export function pathOfReference(tree: AudienceGroup, field: string, id: string): Path | null {
  let found: Path | null = null;
  walkRules(tree, (r, p) => {
    if (!found && (r as Record<string, unknown>)[field] === id) found = p;
  });
  return found;
}

export const pathKey = (p: Path): string => p.join(".");
export const samePath = (a: Path, b: Path): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

// ─── Sentences ───────────────────────────────────────────────────────────

/** A piece of a rule sentence; `bdi` parts are user data (names, values, dates) rendered in `<bdi>`. */
export interface RulePart {
  text: string;
  bdi?: boolean;
}

export interface RuleLookups {
  segments?: { id: string; name: string; nameAr?: string | null; origin: string }[];
  pipelines?: {
    id: string;
    name: string;
    nameAr?: string | null;
    archivedAt?: string | null;
    stages: { id: string; label: string; labelAr?: string | null }[];
  }[];
  defs?: { id: string; label: string; labelAr?: string | null; type: CustomFieldType; archivedAt?: string | null }[];
  campaigns?: { id: string; name: string }[];
}

export const partsText = (parts: RulePart[]): string => parts.map((p) => p.text).join("");

const T = (text: string): RulePart => ({ text });
const B = (text: string): RulePart => ({ text, bdi: true });
const name2 = (tx: Tx, en: string, ar?: string | null) => (isArabic(tx) && ar ? ar : en);

const CHANNEL_NAMES: Record<string, [string, string]> = {
  whatsapp: ["WhatsApp", "واتساب"],
  instagram: ["Instagram", "إنستغرام"],
  facebook: ["Facebook", "فيسبوك"],
  telegram: ["Telegram", "تيليجرام"],
  webchat: ["Web chat", "محادثة الويب"],
  tiktok: ["TikTok", "تيك توك"],
  l: ["AI Agent", "وكيل الذكاء الاصطناعي"],
};
export const AUDIENCE_CHANNELS = Object.keys(CHANNEL_NAMES);
export function channelName(c: string, tx: Tx): RulePart {
  const n = CHANNEL_NAMES[c];
  return n ? T(tx(n[0], n[1])) : B(c);
}

/** "7 days" / "٧ أيام", with Arabic number agreement. */
export function relTimeLabel(v: RelTime, tx: Tx): string {
  const n = v.amount;
  const EN: Record<RelUnit, [string, string]> = { hours: ["hour", "hours"], days: ["day", "days"], weeks: ["week", "weeks"], months: ["month", "months"] };
  //            one,            two,       3–10 plural, 11+ accusative, ×100 genitive
  const AR: Record<RelUnit, [string, string, string, string, string]> = {
    hours: ["ساعة واحدة", "ساعتين", "ساعات", "ساعةً", "ساعة"],
    days: ["يوم واحد", "يومين", "أيام", "يومًا", "يوم"],
    weeks: ["أسبوع واحد", "أسبوعين", "أسابيع", "أسبوعًا", "أسبوع"],
    months: ["شهر واحد", "شهرين", "أشهر", "شهرًا", "شهر"],
  };
  const [one, many] = EN[v.unit] ?? ["", ""];
  const en = `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
  const a = AR[v.unit];
  let ar: string;
  if (!a) ar = String(n);
  else if (n === 1) ar = a[0];
  else if (n === 2) ar = a[1];
  else {
    const r = n % 100;
    const word = r >= 3 && r <= 10 ? a[2] : r >= 11 ? a[3] : a[4];
    ar = `${n.toLocaleString("ar")} ${word}`;
  }
  return tx(en, ar);
}

function list(items: RulePart[], tx: Tx): RulePart[] {
  const out: RulePart[] = [];
  items.forEach((p, i) => {
    if (i > 0) out.push(T(tx(", ", "، ")));
    out.push(p);
  });
  return out.length ? out : [T("…")];
}

const lifecyclePart = (v: string, tx: Tx): RulePart => {
  const label = lifecycleLabel(tx, v);
  return label === v ? B(v) : T(label);
};

function segmentRef(id: string, tx: Tx, lk: RuleLookups): { part: RulePart; smart: boolean } {
  if (!id) return { part: T("…"), smart: false };
  const s = lk.segments?.find((x) => x.id === id);
  if (!s) return { part: T(tx("(deleted group)", "(مجموعة محذوفة)")), smart: false };
  return { part: B(name2(tx, s.name, s.nameAr)), smart: s.origin === "crm" };
}

/** One rule as a phrase starting in lower case (English); `describeRule` capitalises it. */
function phrase(r: AudienceRule, tx: Tx, lk: RuleLookups): RulePart[] {
  switch (r.field) {
    case "tag": {
      const tag = r.tag ? B(r.tag) : T("…");
      return r.op === "has" ? [T(tx("has tag ", "لديه الوسم ")), tag] : [T(tx("doesn't have tag ", "ليس لديه الوسم ")), tag];
    }
    case "lifecycle": {
      const vals = list(r.values.map((v) => lifecyclePart(v, tx)), tx);
      const one = r.values.length <= 1;
      if (r.op === "in") return [T(one ? tx("lifecycle is ", "مرحلة العميل هي ") : tx("lifecycle is one of ", "مرحلة العميل إحدى: ")), ...vals];
      return [T(one ? tx("lifecycle is not ", "مرحلة العميل ليست ") : tx("lifecycle is none of ", "مرحلة العميل ليست أيًّا من: ")), ...vals];
    }
    case "not_a_lead":
      return [T(r.op === "is" ? tx("is marked not a lead", "مُعلَّم بأنه ليس عميلًا محتملًا") : tx("isn't marked not a lead", "غير مُعلَّم بأنه ليس عميلًا محتملًا"))];
    case "last_active":
      return r.op === "within"
        ? [T(tx("last active within the last ", "آخر نشاط خلال آخر ")), T(relTimeLabel(r.value, tx))]
        : [T(tx("last active more than ", "آخر نشاط قبل أكثر من ")), T(relTimeLabel(r.value, tx)), T(tx(" ago, or never", "، أو لم ينشط أبدًا"))];
    case "conversations":
      return [T(r.op === "any" ? tx("has at least one conversation", "لديه محادثة واحدة على الأقل") : tx("has no conversations", "ليست لديه أي محادثة"))];
    case "channel":
      return [T(r.op === "is" ? tx("has a conversation on ", "لديه محادثة على ") : tx("has no conversation on ", "ليست لديه محادثة على ")), channelName(r.channel, tx)];
    case "group": {
      const { part, smart } = segmentRef(r.segmentId, tx, lk);
      if (smart) return [T(r.op === "in" ? tx("in audience ", "ضمن الجمهور ") : tx("not in audience ", "ليس ضمن الجمهور ")), part];
      return [T(r.op === "in" ? tx("member of group ", "عضو في مجموعة ") : tx("not a member of group ", "ليس عضوًا في مجموعة ")), part];
    }
    case "created":
      if ("value" in r) {
        return r.op === "within"
          ? [T(tx("created within the last ", "أُنشئ خلال آخر ")), T(relTimeLabel(r.value, tx))]
          : [T(tx("created more than ", "أُنشئ قبل أكثر من ")), T(relTimeLabel(r.value, tx)), T(tx(" ago", ""))].filter((p) => p.text);
      }
      return [T(r.op === "before" ? tx("created before ", "أُنشئ قبل ") : tx("created after ", "أُنشئ بعد ")), r.date ? B(r.date) : T("…")];
    case "pipeline_stage": {
      const p = lk.pipelines?.find((x) => x.id === r.pipelineId);
      const pPart = !r.pipelineId ? T("…") : p ? B(name2(tx, p.name, p.nameAr)) : T(tx("(deleted pipeline)", "(مسار محذوف)"));
      if (r.stageId) {
        const s = p?.stages.find((x) => x.id === r.stageId);
        const sPart = s ? B(name2(tx, s.label, s.labelAr)) : T(tx("(removed stage)", "(مرحلة محذوفة)"));
        const lead = r.op === "in" ? tx("has a card in ", "لديه بطاقة في ") : tx("has no card in ", "ليست لديه بطاقة في ");
        return [T(lead), pPart, T(tx(" › ", " ‹ ")), sPart];
      }
      return [T(r.op === "in" ? tx("has an open card in ", "لديه بطاقة مفتوحة في ") : tx("has no open card in ", "ليست لديه بطاقة مفتوحة في ")), pPart];
    }
    case "custom_field": {
      const d = lk.defs?.find((x) => x.id === r.defId);
      const f = !r.defId ? T("…") : d ? B(name2(tx, d.label, d.labelAr)) : T(tx("(deleted field)", "(حقل محذوف)"));
      const op = T(` ${opLabel("custom_field", r.op, tx, d?.type)}`);
      if (r.op === "set" || r.op === "unset") return [f, op];
      const raw = r.value ?? "";
      const v = d?.type === "boolean" ? T(raw === "true" ? tx("Yes", "نعم") : tx("No", "لا")) : raw ? B(raw) : T("…");
      return [f, op, T(" "), v];
    }
    case "campaign": {
      const c = lk.campaigns?.find((x) => x.id === r.campaignId);
      const cPart = !r.campaignId ? T("…") : c ? B(c.name) : T(tx("(deleted campaign)", "(حملة محذوفة)"));
      switch (r.op) {
        case "received": return [T(tx("received campaign ", "استلم الحملة ")), cPart];
        case "read": return [T(tx("read campaign ", "قرأ الحملة ")), cPart];
        case "replied": return [T(tx("replied to campaign ", "ردّ على الحملة ")), cPart];
        case "not_replied": return [T(tx("received campaign ", "استلم الحملة ")), cPart, T(tx(" and didn't reply", " ولم يردّ"))];
        default: return [T(tx("wasn't reached by campaign ", "فشل إرسال الحملة ")), cPart, T(tx(" (it failed)", " إليه"))];
      }
    }
    case "follow_up":
      return [
        T(
          r.op === "open"
            ? tx("has an open follow-up", "لديه متابعة مفتوحة")
            : r.op === "overdue"
              ? tx("has an overdue follow-up", "لديه متابعة متأخرة")
              : tx("has no open follow-up", "ليست لديه متابعة مفتوحة"),
        ),
      ];
    case "industry":
    case "source": {
      const one = r.values.length <= 1;
      const lead =
        r.field === "industry"
          ? one ? tx("industry is ", "القطاع هو ") : tx("industry is one of ", "القطاع أحد: ")
          : one ? tx("source is ", "المصدر هو ") : tx("source is one of ", "المصدر أحد: ");
      return [T(lead), ...list(r.values.map(B), tx)];
    }
    case "name":
      return [T(tx("name contains ", "الاسم يحتوي على ")), r.value ? B(r.value) : T("…")];
    case "phone":
      return [T(r.op === "set" ? tx("has a phone number", "لديه رقم هاتف") : tx("has no phone number", "ليس لديه رقم هاتف"))];
    case "stage_key":
      return [T(r.keys.length <= 1 ? tx("has a deal in stage ", "لديه صفقة في المرحلة ") : tx("has a deal in any of the stages ", "لديه صفقة في إحدى المراحل: ")), ...list(r.keys.map(B), tx)];
  }
}

function capitalise(parts: RulePart[]): RulePart[] {
  const first = parts[0];
  if (!first || first.bdi || !first.text) return parts;
  return [{ text: first.text.charAt(0).toUpperCase() + first.text.slice(1) }, ...parts.slice(1)];
}

/** One sentence for one rule, e.g. "Member of group <bdi>VIP</bdi>" / "عضو في مجموعة <bdi>VIP</bdi>". */
export function describeRule(r: AudienceRule, tx: Tx, lk: RuleLookups = {}): RulePart[] {
  return capitalise(phrase(r, tx, lk));
}

function groupPhrase(g: AudienceGroup, tx: Tx, lk: RuleLookups, nested: boolean): RulePart[] {
  const joiner = g.op === "and" ? tx(" and ", " و") : tx(" or ", " أو ");
  const out: RulePart[] = [];
  g.rules.forEach((n, i) => {
    if (i > 0) out.push(T(joiner));
    out.push(...(isGroup(n) ? groupPhrase(n, tx, lk, true) : phrase(n, tx, lk)));
  });
  return nested && g.rules.length > 1 ? [T("("), ...out, T(")")] : out;
}

/** The whole tree as one sentence; nested groups in parentheses. */
export function describeTree(tree: AudienceGroup, tx: Tx, lk: RuleLookups = {}): RulePart[] {
  if (tree.rules.length === 0) return [T(tx("Everyone in the workspace", "كل جهات الاتصال في مساحة العمل"))];
  return capitalise(groupPhrase(tree, tx, lk, false));
}

// ─── Issues and counts ───────────────────────────────────────────────────

/** Why a rule matches nobody (server `RuleIssue.kind`), never blank. */
export function issueText(issue: RuleIssue, tx: Tx): string {
  switch (issue.kind) {
    case "tag_deleted":
      return tx(
        "A tag this condition relies on was deleted, so it matches nobody until you change it.",
        "حُذف وسم يعتمد عليه هذا الشرط، لذا لن يطابق أحدًا حتى تعدّله.",
      );
    case "group_missing":
      return tx(
        "The group or audience this condition uses no longer exists, so it matches nobody.",
        "لم تعد المجموعة أو الجمهور الذي يستخدمه هذا الشرط موجودًا، لذا لا يطابق أحدًا.",
      );
    case "field_missing":
      return tx(
        "A custom field this condition relies on was deleted or archived, so it matches nobody.",
        "حُذف حقل مخصص يعتمد عليه هذا الشرط أو أُرشف، لذا لا يطابق أحدًا.",
      );
    case "pipeline_missing":
      return tx(
        "A pipeline this condition relies on no longer exists, so it matches nobody.",
        "لم يعد المسار الذي يعتمد عليه هذا الشرط موجودًا، لذا لا يطابق أحدًا.",
      );
    case "pipeline_archived":
      return tx(
        "A pipeline this condition relies on is archived, so it matches nobody.",
        "المسار الذي يعتمد عليه هذا الشرط مؤرشف، لذا لا يطابق أحدًا.",
      );
    case "stage_missing":
      return tx(
        "A stage this condition relies on was removed, so it matches nobody.",
        "حُذفت مرحلة يعتمد عليها هذا الشرط، لذا لا يطابق أحدًا.",
      );
    case "campaign_missing":
      return tx(
        "A campaign this condition relies on was deleted, so it matches nobody.",
        "حُذفت حملة يعتمد عليها هذا الشرط، لذا لا يطابق أحدًا.",
      );
    case "cycle":
      return tx(
        "This condition leads back to this audience through other audiences, so it matches nobody.",
        "يعود هذا الشرط إلى هذا الجمهور عبر جماهير أخرى، لذا لا يطابق أحدًا.",
      );
    case "too_deep": {
      const max = AUDIENCE_LIMITS.maxReferenceDepth;
      return tx(
        `This condition goes through more than ${max} audiences in a row, so it matches nobody. Point it at an audience with a shorter chain.`,
        `يمرّ هذا الشرط عبر أكثر من ${max} جماهير متتالية، لذا لا يطابق أحدًا. اختر جمهورًا بسلسلة أقصر.`,
      );
    }
    default:
      return tx("This condition has a problem, so it matches nobody.", "في هذا الشرط مشكلة، لذا لا يطابق أحدًا.");
  }
}

export function issuesAt(issues: readonly RuleIssue[] | undefined, path: Path): RuleIssue[] {
  return (issues ?? []).filter((i) => samePath(i.path, path));
}

export interface CountLabel {
  /** Full text: a number, or a sentence for an unknown count. */
  text: string;
  /** For tight places (chips): a number, "—" or "…"; pair with `title`. */
  short: string;
  title: string | undefined;
  state: "known" | "too_large" | "counting";
}

/** A member count that may be unknown. A null count is never shown as 0 or blank. */
export function countLabel(count: number | null | undefined, timedOut: boolean | undefined, tx: Tx): CountLabel {
  if (typeof count === "number" && Number.isFinite(count)) {
    const s = count.toLocaleString("en-US");
    return { text: s, short: s, title: undefined, state: "known" };
  }
  if (timedOut) {
    const t = tx("Too large to count right now", "العدد كبير جدًا لحسابه الآن");
    return { text: t, short: "—", title: t, state: "too_large" };
  }
  const t = tx("Counting…", "جارٍ العدّ…");
  return { text: t, short: "…", title: t, state: "counting" };
}

/** "Counted 3 min ago" style label for `countedAt`; null when never counted. */
export function countedAtLabel(iso: string | null | undefined, tx: Tx, now: number = Date.now()): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const mins = Math.max(0, Math.round((now - t) / 60_000));
  if (mins < 1) return tx("Counted just now", "حُسب الآن");
  if (mins < 60) return tx(`Counted ${mins} min ago`, `حُسب قبل ${mins} دقيقة`);
  const d = new Date(t);
  const when = d.toLocaleString(isArabic(tx) ? "ar" : "en-US", { dateStyle: "medium", timeStyle: "short" });
  return tx(`Counted at ${when}`, `حُسب في ${when}`);
}

export { fmtNum };
