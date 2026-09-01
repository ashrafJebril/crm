import { useState } from "react";
import { useAuth } from "@/auth/context";
import { useTweaks } from "@/tweaks/context";
import { makeTx, type Tx } from "@/lib/tx";
import { Badge } from "@/components/Badge";
import { useFetch, useMutation } from "@/api/useFetch";
import {
  createWorkflow,
  deleteWorkflow,
  setWorkflowKillSwitch,
  updateWorkflow,
  type Workflow,
  type WorkflowDraft,
  type WorkflowListResponse,
  type WorkflowRunsResponse,
  type WorkflowKillSwitchResponse,
} from "@/api/aiWorkflows";
import { ErrorRow, SettingsCard } from "./form";
import { WorkflowEditor } from "./workflows/WorkflowEditor";
import { WorkflowRuns } from "./workflows/WorkflowRuns";

const triggerLabel = (trigger: string, tx: Tx) => ({
  BOOKING_CREATED: tx("booking created", "إنشاء حجز"),
  BOOKING_RESCHEDULED: tx("booking rescheduled", "إعادة جدولة حجز"),
  BOOKING_CANCELLED: tx("booking cancelled", "إلغاء حجز"),
}[trigger] ?? trigger);

const runStatusLabel = (status: string, tx: Tx) => ({
  PENDING: tx("Pending", "قيد الانتظار"),
  RUNNING: tx("Running", "قيد التنفيذ"),
  COMPLETED: tx("Completed", "مكتمل"),
  PARTIAL_FAILED: tx("Partially failed", "فشل جزئي"),
  FAILED: tx("Failed", "فشل"),
  BLOCKED_KILL_SWITCH: tx("Blocked by global stop", "محظور بسبب الإيقاف العام"),
}[status] ?? status);

