import type { ConversationLabel } from "@/lib/types";
import { LABEL_COLOR_VAR } from "./LabelPicker";

/** At most two label chips on a row, then "+n". */
export function LabelChips({
  labelIds,
  labelById,
}: {
  labelIds: string[];
  labelById: Map<string, ConversationLabel>;
}) {
  const labels = labelIds.map((id) => labelById.get(id)).filter((l): l is ConversationLabel => !!l);
  if (!labels.length) return null;
  const shown = labels.slice(0, 2);
  const more = labels.length - shown.length;
  return (
    <span style={{ display: "inline-flex", gap: 4, alignItems: "center", minWidth: 0 }}>
      {shown.map((l) => (
        <span
          key={l.id}
          dir="auto"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontSize: 10.5,
            maxWidth: 80,
            padding: "1px 6px",
            borderRadius: 99,
            border: "1px solid var(--line-soft)",
            color: "var(--ink-2)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          <span
            style={{ width: 6, height: 6, borderRadius: 99, flex: "0 0 auto", background: LABEL_COLOR_VAR[l.color] }}
          />
          {l.name}
        </span>
      ))}
      {more > 0 && <span style={{ fontSize: 10.5, color: "var(--ink-3)" }}>+{more}</span>}
    </span>
  );
}
