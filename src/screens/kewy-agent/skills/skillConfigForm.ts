import type { SkillConfigField } from "@/lib/types";
import type { Tx } from "@/lib/tx";
import { SAFE_TAG_RE } from "./skillCatalog";

/** Mirrors backend/src/skills/skill-catalog.ts. */
export const SKILL_CONFIG_MAX_BYTES = 8 * 1024;

export type FieldErrorCode =
  | "unknown_key"
  | "wrong_type"
  | "not_an_option"
  | "below_min"
  | "above_max"
  | "too_long"
  | "required"
  | "too_large"
  | "unsafe_text";

export type FormValue = string | number | boolean | string[] | null;

/** The form's starting values: saved config, else each field's default. */
export function initialValues(fields: SkillConfigField[], config: Record<string, unknown>): Record<string, FormValue> {
  const out: Record<string, FormValue> = {};
  for (const f of fields) {
    const v = config[f.key] !== undefined ? config[f.key] : f.default;
    if (f.type === "tags") out[f.key] = Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
    else if (f.type === "boolean") out[f.key] = v === true;
    else if (f.type === "number") out[f.key] = typeof v === "number" ? v : null;
    else out[f.key] = typeof v === "string" ? v : "";
  }
  return out;
}

/** "vip, wholesale" or one per line → trimmed, de-duplicated tags. */
export function parseTagsInput(raw: string): string[] {
  return [...new Set(raw.split(/[,\n،]/).map((t) => t.trim()).filter(Boolean))];
}

function check(f: SkillConfigField, v: FormValue): FieldErrorCode | null {
  switch (f.type) {
    case "text":
    case "textarea":
      if (typeof v !== "string") return "wrong_type";
      if (f.maxLength !== undefined && v.length > f.maxLength) return "too_long";
      if (f.required && v.trim() === "") return "required";
      return null;
    case "number":
      if (v === null || v === undefined) return f.required ? "required" : null;
      if (typeof v !== "number" || !Number.isFinite(v)) return "wrong_type";
      if (f.min !== undefined && v < f.min) return "below_min";
      if (f.max !== undefined && v > f.max) return "above_max";
      return null;
    case "select":
      if (typeof v !== "string") return "wrong_type";
      return f.options?.includes(v) ? null : "not_an_option";
    case "boolean":
      return typeof v === "boolean" ? null : "wrong_type";
    case "tags":
      if (!Array.isArray(v)) return "wrong_type";
      if (f.max !== undefined && v.length > f.max) return "above_max";
      if (f.maxLength !== undefined && v.some((t) => t.length > (f.maxLength as number))) return "too_long";
      if (v.some((t) => !SAFE_TAG_RE.test(t))) return "unsafe_text";
      if (f.required && v.length === 0) return "required";
      return null;
  }
}

/**
 * Client validation, the same rules as the server's validateSkillConfig
 * (required, bounds, lengths, options, tags ≤ max and safe characters, the
 * 8 KB cap), so most mistakes are caught before a round trip. The server
 * stays the authority.
 */
export function validateConfig(
  fields: SkillConfigField[],
  values: Record<string, FormValue>,
): { ok: true; config: Record<string, unknown> } | { ok: false; errors: Record<string, FieldErrorCode> } {
  const errors: Record<string, FieldErrorCode> = {};
  const config: Record<string, unknown> = {};
  for (const f of fields) {
    let v = values[f.key];
    if (typeof v === "string") v = v.trim();
    if (f.type === "tags" && Array.isArray(v)) v = [...new Set(v.map((t) => t.trim()).filter(Boolean))];
    if (f.type === "number" && (v === null || v === undefined) && !f.required) continue;
    const code = check(f, v ?? null);
    if (code) errors[f.key] = code;
    else config[f.key] = v;
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  if (new TextEncoder().encode(JSON.stringify(config)).length > SKILL_CONFIG_MAX_BYTES) return { ok: false, errors: { "": "too_large" } };
  return { ok: true, config };
}

/** After an update: which saved settings the new version dropped. */
export function droppedNotice(dropped: string[], tx: Tx): string | null {
  if (!dropped.length) return null;
  const list = dropped.join(", ");
  return tx(
    `Updated. These settings no longer exist or were not valid in the new version and were removed: ${list}.`,
    `تم التحديث. أُزيلت هذه الإعدادات لأنها لم تعد موجودة أو لم تكن صالحة في الإصدار الجديد: ${list}.`,
  );
}
