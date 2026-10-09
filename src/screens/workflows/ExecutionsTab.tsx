import { useState } from "react";
import { useFetch } from "@/api/useFetch";
import type { Tx } from "@/lib/tx";
import type { WorkflowRun } from "@/lib/types";
import { Badge } from "@/components/Badge";
import type { BadgeKind } from "@/components/Badge";

const STATUS_KIND: Record<WorkflowRun["status"], BadgeKind> = {
  running: "info",
  waiting: "warn",
  completed: "ok",
  failed: "bad",
  cancelled: "",
};

export function ExecutionsTab({
  workflowId,
  tx,
  lang,
}: {
  workflowId: string;
  tx: Tx;
  lang: "en" | "ar";
}) {
  const { data, loading } = useFetch<WorkflowRun[]>(`/workflows/${workflowId}/runs`);
  const runs = data ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = runs.find((r) => r.id === selectedId) ?? null;

  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
      <div style={{ width: "40%", overflowY: "auto", borderInlineEnd: "1px solid var(--line-soft)" }}>
        {loading && runs.length === 0 && (
          <div className="muted" style={{ padding: 16 }}>
            {tx("Loading…", "جارٍ التحميل…")}
          </div>
        )}
        {!loading && runs.length === 0 && (
          <div className="muted" style={{ padding: 16 }}>
            {tx("No runs yet.", "لا توجد عمليات تشغيل بعد.")}
          </div>
        )}
        {runs.map((r) => (
          <div
            key={r.id}
            onClick={() => setSelectedId(r.id)}
            style={{
              padding: "10px 16px",
              cursor: "pointer",
              borderBottom: "1px solid var(--line-soft)",
              background: selectedId === r.id ? "var(--bg-2)" : "transparent",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <Badge kind={STATUS_KIND[r.status]}>{r.status}</Badge>
              {r.isTest && (
                <span className="muted" style={{ fontSize: 11 }}>
                  {tx("test", "اختبار")}
                </span>
              )}
            </div>
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              {new Date(r.startedAt).toLocaleString(lang === "ar" ? "ar" : "en")}
            </div>
          </div>
        ))}
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
        {!selected ? (
          <div className="muted">{tx("Select a run to see its details.", "اختر عملية تشغيل لعرض تفاصيلها.")}</div>
        ) : (
          <div>
            {selected.error && <div style={{ color: "var(--bad)", marginBottom: 12 }}>{selected.error}</div>}
            <div style={{ fontWeight: 600, marginBottom: 8 }}>{tx("Trigger payload", "بيانات المُشغّل")}</div>
            <pre style={{ background: "var(--bg-1)", padding: 12, borderRadius: 8, fontSize: 12 }}>
              {JSON.stringify(selected.context.trigger, null, 2)}
            </pre>
            <div style={{ fontWeight: 600, margin: "16px 0 8px" }}>{tx("Steps", "الخطوات")}</div>
            {Object.entries(selected.stepsSnapshot.steps).map(([stepId, step]) => (
              <div key={stepId} style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 600 }}>
                  {step.type} ({stepId})
                </div>
                <pre style={{ background: "var(--bg-1)", padding: 8, borderRadius: 6, fontSize: 11 }}>
                  {JSON.stringify(selected.result[stepId] ?? null, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
