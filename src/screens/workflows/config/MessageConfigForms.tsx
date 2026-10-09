import type { Tx } from "@/lib/tx";
import type { WorkflowAskAgentConfig, WorkflowSendWhatsappConfig, WorkflowTriggerType } from "@/lib/types";
import { VariableMentionField, type VariableOption } from "../VariableMentionField";

const TRIGGER_VARIABLES: Record<WorkflowTriggerType, VariableOption[]> = {
  contact_created: [
    { path: "trigger.contact.name", label: "Contact name" },
    { path: "trigger.contact.phone", label: "Contact phone" },
    { path: "trigger.contact.lifecycle", label: "Contact lifecycle" },
  ],
  message_received: [
    { path: "trigger.contact.name", label: "Contact name" },
    { path: "trigger.message.body", label: "Message body" },
    { path: "trigger.conversation.channel", label: "Channel" },
  ],
  ticket_created: [
    { path: "trigger.ticket.title", label: "Ticket title" },
    { path: "trigger.ticket.number", label: "Ticket number" },
  ],
  ticket_stage_changed: [
    { path: "trigger.ticket.title", label: "Ticket title" },
    { path: "trigger.ticket.stageId", label: "New stage id" },
  ],
  schedule: [],
  webhook: [],
};

const NO_CONVERSATION_TRIGGERS: WorkflowTriggerType[] = ["contact_created", "schedule", "webhook"];

export function SendWhatsappConfigForm({
  config,
  onChange,
  triggerType,
  tx,
}: {
  config: WorkflowSendWhatsappConfig;
  onChange: (c: WorkflowSendWhatsappConfig) => void;
  triggerType: WorkflowTriggerType;
  tx: Tx;
}) {
  return (
    <div>
      <label style={{ fontSize: 12, color: "var(--ink-3)" }}>{tx("Message", "الرسالة")}</label>
      <VariableMentionField
        value={config.message}
        onChange={(message) => onChange({ message })}
        variables={TRIGGER_VARIABLES[triggerType]}
        placeholder={tx("Type your message…", "اكتب رسالتك…")}
      />
      {NO_CONVERSATION_TRIGGERS.includes(triggerType) && (
        <div
          style={{
            marginTop: 6,
            padding: "10px 12px",
            borderRadius: 8,
            background: "color-mix(in oklch, var(--warn) 10%, transparent)",
            border: "1px solid color-mix(in oklch, var(--warn) 35%, transparent)",
            color: "var(--ink-1)",
            fontSize: 12,
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <span style={{ color: "var(--warn)", fontSize: 14 }}>⚠</span>
          <div style={{ flex: 1, minWidth: 0, lineHeight: 1.4 }}>
            {tx(
              "This trigger has no conversation to reply in — sending will fail. Use a Message received or Ticket trigger instead, or add an Update CRM Data / Ask AI Agent step instead.",
              "لا يوجد محادثة للرد عليها لهذا المُشغّل — سيفشل الإرسال. استخدم مُشغّل رسالة واردة أو تذكرة بدلاً من ذلك، أو أضف خطوة تحديث بيانات CRM / اسأل وكيل الذكاء بدلاً من ذلك.",
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function AskAgentConfigForm({
  config,
  onChange,
  triggerType,
  tx,
}: {
  config: WorkflowAskAgentConfig;
  onChange: (c: WorkflowAskAgentConfig) => void;
  triggerType: WorkflowTriggerType;
  tx: Tx;
}) {
  return (
    <div>
      <label style={{ fontSize: 12, color: "var(--ink-3)" }}>{tx("Prompt", "الطلب")}</label>
      <VariableMentionField
        value={config.prompt}
        onChange={(prompt) => onChange({ prompt })}
        variables={TRIGGER_VARIABLES[triggerType]}
        placeholder={tx("Ask the AI agent…", "اسأل وكيل الذكاء…")}
      />
    </div>
  );
}
