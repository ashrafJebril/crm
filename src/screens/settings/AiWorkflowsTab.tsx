import { useMemo, useState } from "react";
import { useAuth } from "@/auth/context";
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
} from "@/api/aiWorkflows";
import { ErrorRow, SettingsCard } from "./form";
import { WorkflowEditor } from "./workflows/WorkflowEditor";
import { WorkflowRuns } from "./workflows/WorkflowRuns";

const triggerLabel = (trigger: string) => trigger.replaceAll("_", " ").toLowerCase();

export function AiWorkflowsTab() {
  const { activeWorkspace } = useAuth();
  const canMutate = activeWorkspace?.role === "owner" || activeWorkspace?.role === "admin";
  const workflowsQ = useFetch<WorkflowListResponse | Workflow[]>("/ai/workflows");
  const runsQ = useFetch<WorkflowRunsResponse | Workflow[]>("/ai/workflows/runs", { pollMs: 15_000 });
  const [editing, setEditing] = useState<Workflow | "new" | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const workflows = useMemo(() => Array.isArray(workflowsQ.data) ? workflowsQ.data : workflowsQ.data?.workflows ?? [], [workflowsQ.data]);
  const runs = useMemo(() => Array.isArray(runsQ.data) ? runsQ.data as never[] : runsQ.data?.runs ?? [], [runsQ.data]);
  const killSwitch = !Array.isArray(workflowsQ.data) && !!(workflowsQ.data?.workflowKillSwitch ?? workflowsQ.data?.killSwitch);
  const executionOn = !killSwitch;

  const saveMut = useMutation<{ id?: string; draft: WorkflowDraft }, Workflow>(async ({ id, draft }) => id ? updateWorkflow(id, draft) : createWorkflow(draft));
  const deleteMut = useMutation<string, { ok: true }>(deleteWorkflow);
  const toggleMut = useMutation<boolean, { enabled: boolean }>(setWorkflowKillSwitch);

  const save = async (draft: WorkflowDraft) => {
    await saveMut.mutate({ id: editing && editing !== "new" ? editing.id : undefined, draft });
    setEditing(null); setStatus("Workflow saved."); workflowsQ.refetch();
  };
  const toggleExecution = async () => {
    // API's `enabled` describes the kill switch itself: true stops execution.
    await toggleMut.mutate(executionOn);
    setStatus(executionOn ? "Workflow execution stopped." : "Workflow execution enabled.");
    workflowsQ.refetch();
  };
  const remove = async (workflow: Workflow) => {
    if (!window.confirm(`Delete “${workflow.name}”? Runs and logs are preserved.`)) return;
    await deleteMut.mutate(workflow.id); workflowsQ.refetch(); setStatus("Workflow deleted.");
  };
  const toggleWorkflow = async (workflow: Workflow) => {
    await updateWorkflow(workflow.id, { enabled: !workflow.enabled }); workflowsQ.refetch();
  };

  if (!activeWorkspace) return <div className="muted">No active workspace.</div>;
  return <div style={{ maxWidth: 920, margin: "0 auto" }}>
    {status && <div style={{ marginBottom: 12, padding: 10, borderRadius: 8, background: "var(--bg-2)", fontSize: 12 }}>{status}</div>}
    <SettingsCard title="Workflow execution" description="The global switch stops new email actions while preserving booking events, workflow definitions, and every run log.">
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <Badge kind={executionOn ? "ok" : "warn"}>{executionOn ? "ON" : "OFF"}</Badge>
        <span style={{ flex: 1, minWidth: 220, fontSize: 12 }}>{executionOn ? "Enabled workflows can process new booking events." : "No new workflow actions will run."}</span>
        {canMutate && <button type="button" className={executionOn ? "btn ghost" : "btn primary"} disabled={toggleMut.loading} onClick={toggleExecution}>{toggleMut.loading ? "Updating…" : executionOn ? "Stop all workflows" : "Enable workflows"}</button>}
      </div>
      <ErrorRow message={toggleMut.error} />
    </SettingsCard>

    <SettingsCard title={editing ? editing === "new" ? "New workflow" : `Edit ${editing.name}` : "Booking email workflows"} description="Trigger → AND conditions → ordered customer and staff email actions.">
      {editing ? <WorkflowEditor workflow={editing === "new" ? undefined : editing} onSave={save} onCancel={() => setEditing(null)} saving={saveMut.loading} readOnly={!canMutate} /> : <>
        {workflowsQ.loading && workflows.length === 0 ? <div className="muted pulse">Loading workflows…</div> : workflows.length === 0 ? <div className="muted" style={{ fontSize: 12 }}>No workflows yet. Create one for booking created, rescheduled, or cancelled.</div> : <div style={{ display: "grid", gap: 8 }}>
          {workflows.map((workflow) => <div key={workflow.id} style={{ border: "1px solid var(--line-soft)", borderRadius: 9, padding: 12, display: "grid", gridTemplateColumns: "1fr auto", gap: 10 }}>
            <div><strong style={{ fontSize: 13 }}>{workflow.name}</strong><div className="muted" style={{ fontSize: 11, marginTop: 3 }}>{triggerLabel(workflow.trigger)} · {workflow.conditions.length} condition{workflow.conditions.length === 1 ? "" : "s"} · {workflow.actions.map((a) => a.type === "CUSTOMER_EMAIL" ? "customer" : `${a.recipients.length} staff`).join(" + ")}</div>{workflow.lastRun && <div className="muted" style={{ fontSize: 10 }}>Last run: {workflow.lastRun.status} · {new Date(workflow.lastRun.createdAt).toLocaleString()}</div>}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}><Badge kind={workflow.enabled ? "ok" : ""}>{workflow.enabled ? "Enabled" : "Disabled"}</Badge><button type="button" className="btn ghost" onClick={() => setEditing(workflow)}>View{canMutate ? " / edit" : ""}</button>{canMutate && <><button type="button" className="btn ghost" onClick={() => toggleWorkflow(workflow)}>{workflow.enabled ? "Disable" : "Enable"}</button><button type="button" className="btn ghost" onClick={() => remove(workflow)}>Delete</button></>}</div>
          </div>)}
        </div>}
        {canMutate && <button type="button" className="btn primary" style={{ justifySelf: "start", marginTop: 8 }} onClick={() => setEditing("new")}>Create workflow</button>}
      </>}
      <ErrorRow message={workflowsQ.error ?? saveMut.error ?? deleteMut.error} />
    </SettingsCard>

    <SettingsCard title="Run logs" description="Inspect each event and action result. Recipients are masked; provider ids and safe errors remain auditable.">
      {runsQ.loading && runs.length === 0 ? <div className="muted pulse">Loading runs…</div> : <WorkflowRuns runs={runs} canMutate={!!canMutate} onRetried={runsQ.refetch} />}
      <ErrorRow message={runsQ.error} />
    </SettingsCard>
  </div>;
}
