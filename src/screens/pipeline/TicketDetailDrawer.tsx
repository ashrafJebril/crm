import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk } from "@/api/queryKeys";
import { useAddNote, useDeleteTicket, useUpdateTicket } from "./hooks/useTicketMutations";
import type { Lang, TicketDetail } from "@/lib/types";

interface Props {
  ticketId: string;
  pipelineId: string;
  stageId: string;
  lang: Lang;
  onClose: () => void;
  onOpenConversation: (conversationId: string) => void;
}

export function TicketDetailDrawer({
  ticketId,
  pipelineId,
  stageId,
  lang,
  onClose,
  onOpenConversation,
}: Props) {
  const q = useQuery<TicketDetail>({
    queryKey: qk.ticket(ticketId),
    queryFn: ({ signal }) => api.get<TicketDetail>(`/tickets/${ticketId}`, signal),
  });

  const addNote = useAddNote();
  const update = useUpdateTicket();
  const del = useDeleteTicket();

  const [noteText, setNoteText] = useState("");
  const t = q.data;

  return (
    <div
      role="dialog"
      aria-modal="false"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 90,
        display: "flex",
        justifyContent: lang === "ar" ? "flex-start" : "flex-end",
      }}
    >
      <aside
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(440px, 92vw)",
          height: "100%",
          background: "var(--bg-1)",
          borderLeft: lang === "ar" ? 0 : "1px solid var(--line)",
          borderRight: lang === "ar" ? "1px solid var(--line)" : 0,
          padding: 16,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        {q.isLoading ? (
          <div style={{ color: "var(--ink-3)", fontSize: 12 }}>
            {lang === "ar" ? "جارٍ التحميل..." : "Loading..."}
          </div>
        ) : !t ? (
          <div style={{ color: "var(--bad)", fontSize: 13 }}>
            {lang === "ar" ? "التذكرة غير موجودة" : "Ticket not found"}
          </div>
        ) : (
          <>
            <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <strong style={{ color: "var(--ink)", fontSize: 14 }}>
                #{t.number} — {t.title}
              </strong>
              <button
                onClick={onClose}
                style={{
                  background: "transparent",
                  border: 0,
                  color: "var(--ink-2)",
                  cursor: "pointer",
                  fontSize: 18,
                }}
              >
                ×
              </button>
            </header>

            <section style={section}>
              <div style={label}>{lang === "ar" ? "العميل" : "Contact"}</div>
              <div style={value}>{t.contact?.name ?? "—"}</div>
            </section>

            <section style={section}>
              <div style={label}>{lang === "ar" ? "القيمة" : "Value"}</div>
              <input
                type="number"
                defaultValue={t.value ?? 0}
                onBlur={(e) => {
                  const v = Number(e.target.value);
                  if (v !== (t.value ?? 0)) {
                    update.mutate({ id: t.id, patch: { value: v } });
                  }
                }}
                style={input}
              />
            </section>

            {t.conversationId ? (
              <button
                type="button"
                onClick={() => onOpenConversation(t.conversationId!)}
                style={{ ...input, cursor: "pointer", textAlign: "start" }}
              >
                {lang === "ar" ? "افتح المحادثة المرتبطة" : "Open linked conversation"}
              </button>
            ) : null}

            <section style={section}>
              <div style={label}>{lang === "ar" ? "النشاط" : "Activity"}</div>
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                {(t.activities ?? []).map((a) => (
                  <li
                    key={a.id}
                    style={{
                      fontSize: 12,
                      color: "var(--ink-2)",
                      padding: 6,
                      background: "var(--bg-2)",
                      borderRadius: "var(--r)",
                    }}
                  >
                    <strong style={{ color: "var(--ink)" }}>{a.kind}</strong>
                    {a.fromStage ? ` — ${a.fromStage} → ${a.toStage}` : ""}
                    {a.note ? ` — ${a.note}` : ""}
                  </li>
                ))}
              </ul>
            </section>

            <section style={section}>
              <div style={label}>{lang === "ar" ? "إضافة ملاحظة" : "Add note"}</div>
              <textarea
                rows={3}
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                style={{ ...input, resize: "vertical" }}
              />
              <button
                type="button"
                disabled={!noteText.trim() || addNote.isPending}
                onClick={async () => {
                  await addNote.mutateAsync({ ticketId: t.id, note: noteText.trim() });
                  setNoteText("");
                }}
                style={{
                  padding: "6px 12px",
                  background: "var(--accent)",
                  border: 0,
                  borderRadius: "var(--r)",
                  color: "white",
                  cursor: "pointer",
                  alignSelf: "flex-start",
                }}
              >
                {lang === "ar" ? "حفظ" : "Save note"}
              </button>
            </section>

            <button
              type="button"
              onClick={() => {
                if (!confirm(lang === "ar" ? "حذف هذه التذكرة؟" : "Delete this ticket?")) return;
                del.mutate({ id: t.id, pipelineId, stageId });
                onClose();
              }}
              style={{
                marginTop: "auto",
                padding: "8px 12px",
                background: "transparent",
                border: "1px solid var(--bad)",
                borderRadius: "var(--r)",
                color: "var(--bad)",
                cursor: "pointer",
              }}
            >
              {lang === "ar" ? "حذف" : "Delete"}
            </button>
          </>
        )}
      </aside>
    </div>
  );
}

const section: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const label: React.CSSProperties = {
  fontSize: 11,
  color: "var(--ink-3)",
  textTransform: "uppercase",
  letterSpacing: 0.5,
};

const value: React.CSSProperties = {
  fontSize: 13,
  color: "var(--ink)",
};

const input: React.CSSProperties = {
  width: "100%",
  background: "var(--bg-2)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r)",
  padding: "8px 12px",
  color: "var(--ink)",
  fontSize: 13,
};
