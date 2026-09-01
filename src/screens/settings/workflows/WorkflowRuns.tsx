import { useState } from "react";
import { retryWorkflowRun, type WorkflowRun } from "@/api/aiWorkflows";
import { Badge } from "@/components/Badge";

const badge = (status: string) => status === "SUCCEEDED" || status === "SENT" ? "ok" : status === "FAILED" || status === "DEAD" ? "bad" : status === "RUNNING" || status === "RETRYING" ? "info" : "";
const maskRecipient = (email?: string | null) => {
  if (!email) return "—";
  const [local, domain] = email.split("@");
  return domain ? `${local.slice(0, 2)}***@${domain}` : "***";
};

export function WorkflowRuns({ runs, canMutate, onRetried }: { runs: WorkflowRun[]; canMutate: boolean; onRetried: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const retry = async (id: string) => {
    setRetrying(id); setError(null);
    try { await retryWorkflowRun(id); onRetried(); }
    catch (e) { setError(e instanceof Error ? e.message : "Retry failed"); }
    finally { setRetrying(null); }
  };

  if (runs.length === 0) return <div className="muted" style={{ fontSize: 12 }}>No workflow runs yet. Events and skipped actions will appear here.</div>;
  return <div style={{ display: "grid", gap: 8 }}>
    {error && <div style={{ color: "var(--bad)", fontSize: 12 }}>{error}</div>}
    {runs.map((run) => <div key={run.id} style={{ border: "1px solid var(--line-soft)", borderRadius: 9, padding: 12 }}>
      <button type="button" onClick={() => setOpen(open === run.id ? null : run.id)} style={{ width: "100%", border: 0, background: "transparent", color: "inherit", padding: 0, display: "grid", gridTemplateColumns: "1fr auto", textAlign: "start", cursor: "pointer" }}>
        <span><strong style={{ fontSize: 12 }}>{run.workflowName ?? run.event ?? "Workflow run"}</strong><span className="muted" style={{ display: "block", fontSize: 11 }}>Booking {run.bookingId ?? "—"} · {new Date(run.createdAt).toLocaleString()}</span></span>
        <Badge kind={badge(run.status) as never}>{run.status}</Badge>
      </button>
      {open === run.id && <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
        {run.error && <div style={{ color: "var(--bad)", fontSize: 12 }}>{run.error}</div>}
        {(run.actions ?? []).map((action, index) => <div key={action.id ?? index} style={{ background: "var(--bg-2)", padding: 9, borderRadius: 7, fontSize: 11 }}>
          <strong>{action.type ?? `Action ${index + 1}`}</strong> · {action.status} · {maskRecipient(action.recipient)}
          {action.providerMessageId && <div className="mono muted">Provider: {action.providerMessageId}</div>}
          {action.error && <div style={{ color: "var(--bad)" }}>{action.error}</div>}
        </div>)}
        {canMutate && ["FAILED", "PARTIAL", "DEAD"].includes(run.status) && <button type="button" className="btn ghost" style={{ justifySelf: "start" }} disabled={retrying === run.id} onClick={() => retry(run.id)}>{retrying === run.id ? "Retrying…" : "Retry failed actions"}</button>}
      </div>}
    </div>)}
  </div>;
}
