import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { useFetch } from "@/api/useFetch";
import type { SandboxReply, SandboxTurn } from "@/lib/types";
import type { Tx } from "@/lib/tx";
import { ErrorRow, inputStyle } from "@/screens/settings/form";
import { SANDBOX_PATH, resetSandbox, sendSandboxMessage } from "./agentApi";
import { SANDBOX_MESSAGE_MAX } from "./agentConstants";
import { agentErrorText } from "./agentErrors";
import { answeredFrom, safeHref } from "./answeredFrom";
import { toolLines } from "./toolLines";

/**
 * SP-20 "Try your agent": a preview chat with the agent (owner/admin,
 * agent.update). Write tools are simulated; replies are plain text with
 * http(s) links rendered as React elements (never HTML). The message is
 * restored to the composer when a turn fails.
 */

const GATE_REASON: Record<string, [string, string]> = {
  stopped: ["the agent is stopped", "الوكيل متوقف"],
  conversation_off: ["automatic replies are off", "الردود التلقائية متوقفة"],
  paused: ["a team member took over", "تولّى عضو في الفريق المحادثة"],
  excluded: ["this customer is excluded", "هذا العميل مستثنى"],
  outside_hours: ["outside working hours", "خارج ساعات العمل"],
  within_hours: ["inside working hours (the agent answers only outside them)", "داخل ساعات العمل (يرد الوكيل خارجها فقط)"],
  unknown: ["the reply check failed", "تعذّر التحقق من الرد"],
};

