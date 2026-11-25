/**
 * SP-21 file extraction, per type (Architecture → knowledge-extract):
 *  - PDF: `pdf-parse` (D8) text; when the text averages fewer than
 *    PDF_TEXT_PER_PAGE characters per page the PDF is scanned and is sent to
 *    Claude for transcription (≤ KB_PDF_MAX_PAGES pages);
 *  - XLSX/CSV: the SP-03 parser; each sheet is a section, each row a chunk;
 *  - JPEG/PNG/WebP: Claude transcription.
 * Typed documents use `extractTyped` (template check + valid rows only).
 * Extracted text is capped at KB_TEXT_MAX characters per file. Nothing here
 * writes anything: it returns chunks; the processor stores them.
 */
import { ImportFileError, parseFileSheets } from "../imports/parse-file";
import { chunkRows, chunkText, type Chunk } from "./knowledge-chunker";
import { KB_FILE_MAX_BYTES, KB_PDF_MAX_PAGES, KB_TEXT_MAX, type KbFileType, type TypedKind } from "./knowledge-constants";
import { KnowledgeFailure } from "./knowledge-errors";
import type { KnowledgeVisionPort } from "./knowledge-vision";
import { typedRowText, validateTypedSheet, type TypedValidation } from "./typed-docs";

/** Below this average of characters per page, a PDF is treated as scanned. */
export const PDF_TEXT_PER_PAGE = 200;

export type PdfTextFn = (buffer: Buffer) => Promise<{ text: string; numpages: number }>;

/**
 * The bytes as an exact-length copy. A small Node Buffer (for instance from
 * `fs.promises.readFile`) is often a view into a shared 8 KB pool with a
 * non-zero `byteOffset`; pdf.js reads the underlying ArrayBuffer and then fails
 * with "bad XRef entry". A copy owns its ArrayBuffer from offset 0.
 */
export function exactBytes(buffer: Uint8Array): Uint8Array {
  return new Uint8Array(buffer);
}

/** `pdf-parse` loaded lazily from its library file (its index runs a self-test when required directly). */
export const defaultPdfText: PdfTextFn = async (buffer) => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pdf = require("pdf-parse/lib/pdf-parse.js") as (b: Uint8Array) => Promise<{ text: string; numpages: number }>;
  const r = await pdf(exactBytes(buffer));
  return { text: r.text ?? "", numpages: r.numpages ?? 0 };
};

export interface ExtractDeps {
  vision: KnowledgeVisionPort;
  pdfText: PdfTextFn;
}

export const MIME_OF_TYPE: Record<KbFileType, string> = {
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export function typeOfMime(mime: string): KbFileType | null {
  const hit = (Object.entries(MIME_OF_TYPE) as [KbFileType, string][]).find(([, m]) => m === mime);
  return hit?.[0] ?? null;
}

/** Keep chunks until KB_TEXT_MAX characters are reached. */
function capChunks(chunks: Chunk[]): Chunk[] {
  const out: Chunk[] = [];
  let total = 0;
  for (const c of chunks) {
    if (total + c.text.length > KB_TEXT_MAX) break;
    total += c.text.length;
    out.push(c);
  }
  return out;
}

async function sheets(buffer: Buffer, fileName: string) {
  try {
    return await parseFileSheets(buffer, fileName, { maxBytes: KB_FILE_MAX_BYTES });
  } catch (e) {
    if (e instanceof ImportFileError) throw new KnowledgeFailure(e.messageKey === "imports.file_empty" ? "knowledge.empty" : "knowledge.unreadable");
    throw new KnowledgeFailure("knowledge.unreadable");
  }
}

/** Chunks of an untyped file. Throws KnowledgeFailure. */
export async function extractFile(input: { buffer: Buffer; type: KbFileType; fileName: string }, deps: ExtractDeps): Promise<Chunk[]> {
  let chunks: Chunk[];
  switch (input.type) {
    case "pdf": {
      let parsed: { text: string; numpages: number };
      try {
        parsed = await deps.pdfText(input.buffer);
      } catch {
        throw new KnowledgeFailure("knowledge.unreadable");
      }
      const pages = Math.max(1, parsed.numpages || 1);
      const text = parsed.text.trim();
      if (text.length / pages >= PDF_TEXT_PER_PAGE) {
        chunks = chunkText(text.slice(0, KB_TEXT_MAX));
      } else {
        if (pages > KB_PDF_MAX_PAGES) throw new KnowledgeFailure("knowledge.pdf_too_long");
        const transcript = await deps.vision.transcribe(input.buffer, "application/pdf");
        chunks = chunkText(transcript.slice(0, KB_TEXT_MAX));
      }
      break;
    }
    case "xlsx":
    case "csv": {
      const parsed = await sheets(input.buffer, input.fileName);
      chunks = parsed.flatMap((s) => chunkRows(s.name || null, s.headers, s.rows, s.rowNumbers));
      break;
    }
    default: {
      const transcript = await deps.vision.transcribe(input.buffer, MIME_OF_TYPE[input.type] as "image/jpeg");
      chunks = chunkText(transcript.slice(0, KB_TEXT_MAX));
    }
  }
  const capped = capChunks(chunks);
  if (capped.length === 0) throw new KnowledgeFailure("knowledge.empty");
  return capped;
}

export interface TypedExtraction {
  validation: TypedValidation;
  sheetName: string;
}

/**
 * Parse and check a typed sheet (the first non-empty sheet). Parse failures
 * throw KnowledgeFailure; template and row problems are in `validation`.
 */
export async function readTyped(
  input: { buffer: Buffer; fileName: string },
  kind: TypedKind,
  opts: { defaultCurrency?: string } = {},
): Promise<TypedExtraction> {
  const [sheet] = await sheets(input.buffer, input.fileName);
  return { validation: validateTypedSheet(kind, sheet.headers, sheet.rows, sheet.rowNumbers, opts), sheetName: sheet.name };
}

/** The valid rows of a typed sheet as chunks (one per row, `validTo` for offers). */
export function typedChunks(kind: TypedKind, x: TypedExtraction): Chunk[] {
  return capChunks(
    x.validation.rows.map((r) => ({
      heading: x.sheetName || null,
      text: typedRowText(kind, r),
      rowRef: r.row,
      validTo: kind === "offers" ? r.validTo : null,
    })),
  );
}
