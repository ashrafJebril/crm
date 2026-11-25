import type { Tx } from "@/lib/tx";
import type { CampaignVariable, Template, VarField, VarMap, VarSlot } from "@/lib/types";

/**
 * SP-13 template variable mapping, the frontend mirror of backend
 * `campaigns/sending/var-map.ts`. It mirrors the labelling, the form
 * validation and the rendering only: which value a recipient gets (and
 * whether they are skipped) is decided by the backend preview and launch.
 * Pure, so it is unit-tested. Replaces `campaignVars.ts` (which re-exports).
 */

export type { VarField, VarMap, VarSlot };

/** Meta's parameter limit the backend enforces (characters after trimming). */
export const VAR_VALUE_MAX = 1024;
const CUSTOM_KEY = /^[a-z0-9_]{1,100}$/i;
const SLOT_KEY = /^[1-9]\d{0,2}$/;

/** Built-in contact fields, with the backend's bilingual labels (var-map.ts FIELD_LABELS). */
export const FIELD_SOURCES: { key: VarField; label: string; labelAr: string }[] = [
  { key: "name", label: "Name", labelAr: "الاسم" },
  { key: "firstName", label: "First name", labelAr: "الاسم الأول" },
  { key: "lastName", label: "Last name", labelAr: "اسم العائلة" },
  { key: "phone", label: "Phone", labelAr: "الهاتف" },
  { key: "email", label: "Email", labelAr: "البريد الإلكتروني" },
];
const FIELD_KEYS = new Set<string>(FIELD_SOURCES.map((f) => f.key));

export type CustomLabels = ReadonlyMap<string, { label: string; labelAr: string }>;

/** Highest {{n}} in a template body. */
export function placeholderCount(body: string | null | undefined): number {
  let max = 0;
  for (const m of (body ?? "").matchAll(/\{\{\s*(\d+)\s*\}\}/g)) max = Math.max(max, Number(m[1]));
  return max;
}

/** Slot keys in numeric order ("2" before "10"), as the backend's `slotKeys`. */
export const slotKeys = (map: Record<string, unknown>): string[] =>
  Object.keys(map).sort((a, b) => Number(a) - Number(b) || (a < b ? -1 : a > b ? 1 : 0));

/** Every slot mapped to the contact's name (the pre-SP-13 default). */
export function defaultVarMap(count: number): VarMap {
  const out: VarMap = {};
  for (let i = 1; i <= count; i++) out[String(i)] = { source: "field", key: "name" };
  return out;
}

/** Keeps the slots 1..count, filling new ones with the default and dropping the rest. */
export function resizeVarMap(map: VarMap, count: number): VarMap {
  const out: VarMap = {};
  for (let i = 1; i <= count; i++) out[String(i)] = map[String(i)] ?? { source: "field", key: "name" };
  return out;
}

export type VarMapReason =
  | "missing_slot"
  | "extra_slot"
  | "bad_source"
  | "bad_key"
  | "unknown_custom_field"
  | "empty_value"
  | "too_long";

const tooLong = (v: string | undefined) => (v ?? "").trim().length > VAR_VALUE_MAX;

/**
 * The first problem, in the backend's order (shape per slot, then missing,
 * then extra, then unknown custom field), or null. `customKeys` null means
 * the list is not readable here (no contacts.view): the backend checks it.
 */
export function varMapIssue(
  map: VarMap,
  slotCount: number,
  customKeys: ReadonlySet<string> | null = null,
): { slot: string; reason: VarMapReason } | null {
  for (const slot of Object.keys(map)) if (!SLOT_KEY.test(slot)) return { slot, reason: "extra_slot" };
  for (const slot of slotKeys(map)) {
    const s = map[slot] as VarSlot | undefined;
    if (!s || typeof s !== "object") return { slot, reason: "bad_source" };
    if (s.source === "static") {
      if (typeof s.value !== "string" || !s.value.trim()) return { slot, reason: "empty_value" };
      if (tooLong(s.value)) return { slot, reason: "too_long" };
    } else if (s.source === "field" || s.source === "custom") {
      const ok = s.source === "field" ? FIELD_KEYS.has(s.key) : typeof s.key === "string" && CUSTOM_KEY.test(s.key);
      if (!ok) return { slot, reason: "bad_key" };
      if (tooLong(s.fallback)) return { slot, reason: "too_long" };
    } else {
      return { slot, reason: "bad_source" };
    }
  }
  for (let i = 1; i <= slotCount; i++) if (!(String(i) in map)) return { slot: String(i), reason: "missing_slot" };
  for (const slot of slotKeys(map)) if (Number(slot) > slotCount) return { slot, reason: "extra_slot" };
  if (customKeys) {
    for (const slot of slotKeys(map)) {
      const s = map[slot]!;
      if (s.source === "custom" && !customKeys.has(s.key)) return { slot, reason: "unknown_custom_field" };
    }
  }
  return null;
}

