// src/screens/workflows/WorkflowsPage.tsx
import { memo, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { useFetch } from "@/api/useFetch";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/Badge";
import type { BadgeKind } from "@/components/Badge";
import type { Workflow } from "@/lib/types";
import { WorkflowBuilder } from "./WorkflowBuilder";

const TRIGGER_LABEL: Record<Workflow["triggerType"], [string, string]> = {
  contact_created: ["New contact", "جهة اتصال جديدة"],
  message_received: ["Message received", "رسالة واردة"],
  ticket_created: ["Ticket created", "تذكرة جديدة"],
  ticket_stage_changed: ["Ticket stage changed", "تغيّر مرحلة التذكرة"],
  schedule: ["Schedule", "جدولة"],
  webhook: ["Webhook", "ويبهوك"],
};

function WorkflowsPageImpl() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const { data, loading, refetch } = useFetch<Workflow[]>("/workflows");
  const workflows = data ?? [];
  const [openId, setOpenId] = useState<string | "new" | null>(null);

  if (openId !== null) {
    return (
      <WorkflowBuilder
        workflowId={openId === "new" ? null : openId}
        onClose={() => {
          setOpenId(null);
          refetch();
        }}
      />
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <PageHeader
        title={tx("Workflows", "الأتمتة")}
        subtitle={tx(
          "Automate what happens when a contact, message, or ticket event occurs.",
          "أتمتة ما يحدث عند وقوع حدث متعلق بجهة اتصال أو رسالة أو تذكرة.",
        )}
        actions={
          <button type="button" onClick={() => setOpenId("new")}>
            {tx("New workflow", "أتمتة جديدة")}
          </button>
        }
      />

      <div style={{ flex: 1, overflowY: "auto", padding: "0 32px 32px" }}>
        {loading && workflows.length === 0 ? (
          <div className="muted">{tx("Loading…", "جارٍ التحميل…")}</div>
        ) : workflows.length === 0 ? (
          <div className="muted">{tx("No workflows yet.", "لا توجد أتمتة بعد.")}</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: t.lang === "ar" ? "right" : "left", color: "var(--ink-3)", fontSize: 12 }}>
                <th style={{ padding: "8px 12px" }}>{tx("Name", "الاسم")}</th>
                <th style={{ padding: "8px 12px" }}>{tx("Trigger", "المُشغّل")}</th>
                <th style={{ padding: "8px 12px" }}>{tx("Status", "الحالة")}</th>
                <th style={{ padding: "8px 12px" }}>{tx("Updated", "آخر تحديث")}</th>
              </tr>
            </thead>
            <tbody>
              {workflows.map((wf) => (
                <tr
                  key={wf.id}
                  onClick={() => setOpenId(wf.id)}
                  style={{ borderTop: "1px solid var(--line-soft)", cursor: "pointer" }}
                >
                  <td style={{ padding: "10px 12px", fontWeight: 600 }}>{wf.name}</td>
                  <td style={{ padding: "10px 12px" }}>
                    {t.lang === "ar" ? TRIGGER_LABEL[wf.triggerType][1] : TRIGGER_LABEL[wf.triggerType][0]}
                  </td>
                  <td style={{ padding: "10px 12px" }}>
                    <Badge kind={(wf.status === "active" ? "ok" : "") as BadgeKind}>
                      {wf.status === "active" ? tx("Active", "نشطة") : tx("Draft", "مسودة")}
                    </Badge>
                  </td>
                  <td style={{ padding: "10px 12px", color: "var(--ink-3)" }}>
                    {new Date(wf.updatedAt).toLocaleString(t.lang === "ar" ? "ar" : "en")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const WorkflowsPage = memo(WorkflowsPageImpl);
export default WorkflowsPage;
