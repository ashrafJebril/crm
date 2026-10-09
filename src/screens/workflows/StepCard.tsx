import type { WorkflowStep } from "@/lib/types";
import type { Tx } from "@/lib/tx";
import { IconTrash } from "@/icons";

function stepLabel(type: WorkflowStep["type"], tx: Tx): string {
  switch (type) {
    case "condition":
      return tx("Condition", "شرط");
    case "ai_condition":
      return tx("AI Condition", "شرط بالذكاء الاصطناعي");
    case "send_whatsapp":
      return tx("Send WhatsApp", "إرسال واتساب");
    case "ask_agent":
      return tx("Ask AI Agent", "اسأل وكيل الذكاء");
    case "update_data":
      return tx("Update CRM Data", "تحديث بيانات العميل");
    case "delay":
      return tx("Delay", "تأخير");
  }
}

export function StepCard({
  step,
  selected,
  onSelect,
  onRemove,
  tx,
}: {
  step: WorkflowStep;
  selected: boolean;
  onSelect: () => void;
  onRemove?: () => void;
  tx: Tx;
}) {
  return (
    <div
      onClick={onSelect}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "8px 12px",
        borderRadius: 8,
        border: `1px solid ${selected ? "var(--accent)" : "var(--line-soft)"}`,
        cursor: "pointer",
        background: selected ? "var(--bg-2)" : "var(--bg-1)",
      }}
    >
      <span style={{ fontSize: 13 }}>{stepLabel(step.type, tx)}</span>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          aria-label="Remove step"
          style={{ background: "none", border: "none", cursor: "pointer" }}
        >
          <IconTrash w={14} />
        </button>
      )}
    </div>
  );
}
