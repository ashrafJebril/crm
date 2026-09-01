import { useMemo, useState } from "react";
import {
  WORKFLOW_TRIGGERS,
  previewWorkflow,
  type Workflow,
  type WorkflowAction,
  type WorkflowCondition,
  type WorkflowDraft,
} from "@/api/aiWorkflows";
import { Field, inputStyle } from "../form";
import { invalidTemplateVariables, TemplateEditor } from "./TemplateEditor";
import { useTweaks } from "@/tweaks/context";
import { makeTx, type Tx } from "@/lib/tx";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const customerDefault: WorkflowAction = { type: "CUSTOMER_EMAIL", subject: "Booking confirmed — {{branch.name}}", body: "Hi {{customer.name}},\n\nYour booking is confirmed for {{booking.date}} at {{booking.time}}." };
const staffDefault: WorkflowAction = { type: "STAFF_EMAIL", recipients: [], subject: "Booking {{booking.status}} — {{customer.name}}", body: "Booking {{booking.id}} at {{branch.name}} for {{services.names}}." };

export const emptyWorkflow = (): WorkflowDraft => ({ name: "", enabled: false, trigger: "BOOKING_CREATED", conditions: [], actions: [customerDefault] });

export function workflowDraftErrors(draft: WorkflowDraft, tx: Tx = (en) => en): string[] {
  const errors: string[] = [];
  if (!draft.name.trim()) errors.push(tx("Name is required", "الاسم مطلوب"));
  if (draft.actions.length === 0) errors.push(tx("Choose at least one email action", "اختر إجراء بريد واحدًا على الأقل"));
  for (const action of draft.actions) {
    if (!action.subject.trim() || !action.body.trim()) errors.push(tx("Every email needs a subject and body", "يحتاج كل بريد إلى موضوع ونص"));
    const unknown = invalidTemplateVariables(`${action.subject}\n${action.body}`);
    if (unknown.length) errors.push(tx(`Unknown variables: ${unknown.join(", ")}`, `متغيرات غير معروفة: ${unknown.join(", ")}`));
    if (action.type === "STAFF_EMAIL" && (action.recipients.length === 0 || action.recipients.some((x) => !EMAIL.test(x)))) errors.push(tx("Enter valid staff email addresses", "أدخل عناوين بريد صحيحة للموظفين"));
  }
  for (const c of draft.conditions) if (Array.isArray(c.value) ? c.value.length === 0 : !c.value.trim()) errors.push(tx("Complete or remove empty conditions", "أكمل الشروط الفارغة أو احذفها"));
  return [...new Set(errors)];
}

