/**
 * SP-21 (ruling 10): business content is TipTap JSON validated against an
 * allow-list, plus derived markdown-like text. Pure. The backend never emits
 * HTML; anything outside the allow-list is a 400 `knowledge.content_invalid`.
 *
 * Allowed nodes: doc, paragraph, heading (level 1-3), bulletList,
 * orderedList, listItem, text, hardBreak. Allowed marks: bold, italic,
 * link (href https: or mailto: only).
 */
import { knowledgeError } from "./knowledge-errors";
import { KNOWLEDGE_CONTENT_MAX } from "./knowledge-constants";

/** Raw JSON size and nesting accepted before walking (cheap DoS guard). */
export const CONTENT_JSON_MAX_BYTES = 1_000_000;
export const CONTENT_MAX_DEPTH = 20;

type Node = { type?: unknown; attrs?: unknown; content?: unknown; text?: unknown; marks?: unknown };

const BLOCKS = new Set(["paragraph", "heading", "bulletList", "orderedList", "listItem"]);
const ATTRS: Record<string, string[]> = {
  heading: ["level", "textAlign", "dir"],
  paragraph: ["textAlign", "dir"],
  orderedList: ["start", "type"],
  bulletList: [],
  listItem: [],
  doc: [],
  text: [],
  hardBreak: [],
};

const invalid = () => knowledgeError("knowledge.content_invalid");

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function checkAttrs(type: string, attrs: unknown) {
  if (attrs === undefined || attrs === null) return;
  if (!isObj(attrs)) throw invalid();
  const allowed = ATTRS[type] ?? [];
  for (const [k, v] of Object.entries(attrs)) {
    if (!allowed.includes(k)) throw invalid();
    if (v !== null && typeof v !== "string" && typeof v !== "number") throw invalid();
  }
  if (type === "heading") {
    const level = (attrs as { level?: unknown }).level;
    if (level !== undefined && !(level === 1 || level === 2 || level === 3)) throw invalid();
  }
}

export function safeHref(href: unknown): href is string {
  if (typeof href !== "string" || href.length > 2000) return false;
  try {
    const u = new URL(href);
    return u.protocol === "https:" || u.protocol === "mailto:";
  } catch {
    return false;
  }
}

function inlineText(node: Node): string {
  if (node.type === "hardBreak") {
    if (node.content !== undefined || node.marks !== undefined) throw invalid();
    checkAttrs("hardBreak", node.attrs);
    return "\n";
  }
  if (node.type !== "text" || typeof node.text !== "string") throw invalid();
  if (node.content !== undefined) throw invalid();
  checkAttrs("text", node.attrs);
  let href: string | null = null;
  if (node.marks !== undefined) {
    if (!Array.isArray(node.marks)) throw invalid();
    for (const m of node.marks as unknown[]) {
      if (!isObj(m)) throw invalid();
      if (m.type === "bold" || m.type === "italic") {
        if (m.attrs !== undefined && m.attrs !== null && (!isObj(m.attrs) || Object.keys(m.attrs).length)) throw invalid();
        continue;
      }
      if (m.type === "link") {
        if (!isObj(m.attrs) || !safeHref(m.attrs.href)) throw invalid();
        for (const k of Object.keys(m.attrs)) if (!["href", "target", "rel", "class"].includes(k)) throw invalid();
        href = m.attrs.href as string;
        continue;
      }
      throw invalid();
    }
  }
  return href && href !== node.text ? `${node.text} (${href})` : node.text;
}

function children(node: Node): Node[] {
  if (node.content === undefined) return [];
  if (!Array.isArray(node.content)) throw invalid();
  for (const c of node.content) if (!isObj(c)) throw invalid();
  return node.content as Node[];
}

function inlineRun(node: Node): string {
  return children(node).map(inlineText).join("");
}

/** `prefix` is put before the first line of this block; `indent` before later ones (lists). */
function block(node: Node, depth: number, out: string[], prefix = "", indent = ""): void {
  if (depth > CONTENT_MAX_DEPTH) throw invalid();
  const type = node.type;
  if (typeof type !== "string" || !BLOCKS.has(type)) throw invalid();
  if (node.text !== undefined || node.marks !== undefined) throw invalid();
  checkAttrs(type, node.attrs);
  switch (type) {
    case "paragraph": {
      const t = inlineRun(node).trim();
      if (t) out.push(prefix + t.replace(/\n/g, "\n" + indent));
      return;
    }
    case "heading": {
      const level = Number((node.attrs as { level?: number } | undefined)?.level ?? 1);
      const t = inlineRun(node).replace(/\n/g, " ").trim();
      if (t) out.push(`${"#".repeat(level)} ${t}`);
      return;
    }
    case "bulletList":
    case "orderedList": {
      let n = Number((node.attrs as { start?: number } | undefined)?.start ?? 1) || 1;
      for (const item of children(node)) {
        if (item.type !== "listItem") throw invalid();
        const marker = type === "bulletList" ? "- " : `${n++}. `;
        block(item, depth + 1, out, indent + marker, indent + " ".repeat(marker.length));
      }
      return;
    }
    case "listItem": {
      children(node).forEach((k, i) => {
        if (k.type === "listItem") throw invalid(); // only inside a list
        block(k, depth + 1, out, i === 0 ? prefix : indent, indent);
      });
      return;
    }
  }
}

/**
 * Validate a TipTap document and derive its text: `#`-prefixed headings,
 * `- ` / `1. ` list items, blank lines between blocks. Throws 400
 * `knowledge.content_invalid` for anything outside the allow-list and
 * `knowledge.content_too_long {max}` past KNOWLEDGE_CONTENT_MAX characters.
 */
export function tiptapToText(doc: unknown): string {
  if (!isObj(doc) || doc.type !== "doc") throw invalid();
  let size: number;
  try {
    size = JSON.stringify(doc).length;
  } catch {
    throw invalid();
  }
  if (size > CONTENT_JSON_MAX_BYTES) throw knowledgeError("knowledge.content_too_long", { max: KNOWLEDGE_CONTENT_MAX });
  for (const k of Object.keys(doc)) if (!["type", "content", "attrs"].includes(k)) throw invalid();
  checkAttrs("doc", doc.attrs);
  const out: string[] = [];
  for (const node of children(doc as Node)) {
    if (node.type === "listItem") throw invalid(); // only inside a list
    block(node, 1, out);
  }
  const text = out.join("\n\n").trim();
  if (text.length > KNOWLEDGE_CONTENT_MAX) throw knowledgeError("knowledge.content_too_long", { max: KNOWLEDGE_CONTENT_MAX });
  return text;
}
