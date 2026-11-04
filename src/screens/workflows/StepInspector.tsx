import type { Tx } from "@/lib/tx";
import type { WorkflowStep, WorkflowStepGraph, WorkflowTriggerType } from "@/lib/types";
import { IconAlert, IconX } from "@/icons";
import { isBranchStep } from "./graph";
import { STEP_META, TRIGGER_META, TRIGGER_ORDER, type WorkflowVariable } from "./stepMeta";
import { StepIcon, stepKindLabel } from "./StepNode";
import { TRIGGER_NODE_ID } from "./FlowCanvas";
import { AiConditionConfigForm, ConditionConfigForm, DelayConfigForm, UpdateDataConfigForm } from "./config/StepConfigForms";
import { AskAgentConfigForm, SendWhatsappConfigForm, SendWhatsappTemplateConfigForm } from "./config/MessageConfigForms";
import { TriggerConfigFields } from "./config/TriggerConfigFields";

interface Props {
  selectedId: string | null;
  graph: WorkflowStepGraph;
  order: string[];
  issues: Record<string, string | null>;
  triggerType: WorkflowTriggerType;
  triggerConfig: Record<string, unknown>;
  onTriggerType: (t: WorkflowTriggerType) => void;
  onTriggerConfig: (c: Record<string, unknown>) => void;
  onStepConfig: (id: string, config: WorkflowStep["config"]) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onClose: () => void;
  variablesFor: (stepId: string) => WorkflowVariable[];
  stageOptions: Array<{ id: string; label: string }>;
  workflowId: string | null;
  webhookSecret: string | null;
  tx: Tx;
}

function Issue({ text }: { text: string | null | undefined }) {
  if (!text) return null;
  return (
    <div className="wf-callout warn" role="alert">
      <IconAlert w={14} />
      <span>{text}</span>
    </div>
  );
}

export function StepInspector(p: Props) {
  const { tx, selectedId } = p;

  if (selectedId === TRIGGER_NODE_ID) {
    const meta = TRIGGER_META[p.triggerType];
    return (
      <aside className="wf-inspector" aria-label={tx("Trigger settings", "إعدادات المُشغّل")}>
        <div className="wf-ins-head">
          <StepIcon type="trigger" size="lg" />
          <div>
            <h3>
              {tx("Trigger", "المُشغّل")} · {tx(meta.en, meta.ar)}
            </h3>
            <p>{tx("What starts this workflow", "ما يبدأ هذه الأتمتة")}</p>
          </div>
          <button type="button" className="btn icon ghost sm" aria-label={tx("Close panel", "إغلاق اللوحة")} onClick={p.onClose}>
            <IconX w={14} />
          </button>
        </div>
        <div className="wf-ins-body">
          <Issue text={p.issues[TRIGGER_NODE_ID]} />
          <div className="wf-field">
            <label className="wf-label" htmlFor="wf-trg-type">
              {tx("When this happens", "عندما يحدث هذا")}
            </label>
            <select
              id="wf-trg-type"
              className="wf-input"
              value={p.triggerType}
              onChange={(e) => p.onTriggerType(e.target.value as WorkflowTriggerType)}
            >
              {TRIGGER_ORDER.map((t) => (
                <option key={t} value={t}>
                  {tx(TRIGGER_META[t].en, TRIGGER_META[t].ar)}
                </option>
              ))}
            </select>
            <p className="wf-hint">{tx(meta.descEn, meta.descAr)}</p>
          </div>
          <TriggerConfigFields
            triggerType={p.triggerType}
            triggerConfig={p.triggerConfig}
            onChange={p.onTriggerConfig}
            workflowId={p.workflowId}
            webhookSecret={p.webhookSecret}
            stageOptions={p.stageOptions}
            tx={tx}
          />
        </div>
        <div className="wf-ins-foot">
          <span className="wf-hint">{tx("The trigger can be changed but not deleted.", "يمكن تغيير المُشغّل لكن لا يمكن حذفه.")}</span>
        </div>
      </aside>
    );
  }

  const step = selectedId ? p.graph.steps[selectedId] : undefined;
  if (!step) {
    return (
      <aside className="wf-inspector" aria-label={tx("Step settings", "إعدادات الخطوة")}>
        <div className="wf-ins-empty">
          <StepIcon type="trigger" size="lg" />
          <h3>{tx("Select a step", "اختر خطوة")}</h3>
          <p className="wf-hint">
            {tx("Click a card to edit it, or a + to add a step.", "انقر على بطاقة لتعديلها، أو على + لإضافة خطوة.")}
          </p>
        </div>
      </aside>
    );
  }

  const meta = STEP_META[step.type];
  const index = p.order.indexOf(step.id) + 1;
  const variables = p.variablesFor(step.id);
  const set = (config: WorkflowStep["config"]) => p.onStepConfig(step.id, config);

  return (
    <aside className="wf-inspector" aria-label={tx("Step settings", "إعدادات الخطوة")}>
      <div className="wf-ins-head">
        <StepIcon type={step.type} size="lg" />
        <div>
          <h3>{tx(meta.en, meta.ar)}</h3>
          <p>
            {stepKindLabel(step.type, tx)} · {tx(`step ${index} of ${p.order.length}`, `الخطوة ${index} من ${p.order.length}`)}
          </p>
        </div>
        <button type="button" className="btn icon ghost sm" aria-label={tx("Close panel", "إغلاق اللوحة")} onClick={p.onClose}>
          <IconX w={14} />
        </button>
      </div>
      {/* Keyed by step so per-form local state never leaks between steps. */}
      <div className="wf-ins-body" key={step.id}>
        <Issue text={p.issues[step.id]} />
        {step.type === "condition" && <ConditionConfigForm config={step.config} onChange={set} variables={variables} tx={tx} />}
        {step.type === "ai_condition" && <AiConditionConfigForm config={step.config} onChange={set} tx={tx} />}
        {step.type === "delay" && <DelayConfigForm config={step.config} onChange={set} tx={tx} />}
        {step.type === "update_data" && (
          <UpdateDataConfigForm config={step.config} onChange={set} stageOptions={p.stageOptions} tx={tx} />
        )}
        {step.type === "send_whatsapp" && (
          <SendWhatsappConfigForm config={step.config} onChange={set} triggerType={p.triggerType} variables={variables} tx={tx} />
        )}
        {step.type === "send_whatsapp_template" && (
          <SendWhatsappTemplateConfigForm config={step.config} onChange={set} variables={variables} tx={tx} />
        )}
        {step.type === "ask_agent" && (
          <AskAgentConfigForm config={step.config} onChange={set} variables={variables} stepId={step.id} tx={tx} />
        )}
      </div>
      <div className="wf-ins-foot">
        <button type="button" className="btn sm ghost danger" onClick={() => p.onDelete(step.id)}>
          {tx("Delete step", "حذف الخطوة")}
        </button>
        {!isBranchStep(step) && (
          <button type="button" className="btn sm" onClick={() => p.onDuplicate(step.id)}>
            {tx("Duplicate", "تكرار")}
          </button>
        )}
      </div>
    </aside>
  );
}