export function WorkflowEditor({ workflow, onSave, onCancel, saving, readOnly = false }: { workflow?: Workflow; onSave: (draft: WorkflowDraft) => Promise<void>; onCancel: () => void; saving: boolean; readOnly?: boolean }) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const [draft, setDraft] = useState<WorkflowDraft>(() => workflow ? { name: workflow.name, enabled: workflow.enabled, trigger: workflow.trigger, conditions: workflow.conditions, actions: workflow.actions } : emptyWorkflow());
  const [preview, setPreview] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const errors = useMemo(() => workflowDraftErrors(draft, tx), [draft, tx]);
  const customer = draft.actions.find((a) => a.type === "CUSTOMER_EMAIL");
  const staff = draft.actions.find((a) => a.type === "STAFF_EMAIL");

  const replaceAction = (type: WorkflowAction["type"], next: WorkflowAction) => setDraft((d) => ({ ...d, actions: d.actions.map((a) => a.type === type ? next : a) }));
  const toggleAction = (type: WorkflowAction["type"], enabled: boolean) => setDraft((d) => ({ ...d, actions: enabled ? [...d.actions, type === "CUSTOMER_EMAIL" ? customerDefault : staffDefault] : d.actions.filter((a) => a.type !== type) }));
  const addCondition = () => setDraft((d) => ({ ...d, conditions: [...d.conditions, { field: "branch.id", op: "EQ", value: "" }] }));
  const setCondition = (index: number, next: WorkflowCondition) => setDraft((d) => ({ ...d, conditions: d.conditions.map((c, i) => i === index ? next : c) }));

  const requestPreview = async () => {
    setPreviewError(null);
    try {
      const result = await previewWorkflow(draft);
      const rows = result.actions ?? (result.subject || result.body ? [{ subject: result.subject ?? "", body: result.body ?? "" }] : []);
      setPreview(rows.map((r) => `${r.subject}\n${r.body}`).join("\n\n——\n\n") || tx("Preview generated successfully.", "تم إنشاء المعاينة بنجاح."));
    } catch (e) { setPreviewError(e instanceof Error ? e.message : tx("Preview failed", "فشلت المعاينة")); }
  };

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {readOnly && <div style={{ padding: 10, borderRadius: 8, background: "var(--bg-2)", fontSize: 12 }}>{tx("View only — an owner or admin can change workflow configuration.", "للعرض فقط — يمكن للمالك أو المسؤول تغيير إعدادات سير العمل.")}</div>}
      {!workflow && <div style={{ padding: 10, borderRadius: 8, background: "oklch(0.75 0.12 85 / .12)", fontSize: 12 }}>{tx("New workflows are saved disabled. Review the preview, then enable when ready.", "تُحفظ مهام سير العمل الجديدة معطّلة. راجع المعاينة ثم فعّلها عندما تصبح جاهزة.")}</div>}
      <Field label={tx("Workflow name", "اسم سير العمل")}><input style={inputStyle} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
      <Field label={tx("Trigger", "المشغّل")}><select style={inputStyle} value={draft.trigger} onChange={(e) => setDraft({ ...draft, trigger: e.target.value as WorkflowDraft["trigger"] })}>{WORKFLOW_TRIGGERS.map((trigger) => <option key={trigger} value={trigger}>{({ BOOKING_CREATED: tx("Booking created", "إنشاء حجز"), BOOKING_RESCHEDULED: tx("Booking rescheduled", "إعادة جدولة حجز"), BOOKING_CANCELLED: tx("Booking cancelled", "إلغاء حجز") })[trigger]}</option>)}</select></Field>

      <div style={{ display: "grid", gap: 8 }}>
        <strong style={{ fontSize: 13 }}>{tx("Conditions (all must match)", "الشروط (يجب أن تتطابق جميعها)")}</strong>
        {draft.conditions.map((condition, index) => (
          <div key={index} style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 8 }}>
            <select style={inputStyle} value={condition.field} onChange={(e) => {
              const field = e.target.value as WorkflowCondition["field"];
              setCondition(index, field === "services.ids" ? { field, op: "CONTAINS_ANY", value: [] } : { field, op: "EQ", value: "" });
            }}>
              <option value="branch.id">{tx("Branch id", "معرّف الفرع")}</option><option value="services.ids">{tx("Service ids", "معرّفات الخدمات")}</option><option value="booking.source">{tx("Booking source", "مصدر الحجز")}</option>
            </select>
            <input style={inputStyle} placeholder={condition.field === "services.ids" ? "svc-1, svc-2" : tx("Value", "القيمة")} value={Array.isArray(condition.value) ? condition.value.join(", ") : condition.value} onChange={(e) => setCondition(index, condition.field === "services.ids" ? { ...condition, value: e.target.value.split(",").map((v) => v.trim()).filter(Boolean) } : { ...condition, value: e.target.value })} />
            <button type="button" className="btn ghost" onClick={() => setDraft((d) => ({ ...d, conditions: d.conditions.filter((_, i) => i !== index) }))}>{tx("Remove", "إزالة")}</button>
          </div>
        ))}
        <button type="button" className="btn ghost" style={{ justifySelf: "start" }} onClick={addCondition}>{tx("+ Add condition", "+ إضافة شرط")}</button>
      </div>

      <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={!!customer} onChange={(e) => toggleAction("CUSTOMER_EMAIL", e.target.checked)} /> {tx("Send customer email", "إرسال بريد للعميل")}</label>
      {customer?.type === "CUSTOMER_EMAIL" && <TemplateEditor label={tx("Customer email", "بريد العميل")} subject={customer.subject} body={customer.body} onChange={(v) => replaceAction("CUSTOMER_EMAIL", { type: "CUSTOMER_EMAIL", ...v })} />}

      <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={!!staff} onChange={(e) => toggleAction("STAFF_EMAIL", e.target.checked)} /> {tx("Notify staff", "إشعار الموظفين")}</label>
      {staff?.type === "STAFF_EMAIL" && <>
        <Field label={tx("Staff recipients", "مستلمو الموظفين")} hint={tx("Separate multiple addresses with commas", "افصل بين العناوين المتعددة بفواصل")}><input style={inputStyle} value={staff.recipients.join(", ")} onChange={(e) => replaceAction("STAFF_EMAIL", { ...staff, recipients: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} /></Field>
        <TemplateEditor label={tx("Staff email", "بريد الموظفين")} subject={staff.subject} body={staff.body} onChange={(v) => replaceAction("STAFF_EMAIL", { ...staff, ...v })} />
      </>}

      {errors.length > 0 && <div style={{ color: "var(--bad)", fontSize: 12 }}>{errors.join(" · ")}</div>}
      {previewError && <div style={{ color: "var(--bad)", fontSize: 12 }}>{previewError}</div>}
      {preview && <pre style={{ whiteSpace: "pre-wrap", background: "var(--bg-2)", borderRadius: 8, padding: 12, fontSize: 12 }}>{preview}</pre>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
        <button type="button" className="btn ghost" onClick={onCancel}>{tx("Cancel", "إلغاء")}</button>
        <button type="button" className="btn ghost" disabled={errors.length > 0} onClick={requestPreview}>{tx("Server preview", "معاينة الخادم")}</button>
        {!readOnly && <button type="button" className="btn primary" disabled={errors.length > 0 || saving} onClick={() => onSave({ ...draft, enabled: workflow ? draft.enabled : false })}>{saving ? tx("Saving…", "جارٍ الحفظ…") : tx("Save workflow", "حفظ سير العمل")}</button>}
      </div>
    </div>
  );
}
