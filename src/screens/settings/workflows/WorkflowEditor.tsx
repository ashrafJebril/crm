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

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const customerDefault: WorkflowAction = { type: "CUSTOMER_EMAIL", subject: "Booking confirmed — {{branch.name}}", body: "Hi {{customer.name}},\n\nYour booking is confirmed for {{booking.date}} at {{booking.time}}." };
const staffDefault: WorkflowAction = { type: "STAFF_EMAIL", recipients: [], subject: "Booking {{booking.status}} — {{customer.name}}", body: "Booking {{booking.id}} at {{branch.name}} for {{services.names}}." };

export const emptyWorkflow = (): WorkflowDraft => ({ name: "", enabled: false, trigger: "BOOKING_CREATED", conditions: [], actions: [customerDefault] });

export function workflowDraftErrors(draft: WorkflowDraft): string[] {
  const errors: string[] = [];
  if (!draft.name.trim()) errors.push("Name is required");
  if (draft.actions.length === 0) errors.push("Choose at least one email action");
  for (const action of draft.actions) {
    if (!action.subject.trim() || !action.body.trim()) errors.push("Every email needs a subject and body");
    const unknown = invalidTemplateVariables(`${action.subject}\n${action.body}`);
    if (unknown.length) errors.push(`Unknown variables: ${unknown.join(", ")}`);
    if (action.type === "STAFF_EMAIL" && (action.recipients.length === 0 || action.recipients.some((x) => !EMAIL.test(x)))) errors.push("Enter valid staff email addresses");
  }
  for (const c of draft.conditions) if (Array.isArray(c.value) ? c.value.length === 0 : !c.value.trim()) errors.push("Complete or remove empty conditions");
  return [...new Set(errors)];
}

export function WorkflowEditor({ workflow, onSave, onCancel, saving, readOnly = false }: { workflow?: Workflow; onSave: (draft: WorkflowDraft) => Promise<void>; onCancel: () => void; saving: boolean; readOnly?: boolean }) {
  const [draft, setDraft] = useState<WorkflowDraft>(() => workflow ? { name: workflow.name, enabled: workflow.enabled, trigger: workflow.trigger, conditions: workflow.conditions, actions: workflow.actions } : emptyWorkflow());
  const [preview, setPreview] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const errors = useMemo(() => workflowDraftErrors(draft), [draft]);
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
      setPreview(rows.map((r) => `${r.subject}\n${r.body}`).join("\n\n——\n\n") || "Preview generated successfully.");
    } catch (e) { setPreviewError(e instanceof Error ? e.message : "Preview failed"); }
  };

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {readOnly && <div style={{ padding: 10, borderRadius: 8, background: "var(--bg-2)", fontSize: 12 }}>View only — an owner or admin can change workflow configuration.</div>}
      {!workflow && <div style={{ padding: 10, borderRadius: 8, background: "oklch(0.75 0.12 85 / .12)", fontSize: 12 }}>New workflows are saved disabled. Review the preview, then enable when ready.</div>}
      <Field label="Workflow name"><input style={inputStyle} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
      <Field label="Trigger"><select style={inputStyle} value={draft.trigger} onChange={(e) => setDraft({ ...draft, trigger: e.target.value as WorkflowDraft["trigger"] })}>{WORKFLOW_TRIGGERS.map((t) => <option key={t} value={t}>{t.replaceAll("_", " ").toLowerCase()}</option>)}</select></Field>

      <div style={{ display: "grid", gap: 8 }}>
        <strong style={{ fontSize: 13 }}>Conditions (all must match)</strong>
        {draft.conditions.map((condition, index) => (
          <div key={index} style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 8 }}>
            <select style={inputStyle} value={condition.field} onChange={(e) => {
              const field = e.target.value as WorkflowCondition["field"];
              setCondition(index, field === "services.ids" ? { field, op: "CONTAINS_ANY", value: [] } : { field, op: "EQ", value: "" });
            }}>
              <option value="branch.id">Branch id</option><option value="services.ids">Service ids</option><option value="booking.source">Booking source</option>
            </select>
            <input style={inputStyle} placeholder={condition.field === "services.ids" ? "svc-1, svc-2" : "Value"} value={Array.isArray(condition.value) ? condition.value.join(", ") : condition.value} onChange={(e) => setCondition(index, condition.field === "services.ids" ? { ...condition, value: e.target.value.split(",").map((v) => v.trim()).filter(Boolean) } : { ...condition, value: e.target.value })} />
            <button type="button" className="btn ghost" onClick={() => setDraft((d) => ({ ...d, conditions: d.conditions.filter((_, i) => i !== index) }))}>Remove</button>
          </div>
        ))}
        <button type="button" className="btn ghost" style={{ justifySelf: "start" }} onClick={addCondition}>+ Add condition</button>
      </div>

      <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={!!customer} onChange={(e) => toggleAction("CUSTOMER_EMAIL", e.target.checked)} /> Send customer email</label>
      {customer?.type === "CUSTOMER_EMAIL" && <TemplateEditor label="Customer email" subject={customer.subject} body={customer.body} onChange={(v) => replaceAction("CUSTOMER_EMAIL", { type: "CUSTOMER_EMAIL", ...v })} />}

      <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={!!staff} onChange={(e) => toggleAction("STAFF_EMAIL", e.target.checked)} /> Notify staff</label>
      {staff?.type === "STAFF_EMAIL" && <>
        <Field label="Staff recipients" hint="Separate multiple addresses with commas"><input style={inputStyle} value={staff.recipients.join(", ")} onChange={(e) => replaceAction("STAFF_EMAIL", { ...staff, recipients: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} /></Field>
        <TemplateEditor label="Staff email" subject={staff.subject} body={staff.body} onChange={(v) => replaceAction("STAFF_EMAIL", { ...staff, ...v })} />
      </>}

      {errors.length > 0 && <div style={{ color: "var(--bad)", fontSize: 12 }}>{errors.join(" · ")}</div>}
      {previewError && <div style={{ color: "var(--bad)", fontSize: 12 }}>{previewError}</div>}
      {preview && <pre style={{ whiteSpace: "pre-wrap", background: "var(--bg-2)", borderRadius: 8, padding: 12, fontSize: 12 }}>{preview}</pre>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
        <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn ghost" disabled={errors.length > 0} onClick={requestPreview}>Server preview</button>
        {!readOnly && <button type="button" className="btn primary" disabled={errors.length > 0 || saving} onClick={() => onSave({ ...draft, enabled: workflow ? draft.enabled : false })}>{saving ? "Saving…" : "Save workflow"}</button>}
      </div>
    </div>
  );
}
