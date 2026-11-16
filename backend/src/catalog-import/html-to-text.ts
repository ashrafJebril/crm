/**
 * SP-10 catalog import: a fetched page as plain text for extraction. Pure.
 * Scripts, styles, templates, SVG and comments are dropped with their content;
 * block elements become line breaks; entities are decoded; whitespace is
 * collapsed; the result is capped. The text is untrusted data: it only ever
 * reaches the model as the document to extract from, never as instructions.
 *
 * Every pass is a single left-to-right scan with `indexOf` (review I1): the
 * former lazy regexes rescanned to the end of the input for each opener with
 * no closer, which is quadratic on a hostile or broken page. The output on
 * well-formed input is the same as theirs; an opener whose closer is missing
 * now drops the rest of the input.
 */

// Element names are the whole word after `<` (the old regexes' `\b`), ASCII case-insensitive.
const DROP = new Set(["script", "style", "noscript", "template", "svg", "iframe", "object", "embed", "head"]);
const BLOCK = new Set([
  "p", "div", "br", "li", "ul", "ol", "tr", "td", "th", "table", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article",
  "header", "footer", "nav", "main", "aside", "dt", "dd", "dl", "pre", "blockquote", "hr", "figure", "figcaption", "address", "option",
]);
const TITLE = new Set(["title"]);
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
 * Each `<name …>…</name>` (name in `names`) → a space. With `attrs`, the
 * content starts after the opener's `>` (the old `<title\b[^>]*>`); otherwise
 * right after the name (the old DROP rule). An opener without its closer (or,
 * with `attrs`, without its `>`) drops the rest of the input. `onContent`
 * sees each element's content, in order.
 */
function stripElements(s: string, names: ReadonlySet<string>, attrs: boolean, onContent?: (content: string) => void): string {
  const lower = asciiLower(s);
  // Openers only: a fixed-length match with no lazy part, so one linear pass.
  const opener = new RegExp(`<(${[...names].join("|")})(?![a-z0-9_])`, "g");
  const out: string[] = [];
  let pos = 0;
  for (let m = opener.exec(lower); m; m = opener.exec(lower)) {
    const lt = m.index;
    const name = m[1];
    out.push(s.slice(pos, lt), " ");
    const nameEnd = lt + 1 + name.length;
    const contentStart = attrs ? lower.indexOf(">", nameEnd) + 1 : nameEnd;
    if (contentStart === 0) return out.join("");
    const closer = findCloser(lower, name, contentStart);
    if (!closer) return out.join("");
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
