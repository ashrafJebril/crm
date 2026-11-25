import { renderMentionParts } from "@/lib/mentions";

/** Renders a note body: `@[Name](user:id)` tokens become chips, everything else
 *  stays plain text (React escapes it — no HTML is ever injected). */
export function MentionText({ body }: { body: string }) {
  return (
    <span dir="auto" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
      {renderMentionParts(body).map((p, i) =>
        "mention" in p ? (
          <span
            key={i}
            className="mention-chip"
            dir="auto"
            title={p.mention.name}
            style={{
              display: "inline-block",
              padding: "0 6px",
              borderRadius: 999,
              background: "color-mix(in oklab, var(--accent) 18%, transparent)",
              color: "var(--accent)",
              fontWeight: 600,
              fontSize: "0.95em",
              lineHeight: 1.5,
            }}
          >
            @{p.mention.name}
          </span>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </span>
  );
}
