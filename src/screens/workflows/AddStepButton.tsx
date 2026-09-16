import type { WorkflowStepType } from "@/lib/types";
import type { Tx } from "@/lib/tx";

function optionLabel(value: WorkflowStepType, tx: Tx): string {
  switch (value) {
    case "send_whatsapp":
      return tx("Send WhatsApp", "إرسال واتساب");
    case "ask_agent":
      return tx("Ask AI Agent", "اسأل وكيل الذكاء");
    case "update_data":
      return tx("Update CRM Data", "تحديث بيانات العميل");
    case "condition":
      return tx("Condition", "شرط");
    case "ai_condition":
      return tx("AI Condition", "شرط بالذكاء الاصطناعي");
    case "delay":
      return tx("Delay", "تأخير");
  }
}

const OPTION_VALUES: WorkflowStepType[] = [
  "send_whatsapp",
  "ask_agent",
  "update_data",
  "condition",
  "ai_condition",
  "delay",
];

export function AddStepButton({ onAdd, tx }: { onAdd: (type: WorkflowStepType) => void; tx: Tx }) {
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
      <option value="">{tx("+ Add step", "+ إضافة خطوة")}</option>
      {OPTION_VALUES.map((value) => (
        <option key={value} value={value}>
          {optionLabel(value, tx)}
        </option>
      ))}
    </select>
  );
}
