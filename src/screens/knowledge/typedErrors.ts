import type { Tx } from "@/lib/tx";
import { MAX_TYPED_ROWS } from "./knowledgeConstants";

/**
 * SP-21 typed spreadsheet reports (ruling 5): the column report of
 * `knowledge.template_columns {missing, unknown}` and the row errors of
 * `knowledge.typed_rows {rowErrors: {row, column, error}[], total, validRows}`.
 * Column names are the template's own (English, as in the file); the copy
 * around them is bilingual.
 */

type Extra = Record<string, unknown>;

export interface RowError {
  row: number | null;
  column: string | null;
  error: string;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const list = (xs: string[]) => xs.join(", ");

export function rowErrorsOf(x: Extra): RowError[] {
  return Array.isArray(x.rowErrors)
    ? (x.rowErrors as unknown[])
        .filter((r): r is RowError => typeof r === "object" && r !== null && typeof (r as RowError).error === "string")
        .map((r) => ({ row: typeof r.row === "number" ? r.row : null, column: typeof r.column === "string" ? r.column : null, error: r.error }))
    : [];
}

/** `knowledge.template_columns`: the missing required columns and the unknown ones. */
export function columnReportText(x: Extra): [string, string] {
  const missing = strings(x.missing);
  const unknown = strings(x.unknown);
  const en = [
    missing.length ? `This file is missing required columns: ${list(missing)}.` : "This file doesn't match the template.",
    unknown.length ? `Columns not in the template (ignored): ${list(unknown)}.` : "",
    "Download the template and copy your data into it.",
  ];
  const ar = [
    missing.length ? `ينقص هذا الملف أعمدة مطلوبة: ${list(missing)}.` : "هذا الملف لا يطابق القالب.",
    unknown.length ? `أعمدة ليست في القالب (سيتم تجاهلها): ${list(unknown)}.` : "",
    "نزّل القالب وانسخ بياناتك إليه.",
  ];
  return [en.filter(Boolean).join(" "), ar.filter(Boolean).join(" ")];
}

const REASON: Record<string, [string, string]> = {
  required: ["is required", "مطلوب"],
  number: ["must be a number of 0 or more", "يجب أن يكون رقمًا يساوي 0 أو أكثر"],
  date: ["must be a date (YYYY-MM-DD or DD/MM/YYYY)", "يجب أن يكون تاريخًا (YYYY-MM-DD أو DD/MM/YYYY)"],
  boolean: ["must be yes or no", "يجب أن يكون نعم أو لا"],
  currency: ["must be a 3-letter currency code such as SAR", "يجب أن يكون رمز عملة من 3 أحرف مثل SAR"],
  url: ["must be an https link", "يجب أن يكون رابط https"],
};

/** One row error, naming the row and the column: "Row 4: price must be a number…". */
export function rowErrorLine(e: RowError, tx: Tx): string {
  if (e.error === "too_many_rows") {
    return tx(`The file has more than ${MAX_TYPED_ROWS.toLocaleString("en-US")} rows.`, `يحتوي الملف على أكثر من ${MAX_TYPED_ROWS.toLocaleString("en-US")} صف.`);
  }
  const r = REASON[e.error] ?? ["is not valid", "غير صالح"];
  const col = e.column ?? "?";
  return e.row === null ? tx(`${col} ${r[0]}.`, `${col} ${r[1]}.`) : tx(`Row ${e.row}: ${col} ${r[0]}.`, `الصف ${e.row}: ${col} ${r[1]}.`);
}

/** `knowledge.typed_rows` summary line. */
export function rowErrorsSummary(x: Extra): [string, string] {
  const errors = rowErrorsOf(x);
  if (errors.some((e) => e.error === "too_many_rows")) {
    const max = MAX_TYPED_ROWS.toLocaleString("en-US");
    return [`The file has more than ${max} rows. Split it into smaller files.`, `يحتوي الملف على أكثر من ${max} صف. قسّمه إلى ملفات أصغر.`];
  }
  const total = typeof x.total === "number" ? x.total : errors.length;
  const valid = typeof x.validRows === "number" ? x.validRows : null;
  if (total === 0) return ["The file has no data rows.", "لا يحتوي الملف على صفوف بيانات."];
  const en = `${total} problem${total === 1 ? "" : "s"} found in the rows${valid !== null ? ` (${valid} valid row${valid === 1 ? "" : "s"})` : ""}.`;
  const ar = `وُجدت ${total} مشكلة في الصفوف${valid !== null ? ` (${valid} صفًا صالحًا)` : ""}.`;
  return [en, ar];
}

/** Rows for the error table, the first `limit`, plus how many more were not reported. */
export function rowErrorTable(x: Extra, tx: Tx, limit = 100): { rows: { key: string; row: string; column: string; text: string }[]; more: number } {
  const errors = rowErrorsOf(x);
  const total = typeof x.total === "number" ? x.total : errors.length;
  const shown = errors.slice(0, limit);
  return {
    rows: shown.map((e, i) => ({ key: `${e.row}-${e.column}-${i}`, row: e.row === null ? "—" : String(e.row), column: e.column ?? "—", text: rowErrorLine(e, tx) })),
    more: Math.max(0, total - shown.length),
  };
}

/** "Keep N valid rows" is offered when some rows are valid and the file was not refused for size. */
export function canKeepValidRows(x: Extra): number | null {
  const valid = typeof x.validRows === "number" ? x.validRows : 0;
  if (rowErrorsOf(x).some((e) => e.error === "too_many_rows")) return null;
  return valid > 0 ? valid : null;
}
