import type { WorkflowStepType } from "@/lib/types";

const OPTIONS: Array<{ value: WorkflowStepType; label: string }> = [
  { value: "send_whatsapp", label: "Send WhatsApp" },
  { value: "ask_agent", label: "Ask AI Agent" },
  { value: "update_data", label: "Update CRM Data" },
  { value: "condition", label: "Condition" },
  { value: "ai_condition", label: "AI Condition" },
  { value: "delay", label: "Delay" },
];

export function AddStepButton({ onAdd }: { onAdd: (type: WorkflowStepType) => void }) {
  return (
    <select
      value=""
      onChange={(e) => {
        const type = e.target.value as WorkflowStepType;
        if (type) onAdd(type);
        e.target.value = "";
      }}
      style={{ marginTop: 8, fontSize: 12 }}
    >
      <option value="">{"+ Add step"}</option>
      {OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
