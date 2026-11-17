/**
 * SP-18 answers render a small markdown subset as React elements, never as
 * HTML (no dangerouslySetInnerHTML): paragraphs, line breaks, "-"/"*" and
 * "1." lists, **bold**, [label](href) links and bare URLs. Links open only
 * known in-app routes (bare, or `?record=<kind>:<id>`) and http(s) URLs, and
 * show their target as the title; anything else stays plain text.
 * Model output and customer-written text pass through React's escaping.
 */
import { createElement, Fragment, type ReactNode } from "react";

/** In-app routes a model link may open (with no query, or only `?record=<kind>:<id>`). */
const SAFE_ROUTES = new Set(["dashboard", "inbox", "calendar", "campaigns", "pipeline", "contacts", "followups", "analytics", "agent", "copilot"]);
const RECORD_TARGET = /^(contact|conversation|ticket|booking|campaign):[A-Za-z0-9_-]{1,64}$/;

function safeHash(h: string): string | null {
  const m = /^#\/([a-z]+)(?:\?(.*))?$/.exec(h);
  if (!m || !SAFE_ROUTES.has(m[1])) return null;
  if (m[2] === undefined || m[2] === "") return `#/${m[1]}`;
  const q = new URLSearchParams(m[2]);
  const keys = [...q.keys()];
  const rec = q.get("record");
  return keys.length === 1 && keys[0] === "record" && rec && RECORD_TARGET.test(rec) ? `#/${m[1]}?record=${rec}` : null;
}

export function safeLinkHref(href: string): string | null {
  const h = href.trim();
  if (h.startsWith("#")) return safeHash(h);
  try {
    const u = new URL(h);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

const INLINE = /\*\*([^*\n]+)\*\*|\[([^\]\n]{1,200})\]\(([^)\s]{1,2000})\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

function link(key: string, href: string, label: string): ReactNode {
  const external = !href.startsWith("#/");
  // The target is always visible on hover (title), whatever the label says.
  return createElement("a", { key, href, title: href, ...(external ? { target: "_blank", rel: "noopener noreferrer" } : {}) }, label);
}

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const k = `${keyBase}-${n++}`;
    if (m[1] !== undefined) out.push(createElement("strong", { key: k }, m[1]));
    else if (m[2] !== undefined) {
      const href = safeLinkHref(m[3]);
      out.push(href ? link(k, href, m[2]) : m[0]);
    } else if (m[4] !== undefined) {
      const href = safeLinkHref(m[4]);
      out.push(href ? link(k, href, m[4]) : m[4]);
    }
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBERED = /^\s*\d{1,3}[.)]\s+(.*)$/;

/** The answer as React nodes. */
export function renderMarkdownLite(text: string): ReactNode {
  const blocks = String(text ?? "").replace(/\r\n?/g, "\n").split(/\n{2,}/);
  const nodes: ReactNode[] = [];
  blocks.forEach((block, bi) => {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (!lines.length) return;
    if (lines.every((l) => BULLET.test(l)) || lines.every((l) => NUMBERED.test(l))) {
      const ordered = NUMBERED.test(lines[0]);
      const re = ordered ? NUMBERED : BULLET;
      nodes.push(
        createElement(
          ordered ? "ol" : "ul",
          { key: `b${bi}` },
          lines.map((l, li) => createElement("li", { key: li }, inline(re.exec(l)![1], `b${bi}-${li}`))),
        ),
      );
      return;
    }
    nodes.push(
      createElement(
        "p",
        { key: `b${bi}` },
        lines.map((l, li) => createElement(Fragment, { key: li }, ...inline(l, `b${bi}-${li}`), li < lines.length - 1 ? createElement("br") : null)),
      ),
    );
  });
  return createElement(Fragment, null, ...nodes);
}
