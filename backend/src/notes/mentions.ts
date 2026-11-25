/** Mention token: `@[display name](user:<id>)`. The name has no `]`. */
export const MENTION_RE = /@\[([^\]]+)\]\(user:([A-Za-z0-9_-]+)\)/g;

/** Unique mentioned user ids, in order of first appearance. */
export function parseMentions(body: string): string[] {
  const ids: string[] = [];
  for (const m of body.matchAll(new RegExp(MENTION_RE.source, "g"))) {
    if (!ids.includes(m[2])) ids.push(m[2]);
  }
  return ids;
}

/** Render tokens as plain `@name`. */
export function renderMentions(body: string): string {
  return body.replace(new RegExp(MENTION_RE.source, "g"), "@$1");
}

/** First `max` user-perceived characters (grapheme clusters), so an emoji or
 *  combined sequence is never cut in half. */
export function excerptOf(text: string, max = 120): string {
  const Seg = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  const units = Seg
    ? Array.from(new Seg(undefined, { granularity: "grapheme" }).segment(text), (s) => s.segment)
    : Array.from(text);
  return units.length <= max ? text : units.slice(0, max).join("");
}
