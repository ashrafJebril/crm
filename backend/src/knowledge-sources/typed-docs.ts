/**
 * SP-21 typed spreadsheet documents (ruling 5). Pure.
 *
 * Kinds and columns (Tkana `typed-docs.ts`; `required` marked): headers are
 * matched case-insensitively with spaces → `_` (a trailing `*` is ignored).
 * A missing required header refuses the whole file (`knowledge.template_columns`);
 * unknown headers are listed but not fatal. Each bad row is reported with
 * its row number (as the user sees it), the column and the reason.
 */
import { MAX_ROW_ERRORS_REPORTED, MAX_TYPED_ROWS, TYPED_KINDS, type TypedKind } from "./knowledge-constants";

export { TYPED_KINDS, type TypedKind };

export interface TypedColumn {
  name: string;
  required: boolean;
  rule?: "number" | "date" | "boolean" | "currency" | "url";
}

const col = (name: string, required = false, rule?: TypedColumn["rule"]): TypedColumn => ({ name, required, ...(rule ? { rule } : {}) });

export const TYPED_COLUMNS: Record<TypedKind, TypedColumn[]> = {
  offers: [
    col("offer_name", true),
    col("price", false, "number"),
    col("currency", false, "currency"),
    col("original_price", false, "number"),
    col("valid_from", false, "date"),
    col("valid_to", true, "date"),
    col("applies_to"),
    col("terms"),
  ],
  inventory: [
    col("product_name", true),
    col("sku"),
    col("category"),
    col("brand"),
    col("price", true, "number"),
    col("currency", false, "currency"),
    col("sale_price", false, "number"),
    col("in_stock", false, "boolean"),
    col("quantity", false, "number"),
    col("description"),
    col("image_url", false, "url"),
  ],
  packages: [
    col("package_name", true),
    col("includes", true),
    col("price", true, "number"),
    col("currency", false, "currency"),
    col("original_price", false, "number"),
    col("valid_to", false, "date"),
    col("description"),
  ],
};

export type RowErrorReason = "required" | "number" | "date" | "boolean" | "currency" | "url" | "too_many_rows";

export interface RowError {
  /** The 1-based row number the user sees; null for a file-level entry. */
  row: number | null;
  column: string | null;
  error: RowErrorReason;
}

export interface TypedRow {
  row: number;
  /** Canonical column → normalised value (empty cells omitted). */
  values: Record<string, string>;
  /** `YYYY-MM-DD` of `valid_to`, when the kind has it and it is set. */
  validTo: string | null;
}

export interface TypedValidation {
  ok: boolean;
  missing: string[];
  unknown: string[];
  /** At most MAX_ROW_ERRORS_REPORTED entries. */
  rowErrors: RowError[];
  /** Every row error, reported or not. */
  total: number;
  rows: TypedRow[];
}

export function isTypedKind(v: unknown): v is TypedKind {
  return typeof v === "string" && (TYPED_KINDS as readonly string[]).includes(v);
}

export function normalizeHeader(h: string): string {
  return String(h ?? "")
    .trim()
    .replace(/\*+$/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

const pad = (n: number) => String(n).padStart(2, "0");
function isoDate(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  if (y < 1900 || y > 2200) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** `YYYY-MM-DD`, an Excel serial day number, or `DD/MM/YYYY` → `YYYY-MM-DD`; null when not a date. */
export function parseTypedDate(v: string): string | null {
  const s = v.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return isoDate(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return isoDate(+m[3], +m[2], +m[1]);
  if (/^\d{5}(\.0+)?$/.test(s)) {
    // Excel's 1900 date system: day 25569 is 1970-01-01.
    const ms = (Math.floor(Number(s)) - 25569) * 86_400_000;
    const d = new Date(ms);
    return isoDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  return null;
}

const NUMBER_RE = /^\d+(\.\d+)?$/;
const YES = new Set(["yes", "true", "1", "نعم"]);
const NO = new Set(["no", "false", "0", "لا"]);

function checkCell(rule: TypedColumn["rule"], raw: string): { value: string } | { error: RowErrorReason } {
  const v = raw.trim();
  switch (rule) {
    case "number": {
      const n = v.replace(/,/g, "");
      return NUMBER_RE.test(n) ? { value: n } : { error: "number" };
    }
    case "date": {
      const d = parseTypedDate(v);
      return d ? { value: d } : { error: "date" };
    }
    case "boolean": {
      const b = v.toLowerCase();
      if (YES.has(b)) return { value: "yes" };
      if (NO.has(b)) return { value: "no" };
      return { error: "boolean" };
    }
    case "currency":
      return /^[a-z]{3}$/i.test(v) ? { value: v.toUpperCase() } : { error: "currency" };
    case "url": {
      try {
        const u = new URL(v);
        return u.protocol === "https:" ? { value: u.toString() } : { error: "url" };
      } catch {
        return { error: "url" };
      }
    }
    default:
      return { value: v };
  }
}

/**
 * Check a parsed sheet against the kind's template. `rows` are the data rows
 * (header excluded) and `rowNumbers` their sheet row numbers.
 */
export function validateTypedSheet(
  kind: TypedKind,
  headers: string[],
  rows: string[][],
  rowNumbers: number[],
  opts: { defaultCurrency?: string } = {},
): TypedValidation {
  const columns = TYPED_COLUMNS[kind];
  const names = new Set(columns.map((c) => c.name));
  const normalized = headers.map(normalizeHeader);
  const index = new Map<string, number>();
  normalized.forEach((h, i) => {
    if (names.has(h) && !index.has(h)) index.set(h, i);
  });
  const missing = columns.filter((c) => c.required && !index.has(c.name)).map((c) => c.name);
  const unknown = [...new Set(normalized.filter((h) => h && !names.has(h)))];
  if (missing.length) return { ok: false, missing, unknown, rowErrors: [], total: 0, rows: [] };
  if (rows.length > MAX_TYPED_ROWS) {
    return { ok: false, missing, unknown, rowErrors: [{ row: null, column: null, error: "too_many_rows" }], total: 1, rows: [] };
  }

  const currency = /^[A-Z]{3}$/.test(opts.defaultCurrency ?? "") ? (opts.defaultCurrency as string) : "SAR";
  const errors: RowError[] = [];
  const good: TypedRow[] = [];
  rows.forEach((cells, i) => {
    const row = rowNumbers[i] ?? i + 2;
    const values: Record<string, string> = {};
    let bad = false;
    for (const c of columns) {
      const at = index.get(c.name);
      const raw = at === undefined ? "" : String(cells[at] ?? "").trim();
      if (raw === "") {
        if (c.required) {
          errors.push({ row, column: c.name, error: "required" });
          bad = true;
        }
        continue;
      }
      const r = checkCell(c.rule, raw);
      if ("error" in r) {
        errors.push({ row, column: c.name, error: r.error });
        bad = true;
      } else values[c.name] = r.value;
    }
    if (bad) return;
    if (names.has("currency") && !values.currency && (values.price || values.original_price || values.sale_price)) values.currency = currency;
    good.push({ row, values, validTo: values.valid_to ?? null });
  });
  return {
    ok: errors.length === 0,
    missing,
    unknown,
    rowErrors: errors.slice(0, MAX_ROW_ERRORS_REPORTED),
    total: errors.length,
    rows: good,
  };
}

/** One typed row as chunk text, in template column order. */
export function typedRowText(kind: TypedKind, row: TypedRow): string {
  return TYPED_COLUMNS[kind]
    .filter((c) => row.values[c.name] !== undefined)
    .map((c) => `${c.name}: ${row.values[c.name]}`)
    .join("; ");
}
