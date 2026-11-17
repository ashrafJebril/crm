import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useAuth } from "@/auth/context";
import { useTweaks } from "@/tweaks/context";
import { useRoute } from "@/router";
import { makeTx, type Tx } from "@/lib/tx";
import type { CopilotApprovalMode, CopilotAttachmentInfo, CopilotRef, PendingCard } from "@/lib/types";
import { STREAM_LOST } from "@/api/eventStream";
import { chatReducer, EMPTY_CHAT } from "./chatReducer";
import { getSession, listSessions, streamTurn } from "./copilotApi";
import { copilotErrorText } from "./copilotErrors";
import { APPROVAL_MODES, RESUME_POLL_MS, RESUME_WINDOW_MS } from "./copilotConstants";
import { MODE_LABELS, readApprovalMode, TAINT_RULE, writeApprovalMode } from "./approvalMode";
import { pageContextOf } from "./pageContext";
import { refsForBody } from "./refs";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";

/**
 * SP-18 "Ask Kewy" drawer: opened from the Topbar button, Ctrl/Cmd+J or an
 * ask box; resumes the member's latest chat from the last 24 h; New chat.
 *
 * The stream (POST /copilot/stream) always ends with done or error. When the
 * connection drops (tab asleep, network), the turn keeps running on the
 * server: the drawer re-reads the session until it is no longer running, and
 * also when the tab becomes visible again, so the answer is never lost.
 */
