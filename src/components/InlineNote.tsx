import { MentionText } from "./MentionText";
import { useSeenOnView } from "@/lib/useSeenOnView";
import type { Note } from "@/lib/types";

/** An internal note rendered inside a conversation thread. Visually distinct
 *  from message bubbles (dashed border, warm tint, "Internal note" label) so it
 *  is never mistaken for something the customer can see. */
export function InlineNote({
  note,
  authorName,
  label,
  timeLabel,
  isOwn,
}: {
  note: Note;
  authorName?: string;
  label: string;
  timeLabel: string;
  isOwn?: boolean;
}) {
  const ref = useSeenOnView(note.id, !!isOwn);
  return (
    <div
      ref={ref}
      role="note"
      style={{
        alignSelf: "center",
        width: "min(520px, 92%)",
        marginInlineStart: note.parentId ? 28 : undefined,
        border: "1px dashed var(--warn)",
        background: "color-mix(in oklab, var(--warn) 10%, var(--bg-1))",
        borderRadius: 10,
        padding: "8px 12px",
        fontSize: 13,
        lineHeight: 1.45,
      }}
    >
      <div
        className="mono"
        style={{
          display: "flex",
          gap: 8,
          fontSize: 10,
          color: "var(--ink-3)",
          textTransform: "uppercase",
          letterSpacing: 0.06,
          marginBottom: 3,
        }}
      >
        <span>{label}</span>
        {authorName && (
          <span dir="auto" style={{ textTransform: "none" }}>
            · {authorName}
          </span>
        )}
        <span style={{ marginInlineStart: "auto" }}>{timeLabel}</span>
      </div>
      <MentionText body={note.body} />
    </div>
  );
}
