import { useFetch } from "@/api/useFetch";
import { makeTx } from "@/lib/tx";
import type { Message } from "@/lib/types";
import { FieldList } from "./FieldList";
import type { RecordBodyProps } from "../RecordSheet";

const LAST_N = 10;

/** Conversation summary: fields, the last 10 messages (read-only) and a jump to the inbox. */
export function ConversationBody({ summary, lang, onClose }: RecordBodyProps) {
  const tx = makeTx(lang);
  const q = useFetch<{ messages: Message[] }>(`/conversations/${encodeURIComponent(summary.id)}`);
  const messages = (q.data?.messages ?? []).slice(-LAST_N);

  const openInbox = (): void => {
    window.location.hash = `#/inbox?open=${encodeURIComponent(summary.id)}`;
    onClose();
  };

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "16px 20px 24px" }}>
      <FieldList kind="conversation" fields={summary.fields} lang={lang} />

      <div className="mono" style={{ marginTop: 22, marginBottom: 8, fontSize: 10, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: 0.06 }}>
        {tx("Last messages", "آخر الرسائل")}
      </div>
      {q.error && !q.data ? (
        <div role="alert" style={{ fontSize: 12, color: "var(--bad)" }}>
          {tx("Couldn't load the messages.", "تعذّر تحميل الرسائل.")}
        </div>
      ) : !q.data ? (
        <div className="muted" style={{ fontSize: 12 }}>{tx("Loading…", "جارٍ التحميل…")}</div>
      ) : messages.length === 0 ? (
        <div className="muted" style={{ fontSize: 12 }}>{tx("No messages yet.", "لا توجد رسائل بعد.")}</div>
      ) : (
        <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          {messages.map((m, i) => {
            const mine = m.from !== "them";
            return (
              <li
                key={`${m.createdAt ?? m.t}-${i}`}
                style={{
                  alignSelf: mine ? "flex-end" : "flex-start",
                  maxWidth: "88%",
                  padding: "8px 10px",
                  borderRadius: 10,
                  background: mine ? "var(--bg-3, var(--bg-2))" : "var(--bg-2)",
                  border: "1px solid var(--line-soft)",
                  fontSize: 13,
                  lineHeight: 1.4,
                }}
              >
                <div dir="auto" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: "var(--ink)" }}>
                  {m.body || (m.attach ? tx("(attachment)", "(مرفق)") : "")}
                </div>
                <div className="mono" style={{ marginTop: 4, fontSize: 10, color: "var(--ink-3)" }}>
                  {m.from === "ai" ? tx("AI", "ذكاء اصطناعي") : mine ? tx("Team", "الفريق") : tx("Customer", "العميل")}
                  {" · "}
                  {m.t}
                </div>
              </li>
            );
          })}
        </ol>
      )}

      <button type="button" className="btn primary" style={{ marginTop: 20 }} onClick={openInbox}>
        {tx("Open in inbox", "فتح في صندوق الوارد")}
      </button>
    </div>
  );
}