export default function CopilotDrawer({ open, onClose, prompt }: { open: boolean; onClose: () => void; prompt: { text: string; n: number } | null }) {
  const { t } = useTweaks();
  const lang = t.lang;
  const tx: Tx = makeTx(lang);
  const { user, activeWorkspace } = useAuth();
  const [route] = useRoute();
  const [state, dispatch] = useReducer(chatReducer, EMPTY_CHAT);
  const [mode, setMode] = useState<CopilotApprovalMode>(() => readApprovalMode(user?.id));
  const [sendError, setSendError] = useState<string | null>(null);
  const [resumed, setResumed] = useState(false);
  // Text put back into the composer (a send refused before its stream).
  const [restore, setRestore] = useState<{ text: string; n: number } | null>(null);
  const streaming = useRef(false);
  const skipResume = useRef(false);
  const lastSend = useRef<{ text: string; refs: CopilotRef[] } | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => setMode(readApprovalMode(user?.id)), [user?.id]);
  // Another workspace: another history.
  useEffect(() => {
    dispatch({ type: "reset" });
    setResumed(false);
  }, [activeWorkspace?.id]);

  const reload = useCallback(async (id: string) => {
    try {
      dispatch({ type: "load", detail: await getSession(id) });
    } catch {
      /* the next poll or open retries */
    }
  }, []);

  // Resume the latest chat (≤ 24 h) the first time the drawer opens.
  useEffect(() => {
    if (!open || resumed) return;
    setResumed(true);
    if (stateRef.current.sessionId || skipResume.current) return;
    void listSessions()
      .then((p) => {
        const s = p.items[0];
        if (s && Date.now() - new Date(s.updatedAt).getTime() < RESUME_WINDOW_MS && !stateRef.current.sessionId && !skipResume.current && !streaming.current) return reload(s.id);
      })
      .catch(() => undefined);
  }, [open, resumed, reload]);

  // A turn running on the server without our stream (lost connection, reload): poll until it ends.
  useEffect(() => {
    if (!state.running || streaming.current || !state.sessionId) return;
    const id = state.sessionId;
    const timer = window.setInterval(() => void reload(id), RESUME_POLL_MS);
    return () => window.clearInterval(timer);
  }, [state.running, state.sessionId, reload]);

  // Back to a visible tab: re-read the open chat (the answer may have arrived meanwhile).
  useEffect(() => {
    const onVis = () => {
      const s = stateRef.current;
      if (document.visibilityState === "visible" && s.sessionId && !streaming.current && (s.running || s.items.some((i) => i.type === "error" && i.code === STREAM_LOST))) void reload(s.sessionId);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [reload]);

  const send = useCallback(
    async (m: { text: string; refs: CopilotRef[]; attachments: CopilotAttachmentInfo[] }) => {
      if (streaming.current || stateRef.current.running) return;
      setSendError(null);
      lastSend.current = { text: m.text, refs: m.refs };
      streaming.current = true;
      const localId = `local-${Date.now()}`;
      dispatch({
        type: "send",
        localId,
        text: m.text,
        references: m.refs.map((r) => ({ kind: r.kind, id: r.id, title: r.title ?? "" })),
        attachments: m.attachments,
      });
      try {
        const end = await streamTurn(
          {
            ...(stateRef.current.sessionId ? { sessionId: stateRef.current.sessionId } : {}),
            message: m.text,
            ...(m.refs.length ? { references: refsForBody(m.refs) } : {}),
            ...(m.attachments.length ? { attachmentIds: m.attachments.map((a) => a.id) } : {}),
            pageContext: pageContextOf(route, window.location.hash),
            approvalMode: mode,
            lang,
          },
          (event, data) => dispatch({ type: "event", event, data }),
        );
        streaming.current = false;
        const sid = stateRef.current.sessionId;
        // The stream was cut: the turn goes on server-side; mark it running and re-read.
        if (end === "error" && sid && stateRef.current.items.some((i) => i.type === "error" && i.code === STREAM_LOST)) {
          void reload(sid);
        } else if (sid && (m.attachments.length || m.refs.length)) {
          // The session may have become tainted (attachments, references): refresh the notice.
          void getSession(sid).then((d) => d.tainted && dispatch({ type: "taint" })).catch(() => undefined);
        }
      } catch (e) {
        streaming.current = false;
        // Refused before the stream (400/403/404/409/429/503): nothing was stored; the text goes back to the composer.
        dispatch({ type: "unsend", localId });
        setSendError(copilotErrorText(e, tx));
        setRestore((r) => ({ text: m.text, n: (r?.n ?? 0) + 1 }));
      }
    },
    [route, mode, lang, reload, tx],
  );

  // An ask box (e.g. insights) sends its question as soon as the drawer opens.
  const asked = useRef(0);
  useEffect(() => {
    if (!prompt || prompt.n === asked.current) return;
    asked.current = prompt.n;
    if (stateRef.current.running || streaming.current) return;
    // A fresh chat for the question (never mixed into a resumed one).
    skipResume.current = true;
    dispatch({ type: "reset" });
    stateRef.current = EMPTY_CHAT;
    void send({ text: prompt.text, refs: [], attachments: [] });
  }, [prompt, send]);

  const newChat = () => {
    if (streaming.current) return;
    dispatch({ type: "reset" });
    setSendError(null);
  };

  const onCard = (c: PendingCard) => dispatch({ type: "card", card: c });
  const onStale = () => state.sessionId && void reload(state.sessionId);

  if (!open) return null;
  return (
    <div className="copilot-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="copilot-drawer" role="dialog" aria-modal="true" aria-label={tx("Ask Kewy", "اسأل كيوي")} dir={lang === "ar" ? "rtl" : "ltr"} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <header className="copilot-head">
          <div className="copilot-title">
            <strong>{tx("Ask Kewy", "اسأل كيوي")}</strong>
            {state.title && (
              <span className="copilot-subtitle" dir="auto">
                {state.title}
              </span>
            )}
          </div>
          <button type="button" className="btn ghost sm" onClick={newChat} disabled={state.running}>
            {tx("New chat", "محادثة جديدة")}
          </button>
          <button type="button" className="btn ghost icon sm" aria-label={tx("Close", "إغلاق")} onClick={onClose}>
            ×
          </button>
        </header>
        <div className="copilot-mode">
          <label>
            <span>{tx("Changes", "التغييرات")}</span>
            <select
              value={mode}
              onChange={(e) => {
                const v = e.target.value as CopilotApprovalMode;
                setMode(v);
                writeApprovalMode(user?.id, v);
              }}
            >
              {APPROVAL_MODES.map((m) => (
                <option key={m} value={m}>
                  {tx(MODE_LABELS[m][0], MODE_LABELS[m][1])}
                </option>
              ))}
            </select>
          </label>
          <p className="copilot-hint">{tx(TAINT_RULE[0], TAINT_RULE[1])}</p>
          {state.tainted && (
            <p className="copilot-taint" role="note">
              {tx("This chat has read customer data: every change needs your approval here.", "قرأت هذه المحادثة بيانات العملاء: يحتاج كل تغيير هنا إلى موافقتك.")}
            </p>
          )}
        </div>
        {state.items.length === 0 && !state.running ? (
          <div className="copilot-empty">
            {tx("Ask about your customers, conversations, tickets, bookings or numbers. Kewy proposes changes; you approve them.", "اسأل عن عملائك أو محادثاتك أو تذاكرك أو حجوزاتك أو أرقامك. يقترح كيوي التغييرات وأنت توافق عليها.")}
          </div>
        ) : (
          <MessageList
            state={state}
            tx={tx}
            lang={lang}
            onCard={onCard}
            onStale={onStale}
            onRetry={() => lastSend.current && void send({ text: lastSend.current.text, refs: lastSend.current.refs, attachments: [] })}
            onNewChat={newChat}
          />
        )}
        {sendError && (
          <div className="copilot-error" role="alert">
            {sendError}
          </div>
        )}
        <Composer key={restore?.n ?? 0} tx={tx} lang={lang} disabled={state.running} initialText={restore?.text} onSend={(m) => void send(m)} />
      </aside>
    </div>
  );
}
