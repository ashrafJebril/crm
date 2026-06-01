export interface ChunkOptions {
  maxChars: number;
  overlapChars: number;
}

/**
 * Recursive character splitter — keeps semantic units together by trying the
 * largest available boundary first (paragraph → line → sentence → word).
 * Arabic-aware: treats `؟`, `۔`, `،` and Latin equivalents as boundaries.
 */
export function splitIntoChunks(text: string, opts: ChunkOptions): string[] {
  const t = text.replace(/\r\n/g, "\n").trim();
  if (!t) return [];
  if (t.length <= opts.maxChars) return [t];

  const separators = ["\n\n", "\n", "؟ ", "? ", "۔ ", ". ", "، ", ", ", " "];
  const pieces = splitRecursive(t, separators, opts.maxChars);

  const out: string[] = [];
  let cur = "";
  for (const p of pieces) {
    if (!p) continue;
    if (cur.length + p.length + 1 <= opts.maxChars) {
      cur = cur ? cur + " " + p : p;
    } else {
      if (cur) out.push(cur);
      const overlap = cur.slice(-opts.overlapChars);
      cur = overlap ? overlap + " " + p : p;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter((c) => c.trim().length > 0);
}

function splitRecursive(text: string, separators: string[], maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  if (separators.length === 0) {
    const out: string[] = [];
    for (let i = 0; i < text.length; i += maxChars) out.push(text.slice(i, i + maxChars));
    return out;
  }
  const [sep, ...rest] = separators;
  const parts = text.split(sep);
  if (parts.length === 1) return splitRecursive(text, rest, maxChars);
  const out: string[] = [];
  for (const part of parts) {
    if (!part.trim()) continue;
    if (part.length <= maxChars) out.push(part);
    else out.push(...splitRecursive(part, rest, maxChars));
  }
  return out;
}

/** Cheap token estimate — ~3.5 chars/token across mixed English+Arabic. */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 3.5);
}
