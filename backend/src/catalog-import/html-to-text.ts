/**
 * SP-10 catalog import: a fetched page as plain text for extraction. Pure.
 * Scripts, styles, templates, SVG and comments are dropped with their content;
 * block elements become line breaks; entities are decoded; whitespace is
 * collapsed; the result is capped. The text is untrusted data: it only ever
 * reaches the model as the document to extract from, never as instructions.
 *
 * Every pass is a single left-to-right scan (review I1): the former lazy
 * regexes rescanned to the end of the input for each opener with no closer,
 * which is quadratic on a hostile or broken page. The output on well-formed
 * input is the same as theirs. Missing closers (re-review I-A):
 *  - `<script>`, `<style>` and comments are raw text: an unclosed one drops
 *    the rest of the input, as a browser would (nothing after it is visible),
 *    and it keeps the pass linear without any bookkeeping.
 *  - Every other element loses only its opener (as with the old regexes) and
 *    the scan goes on: the void `<embed>`, a self-closing `<svg … />`, an
 *    unclosed `<title>`, `<noscript>`, `<object>`… A missing `</head>` ends
 *    the head at `<body`. "No closer at or after X" is remembered per name,
 *    so nothing is rescanned.
 */

// Element names are the whole word after `<` (the old regexes' `\b`), ASCII case-insensitive.
/** How a dropped element ends: `raw` text up to its closer, a normal `element`, or a `void` one with no closer. */
type Rule = "raw" | "element" | "void";
const DROP = new Map<string, Rule>([
  ["script", "raw"],
  ["style", "raw"],
  ["noscript", "element"],
  ["template", "element"],
  ["svg", "element"],
  ["iframe", "element"],
  ["object", "element"],
  ["embed", "void"],
  ["head", "element"],
]);
const BLOCK = new Set([
  "p", "div", "br", "li", "ul", "ol", "tr", "td", "th", "table", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article",
  "header", "footer", "nav", "main", "aside", "dt", "dd", "dl", "pre", "blockquote", "hr", "figure", "figcaption", "address", "option",
]);
const TITLE = new Map<string, Rule>([["title", "element"]]);
const SPACES = /[ \t\f\v ]+/g;

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const lines = (s: string) =>
  s
    .split("\n")
    .map((l) => l.replace(SPACES, " ").trim())
    .filter(Boolean);

/** ASCII-only lowercase: same length as the input, so indexes line up. */
const asciiLower = (s: string) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
const isWordChar = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isSpace = (c: string) => /\s/.test(c);

function wordEnd(s: string, i: number): number {
  while (i < s.length && isWordChar(s.charCodeAt(i))) i++;
  return i;
}

/** `[start, end)` of the first `</name\s*>` at or after `from` in `lower`, or null. */
function findCloser(lower: string, name: string, from: number): { start: number; end: number } | null {
  const needle = `</${name}`;
  for (let i = lower.indexOf(needle, from); i !== -1; i = lower.indexOf(needle, i + needle.length)) {
    let j = i + needle.length;
    while (j < lower.length && isSpace(lower[j])) j++;
    if (lower[j] === ">") return { start: i, end: j + 1 };
  }
  return null;
}

/**
 * Each `<name …>…</name>` (name in `rules`) → a space. With `attrs`, the
 * content starts after the opener's `>` (the old `<title\b[^>]*>`); otherwise
 * right after the name (the old DROP rule). Without a closer, a `raw` element
 * drops the rest of the input; any other opener (and a void or self-closing
 * one) stays in place for the tag pass to strip. `onContent` sees each
 * dropped element's content, in order.
 */
