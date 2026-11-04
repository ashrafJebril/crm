import { useState } from "react";
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
import type { WorkflowVariable } from "../stepMeta";

const CUSTOM = "__custom__";

export function ConditionConfigForm({
  config,
  onChange,
  variables,
  tx,
}: {
  config: WorkflowConditionConfig;
  onChange: (c: WorkflowConditionConfig) => void;
  variables: WorkflowVariable[];
  tx: Tx;
}) {
  const known = variables.some((v) => v.path === config.field);
  // Paths typed by hand (or saved by the old free-text field) stay editable.
  const [custom, setCustom] = useState(Boolean(config.field) && !known);
  const showCustom = custom || variables.length === 0;

  return (
    <>
      <div className="wf-field">
        <label className="wf-label" htmlFor="wf-cond-field">
          {tx("Field", "الحقل")}
        </label>
        {variables.length > 0 && (
          <select
            id="wf-cond-field"
            className="wf-input"
            value={showCustom ? CUSTOM : config.field}
            onChange={(e) => {
              if (e.target.value === CUSTOM) {
                setCustom(true);
                return;
              }
              setCustom(false);
              onChange({ ...config, field: e.target.value });
            }}
          >
            <option value="">{tx("Choose a field…", "اختر حقلاً…")}</option>
            {variables.map((v) => (
              <option key={v.path} value={v.path}>
                {v.label}
              </option>
            ))}
            <option value={CUSTOM}>{tx("Custom path…", "مسار مخصص…")}</option>
          </select>
        )}
        {showCustom && (
          <input
            id={variables.length ? undefined : "wf-cond-field"}
            className="wf-input mono"
            dir="ltr"
            value={config.field}
            onChange={(e) => onChange({ ...config, field: e.target.value })}
            placeholder="trigger.contact.lifecycle"
            aria-label={tx("Field path", "مسار الحقل")}
          />
        )}
      </div>
      <div className="wf-row">
        <div className="wf-field">
          <label className="wf-label" htmlFor="wf-cond-op">
            {tx("Operator", "المعامل")}
          </label>
          <select
            id="wf-cond-op"
            className="wf-input"
            value={config.operator}
            onChange={(e) => onChange({ ...config, operator: e.target.value as WorkflowConditionOperator })}
          >
            <option value="equals">{tx("equals", "يساوي")}</option>
            <option value="not_equals">{tx("does not equal", "لا يساوي")}</option>
            <option value="contains">{tx("contains", "يحتوي على")}</option>
            <option value="not_contains">{tx("does not contain", "لا يحتوي على")}</option>
          </select>
        </div>
        <div className="wf-field">
          <label className="wf-label" htmlFor="wf-cond-value">
            {tx("Value", "القيمة")}
          </label>
          <input
            id="wf-cond-value"
            className="wf-input"
            value={config.value}
            onChange={(e) => onChange({ ...config, value: e.target.value })}
          />
        </div>
      </div>
      <p className="wf-hint">
        {tx(
          "Matching is exact and case-sensitive. Contacts that match go down the Yes lane; everyone else goes down No.",
          "المطابقة دقيقة وتميّز حالة الأحرف. من يطابق يسير في مسار نعم، والباقون في مسار لا.",
        )}
      </p>
    </>
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
    <>
      <div className="wf-field">
        <label className="wf-label" htmlFor="wf-ai-cond">
          {tx("Yes/no question for the AI", "سؤال نعم/لا لوكيل الذكاء")}
        </label>
        <textarea
          id="wf-ai-cond"
          className="wf-input"
          rows={4}
          value={config.prompt}
          onChange={(e) => onChange({ prompt: e.target.value })}
          placeholder={tx(
            "e.g. Does this contact's message sound like a serious buying intent?",
            "مثال: هل تبدو رسالة جهة الاتصال هذه بنيّة شراء جادة؟",
          )}
        />
      </div>
      <p className="wf-hint">
        {tx("An answer starting with “yes” goes down the Yes lane.", "الإجابة التي تبدأ بـ «نعم» تسير في مسار نعم.")}
      </p>
    </>
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
    <>
      <div className="wf-row">
        <div className="wf-field">
          <label className="wf-label" htmlFor="wf-delay-amount">
            {tx("Wait for", "انتظر لمدة")}
          </label>
          <input
            id="wf-delay-amount"
            className="wf-input"
            type="number"
            min={1}
            value={Number.isFinite(config.amount) ? config.amount : ""}
            onChange={(e) => onChange({ ...config, amount: e.target.value === "" ? Number.NaN : Number(e.target.value) })}
          />
        </div>
        <div className="wf-field">
          <label className="wf-label" htmlFor="wf-delay-unit">
            {tx("Unit", "الوحدة")}
          </label>
          <select
            id="wf-delay-unit"
            className="wf-input"
            value={config.unit}
            onChange={(e) => onChange({ ...config, unit: e.target.value as WorkflowDelayConfig["unit"] })}
          >
            <option value="minutes">{tx("minutes", "دقائق")}</option>
            <option value="hours">{tx("hours", "ساعات")}</option>
            <option value="days">{tx("days", "أيام")}</option>
          </select>
        </div>
      </div>
      <p className="wf-hint">
        {tx("The run pauses here and shows as “waiting” under Runs.", "يتوقف التشغيل هنا ويظهر كـ «في الانتظار» ضمن التشغيلات.")}
      </p>
    </>
  );
}

export function useStageOptions() {
  const { data } = useFetch<Pipeline[]>("/pipelines");
  const pipelines = data ?? [];
  return pipelines.flatMap((p) => p.stages.map((s) => ({ id: s.id, label: `${p.name} / ${s.label}` })));
}

export function UpdateDataConfigForm({
  config,
  onChange,
  stageOptions,
  tx,
}: {
  config: WorkflowUpdateDataConfig;
  onChange: (c: WorkflowUpdateDataConfig) => void;
  stageOptions: Array<{ id: string; label: string }>;
  tx: Tx;
}) {
  return (
    <>
      <div className="wf-field">
        <label className="wf-label" htmlFor="wf-upd-op">
          {tx("What to do", "الإجراء")}
        </label>
        <select
          id="wf-upd-op"
          className="wf-input"
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
        <div className="wf-field">
          <label className="wf-label" htmlFor="wf-upd-tag">
            {tx("Tag", "الوسم")}
          </label>
          <input
            id="wf-upd-tag"
            className="wf-input"
            value={config.tag}
            onChange={(e) => onChange({ ...config, tag: e.target.value })}
          />
        </div>
      )}

      {config.operation === "move_ticket_stage" && (
        <div className="wf-field">
          <label className="wf-label" htmlFor="wf-upd-stage">
            {tx("Stage", "المرحلة")}
          </label>
          <select
            id="wf-upd-stage"
            className="wf-input"
            value={config.stageId}
            onChange={(e) => onChange({ ...config, stageId: e.target.value })}
          >
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
        <div className="wf-row">
          <div className="wf-field">
            <label className="wf-label" htmlFor="wf-upd-field">
              {tx("Field", "الحقل")}
            </label>
            <select
              id="wf-upd-field"
              className="wf-input"
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
          <div className="wf-field">
            <label className="wf-label" htmlFor="wf-upd-value">
              {tx("New value", "القيمة الجديدة")}
            </label>
            <input
              id="wf-upd-value"
              className="wf-input"
              value={config.value}
              onChange={(e) => onChange({ ...config, value: e.target.value })}
            />
          </div>
        </div>
      )}
    </>
  );
}