export const varMapComplete = (map: VarMap, slotCount: number, customKeys: ReadonlySet<string> | null = null): boolean =>
  varMapIssue(map, slotCount, customKeys) === null;

/** Copy for `campaigns.var_map_invalid {slot, reason}`. */
export function varMapReasonText(reason: string, slot: string | null | undefined, tx: Tx): string {
  const n = slot ? `{{${slot}}}` : "";
  const t = (en: string, ar: string) => tx(en, ar);
  switch (reason) {
    case "missing_slot":
      return t(`Choose a value for ${n}.`, `اختر قيمة لـ ${n}.`);
    case "extra_slot":
      return t(`${n} isn't in this template. Pick the template again.`, `${n} غير موجود في هذا القالب. اختر القالب مرة أخرى.`);
    case "bad_source":
      return t(`${n} has no valid source. Choose a contact field, a custom field or a fixed value.`, `${n} بلا مصدر صالح. اختر حقل جهة اتصال أو حقلًا مخصصًا أو قيمة ثابتة.`);
    case "bad_key":
      return t(`${n} uses a field that doesn't exist. Choose another field.`, `${n} يستخدم حقلًا غير موجود. اختر حقلًا آخر.`);
    case "unknown_custom_field":
      return t(`${n} uses a custom field that was removed. Choose another field.`, `${n} يستخدم حقلًا مخصصًا تمت إزالته. اختر حقلًا آخر.`);
    case "empty_value":
      return t(`Enter the fixed value for ${n}.`, `أدخل القيمة الثابتة لـ ${n}.`);
    case "too_long":
      return t(`The value for ${n} is longer than 1,024 characters.`, `قيمة ${n} أطول من 1,024 حرفًا.`);
    default:
      return t(`Check the value for ${n}.`, `تحقق من قيمة ${n}.`);
  }
}

/** What is saved: trimmed values and fallbacks, empty fallbacks dropped, numeric order. */
export function normalizeVarMap(map: VarMap): VarMap {
  const out: VarMap = {};
  for (const slot of slotKeys(map)) {
    const s = map[slot]!;
    if (s.source === "static") out[slot] = { source: "static", value: s.value.trim() };
    else {
      const fallback = s.fallback?.trim();
      out[slot] = s.source === "field"
        ? { source: "field", key: s.key, ...(fallback ? { fallback } : {}) }
        : { source: "custom", key: s.key, ...(fallback ? { fallback } : {}) };
    }
  }
  return out;
}

/**
 * The pre-SP-13 launch body `variables` as a varMap (backend `legacyToVarMap`):
 * name/phone/email → field, custom → static. `company` (no contact column) and
 * a blank fixed value don't convert: null.
 */
export function legacyToVarMap(variables: readonly CampaignVariable[]): VarMap | null {
  const out: VarMap = {};
  for (let i = 0; i < variables.length; i++) {
    const v = variables[i] as { field: string; customValue?: string };
    const slot = String(i + 1);
    if (v.field === "name" || v.field === "phone" || v.field === "email") out[slot] = { source: "field", key: v.field };
    else if (v.field === "custom" && (v.customValue ?? "").trim()) out[slot] = { source: "static", value: v.customValue!.trim() };
    else return null;
  }
  return out;
}

/** Built-in or custom field label in both languages; an unknown key is its own label. */
export function fieldLabelOf(
  source: "field" | "custom",
  key: string,
  custom: CustomLabels = new Map(),
): { label: string; labelAr: string; known: boolean } {
  if (source === "field") {
    const f = FIELD_SOURCES.find((x) => x.key === key);
    if (f) return { label: f.label, labelAr: f.labelAr, known: true };
  } else {
    const c = custom.get(key);
    if (c) return { label: c.label, labelAr: c.labelAr || c.label, known: true };
  }
  return { label: key, labelAr: key, known: false };
}

