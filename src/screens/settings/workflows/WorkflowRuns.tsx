import { useState } from "react";
import { retryWorkflowRun, type WorkflowActionStatus, type WorkflowRun, type WorkflowRunStatus } from "@/api/aiWorkflows";
import { Badge } from "@/components/Badge";
import { useTweaks } from "@/tweaks/context";
import { makeTx, type Tx } from "@/lib/tx";
import { canRetryWorkflowRun, workflowStatusBadge } from "./workflowStatus";

const maskRecipient = (email?: string | null) => {
  if (!email) return "—";
  const [local, domain] = email.split("@");
  return domain ? `${local.slice(0, 2)}***@${domain}` : "***";
};

const statusLabel = (status: WorkflowRunStatus | WorkflowActionStatus, tx: Tx) => ({
  PENDING: tx("Pending", "قيد الانتظار"),
  RUNNING: tx("Running", "قيد التنفيذ"),
  COMPLETED: tx("Completed", "مكتمل"),
  PARTIAL_FAILED: tx("Partially failed", "فشل جزئي"),
  FAILED: tx("Failed", "فشل"),
  BLOCKED_KILL_SWITCH: tx("Blocked by global stop", "محظور بسبب الإيقاف العام"),
  SENT: tx("Sent", "أُرسل"),
  FAILED_RETRYABLE: tx("Failed — retryable", "فشل — قابل لإعادة المحاولة"),
  FAILED_PERMANENT: tx("Failed permanently", "فشل نهائي"),
  SKIPPED_NO_CUSTOMER_EMAIL: tx("Skipped — no customer email", "تم التخطي — لا يوجد بريد للعميل"),
  SKIPPED_CUSTOMER_OPT_OUT: tx("Skipped — customer opted out", "تم التخطي — العميل ألغى الاشتراك"),
  BLOCKED_BY_TEST_ALLOWLIST: tx("Blocked by test allowlist", "محظور بقائمة السماح الاختبارية"),
}[status]);

const actionLabel = (type: "CUSTOMER_EMAIL" | "STAFF_EMAIL", tx: Tx) =>
  type === "CUSTOMER_EMAIL" ? tx("Customer email", "بريد العميل") : tx("Staff email", "بريد الموظفين");

const eventLabel = (event: string, tx: Tx) => ({
  "booking.created": tx("Booking created", "تم إنشاء الحجز"),
  "booking.rescheduled": tx("Booking rescheduled", "تمت إعادة جدولة الحجز"),
  "booking.cancelled": tx("Booking cancelled", "تم إلغاء الحجز"),
}[event] ?? event);

export function WorkflowRuns({ runs, canMutate, onRetried }: { runs: WorkflowRun[]; canMutate: boolean; onRetried: () => void }) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const [open, setOpen] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const retry = async (id: string) => {
    setRetrying(id); setError(null);
    try { await retryWorkflowRun(id); onRetried(); }
    catch (e) { setError(e instanceof Error ? e.message : tx("Retry failed", "فشلت إعادة المحاولة")); }
    finally { setRetrying(null); }
  };

  if (runs.length === 0) return <div className="muted" style={{ fontSize: 12 }}>{tx("No workflow runs yet. Events and skipped actions will appear here.", "لا توجد تشغيلات لسير العمل بعد. ستظهر هنا الأحداث والإجراءات المتخطاة.")}</div>;
  return <div style={{ display: "grid", gap: 8 }}>
    {error && <div style={{ color: "var(--bad)", fontSize: 12 }}>{error}</div>}
    {runs.map((run) => <div key={run.id} style={{ border: "1px solid var(--line-soft)", borderRadius: 9, padding: 12 }}>
      <button type="button" onClick={() => setOpen(open === run.id ? null : run.id)} style={{ width: "100%", border: 0, background: "transparent", color: "inherit", padding: 0, display: "grid", gridTemplateColumns: "1fr auto", textAlign: "start", cursor: "pointer" }}>
        <span><strong style={{ fontSize: 12 }}>{run.workflowName}</strong><span className="muted" style={{ display: "block", fontSize: 11 }}>{eventLabel(run.event, tx)} · {tx("Booking", "الحجز")} {run.bookingId} · {new Date(run.createdAt).toLocaleString(t.lang === "ar" ? "ar-JO" : "en")}</span></span>
        <Badge kind={workflowStatusBadge(run.status)}>{statusLabel(run.status, tx)}</Badge>
      </button>
      {open === run.id && <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
        {run.error && <div style={{ color: "var(--bad)", fontSize: 12 }}>{run.error}</div>}
        {run.actions.map((action, index) => <div key={action.id ?? index} style={{ background: "var(--bg-2)", padding: 9, borderRadius: 7, fontSize: 11 }}>
          <strong>{actionLabel(action.type, tx)}</strong> · <Badge kind={workflowStatusBadge(action.status)}>{statusLabel(action.status, tx)}</Badge> · {maskRecipient(action.recipient)}
          {action.providerMessageId && <div className="mono muted">{tx("Provider", "المزوّد")}: {action.providerMessageId}</div>}
          {action.error && <div style={{ color: "var(--bad)" }}>{action.error}</div>}
        </div>)}
        {canMutate && canRetryWorkflowRun(run.status) && <button type="button" className="btn ghost" style={{ justifySelf: "start" }} disabled={retrying === run.id} onClick={() => retry(run.id)}>{retrying === run.id ? tx("Retrying…", "جارٍ إعادة المحاولة…") : tx("Retry failed actions", "إعادة محاولة الإجراءات الفاشلة")}</button>}
      </div>}
    </div>)}
  </div>;
}
