import type { Extensions, JSONContent } from "@tiptap/core";
import { Link } from "@tiptap/extension-link";
import StarterKit from "@tiptap/starter-kit";

/**
 * SP-21 the business-content editor's schema, shared by ContentEditor and the
 * cross-check test that runs its JSON through the backend validator
 * (backend/src/knowledge-sources/knowledge-content.ts).
 *
 * The backend accepts: doc, paragraph, heading 1-3, bulletList, orderedList,
 * listItem, text, hardBreak; marks bold, italic and link with attributes
 * href (https: or mailto: only), target, rel and class. So StarterKit runs
 * without blockquote, code, codeBlock, horizontalRule, strike and underline,
 * and its Link is replaced by one that has no `title` attribute (TipTap 3
 * always serializes `title: null`, which the backend refuses) and accepts
 * only https and mailto links, typed, pasted or auto-linked.
 */

/** Only https and mailto links (the backend refuses anything else). A bare host gets https://. */
export function safeLink(raw: string): string | null {
  const v = String(raw ?? "").trim();
  if (!v) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`;
  try {
    const u = new URL(withScheme);
    return u.protocol === "https:" || u.protocol === "mailto:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** The link attributes the backend accepts. */
export const LINK_ATTRS = ["href", "target", "rel", "class"] as const;

export const KnowledgeLink = Link.extend({
  addAttributes() {
    const parent = (this.parent?.() ?? {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const name of LINK_ATTRS) if (name in parent) out[name] = parent[name];
    return out;
  },
}).configure({
  openOnClick: false,
  autolink: true,
  protocols: ["mailto"],
  defaultProtocol: "https",
  // Typed, pasted and parsed links: https and mailto only (an http link stays text).
  isAllowedUri: (uri) => !!uri && /^(https:|mailto:)/i.test(uri) && !!safeLink(uri),
  shouldAutoLink: (uri) => !!safeLink(uri) && !/^http:/i.test(uri),
});

export function knowledgeExtensions(): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      blockquote: false,
      code: false,
      codeBlock: false,
      horizontalRule: false,
      strike: false,
      underline: false,
      link: false,
    }),
    KnowledgeLink,
  ];
}

/** Pasted HTML: `http:` links become `https:` (the backend accepts https only). */
export function upgradePastedLinks(html: string): string {
  return html.replace(/(\shref\s*=\s*["']?)http:\/\//gi, "$1https://");
}

type Mark = NonNullable<JSONContent["marks"]>[number];

/**
 * A last safety net before saving: link marks keep only the accepted
 * attributes; a link whose href is not https/mailto is dropped (its text stays).
 */
export function sanitizeDoc(doc: JSONContent): JSONContent {
  const fixMark = (m: Mark): Mark | null => {
    if (m.type !== "link") return m;
    const href = typeof m.attrs?.href === "string" ? m.attrs.href : "";
    const ok = /^(https:|mailto:)/i.test(href) ? safeLink(href) : null;
    if (!ok) return null;
    const attrs: Record<string, unknown> = {};
    for (const k of LINK_ATTRS) if (m.attrs && k in m.attrs) attrs[k] = m.attrs[k];
    return { ...m, attrs };
  };
  const walk = (n: JSONContent): JSONContent => {
    const out: JSONContent = { ...n };
    if (n.marks) {
      const marks = n.marks.map(fixMark).filter((m): m is Mark => m !== null);
      if (marks.length) out.marks = marks;
      else delete out.marks;
    }
    if (n.content) out.content = n.content.map(walk);
    return out;
  };
  return walk(doc);
}

/** The hrefs in a document the backend would refuse (for the error line). */
export function badLinks(doc: JSONContent): string[] {
  const out: string[] = [];
  const walk = (n: JSONContent) => {
    for (const m of n.marks ?? []) {
      if (m.type !== "link") continue;
      const href = typeof m.attrs?.href === "string" ? m.attrs.href : "";
      if (!/^(https:|mailto:)/i.test(href) || !safeLink(href)) out.push(href || "(empty)");
    }
    for (const c of n.content ?? []) walk(c);
  };
  walk(doc);
  return [...new Set(out)];
}
