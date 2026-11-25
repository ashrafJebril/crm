/**
 * SP-21 (R11) bounded prompt blocks. Pure; SP-20 reuses it for the persona.
 *
 * A block is `<!-- kewy-crm-<name>:begin -->\n<text>\n<!-- kewy-crm-<name>:end -->`.
 * `upsertBlock` replaces an existing block in place, leaving every character
 * outside the markers untouched; with no block it appends one. A begin marker
 * with no end marker after it (a hand-edited prompt) is left where it is and
 * a fresh block is appended (`dangling: true`, for the caller's log). The
 * block text cannot carry our markers: `<!-- kewy-crm-` inside it is defused.
 */

export const BLOCK_PREFIX = "<!-- kewy-crm-";

export function blockMarkers(name: string): { begin: string; end: string } {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`invalid block name: ${name}`);
  return { begin: `${BLOCK_PREFIX}${name}:begin -->`, end: `${BLOCK_PREFIX}${name}:end -->` };
}

/** Remove anything that could open or close one of our blocks. */
export function defuse(text: string): string {
  return String(text ?? "").split(BLOCK_PREFIX).join("<!-- kewy crm ");
}

function find(prompt: string, name: string): { start: number; end: number } | null {
  const { begin, end } = blockMarkers(name);
  // Pair the first end marker with the nearest begin before it, so a stale
  // begin marker left earlier in a hand-edited prompt is never part of the span.
  const first = prompt.indexOf(begin);
  if (first < 0) return null;
  const e = prompt.indexOf(end, first + begin.length);
  if (e < 0) return null;
  const b = prompt.lastIndexOf(begin, e - begin.length);
  return { start: b, end: e + end.length };
}

export function upsertBlock(prompt: string, name: string, text: string): { prompt: string; dangling: boolean } {
  const body = defuse(text).trim();
  if (!body) return { prompt: removeBlock(prompt, name), dangling: false };
  const { begin, end } = blockMarkers(name);
  const block = `${begin}\n${body}\n${end}`;
  const current = String(prompt ?? "");
  const at = find(current, name);
  if (at) return { prompt: current.slice(0, at.start) + block + current.slice(at.end), dangling: false };
  const dangling = current.includes(begin);
  const head = current.trimEnd();
  return { prompt: head ? `${head}\n\n${block}` : block, dangling };
}

/** Remove a complete block and the blank line before it; everything else stays. */
export function removeBlock(prompt: string, name: string): string {
  const current = String(prompt ?? "");
  const at = find(current, name);
  if (!at) return current;
  let start = at.start;
  while (start > 0 && (current[start - 1] === "\n" || current[start - 1] === "\r")) start--;
  const before = current.slice(0, start);
  const after = current.slice(at.end);
  return before && after.trim() ? `${before}\n\n${after.replace(/^\s+/, "")}` : `${before}${after.trim() ? after.replace(/^\s+/, "") : ""}`;
}
