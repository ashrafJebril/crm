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
