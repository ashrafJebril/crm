import * as ExcelJS from "exceljs";

export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 50_000;

export type ImportFileErrorKey =
  | "imports.file_empty"
  | "imports.file_too_large"
  | "imports.unsupported_type"
  | "imports.file_invalid";

/** Typed parse failure; `messageKey` is the bilingual i18n key for the 400. */
export class ImportFileError extends Error {
  constructor(public readonly messageKey: ImportFileErrorKey) {
    super(messageKey);
    this.name = "ImportFileError";
  }
}

export interface ParsedFile {
  headers: string[];
  rows: string[][];
}

export async function parseFile(buffer: Buffer, fileName: string): Promise<ParsedFile> {
  const ext = /\.([^.\/]+)$/.exec(fileName || "")?.[1]?.toLowerCase();
  if (ext !== "csv" && ext !== "xlsx") throw new ImportFileError("imports.unsupported_type");
  if (buffer.length > MAX_IMPORT_BYTES) throw new ImportFileError("imports.file_too_large");
  const table = ext === "csv" ? parseCsv(buffer) : await parseXlsx(buffer);
  return shape(table);
}

// ─── CSV ────────────────────────────────────────────────────────────────

function parseCsv(buffer: Buffer): string[][] {
  let text = buffer.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const delimiter = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else field += c;
      i++;
      continue;
    }
    if (c === '"' && field === "") quoted = true;
    else if (c === delimiter) endField();
    else if (c === "\r") {
      if (text[i + 1] === "\n") i++;
      endRow();
    } else if (c === "\n") endRow();
    else field += c;
    i++;
  }
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

/** Comma vs semicolon, decided on the first non-empty line outside quotes. */
function detectDelimiter(text: string): "," | ";" {
  let commas = 0;
  let semis = 0;
  let quoted = false;
  let seen = false;
  for (const c of text) {
    if (c === '"') quoted = !quoted;
    else if (!quoted) {
      if (c === "\n" || c === "\r") {
        if (seen) break;
      } else {
        seen = true;
        if (c === ",") commas++;
        else if (c === ";") semis++;
      }
    }
  }
  return semis > commas ? ";" : ",";
}

// ─── XLSX ───────────────────────────────────────────────────────────────

async function parseXlsx(buffer: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as any);
  } catch {
    throw new ImportFileError("imports.file_invalid");
  }
  const ws = wb.worksheets[0];
  if (!ws) throw new ImportFileError("imports.file_empty");
  const rows: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (r) => {
    const cells: string[] = [];
    for (let c = 1; c <= r.cellCount; c++) cells.push(cellToString(r.getCell(c).value));
    rows.push(cells);
  });
  return rows;
}

function cellToString(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as any;
    if ("result" in o) return cellToString(o.result);
    if (Array.isArray(o.richText)) return o.richText.map((t: any) => t.text ?? "").join("");
    if (typeof o.text === "string") return o.text;
    if (typeof o.error === "string") return "";
    return "";
  }
  return String(v);
}

// ─── Shared shaping ─────────────────────────────────────────────────────

function shape(table: string[][]): ParsedFile {
  const isBlank = (r: string[]) => r.every((c) => c.trim() === "");
  const headerIdx = table.findIndex((r) => !isBlank(r));
  if (headerIdx < 0) throw new ImportFileError("imports.file_empty");

  const rawHeaders = table[headerIdx].map((h) => h.trim());
  // Columns with no header are ignored (their data too).
  const keep: number[] = [];
  rawHeaders.forEach((h, i) => {
    if (h !== "") keep.push(i);
  });

  const seen = new Map<string, number>();
  const headers = keep.map((i) => {
    const h = rawHeaders[i];
    const n = (seen.get(h) ?? 0) + 1;
    seen.set(h, n);
    return n === 1 ? h : `${h}_${n}`;
  });

  const rows: string[][] = [];
  for (let r = headerIdx + 1; r < table.length; r++) {
    const src = table[r];
    if (isBlank(src)) continue;
    if (rows.length >= MAX_IMPORT_ROWS) throw new ImportFileError("imports.file_too_large");
    rows.push(keep.map((i) => (src[i] ?? "").trim()));
  }
  if (rows.length === 0) throw new ImportFileError("imports.file_empty");
  return { headers, rows };
}