/** What a slot shows where no real contact is available ("Name", "City", or the fixed value). */
export function slotLabel(slot: VarSlot, tx: Tx, custom: CustomLabels = new Map()): string {
  if (slot.source === "static") return slot.value;
  const l = fieldLabelOf(slot.source, slot.key, custom);
  return tx(l.label, l.labelAr);
}

/** The body with each {{n}} replaced by its value; an empty value keeps {{n}} (backend `renderTemplate`). */
export function renderTemplate(body: string, values: readonly string[]): string {
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (tok, n: string) => {
    const v = values[Number(n) - 1];
    return v ? v : tok;
  });
}

/** The body with each slot as its label in brackets: the review step without contact samples (ruling 18). */
export function renderWithLabels(body: string, map: VarMap, tx: Tx, custom: CustomLabels = new Map()): string {
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (tok, n: string) => {
    const s = map[String(Number(n))];
    if (!s) return tok;
    return s.source === "static" ? s.value.trim() || tok : `[${slotLabel(s, tx, custom)}]`;
  });
}

const blank = (v: unknown) => v === null || v === undefined || (typeof v === "string" && !v.trim());

/**
 * Values for one example contact: the value, else the trimmed fallback, else
 * "" with the first missing slot reported (the backend would skip them).
 * For the phone preview only; the backend preview decides for real.
 */
export function previewValues(
  map: VarMap,
  contact: Partial<Record<VarField, string | null>>,
  customValues: Record<string, unknown>,
): { values: string[]; usedFallback: number[]; missing: { slot: number; source: "field" | "custom"; key: string } | null } {
  const values: string[] = [];
  const usedFallback: number[] = [];
  let missing: { slot: number; source: "field" | "custom"; key: string } | null = null;
  for (const slot of slotKeys(map)) {
    const s = map[slot]!;
    const n = Number(slot);
    if (s.source === "static") {
      values.push(s.value.trim());
      continue;
    }
    const raw = s.source === "field" ? contact[s.key] : customValues[s.key];
    if (!blank(raw)) values.push(String(raw).trim());
    else if (s.fallback?.trim()) {
      values.push(s.fallback.trim());
      usedFallback.push(n);
    } else {
      values.push("");
      missing ??= { slot: n, source: s.source, key: s.key };
    }
  }
  return { values, usedFallback, missing };
}

/**
 * Templates campaigns can't send yet (ruling 12): a text header with {{n}},
 * or a URL button with a dynamic {{n}} part. They still work in the inbox.
 */
export function templateUnsupported(t: Pick<Template, "headerType" | "buttons"> & { headerContent?: string | null }): boolean {
  if ((t.headerType ?? "").toLowerCase() === "text" && /\{\{\s*\d+\s*\}\}/.test(t.headerContent ?? "")) return true;
  if (!t.buttons) return false;
  try {
    const parsed: unknown = JSON.parse(t.buttons);
    if (!Array.isArray(parsed)) return false;
    return parsed.some(
      (b) =>
        b && typeof b === "object" &&
        String((b as { type?: unknown }).type).toUpperCase() === "URL" &&
        /\{\{\s*\d+\s*\}\}/.test(String((b as { url?: unknown }).url ?? "")),
    );
  } catch {
    return false;
  }
}

export interface SampleSegment {
  text: string;
  /** 1-based slot number when this piece is a filled placeholder. */
  slot?: number;
  /** The value came from the slot's fallback (shown underlined). */
  fallback?: boolean;
  /** No value: the placeholder stays visible as {{n}}. */
  missing?: boolean;
}

/** The body cut into text and filled placeholders, so a sample can mark fallback values. */
export function sampleSegments(body: string, values: readonly string[], usedFallback: readonly number[]): SampleSegment[] {
  const out: SampleSegment[] = [];
  const re = /\{\{\s*(\d+)\s*\}\}/g;
  let last = 0;
  for (const m of body.matchAll(re)) {
    if (m.index! > last) out.push({ text: body.slice(last, m.index) });
    const slot = Number(m[1]);
    const v = values[slot - 1];
    out.push(v ? { text: v, slot, fallback: usedFallback.includes(slot) } : { text: m[0], slot, missing: true });
    last = m.index! + m[0].length;
  }
  if (last < body.length) out.push({ text: body.slice(last) });
  return out;
}
