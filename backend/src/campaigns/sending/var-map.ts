import type { ZernioBroadcastVariable } from "../../integrations/zernio.client";
import { campaignError } from "../campaign-errors";

/**
 * SP-13 template variable mapping (`Campaign.varMap`).
 *
 * Each body slot `{{n}}` maps to a contact field, a custom field (SP-02
 * `CustomFieldDef.key` of THIS workspace) or a fixed value, with an optional
 * fallback. `resolveVarMap` is the one place that decides a recipient's
 * values: preview, launch planning and both transports call it, so what the
 * review step shows, what the rows store and what is sent always agree.
 */

/** Contact columns a slot may read. */
export const VAR_FIELDS = ["name", "firstName", "lastName", "phone", "email"] as const;
export type VarField = (typeof VAR_FIELDS)[number];

export type VarSlot =
  | { source: "field"; key: VarField; fallback?: string }
  | { source: "custom"; key: string; fallback?: string }
  | { source: "static"; value: string };

/** `{"1": slot, "2": slot, …}`. */
export type VarMap = Record<string, VarSlot>;

export type VarSource = "field" | "custom";

export type VarMapInvalidReason =
  | "missing_slot"
  | "extra_slot"
  | "bad_source"
  | "bad_key"
  | "unknown_custom_field"
  | "empty_value"
  | "too_long";

/** A non-archived contact custom field of the campaign's workspace. */
export interface CustomDef {
  id: string;
  key: string;
  label: string;
  labelAr: string;
  /** text | number | date | select | boolean */
  type: string;
  options: unknown;
}

/** The contact columns the resolver reads (any extra columns are ignored). */
export interface VarContact {
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  email?: string | null;
}

export interface ResolveCtx {
  /** The template language ("ar" localizes booleans and select labels). */
  lang: string;
  /** This workspace's custom defs, by key. Keys not in here are missing. */
  defs: ReadonlyMap<string, CustomDef>;
}

export type ResolveResult =
  | { ok: true; values: string[]; usedFallback: number[] }
  | { ok: false; missing: { slot: string; source: VarSource; key: string } };

/** Meta's parameter limit we enforce (characters after trimming). */
export const VAR_VALUE_MAX = 1024;
/** Upper bound on slots accepted in a stored map (templates use far fewer). */
export const VAR_SLOTS_MAX = 100;

const CUSTOM_KEY = /^[a-z0-9_]{1,64}$/i;
const SLOT_KEY = /^[1-9]\d{0,2}$/;

const invalid = (slot: string | undefined, reason: VarMapInvalidReason) =>
  campaignError("campaigns.var_map_invalid", { slot, reason });

