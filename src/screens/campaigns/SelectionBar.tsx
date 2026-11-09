import type { Tx } from "@/lib/tx";
import type { FollowUpMode } from "./FollowUpDialog";
import { fmtNum } from "./ui";

interface Props {
  tickedCount: number;
  canExport: boolean;
  canCreateGroup: boolean;
  canAddToGroup: boolean;
  canTag: boolean;
  onExport: (ticked: boolean) => void;
  onFollowUp: (mode: FollowUpMode) => void;
  onClear: () => void;
  tx: Tx;
}

/**
 * Report actions. Each one works from the current outcome or the ticked rows
 * (the dialog asks which). Actions the role can't use are not rendered.
 */
export function SelectionBar({ tickedCount, canExport, canCreateGroup, canAddToGroup, canTag, onExport, onFollowUp, onClear, tx }: Props) {
  if (!canExport && !canCreateGroup && !canAddToGroup && !canTag) return null;
  return (
    <div
      role="toolbar"
      aria-label={tx("Follow-up actions", "إجراءات المتابعة")}
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 8,
        padding: "8px 12px",
        borderRadius: 10,
        border: `1px solid ${tickedCount ? "var(--accent-ring)" : "var(--line-soft)"}`,
        background: tickedCount ? "var(--accent-soft)" : "var(--bg-1)",
      }}
    >
      <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
        {tickedCount
          ? tx(`${fmtNum(tickedCount)} ticked`, `${fmtNum(tickedCount)} محدد`)
          : tx("Follow up with an outcome, or tick rows", "تابع نتيجة كاملة، أو حدد صفوفًا")}
      </span>
      {tickedCount > 0 && (
        <button className="btn ghost sm" onClick={onClear}>
          {tx("Clear", "مسح التحديد")}
        </button>
      )}
      <span style={{ flex: 1 }} />
      {canExport && (
        <button className="btn sm" onClick={() => onExport(tickedCount > 0)}>
          {tickedCount ? tx("Export ticked", "تصدير المحدد") : tx("Export", "تصدير")}
        </button>
      )}
      {canCreateGroup && (
        <button className="btn sm" onClick={() => onFollowUp("create-group")}>
          {tx("Create group", "إنشاء مجموعة")}
        </button>
      )}
      {canAddToGroup && (
        <button className="btn sm" onClick={() => onFollowUp("add-to-group")}>
          {tx("Add to group", "إضافة إلى مجموعة")}
        </button>
      )}
      {canTag && (
        <button className="btn sm" onClick={() => onFollowUp("tag")}>
          {tx("Tag", "وسم")}
        </button>
      )}
    </div>
  );
}
