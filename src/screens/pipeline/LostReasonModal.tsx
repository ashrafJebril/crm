import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Modal } from "@/components/Modal";
import type { Ticket, Lang } from "@/lib/types";
import { makeTx } from "@/lib/tx";
import { usePermissions } from "@/auth/usePermissions";

export interface LostReasonOption {
  id: string;
  label: string;
  labelAr: string;
  order: number;
}

interface Props {
  ticket: Ticket;
  lang: Lang;
  pipelineId: string;
  onCancel: () => void;
  onConfirm: (reason: { id: string; label: string }) => void;
}

export function LostReasonModal({ ticket, lang, pipelineId, onCancel, onConfirm }: Props) {
  const ar = lang === "ar";
  const tx = makeTx(lang);
  const { can } = usePermissions();
  const q = useQuery<LostReasonOption[]>({
    queryKey: ["pipelines", pipelineId, "lost-reasons"],
    queryFn: ({ signal }) => api.get<LostReasonOption[]>(`/pipelines/${pipelineId}/lost-reasons`, signal),
    staleTime: 0,
  });
  const reasons = q.data ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    if (selected === null && reasons.length > 0) setSelected(reasons[0].id);
  }, [reasons, selected]);
  const chosen = reasons.find((r) => r.id === selected);

  return (
    <Modal onClose={onCancel} width={420} label="Lost reason">
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <h3 style={{ margin: 0, fontSize: 15, color: "var(--ink)" }}>
          {lang === "ar" ? `سبب الخسارة لـ #${ticket.number}` : `Lost reason for #${ticket.number}`}
        </h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {q.isPending ? (
            <div style={{ fontSize: 12, color: "var(--ink-3)" }}>{ar ? "جارٍ التحميل..." : "Loading..."}</div>
          ) : q.isError ? (
            <div style={{ fontSize: 12, color: "var(--bad, #ef4444)" }}>
              {ar ? "تعذر تحميل أسباب الخسارة" : "Could not load lost reasons"}
            </div>
          ) : reasons.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--ink-3)", display: "grid", gap: 6 }}>
              <span>
                {tx(
                  "No lost reasons yet — add them in Settings → Pipelines",
                  "لا توجد أسباب خسارة بعد — أضفها من الإعدادات ← المسارات",
                )}
              </span>
              {can("pipelines.manage") ? (
                <a href="#/settings?tab=pipelines" style={{ color: "var(--accent)" }}>
                  {tx("Open the pipeline editor", "فتح محرر المسارات")}
                </a>
              ) : null}
            </div>
          ) : null}
          {reasons.map((r) => (
            <label
              key={r.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: 8,
                border: "1px solid var(--line)",
                borderRadius: "var(--r)",
                cursor: "pointer",
                background: selected === r.id ? "var(--bg-2)" : "transparent",
              }}
            >
              <input
                type="radio"
                name="lost-reason"
                checked={selected === r.id}
                onChange={() => setSelected(r.id)}
              />
              <span dir="auto" style={{ fontSize: 13, color: "var(--ink)" }}>
                {ar ? r.labelAr : r.label}
              </span>
            </label>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              padding: "8px 14px",
              background: "transparent",
              border: "1px solid var(--line)",
              borderRadius: "var(--r)",
              color: "var(--ink-2)",
              cursor: "pointer",
            }}
          >
            {lang === "ar" ? "إلغاء" : "Cancel"}
          </button>
          <button
            type="button"
            disabled={!chosen}
            onClick={() => chosen && onConfirm({ id: chosen.id, label: chosen.label })}
            style={{
              padding: "8px 14px",
              background: "var(--accent)",
              border: 0,
              borderRadius: "var(--r)",
              color: "white",
              cursor: chosen ? "pointer" : "not-allowed",
              opacity: chosen ? 1 : 0.5,
            }}
          >
            {lang === "ar" ? "تأكيد" : "Confirm"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
