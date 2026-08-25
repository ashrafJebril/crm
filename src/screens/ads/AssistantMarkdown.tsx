import { useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Assistant-message markdown renderer — imported through React.lazy from
 * ChatBubble so react-markdown + remark-gfm land in their OWN async chunk,
 * never the main bundle. It loads the first time an assistant bubble renders.
 *
 * SECURITY: `skipHtml` + NO `rehype-raw` → the model's text can never inject
 * executable HTML. react-markdown builds React elements from the markdown AST
 * (no dangerouslySetInnerHTML), remark-gfm adds ONLY markdown syntax (tables,
 * bold, lists, strikethrough), and only the whitelisted tags below can render —
 * a <script> or <img onerror> in the reply stays inert text.
 *
 * Colours come from the CRM token layer, so light mode needs no second set.
 * User messages never reach here; they stay plain text in ChatBubble.
 */
export default function AssistantMarkdown({ text }: { text: string }) {
  const components = useMemo<Components>(
    () => ({
      // `node` is react-markdown's AST handle — destructured off so it never
      // reaches the DOM element as an unknown attribute.
      p: ({ node: _n, ...p }) => <p style={{ margin: "0 0 8px" }} {...p} />,
      strong: ({ node: _n, ...p }) => <strong style={{ fontWeight: 700, color: "var(--ink)" }} {...p} />,
      a: ({ node: _n, ...p }) => (
        <a
          style={{ color: "var(--accent)", textDecoration: "underline" }}
          target="_blank"
          rel="noopener noreferrer"
          {...p}
        />
      ),
      // Headings are demoted to h3 — the page already owns h1 (PageHeader), and
      // a reply must never outrank it in the document outline.
      h1: ({ node: _n, ...p }) => (
        <h3 style={{ fontSize: 15, fontWeight: 700, color: "var(--ink)", margin: "10px 0 6px" }} {...p} />
      ),
      h2: ({ node: _n, ...p }) => (
        <h3 style={{ fontSize: 14.5, fontWeight: 700, color: "var(--ink)", margin: "10px 0 6px" }} {...p} />
      ),
      h3: ({ node: _n, ...p }) => (
        <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)", margin: "8px 0 5px" }} {...p} />
      ),
      ul: ({ node: _n, ...p }) => <ul style={{ margin: "0 0 8px", paddingInlineStart: 20 }} {...p} />,
      ol: ({ node: _n, ...p }) => <ol style={{ margin: "0 0 8px", paddingInlineStart: 20 }} {...p} />,
      li: ({ node: _n, ...p }) => <li style={{ margin: "2px 0" }} {...p} />,
      blockquote: ({ node: _n, ...p }) => (
        <blockquote
          style={{
            margin: "0 0 8px",
            paddingInlineStart: 10,
            borderInlineStart: "2px solid var(--line)",
            color: "var(--ink-1)",
          }}
          {...p}
        />
      ),
      // Same background on pre + code → an inline pill and a fenced block read
      // as one material.
      code: ({ node: _n, ...p }) => (
        <code
          style={{
            background: "var(--bg-2)",
            borderRadius: 4,
            padding: "1px 5px",
            fontFamily: "var(--font-mono)",
            fontSize: "0.9em",
            color: "var(--ink-1)",
          }}
          {...p}
        />
      ),
      pre: ({ node: _n, ...p }) => (
        <pre style={{ margin: "0 0 8px", background: "var(--bg-2)", borderRadius: 8, padding: 10, overflowX: "auto" }} {...p} />
      ),
      // OVERFLOW: a wide (5-column) table scrolls horizontally inside the
      // bubble instead of blowing out the two-column page layout.
      table: ({ node: _n, ...p }) => (
        <div style={{ overflowX: "auto", maxWidth: "100%", margin: "0 0 8px" }}>
          <table
            style={{ borderCollapse: "collapse", width: "max-content", minWidth: "100%", fontSize: 12.5 }}
            {...p}
          />
        </div>
      ),
      // RTL: dir="auto" per cell → an Arabic header renders RTL while a numeric
      // cell (0.21 JOD, 7.17%) is detected LTR and kept as ONE isolated LTR run,
      // so the bidi algorithm can't reorder the % or the currency. textAlign
      // follows the GFM column-alignment marker when present, else logical start.
      th: ({ node: _n, style, ...rest }) => (
        <th
          dir="auto"
          style={{
            border: "1px solid var(--line)",
            background: "var(--bg-2)",
            color: "var(--ink)",
            fontWeight: 600,
            padding: "6px 9px",
            unicodeBidi: "isolate",
            textAlign: style?.textAlign ?? "start",
          }}
          {...rest}
        />
      ),
      td: ({ node: _n, style, ...rest }) => (
        <td
          dir="auto"
          style={{
            border: "1px solid var(--line)",
            color: "var(--ink-1)",
            padding: "6px 9px",
            unicodeBidi: "isolate",
            textAlign: style?.textAlign ?? "start",
          }}
          {...rest}
        />
      ),
    }),
    [],
  );

  return (
    <div className="ads-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
