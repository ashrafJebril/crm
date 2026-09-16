import type { WorkflowStep } from "@/lib/types";
import { IconTrash } from "@/icons";

const STEP_LABEL: Record<WorkflowStep["type"], string> = {
  condition: "Condition",
  ai_condition: "AI Condition",
  send_whatsapp: "Send WhatsApp",
  ask_agent: "Ask AI Agent",
  update_data: "Update CRM Data",
  delay: "Delay",
};

export function StepCard({
  step,
  selected,
  onSelect,
  onRemove,
}: {
  step: WorkflowStep;
  selected: boolean;
  onSelect: () => void;
  onRemove?: () => void;
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
      <span style={{ fontSize: 13 }}>{STEP_LABEL[step.type]}</span>
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