/** Slot keys in numeric order ("2" before "10"). */
export function slotKeys(map: Record<string, unknown>): string[] {
  return Object.keys(map).sort((a, b) => Number(a) - Number(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The shape only (PATCH on a draft: the template may still change). Returns
 * the normalized map (trimmed value/fallback, unknown props dropped). 400
 * `campaigns.var_map_invalid {slot, reason}` otherwise.
 */
export function validateVarMapShape(map: unknown): VarMap {
  if (!map || typeof map !== "object" || Array.isArray(map)) throw invalid(undefined, "bad_source");
  const out: VarMap = {};
  const keys = Object.keys(map as Record<string, unknown>);
  for (const slot of keys.filter((k) => !SLOT_KEY.test(k))) throw invalid(slot, "extra_slot");
  for (const slot of slotKeys(map as Record<string, unknown>)) {
    if (Number(slot) > VAR_SLOTS_MAX) throw invalid(slot, "extra_slot");
    const raw = (map as Record<string, unknown>)[slot] as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid(slot, "bad_source");
    const fallback = optionalText(raw.fallback, slot);
    if (raw.source === "static") {
      if (typeof raw.value !== "string") throw invalid(slot, "empty_value");
      const value = raw.value.trim();
      if (!value) throw invalid(slot, "empty_value");
      if (value.length > VAR_VALUE_MAX) throw invalid(slot, "too_long");
      out[slot] = { source: "static", value };
    } else if (raw.source === "field") {
      if (typeof raw.key !== "string" || !(VAR_FIELDS as readonly string[]).includes(raw.key)) throw invalid(slot, "bad_key");
      out[slot] = { source: "field", key: raw.key as VarField, ...(fallback ? { fallback } : {}) };
    } else if (raw.source === "custom") {
      if (typeof raw.key !== "string" || !CUSTOM_KEY.test(raw.key)) throw invalid(slot, "bad_key");
      out[slot] = { source: "custom", key: raw.key, ...(fallback ? { fallback } : {}) };
    } else {
      throw invalid(slot, "bad_source");
    }
  }
  return out;
}

function optionalText(v: unknown, slot: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw invalid(slot, "bad_source");
  const t = v.trim();
  if (t.length > VAR_VALUE_MAX) throw invalid(slot, "too_long");
  return t || undefined;
}

/**
 * Everything (preview and launch): the shape, slots exactly "1".."slotCount",
 * and every custom key a non-archived contact def of this workspace
 * (`customDefs`, by key; a key from another workspace is simply absent).
 */
export function validateVarMap(
  map: unknown,
  { slotCount, customDefs }: { slotCount: number; customDefs: ReadonlyMap<string, unknown> },
): VarMap {
  const out = validateVarMapShape(map);
  for (let i = 1; i <= slotCount; i++) if (!(String(i) in out)) throw invalid(String(i), "missing_slot");
  for (const slot of slotKeys(out)) if (Number(slot) > slotCount) throw invalid(slot, "extra_slot");
  for (const slot of slotKeys(out)) {
    const s = out[slot];
    if (s.source === "custom" && !customDefs.has(s.key)) throw invalid(slot, "unknown_custom_field");
  }
  return out;
}

/**
 * Meta-safe parameter text: each newline or tab becomes a space, runs of
 * more than 3 spaces collapse to 3 (Meta error 132018), and the result is cut
 * to 1 024 characters (code points; a surrogate pair is never split).
 */
export function metaSafe(text: string): string {
  const flat = text.replace(/\r\n|[\r\n\t]/g, " ").replace(/ {4,}/g, "   ");
  if (flat.length <= VAR_VALUE_MAX) return flat;
  const points = Array.from(flat);
  return points.length <= VAR_VALUE_MAX ? flat : points.slice(0, VAR_VALUE_MAX).join("");
}

/**
 * A stored custom value as template text (ruling 17), or null when it has no
 * usable value. text: as stored; number: String(n); date: yyyy-mm-dd;
 * boolean: Yes/No (نعم/لا for `ar`); select: the option's label in the
 * template language when options carry labels, else the raw value.
 */
export function formatCustomValue(def: Pick<CustomDef, "type" | "options">, value: unknown, lang: string): string | null {
  if (value === null || value === undefined) return null;
  const ar = String(lang ?? "").toLowerCase().startsWith("ar");
  switch (def.type) {
    case "number":
      if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
      return typeof value === "string" ? value : null;
    case "date": {
      if (typeof value !== "string") return null;
      if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
    }
    case "boolean": {
      const b = value === true || value === "true" ? true : value === false || value === "false" ? false : null;
      if (b === null) return null;
      return b ? (ar ? "نعم" : "Yes") : ar ? "لا" : "No";
    }
    case "select": {
      if (typeof value !== "string") return null;
      if (Array.isArray(def.options)) {
        for (const o of def.options as unknown[]) {
          if (o && typeof o === "object" && (o as { value?: unknown }).value === value) {
            const opt = o as { label?: unknown; labelAr?: unknown };
            const label = ar ? (opt.labelAr ?? opt.label) : opt.label;
            if (typeof label === "string" && label.trim()) return label;
          }
        }
      }
      return value;
    }
    default:
      return typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : null;
  }
}

/**
 * One slot's value: `{value, usedFallback}` (Meta-safe), or null when it is
 * missing (null, undefined or blank after trimming) and has no fallback.
 * `customValues` holds this contact's stored values by def id.
 */
export function resolveSlot(
  slot: VarSlot,
  contact: VarContact,
  customValues: Readonly<Record<string, unknown>>,
  ctx: ResolveCtx,
): { value: string; usedFallback: boolean } | null {
  if (slot.source === "static") return { value: metaSafe(slot.value.trim()), usedFallback: false };
  let raw: string | null = null;
  if (slot.source === "field") {
    const v = contact[slot.key];
    raw = typeof v === "string" ? v : null;
  } else {
    const def = ctx.defs.get(slot.key);
    raw = def ? formatCustomValue(def, customValues[def.id], ctx.lang) : null;
  }
  const trimmed = raw?.trim() ?? "";
  if (trimmed) return { value: metaSafe(trimmed), usedFallback: false };
  const fb = slot.fallback?.trim();
  return fb ? { value: metaSafe(fb), usedFallback: true } : null;
}

/**
 * A recipient's values for every slot, in slot order, or the lowest-numbered
 * missing slot (the recipient is then skipped with `missingSkipCode`).
 * `usedFallback` lists the 1-based slot numbers that used their fallback.
 */
export function resolveVarMap(
  map: VarMap,
  contact: VarContact,
  customValues: Readonly<Record<string, unknown>>,
  ctx: ResolveCtx,
): ResolveResult {
  const values: string[] = [];
  const usedFallback: number[] = [];
  for (const slot of slotKeys(map)) {
    const s = map[slot];
    const r = resolveSlot(s, contact, customValues, ctx);
    if (!r) return { ok: false, missing: { slot, source: s.source as VarSource, key: (s as { key: string }).key } };
    values.push(r.value);
    if (r.usedFallback) usedFallback.push(Number(slot));
  }
  return { ok: true, values, usedFallback };
}

/** `skip:missing_value:<source>.<key>` (the recipient row's failureCode). */
export function missingSkipCode(source: VarSource, key: string): string {
  return `skip:missing_value:${source}.${key}`;
}

/**
 * Legacy launch `variables` (`[{field, customValue?}]`, slot n = index n-1)
 * as a varMap. `company` is refused (Contact has no company column).
 */
export function legacyToVarMap(variables: ReadonlyArray<{ field: string; customValue?: string }>): VarMap {
  const out: VarMap = {};
  variables.forEach((v, i) => {
    const slot = String(i + 1);
    if (v.field === "name" || v.field === "phone" || v.field === "email") {
      out[slot] = { source: "field", key: v.field };
    } else if (v.field === "custom") {
      const value = (v.customValue ?? "").trim();
      if (!value) throw invalid(slot, "empty_value");
      if (value.length > VAR_VALUE_MAX) throw invalid(slot, "too_long");
      out[slot] = { source: "static", value };
    } else {
      throw invalid(slot, "bad_key");
    }
  });
  return out;
}

/**
 * Native slots keep Zernio's per-recipient resolution on a broadcast
 * (ruling 2): a fixed value, `field.phone` and `field.name`. Every other
 * slot is part of the partition key and is sent as a literal.
 */
export function isNativeSlot(slot: VarSlot): boolean {
  return slot.source === "static" || (slot.source === "field" && (slot.key === "phone" || slot.key === "name"));
}

/** The Zernio broadcast variable for one slot of a partition. */
export function zernioVariableFor(slot: VarSlot, value: string): ZernioBroadcastVariable {
  if (slot.source === "static") return { field: "custom", customValue: slot.value };
  if (slot.source === "field" && slot.key === "phone") return { field: "phone" };
  if (slot.source === "field" && slot.key === "name") return { field: "name" };
  return { field: "custom", customValue: value };
}

const FIELD_LABELS: Record<VarField, { label: string; labelAr: string }> = {
  name: { label: "Name", labelAr: "الاسم" },
  firstName: { label: "First name", labelAr: "الاسم الأول" },
  lastName: { label: "Last name", labelAr: "اسم العائلة" },
  phone: { label: "Phone", labelAr: "الهاتف" },
  email: { label: "Email", labelAr: "البريد الإلكتروني" },
};

/** The bilingual label of a slot source (custom: the def's label; unknown: the raw key). */
export function fieldLabel(
  source: VarSource,
  key: string,
  defs: ReadonlyMap<string, Pick<CustomDef, "label" | "labelAr">>,
): { label: string; labelAr: string } {
  if (source === "field" && key in FIELD_LABELS) return FIELD_LABELS[key as VarField];
  const d = source === "custom" ? defs.get(key) : undefined;
  return d ? { label: d.label, labelAr: d.labelAr } : { label: key, labelAr: key };
}
