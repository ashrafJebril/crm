/** Mention tokens in note bodies: `@[Display Name](user:<id>)`. Mirrors backend/src/notes/mentions.ts. */
const MENTION_RE = /@\[([^\]]+)\]\(user:([A-Za-z0-9_-]+)\)/g;

export type MentionPart = { text: string } | { mention: { id: string; name: string } };

export function parseMentions(body: string): string[] {
  const ids: string[] = [];
  for (const m of body.matchAll(MENTION_RE)) {
    if (!ids.includes(m[2]!)) ids.push(m[2]!);
  }
  return ids;
}

export function renderMentionParts(body: string): MentionPart[] {
  const parts: MentionPart[] = [];
  let last = 0;
  for (const m of body.matchAll(MENTION_RE)) {
    const at = m.index ?? 0;
    if (at > last) parts.push({ text: body.slice(last, at) });
    parts.push({ mention: { id: m[2]!, name: m[1]! } });
    last = at + m[0].length;
  }
  if (last < body.length) parts.push({ text: body.slice(last) });
  return parts;
}

/** The `@query` being typed just before the caret, or null. The `@` must start
 *  the text or follow whitespace, and no whitespace may sit between it and the caret. */
export function mentionQuery(body: string, caret: number): { start: number; query: string } | null {
  const before = body.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(before[at - 1]!)) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query) || /[[\]()]/.test(query)) return null;
  return { start: at, query };
}

export function insertMention(
  body: string,
  caret: number,
  member: { id: string; name: string },
): { body: string; caret: number } {
  const name = member.name.replace(/[[\]()]/g, "").trim() || "user";
  const token = `@[${name}](user:${member.id}) `;
  const q = mentionQuery(body, caret);
  const start = q ? q.start : caret;
  const next = body.slice(0, start) + token + body.slice(caret);
  return { body: next, caret: start + token.length };
}

const strip = (name: string) => name.replace(/[[\]()]/g, "").trim() || "user";

/** Side-map editing: the textarea shows a plain `@Name`; the picked members are
 *  remembered and turned into tokens by `serializeMentions` on submit. */
export function insertMentionPlain(
  body: string,
  caret: number,
  member: { id: string; name: string },
): { body: string; caret: number } {
  const q = mentionQuery(body, caret);
  const start = q ? q.start : caret;
  const text = `@${strip(member.name)} `;
  return { body: body.slice(0, start) + text + body.slice(caret), caret: start + text.length };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function serializeMentions(display: string, picked: Array<{ id: string; name: string }>): string {
  if (picked.length === 0) return display;
  const byName = new Map<string, string>();
  for (const p of picked) byName.set(strip(p.name), p.id);
  const names = [...byName.keys()].sort((a, b) => b.length - a.length).map(escapeRe);
  const re = new RegExp(`(?<![^\\s])@(${names.join("|")})(?![\\p{L}\\p{N}_])`, "gu");
  return display.replace(re, (_m, name: string) => `@[${name}](user:${byName.get(name)})`);
}

/** Interleave `extra` items into `base` by createdAt. Base items without a
 *  timestamp keep their place; leftovers go at the end. */
export function mergeByTime<A extends { createdAt?: string }, B extends { createdAt: string }>(
  base: A[],
  extra: B[],
): Array<A | B> {
  const queue = [...extra].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const out: Array<A | B> = [];
  for (const item of base) {
    const t = item.createdAt ? Date.parse(item.createdAt) : NaN;
    if (!Number.isNaN(t)) {
      while (queue.length && Date.parse(queue[0]!.createdAt) <= t) out.push(queue.shift()!);
    }
    out.push(item);
  }
  return out.concat(queue);
}
