/**
 * SP-21 chunker. Pure. Text is split on markdown-like headings (`#`, `##`,
 * `###` lines), then on paragraphs (blank lines), then on sentences, into
 * chunks of at most CHUNK_MAX_CHARS characters; each chunk carries its
 * section heading. Chunks shorter than CHUNK_MIN_CHARS are dropped. Typed and
 * sheet rows are one chunk each (`chunkRows`).
 */
import { CHUNK_MAX_CHARS, CHUNK_MIN_CHARS } from "./knowledge-constants";

export interface Chunk {
  /** Section heading, sheet name, or null ("General"). */
  heading: string | null;
  text: string;
  /** Sheet rows: the 1-based row number the user sees. */
  rowRef?: number | null;
  /** Offers: end of validity, `YYYY-MM-DD` (workspace TZ). */
  validTo?: string | null;
}

const HEADING_RE = /^(#{1,3})\s+(.+)$/;

/** Split one over-long piece on sentence ends, then hard-cut what is still too long. */
function splitLong(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const sentences = text.match(/[^.!?؟。\n]+(?:[.!?؟。]+|\n+|$)/g) ?? [text];
  const out: string[] = [];
  let cur = "";
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if (s.length > max) {
      if (cur) out.push(cur);
      cur = "";
      for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
      continue;
    }
    if (cur && cur.length + 1 + s.length > max) {
      out.push(cur);
      cur = s;
    } else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out;
}

/** Text → chunks with their section headings. */
export function chunkText(text: string, opts: { max?: number; min?: number; heading?: string | null } = {}): Chunk[] {
  const max = opts.max ?? CHUNK_MAX_CHARS;
  const min = opts.min ?? CHUNK_MIN_CHARS;
  const sections: { heading: string | null; paras: string[] }[] = [{ heading: opts.heading ?? null, paras: [] }];
  let para: string[] = [];
  const flush = () => {
    const p = para.join("\n").trim();
    if (p) sections[sections.length - 1].paras.push(p);
    para = [];
  };
  for (const line of String(text ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const m = HEADING_RE.exec(line.trim());
    if (m) {
      flush();
      sections.push({ heading: m[2].trim().slice(0, 300), paras: [] });
    } else if (line.trim() === "") flush();
    else para.push(line);
  }
  flush();

  const out: Chunk[] = [];
  for (const s of sections) {
    let cur = "";
    const push = () => {
      if (cur.trim().length >= min) out.push({ heading: s.heading, text: cur.trim() });
      cur = "";
    };
    for (const p of s.paras) {
      for (const piece of splitLong(p, max)) {
        if (cur && cur.length + 2 + piece.length > max) push();
        cur = cur ? `${cur}\n\n${piece}` : piece;
      }
    }
    push();
  }
  return out;
}

/** Sheet rows → one chunk each: `header: value; header: value` (empty cells skipped). */
export function chunkRows(
  heading: string | null,
  headers: string[],
  rows: string[][],
  rowNumbers: number[],
  max = CHUNK_MAX_CHARS,
): Chunk[] {
  const out: Chunk[] = [];
  rows.forEach((cells, i) => {
    const parts = headers.map((h, j) => [h, (cells[j] ?? "").trim()] as const).filter(([, v]) => v !== "");
    if (parts.length === 0) return;
    const text = parts.map(([h, v]) => `${h}: ${v}`).join("; ").slice(0, max);
    out.push({ heading, text, rowRef: rowNumbers[i] ?? null });
  });
  return out;
}