export function AiWorkflowsTab() {
  const { activeWorkspace } = useAuth();
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const canMutate = activeWorkspace?.role === "owner" || activeWorkspace?.role === "admin";
  const workflowsQ = useFetch<WorkflowListResponse>("/ai/workflows");
  const runsQ = useFetch<WorkflowRunsResponse>("/ai/workflows/runs", { pollMs: 15_000 });
  const [editing, setEditing] = useState<Workflow | "new" | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const workflows = workflowsQ.data?.workflows ?? [];
  const runs = runsQ.data?.runs ?? [];
  const killSwitch = workflowsQ.data?.workflowKillSwitch ?? false;
  const executionOn = !killSwitch;

  const saveMut = useMutation<{ id?: string; draft: WorkflowDraft }, Workflow>(async ({ id, draft }) => id ? updateWorkflow(id, draft) : createWorkflow(draft));
  const deleteMut = useMutation<string, { ok: true }>(deleteWorkflow);
  const toggleMut = useMutation<boolean, WorkflowKillSwitchResponse>(setWorkflowKillSwitch);

  const save = async (draft: WorkflowDraft) => {
    await saveMut.mutate({ id: editing && editing !== "new" ? editing.id : undefined, draft });
    setEditing(null); setStatus(tx("Workflow saved.", "تم حفظ سير العمل.")); workflowsQ.refetch();
  };
  const toggleExecution = async () => {
    // API's `enabled` describes the kill switch itself: true stops execution.
    await toggleMut.mutate(executionOn);
    setStatus(executionOn ? tx("Workflow execution stopped.", "تم إيقاف تنفيذ سير العمل.") : tx("Workflow execution enabled.", "تم تفعيل تنفيذ سير العمل."));
    workflowsQ.refetch();
  };
  const remove = async (workflow: Workflow) => {
    if (!window.confirm(tx(`Delete “${workflow.name}”? Runs and logs are preserved.`, `حذف «${workflow.name}»؟ سيتم الاحتفاظ بالتشغيلات والسجلات.`))) return;
    await deleteMut.mutate(workflow.id); workflowsQ.refetch(); setStatus(tx("Workflow deleted.", "تم حذف سير العمل."));
  };
  const toggleWorkflow = async (workflow: Workflow) => {
    await updateWorkflow(workflow.id, { enabled: !workflow.enabled }); workflowsQ.refetch();
  };

  if (!activeWorkspace) return <div className="muted">{tx("No active workspace.", "لا توجد مساحة عمل نشطة.")}</div>;
  return <div style={{ maxWidth: 920, margin: "0 auto" }}>
    {status && <div style={{ marginBottom: 12, padding: 10, borderRadius: 8, background: "var(--bg-2)", fontSize: 12 }}>{status}</div>}
    <SettingsCard title={tx("Workflow execution", "تنفيذ سير العمل")} description={tx("The global switch stops new email actions while preserving booking events, workflow definitions, and every run log.", "يوقف المفتاح العام إجراءات البريد الجديدة مع الاحتفاظ بأحداث الحجز وتعريفات سير العمل وجميع سجلات التشغيل.")}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <Badge kind={executionOn ? "ok" : "warn"}>{executionOn ? tx("ON", "مفعّل") : tx("OFF", "متوقف")}</Badge>
        <span style={{ flex: 1, minWidth: 220, fontSize: 12 }}>{executionOn ? tx("Enabled workflows can process new booking events.", "يمكن لسير العمل المفعّل معالجة أحداث الحجز الجديدة.") : tx("No new workflow actions will run.", "لن تُنفّذ إجراءات سير عمل جديدة.")}</span>
        {canMutate && <button type="button" className={executionOn ? "btn ghost" : "btn primary"} disabled={toggleMut.loading} onClick={toggleExecution}>{toggleMut.loading ? tx("Updating…", "جارٍ التحديث…") : executionOn ? tx("Stop all workflows", "إيقاف جميع مهام سير العمل") : tx("Enable workflows", "تفعيل مهام سير العمل")}</button>}
      </div>
      <ErrorRow message={toggleMut.error} />
    </SettingsCard>

    <SettingsCard title={editing ? editing === "new" ? tx("New workflow", "سير عمل جديد") : tx(`Edit ${editing.name}`, `تعديل ${editing.name}`) : tx("Booking email workflows", "مهام سير عمل بريد الحجوزات")} description={tx("Trigger → AND conditions → ordered customer and staff email actions.", "المشغّل ← شروط مترابطة بـ «و» ← إجراءات بريد مرتبة للعملاء والموظفين.")}>
      {editing ? <WorkflowEditor workflow={editing === "new" ? undefined : editing} onSave={save} onCancel={() => setEditing(null)} saving={saveMut.loading} readOnly={!canMutate} /> : <>
        {workflowsQ.loading && workflows.length === 0 ? <div className="muted pulse">{tx("Loading workflows…", "جارٍ تحميل مهام سير العمل…")}</div> : workflows.length === 0 ? <div className="muted" style={{ fontSize: 12 }}>{tx("No workflows yet. Create one for booking created, rescheduled, or cancelled.", "لا توجد مهام سير عمل بعد. أنشئ مهمة عند إنشاء الحجز أو إعادة جدولته أو إلغائه.")}</div> : <div style={{ display: "grid", gap: 8 }}>
          {workflows.map((workflow) => <div key={workflow.id} style={{ border: "1px solid var(--line-soft)", borderRadius: 9, padding: 12, display: "grid", gridTemplateColumns: "1fr auto", gap: 10 }}>
            <div><strong style={{ fontSize: 13 }}>{workflow.name}</strong><div className="muted" style={{ fontSize: 11, marginTop: 3 }}>{triggerLabel(workflow.trigger, tx)} · {tx(`${workflow.conditions.length} condition${workflow.conditions.length === 1 ? "" : "s"}`, `${workflow.conditions.length} شرط`)} · {workflow.actions.map((a) => a.type === "CUSTOMER_EMAIL" ? tx("customer", "العميل") : tx(`${a.recipients.length} staff`, `${a.recipients.length} موظف`)).join(" + ")}</div>{workflow.lastRun && <div className="muted" style={{ fontSize: 10 }}>{tx("Last run", "آخر تشغيل")}: {runStatusLabel(workflow.lastRun.status, tx)} · {new Date(workflow.lastRun.createdAt).toLocaleString(t.lang === "ar" ? "ar-JO" : "en")}</div>}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}><Badge kind={workflow.enabled ? "ok" : ""}>{workflow.enabled ? tx("Enabled", "مفعّل") : tx("Disabled", "معطّل")}</Badge><button type="button" className="btn ghost" onClick={() => setEditing(workflow)}>{canMutate ? tx("View / edit", "عرض / تعديل") : tx("View", "عرض")}</button>{canMutate && <><button type="button" className="btn ghost" onClick={() => toggleWorkflow(workflow)}>{workflow.enabled ? tx("Disable", "تعطيل") : tx("Enable", "تفعيل")}</button><button type="button" className="btn ghost" onClick={() => remove(workflow)}>{tx("Delete", "حذف")}</button></>}</div>
          </div>)}
        </div>}
        {canMutate && <button type="button" className="btn primary" style={{ justifySelf: "start", marginTop: 8 }} onClick={() => setEditing("new")}>{tx("Create workflow", "إنشاء سير عمل")}</button>}
      </>}
      <ErrorRow message={workflowsQ.error ?? saveMut.error ?? deleteMut.error} />
    </SettingsCard>

    <SettingsCard title={tx("Run logs", "سجلات التشغيل")} description={tx("Inspect each event and action result. Recipients are masked; provider ids and safe errors remain auditable.", "راجع نتيجة كل حدث وإجراء. تُحجب بيانات المستلمين وتبقى معرّفات المزوّد والأخطاء الآمنة قابلة للتدقيق.")}>
      {runsQ.loading && runs.length === 0 ? <div className="muted pulse">{tx("Loading runs…", "جارٍ تحميل التشغيلات…")}</div> : <WorkflowRuns runs={runs} canMutate={!!canMutate} onRetried={runsQ.refetch} />}
      <ErrorRow message={runsQ.error} />
    </SettingsCard>
  </div>;
}
