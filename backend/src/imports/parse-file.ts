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
  /**
   * 1-based source row number of each entry in `rows`, as the user sees it in
   * a spreadsheet: the header row and any blank rows before/between data rows
   * count. CSV: the record index (a quoted field with embedded newlines is one
   * row). XLSX: the worksheet row number. Use it in error reports.
   */
  rowNumbers: number[];
}

interface SourceRow {
  n: number;
  cells: string[];
}

export async function parseFile(buffer: Buffer, fileName: string): Promise<ParsedFile> {
  const ext = /\.([^.\\/]+)$/.exec(fileName || "")?.[1]?.toLowerCase();
  if (ext !== "csv" && ext !== "xlsx") throw new ImportFileError("imports.unsupported_type");
  if (buffer.length > MAX_IMPORT_BYTES) throw new ImportFileError("imports.file_too_large");
  const table = ext === "csv" ? parseCsv(buffer) : await parseXlsx(buffer);
  return shape(table);
}

// ─── CSV ────────────────────────────────────────────────────────────────

function decodeCsv(buffer: Buffer): string {
  let text = buffer.toString("utf8");
  if (text.includes("�")) {
    // Not valid UTF-8: Excel on Arabic Windows saves CSV as windows-1256.
    try {
      text = new TextDecoder("windows-1256").decode(buffer);
    } catch {
      throw new ImportFileError("imports.file_invalid");
    }
    if (text.includes("�")) throw new ImportFileError("imports.file_invalid");
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

function parseCsv(buffer: Buffer): SourceRow[] {
  const text = decodeCsv(buffer);
  const delimiter = detectDelimiter(text);
  const rows: SourceRow[] = [];
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
    rows.push({ n: rows.length + 1, cells: row });
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
  if (quoted) throw new ImportFileError("imports.file_invalid");
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

async function parseXlsx(buffer: Buffer): Promise<SourceRow[]> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as any);
  } catch {
    throw new ImportFileError("imports.file_invalid");
  }
  const ws = wb.worksheets[0];
  if (!ws) throw new ImportFileError("imports.file_empty");
  const rows: SourceRow[] = [];
  let nonBlank = 0;
  let tooLarge = false;
  ws.eachRow({ includeEmpty: false }, (r) => {
    if (tooLarge) return;
    const cells: string[] = [];
    for (let c = 1; c <= r.cellCount; c++) cells.push(cellToString(r.getCell(c)));
    if (cells.some((x) => x.trim() !== "")) nonBlank++;
    // header + MAX data rows is the most a valid file can hold
    if (nonBlank > MAX_IMPORT_ROWS + 1) {
      tooLarge = true;
      return;
    }
    rows.push({ n: r.number, cells });
  });
  if (tooLarge) throw new ImportFileError("imports.file_too_large");
  return rows;
}

function cellToString(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (typeof v === "number" && typeof cell.numFmt === "string" && /^0{2,}$/.test(cell.numFmt)) {
    // A zero-padded number format (e.g. 0000000000) shows leading zeros.
    return String(v).padStart(cell.numFmt.length, "0");
  }
  return valueToString(v);
}

function valueToString(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as any;
    if ("result" in o) return valueToString(o.result);
    if (Array.isArray(o.richText)) return o.richText.map((t: any) => t.text ?? "").join("");
    if (typeof o.text === "string") return o.text;
    return "";
  }
  return String(v);
}

// ─── Shared shaping ─────────────────────────────────────────────────────

function shape(table: SourceRow[]): ParsedFile {
  const isBlank = (r: SourceRow) => r.cells.every((c) => c.trim() === "");
  const headerIdx = table.findIndex((r) => !isBlank(r));
  if (headerIdx < 0) throw new ImportFileError("imports.file_empty");

  const rawHeaders = table[headerIdx].cells.map((h) => h.trim());
  // Columns with no header are ignored (their data too).
  const keep: number[] = [];
  rawHeaders.forEach((h, i) => {
    if (h !== "") keep.push(i);
  });

  // Duplicates get _2, _3, … skipping any name already used by another header.
  const taken = new Set(keep.map((i) => rawHeaders[i]));
  const firstSeen = new Set<string>();
  const counters = new Map<string, number>();
  const headers = keep.map((i) => {
    const h = rawHeaders[i];
    if (!firstSeen.has(h)) {
      firstSeen.add(h);
      return h;
    }
    let n = counters.get(h) ?? 1;
    let candidate: string;
    do {
      n++;
      candidate = `${h}_${n}`;
    } while (taken.has(candidate));
    counters.set(h, n);
    taken.add(candidate);
    return candidate;
  });

  const rows: string[][] = [];
  const rowNumbers: number[] = [];
  for (let r = headerIdx + 1; r < table.length; r++) {
    const src = table[r];
    if (isBlank(src)) continue;
    if (rows.length >= MAX_IMPORT_ROWS) throw new ImportFileError("imports.file_too_large");
    rows.push(keep.map((i) => (src.cells[i] ?? "").trim()));
    rowNumbers.push(src.n);
  }
  if (rows.length === 0) throw new ImportFileError("imports.file_empty");
  return { headers, rows, rowNumbers };
}
