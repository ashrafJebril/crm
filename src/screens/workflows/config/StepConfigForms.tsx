import type { Tx } from "@/lib/tx";
import { useFetch } from "@/api/useFetch";
import type {
  Pipeline,
  WorkflowAiConditionConfig,
  WorkflowConditionConfig,
  WorkflowConditionOperator,
  WorkflowDelayConfig,
  WorkflowUpdateDataConfig,
} from "@/lib/types";

const fieldStyle = { display: "flex", flexDirection: "column" as const, gap: 4, marginBottom: 12 };
const labelStyle = { fontSize: 12, color: "var(--ink-3)" };

export function ConditionConfigForm({
  config,
  onChange,
  tx,
}: {
  config: WorkflowConditionConfig;
  onChange: (c: WorkflowConditionConfig) => void;
  tx: Tx;
}) {
  return (
    <div>
      <div style={fieldStyle}>
        <label style={labelStyle}>{tx("Field", "الحقل")}</label>
        <input
          value={config.field}
          onChange={(e) => onChange({ ...config, field: e.target.value })}
          placeholder="trigger.contact.lifecycle"
        />
      </div>
      <div style={fieldStyle}>
        <label style={labelStyle}>{tx("Operator", "المعامل")}</label>
        <select
          value={config.operator}
          onChange={(e) => onChange({ ...config, operator: e.target.value as WorkflowConditionOperator })}
        >
          <option value="equals">{tx("equals", "يساوي")}</option>
          <option value="not_equals">{tx("not equals", "لا يساوي")}</option>
          <option value="contains">{tx("contains", "يحتوي على")}</option>
          <option value="not_contains">{tx("does not contain", "لا يحتوي على")}</option>
        </select>
      </div>
      <div style={fieldStyle}>
        <label style={labelStyle}>{tx("Value", "القيمة")}</label>
        <input value={config.value} onChange={(e) => onChange({ ...config, value: e.target.value })} />
      </div>
    </div>
  );
}

export function AiConditionConfigForm({
  config,
  onChange,
  tx,
}: {
  config: WorkflowAiConditionConfig;
  onChange: (c: WorkflowAiConditionConfig) => void;
  tx: Tx;
}) {
  return (
    <div style={fieldStyle}>
      <label style={labelStyle}>
        {tx("Ask the AI agent a yes/no question", "اسأل وكيل الذكاء سؤالاً بنعم أو لا")}
      </label>
      <textarea
        rows={4}
        value={config.prompt}
        onChange={(e) => onChange({ prompt: e.target.value })}
        placeholder={tx(
          "e.g. Does this contact's message sound like a serious buying intent?",
          "مثال: هل تبدو رسالة جهة الاتصال هذه بنيّة شراء جادة؟",
        )}
      />
    </div>
  );
}

export function DelayConfigForm({
  config,
  onChange,
  tx,
}: {
  config: WorkflowDelayConfig;
  onChange: (c: WorkflowDelayConfig) => void;
  tx: Tx;
}) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
      <div style={fieldStyle}>
        <label style={labelStyle}>{tx("Wait for", "انتظر لمدة")}</label>
        <input
          type="number"
          min={1}
          value={config.amount}
          onChange={(e) => onChange({ ...config, amount: Number(e.target.value) })}
          style={{ width: 80 }}
        />
      </div>
      <div style={fieldStyle}>
        <select
          value={config.unit}
          onChange={(e) => onChange({ ...config, unit: e.target.value as WorkflowDelayConfig["unit"] })}
        >
          <option value="minutes">{tx("minutes", "دقائق")}</option>
          <option value="hours">{tx("hours", "ساعات")}</option>
          <option value="days">{tx("days", "أيام")}</option>
        </select>
      </div>
    </div>
  );
}

function useStageOptions() {
  const { data } = useFetch<Pipeline[]>("/pipelines");
  const pipelines = data ?? [];
  return pipelines.flatMap((p) => p.stages.map((s) => ({ id: s.id, label: `${p.name} / ${s.label}` })));
}

export function UpdateDataConfigForm({
  config,
  onChange,
  tx,
}: {
  config: WorkflowUpdateDataConfig;
  onChange: (c: WorkflowUpdateDataConfig) => void;
  tx: Tx;
}) {
  const stageOptions = useStageOptions();

  return (
    <div>
      <div style={fieldStyle}>
        <label style={labelStyle}>{tx("What to do", "الإجراء")}</label>
        <select
          value={config.operation}
          onChange={(e) => {
            const operation = e.target.value as WorkflowUpdateDataConfig["operation"];
            if (operation === "add_tag" || operation === "remove_tag") onChange({ operation, tag: "" });
            else if (operation === "move_ticket_stage") onChange({ operation, stageId: "" });
            else onChange({ operation, field: "lifecycle", value: "" });
          }}
        >
          <option value="add_tag">{tx("Add a tag", "إضافة وسم")}</option>
          <option value="remove_tag">{tx("Remove a tag", "إزالة وسم")}</option>
          <option value="move_ticket_stage">{tx("Move ticket to a stage", "نقل التذكرة إلى مرحلة")}</option>
          <option value="update_contact_field">{tx("Update a contact field", "تحديث حقل في جهة الاتصال")}</option>
        </select>
      </div>

      {(config.operation === "add_tag" || config.operation === "remove_tag") && (
        <div style={fieldStyle}>
          <label style={labelStyle}>{tx("Tag", "الوسم")}</label>
          <input value={config.tag} onChange={(e) => onChange({ ...config, tag: e.target.value })} />
        </div>
      )}

      {config.operation === "move_ticket_stage" && (
        <div style={fieldStyle}>
          <label style={labelStyle}>{tx("Stage", "المرحلة")}</label>
          <select value={config.stageId} onChange={(e) => onChange({ ...config, stageId: e.target.value })}>
            <option value="">{tx("Select a stage…", "اختر مرحلة…")}</option>
            {stageOptions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {config.operation === "update_contact_field" && (
        <>
          <div style={fieldStyle}>
            <label style={labelStyle}>{tx("Field", "الحقل")}</label>
            <select
              value={config.field}
              onChange={(e) => onChange({ ...config, field: e.target.value as typeof config.field })}
            >
              <option value="name">{tx("Name", "الاسم")}</option>
              <option value="phone">{tx("Phone", "الهاتف")}</option>
              <option value="industry">{tx("Industry", "القطاع")}</option>
              <option value="lifecycle">{tx("Lifecycle", "دورة الحياة")}</option>
              <option value="source">{tx("Source", "المصدر")}</option>
              <option value="value">{tx("Value", "القيمة")}</option>
            </select>
          </div>
          <div style={fieldStyle}>
            <label style={labelStyle}>{tx("New value", "القيمة الجديدة")}</label>
            <input value={config.value} onChange={(e) => onChange({ ...config, value: e.target.value })} />
          </div>
        </>
      )}
    </div>
  );
}
