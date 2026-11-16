/**
 * SP-10 catalog import: a fetched page as plain text for extraction. Pure.
 * Scripts, styles, templates, SVG and comments are dropped with their content;
 * block elements become line breaks; entities are decoded; whitespace is
 * collapsed; the result is capped. The text is untrusted data: it only ever
 * reaches the model as the document to extract from, never as instructions.
 */
const DROP = /<(script|style|noscript|template|svg|iframe|object|embed|head)\b[\s\S]*?<\/\1\s*>/gi;
const BLOCK = /<\/?(p|div|br|li|ul|ol|tr|td|th|table|h[1-6]|section|article|header|footer|nav|main|aside|dt|dd|dl|pre|blockquote|hr|figure|figcaption|address|option)\b[^>]*>/gi;
const TITLE = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i;
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

export function htmlToText(html: string, maxChars: number): string {
  // Keep the title first (it often names the business or the service list).
  const title = TITLE.exec(html)?.[1] ?? "";
  const text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(new RegExp(TITLE.source, "gi"), " ")
    .replace(DROP, " ")
    .replace(BLOCK, "\n")
    .replace(/<[^>]*>/g, " ");
  return lines(decodeEntities(`${title}\n${text}`)).join("\n").slice(0, maxChars);
}

/** Plain text bodies: normalized line endings and whitespace, capped. */
export function plainText(text: string, maxChars: number): string {
  return lines(text.replace(/\r\n?/g, "\n")).join("\n").slice(0, maxChars);
}
