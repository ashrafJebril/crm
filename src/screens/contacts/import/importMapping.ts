import type { CustomFieldDef } from "@/lib/types";

export interface MappingTarget {
  value: string;
  en: string;
  ar: string;
}

/** Targets the backend accepts for a column, in picker order. */
const BUILTIN: MappingTarget[] = [
  { value: "ignore", en: "Don't import", ar: "تجاهل العمود" },
  { value: "firstName", en: "First name", ar: "الاسم الأول" },
  { value: "lastName", en: "Last name", ar: "اسم العائلة" },
  { value: "name", en: "Full name", ar: "الاسم الكامل" },
  { value: "phone", en: "Phone", ar: "الهاتف" },
  { value: "email", en: "Email", ar: "البريد الإلكتروني" },
  { value: "lifecycle", en: "Lifecycle", ar: "المرحلة" },
  { value: "tags", en: "Tags", ar: "الوسوم" },
  { value: "owner", en: "Owner (email or name)", ar: "المسؤول (بريد أو اسم)" },
  { value: "source", en: "Source", ar: "المصدر" },
  { value: "industry", en: "Industry", ar: "المجال" },
  { value: "value", en: "Value", ar: "القيمة" },
];

export function targetsFor(customDefs: CustomFieldDef[]): MappingTarget[] {
  return [
    ...BUILTIN,
    ...customDefs
      .filter((d) => !d.archivedAt)
      .map((d) => ({ value: `custom:${d.id}`, en: d.label, ar: d.labelAr || d.label })),
  ];
}

export type MappingError = "imports.mapping_required" | "imports.mapping_duplicate";

const IDENTITY = new Set(["name", "firstName", "phone"]);
/** Targets that may be mapped from several columns. */
const REPEATABLE = new Set(["tags", "ignore"]);

/** Mirrors the server: one identity column is required; each target at most once (tags/ignore may repeat). */
export function validateMapping(mapping: Record<string, string>): { ok: true } | { error: MappingError } {
  const seen = new Set<string>();
  for (const target of Object.values(mapping)) {
    if (REPEATABLE.has(target)) continue;
    if (seen.has(target)) return { error: "imports.mapping_duplicate" };
    seen.add(target);
  }
  for (const t of seen) if (IDENTITY.has(t)) return { ok: true };
  return { error: "imports.mapping_required" };
}

export interface ErrorRow {
  row: number;
  column: string | null;
  /** Already-translated reason. */
  reason: string;
}

const cell = (v: string): string => {
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV (UTF-8 BOM, CRLF) of the rejected rows, safe to open in a spreadsheet. */
export function errorsToCsv(rows: ErrorRow[], header: [string, string, string]): string {
  const lines = [header, ...rows.map((r) => [String(r.row), r.column ?? "", r.reason])].map((r) => r.map(cell).join(","));
  return "﻿" + lines.join("\r\n");
}