const URL_RE = /(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

/** Text with http(s) links as anchors; lines kept. */
export function ReplyText({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <>
      {lines.map((line, i) => {
        const parts: ReactNode[] = [];
        let last = 0;
        for (const m of line.matchAll(URL_RE)) {
          const href = safeHref(m[0]);
          if (m.index! > last) parts.push(line.slice(last, m.index));
          parts.push(
            href ? (
              <a key={`${i}-${m.index}`} href={href} target="_blank" rel="noopener noreferrer">
                {m[0]}
              </a>
            ) : (
              m[0]
            ),
          );
          last = m.index! + m[0].length;
        }
        if (last < line.length) parts.push(line.slice(last));
        return (
          <Fragment key={i}>
            {parts}
            {i < lines.length - 1 && <br />}
          </Fragment>
        );
      })}
    </>
  );
}

function AgentTurn({ turn, tx, gate }: { turn: SandboxTurn; tx: Tx; gate?: SandboxReply["gate"] }) {
  const lines = toolLines(turn.toolCalls ?? [], tx);
  const from = answeredFrom(turn.sources);
  return (
    <div style={{ alignSelf: "flex-start", maxWidth: "85%", display: "flex", flexDirection: "column", gap: 6 }}>
      {lines.length > 0 && (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
          {lines.map((l, i) => (
            <li
              key={i}
              className="muted"
              style={{
                fontSize: 12,
                display: "flex",
                gap: 6,
                alignItems: "center",
                border: l.badge ? "1px dashed var(--line)" : "none",
                borderRadius: 8,
                padding: l.badge ? "4px 8px" : 0,
              }}
            >
              <span>{l.error ? "⚠" : "•"}</span>
              <span>{l.label}</span>
              {l.times && <bdi className="mono">{l.times}</bdi>}
              {l.badge && (
                <span className="chip" style={{ fontSize: 11, padding: "0 6px", borderRadius: 999, background: "var(--bg-2)" }}>
                  {l.badge}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <div dir="auto" style={{ background: "var(--bg-2)", borderRadius: 12, padding: "8px 12px", fontSize: 13, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        <ReplyText text={turn.text} />
      </div>
      {from.visible.length > 0 && (
        <div className="muted" style={{ fontSize: 12, display: "flex", flexWrap: "wrap", gap: 6 }}>
          <span>{tx("Answered from", "الإجابة من")}:</span>
          {from.visible.map((s) =>
            s.href ? (
              <a key={s.sourceId} href={s.href} target="_blank" rel="noopener noreferrer" dir="auto">
                {s.title}
              </a>
            ) : (
              <span key={s.sourceId} dir="auto">
                {s.title}
              </span>
            ),
          )}
          {from.more > 0 && <bdi>{`+${from.more}`}</bdi>}
        </div>
      )}
      {gate && !gate.wouldReply && (
        <div style={{ fontSize: 12, color: "var(--warn, var(--ink-2))" }}>
          {tx("Real customers would not get a reply right now", "لن يتلقى العملاء الحقيقيون ردًا الآن")}
          {": "}
          {tx(...(GATE_REASON[gate.reason] ?? GATE_REASON.unknown))}
        </div>
      )}
    </div>
  );
}

export function TryAgentPanel({ tx, canUse }: { tx: Tx; canUse: boolean }) {
  const q = useFetch<{ messages: SandboxTurn[]; turnCount: number; expiresAt: string | null }>(canUse ? SANDBOX_PATH : null);
  const [turns, setTurns] = useState<SandboxTurn[]>([]);
  const [lastGate, setLastGate] = useState<SandboxReply["gate"] | undefined>(undefined);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (q.data) setTurns(q.data.messages);
  }, [q.data]);
  useEffect(() => bottom.current?.scrollIntoView?.({ block: "end" }), [turns.length]);

  if (!canUse) {
    return <div className="muted" style={{ fontSize: 13 }}>{tx("Only owners and admins can try the agent.", "يمكن للمالكين والمسؤولين فقط تجربة الوكيل.")}</div>;
  }

  async function send() {
    const message = text.trim();
    if (!message || message.length > SANDBOX_MESSAGE_MAX) return;
    setSending(true);
    setError(null);
    setText("");
    const at = new Date().toISOString();
    setTurns((t) => [...t, { role: "owner", text: message, at }]);
    try {
      const r = await sendSandboxMessage(message);
      setLastGate(r.gate);
      setTurns((t) => [...t, { role: "agent", text: r.reply, toolCalls: r.toolCalls, sources: r.sources, at: new Date().toISOString() }]);
    } catch (e) {
      // The message goes back to the composer; the optimistic bubble is removed.
      setTurns((t) => t.slice(0, -1));
      setText(message);
      setError(agentErrorText(e, tx));
    } finally {
      setSending(false);
    }
  }

  async function reset() {
    setError(null);
    try {
      await resetSandbox();
      setTurns([]);
      setLastGate(undefined);
    } catch (e) {
      setError(agentErrorText(e, tx));
    }
  }

  const len = text.trim().length;
  const lastAgent = turns.length ? turns.length - 1 : -1;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 760 }}>
      <div style={{ border: "1px solid var(--line-soft)", borderRadius: 10, padding: "8px 12px", fontSize: 12, background: "var(--bg-1)" }}>
        {tx(
          "Preview: replies may differ slightly from the live agent. Nothing is saved and no customer is messaged; bookings and changes are only described.",
          "معاينة: قد تختلف الردود قليلًا عن الوكيل الفعلي. لا يُحفظ شيء ولا تُرسل أي رسالة لعميل؛ الحجوزات والتغييرات توصف فقط.",
        )}
      </div>
      <div
        role="log"
        aria-live="polite"
        aria-label={tx("Try your agent", "جرّب وكيلك")}
        style={{ display: "flex", flexDirection: "column", gap: 10, minHeight: 240, maxHeight: 480, overflowY: "auto", padding: 4 }}
      >
        {turns.length === 0 && <div className="muted" style={{ fontSize: 13 }}>{tx("Ask what a customer would ask.", "اسأل ما قد يسأله عميل.")}</div>}
        {turns.map((t, i) =>
          t.role === "owner" ? (
            <div
              key={i}
              dir="auto"
              style={{ alignSelf: "flex-end", maxWidth: "85%", background: "var(--accent-soft, var(--bg-2))", borderRadius: 12, padding: "8px 12px", fontSize: 13, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
            >
              {t.text}
            </div>
          ) : (
            <AgentTurn key={i} turn={t} tx={tx} gate={i === lastAgent ? lastGate : undefined} />
          ),
        )}
        {sending && <div className="muted pulse" style={{ fontSize: 12 }}>{tx("The agent is typing…", "الوكيل يكتب…")}</div>}
        <div ref={bottom} />
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <textarea
          dir="auto"
          value={text}
          aria-label={tx("Message", "الرسالة")}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          disabled={sending}
          style={{ ...inputStyle, flex: 1, height: "auto", minHeight: 44, padding: "8px 10px", resize: "vertical" }}
          placeholder={tx("Write as a customer…", "اكتب كأنك عميل…")}
        />
        <button type="button" className="btn primary" onClick={() => void send()} disabled={sending || len === 0 || len > SANDBOX_MESSAGE_MAX}>
          {tx("Send", "إرسال")}
        </button>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="mono" style={{ fontSize: 11, color: len > SANDBOX_MESSAGE_MAX ? "var(--bad)" : "var(--ink-3)" }}>
          <bdi>{`${len}/${SANDBOX_MESSAGE_MAX}`}</bdi>
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn ghost" onClick={() => void reset()} disabled={sending || turns.length === 0}>
          {tx("Reset", "إعادة البدء")}
        </button>
      </div>
      <ErrorRow message={error} />
    </div>
  );
}