function stripElements(s: string, rules: ReadonlyMap<string, Rule>, attrs: boolean, onContent?: (content: string) => void): string {
  const lower = asciiLower(s);
  // Openers only: a fixed-length match with no lazy part, so one linear pass.
  const opener = new RegExp(`<(${[...rules.keys()].join("|")})(?![a-z0-9_])`, "g");
  const bodyOpener = /<body(?![a-z0-9_])/g;
  // Searches only move forward, so "none from X" holds for every later X.
  const noneFrom = new Map<string, number>();
  let noBodyFrom = Infinity;
  let gt = -2; // the next `>` at or after the last asked position; -1: none left
  const nextGt = (from: number) => {
    if (gt !== -1 && gt < from) gt = lower.indexOf(">", from);
    return gt;
  };
  const closerOf = (name: string, from: number): { start: number; end: number } | null => {
    const none = noneFrom.get(name);
    if (none !== undefined && from >= none) return null;
    let closer = findCloser(lower, name, from);
    if (name === "head" && from < noBodyFrom) {
      // An omitted `</head>` (minified pages): the head ends where the body starts.
      bodyOpener.lastIndex = from;
      const body = bodyOpener.exec(lower);
      if (!body) noBodyFrom = from;
      else if (!closer || body.index < closer.start) closer = { start: body.index, end: body.index };
    }
    if (!closer) noneFrom.set(name, from);
    return closer;
  };
  const out: string[] = [];
  let pos = 0;
  for (let m = opener.exec(lower); m; m = opener.exec(lower)) {
    const lt = m.index;
    const name = m[1];
    const rule = rules.get(name);
    const nameEnd = lt + 1 + name.length;
    const tagEnd = nextGt(nameEnd);
    const selfClosing = rule !== "raw" && tagEnd > 0 && lower[tagEnd - 1] === "/";
    if (rule === "void" || selfClosing) continue; // the tag pass strips the opener
    if (attrs && tagEnd === -1) break; // no `>` left: no opener can complete
    const contentStart = attrs ? tagEnd + 1 : nameEnd;
    const closer = closerOf(name, contentStart);
    if (!closer) {
      if (rule !== "raw") continue;
      out.push(s.slice(pos, lt), " ");
      return out.join("");
    }
    out.push(s.slice(pos, lt), " ");
    onContent?.(s.slice(contentStart, closer.start));
    pos = closer.end;
    opener.lastIndex = pos;
  }
  out.push(s.slice(pos));
  return out.join("");
}

/** `<!--…-->` → a space; an unclosed comment drops the rest. */
function stripComments(s: string): string {
  const out: string[] = [];
  let pos = 0;
  for (let i = s.indexOf("<!--"); i !== -1; i = s.indexOf("<!--", pos)) {
    out.push(s.slice(pos, i), " ");
    const end = s.indexOf("-->", i + 4);
    if (end === -1) return out.join("");
    pos = end + 3;
  }
  out.push(s.slice(pos));
  return out.join("");
}

/**
 * Each tag `<…>` (up to the next `>`) → `replace(lt)`; null keeps that `<` as
 * text. A `<` with no `>` after it stays text, as with the old `<…[^>]*>` rules.
 */
function replaceTags(s: string, replace: (lt: number) => string | null): string {
  const out: string[] = [];
  let pos = 0;
  let gt = -1; // the next `>` after the current `<`, cached so `>` is scanned for once in all
  for (let lt = s.indexOf("<"); lt !== -1; ) {
    if (gt <= lt) {
      gt = s.indexOf(">", lt + 1);
      if (gt === -1) break;
    }
    const r = replace(lt);
    if (r === null) {
      lt = s.indexOf("<", lt + 1);
      continue;
    }
    out.push(s.slice(pos, lt), r);
    pos = gt + 1;
    lt = s.indexOf("<", pos);
  }
  out.push(s.slice(pos));
  return out.join("");
}

function blocksToLines(s: string): string {
  const lower = asciiLower(s);
  return replaceTags(s, (lt) => {
    const at = lower[lt + 1] === "/" ? lt + 2 : lt + 1;
    return BLOCK.has(lower.slice(at, wordEnd(lower, at))) ? "\n" : null;
  });
}

const stripTags = (s: string) => replaceTags(s, () => " ");

export function htmlToText(html: string, maxChars: number): string {
  // Keep the title first (it often names the business or the service list).
  let title: string | null = null;
  stripElements(html, TITLE, true, (c) => (title ??= c));
  let text = stripComments(html);
  text = stripElements(text, TITLE, true);
  text = stripElements(text, DROP, false);
  text = stripTags(blocksToLines(text));
  return lines(decodeEntities(`${title ?? ""}\n${text}`)).join("\n").slice(0, maxChars);
}

/** Plain text bodies: normalized line endings and whitespace, capped. */
export function plainText(text: string, maxChars: number): string {
  return lines(text.replace(/\r\n?/g, "\n")).join("\n").slice(0, maxChars);
}
