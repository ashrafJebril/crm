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
import { Composer, type ComposerHandle } from "./Composer";
import { FOCUSABLE, RESUME_MAX_FAILURES, shouldCloseOnEscape, trapTarget } from "./drawerKeys";
import { startersFor } from "./starters";
import { usePermissions } from "@/auth/usePermissions";

type SendInput = { text: string; refs: CopilotRef[]; attachments: CopilotAttachmentInfo[] };

/**
 * SP-18 "Ask Kewy" drawer: opened from the Topbar button, Ctrl/Cmd+J or an
 * ask box; resumes the member's latest chat from the last 24 h; New chat.
 *
 *  - Stays mounted while closed (hidden), so a running turn keeps streaming
 *    and the composer keeps its draft, references and attachments.
 *  - aria-modal: the composer takes focus on open, Tab stays inside, and focus
 *    returns to the opener on close. Escape closes it unless the `@` list is
 *    open (Escape then closes only the list).
 *  - The stream always ends with done or error. When the connection drops,
 *    the turn keeps running on the server: the drawer re-reads the session
 *    (while open and the tab is visible; at most 5 failed reads in a row).
 *  - Reset (New chat) and a workspace switch abort the stream in flight.
 */
export default function CopilotDrawer({
  open,
  onClose,
  prompt,
  session,
}: {
  open: boolean;
  onClose: () => void;
  prompt: { text: string; n: number } | null;
  /** A chat picked in the history page. */
  session?: { id: string; n: number } | null;
}) {
  const { t } = useTweaks();
  const lang = t.lang;
  const tx: Tx = makeTx(lang);
  const { user, activeWorkspace } = useAuth();
  const [route] = useRoute();
  const [state, dispatch] = useReducer(chatReducer, EMPTY_CHAT);
  const [mode, setMode] = useState<CopilotApprovalMode>(() => readApprovalMode(user?.id));
  const [sendError, setSendError] = useState<string | null>(null);
  const [resumed, setResumed] = useState(false);
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState === "visible");
  const streaming = useRef(false);
  const skipResume = useRef(false);
  const suggestionOpen = useRef(false);
  const composer = useRef<ComposerHandle | null>(null);
  const drawer = useRef<HTMLElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const abort = useRef<AbortController | null>(null);
  /** Bumped by every reset: events of an older stream are dropped. */
  const generation = useRef(0);
  const failures = useRef(0);
  const lastSend = useRef<SendInput | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  /** Start over: abort the stream in flight and forget the chat on screen. */
  const resetChat = useCallback(() => {
    generation.current++;
    abort.current?.abort();
    abort.current = null;
    streaming.current = false;
    failures.current = 0;
    dispatch({ type: "reset" });
    stateRef.current = EMPTY_CHAT;
    setSendError(null);
  }, []);

  useEffect(() => setMode(readApprovalMode(user?.id)), [user?.id]);
  // Another workspace: another history (and the old stream stops).
  useEffect(() => {
    resetChat();
    setResumed(false);
  }, [activeWorkspace?.id, resetChat]);
  useEffect(() => () => abort.current?.abort(), []);

  // Focus: the composer on open; back to the opener on close.
  useEffect(() => {
    if (open) {
      const a = document.activeElement;
      opener.current = a instanceof HTMLElement && !drawer.current?.contains(a) ? a : null;
      const id = window.setTimeout(() => composer.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
    const back = opener.current;
    opener.current = null;
    if (back?.isConnected) back.focus();
  }, [open]);

  useEffect(() => {
    const onVis = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  /** Re-read a session; false when the read failed. */
  const reload = useCallback(async (id: string): Promise<boolean> => {
    const gen = generation.current;
    try {
      const d = await getSession(id);
      if (gen === generation.current) dispatch({ type: "load", detail: d });
      return true;
    } catch {
      return false;
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

  // A turn running on the server without our stream: poll while open and visible, give up after 5 failures.
  useEffect(() => {
    if (!open || !visible || !state.running || streaming.current || !state.sessionId) return;
    const id = state.sessionId;
    const timer = window.setInterval(() => {
      void reload(id).then((ok) => {
        failures.current = ok ? 0 : failures.current + 1;
        if (failures.current >= RESUME_MAX_FAILURES) {
          failures.current = 0;
          dispatch({ type: "event", event: "error", data: { code: STREAM_LOST } });
        }
      });
    }, RESUME_POLL_MS);
    return () => window.clearInterval(timer);
  }, [open, visible, state.running, state.sessionId, reload]);

  // Back to a visible tab with an open drawer: re-read the chat (the answer may have arrived).
  useEffect(() => {
    const s = stateRef.current;
    if (open && visible && s.sessionId && !streaming.current && (s.running || s.items.some((i) => i.type === "error" && i.code === STREAM_LOST))) void reload(s.sessionId);
  }, [open, visible, reload]);

  /** Resolves true once the server accepted the message (its stream started), false when it was refused. */
  const send = useCallback(
    (m: SendInput): Promise<boolean> => {
      if (streaming.current || stateRef.current.running) return Promise.resolve(false);
      setSendError(null);
      lastSend.current = m;
      streaming.current = true;
      const gen = generation.current;
      const ctrl = new AbortController();
      abort.current = ctrl;
      const localId = `local-${Date.now()}`;
      dispatch({ type: "send", localId, text: m.text, references: m.refs.map((r) => ({ kind: r.kind, id: r.id, title: r.title ?? "" })), attachments: m.attachments });
      let accept!: (v: boolean) => void;
      const accepted = new Promise<boolean>((r) => (accept = r));
      void streamTurn(
        {
          ...(stateRef.current.sessionId ? { sessionId: stateRef.current.sessionId } : {}),
          message: m.text,
          ...(m.refs.length ? { references: refsForBody(m.refs) } : {}),
          ...(m.attachments.length ? { attachmentIds: m.attachments.map((a) => a.id) } : {}),
          pageContext: pageContextOf(route, window.location.hash),
          approvalMode: mode,
          lang,
        },
        (event, data) => {
          accept(true);
          if (gen === generation.current) dispatch({ type: "event", event, data });
        },
        ctrl.signal,
      )
        .then((end) => {
          accept(true);
          if (gen !== generation.current) return;
          streaming.current = false;
          abort.current = null;
          const sid = stateRef.current.sessionId;
          if (end === "error" && sid && stateRef.current.items.some((i) => i.type === "error" && i.code === STREAM_LOST)) {
            // The stream was cut: the turn goes on server-side.
            void reload(sid);
          } else if (sid && (m.attachments.length || m.refs.length)) {
            void getSession(sid).then((d) => d.tainted && gen === generation.current && dispatch({ type: "taint" })).catch(() => undefined);
          }
        })
        .catch((e) => {
          accept(false);
          if (gen !== generation.current) return;
          streaming.current = false;
          abort.current = null;
          // Refused before the stream: nothing was stored; the composer keeps text, references and files.
          dispatch({ type: "unsend", localId });
          setSendError(copilotErrorText(e, tx));
        });
      return accepted;
    },
    [route, mode, lang, reload, tx],
  );

  // An ask box (e.g. insights) sends its question in a fresh chat as soon as the drawer opens.
  const asked = useRef(0);
  useEffect(() => {
    if (!prompt || prompt.n === asked.current) return;
    asked.current = prompt.n;
    if (stateRef.current.running || streaming.current) return;
    skipResume.current = true;
    resetChat();
    void send({ text: prompt.text, refs: [], attachments: [] });
  }, [prompt, send, resetChat]);

  // A chat picked in the history: show it (unless a turn is streaming here).
  const shown = useRef(0);
  useEffect(() => {
    if (!session || session.n === shown.current) return;
    shown.current = session.n;
    if (streaming.current || stateRef.current.sessionId === session.id) return;
    skipResume.current = true;
    resetChat();
    void reload(session.id);
  }, [session, resetChat, reload]);

  const { can } = usePermissions();
  // The page under the drawer (the record sheet can change it without a route change).
  const [hash, setHash] = useState(() => (typeof window === "undefined" ? "" : window.location.hash));
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const starters = startersFor(pageContextOf(route, hash).page, can, lang);

  const onCard = (c: PendingCard) => dispatch({ type: "card", card: c });
  const onStale = () => state.sessionId && void reload(state.sessionId);
  // Retry the last message: the same text and references. Its attachments are already part of
  // this chat (the stored message carries them, and the model sees them again); sending their ids
  // again would be refused as already sent.
  const retry = () => lastSend.current && void send({ ...lastSend.current, attachments: [] });

  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (shouldCloseOnEscape(e, suggestionOpen.current)) {
      onClose();
      return;
    }
    if (e.key === "Tab" && drawer.current) {
      const items = Array.from(drawer.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
      const next = trapTarget(items, document.activeElement as HTMLElement | null, e.shiftKey);
      if (next) {
        e.preventDefault();
        next.focus();
      }
    }
  };

  return (
    <div className="copilot-backdrop" hidden={!open} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside ref={drawer} className="copilot-drawer" role="dialog" aria-modal="true" aria-label={tx("Ask Kewy", "اسأل كيوي")} dir={lang === "ar" ? "rtl" : "ltr"} onKeyDown={onKeyDown}>
        <header className="copilot-head">
          <div className="copilot-title">
            <strong>{tx("Ask Kewy", "اسأل كيوي")}</strong>
            {state.title && (
              <span className="copilot-subtitle" dir="auto">
                {state.title}
              </span>
            )}
          </div>
          <button type="button" className="btn ghost sm" onClick={resetChat}>
            {tx("New chat", "محادثة جديدة")}
          </button>
          <a className="btn ghost sm" href="#/copilot" onClick={onClose}>
            {tx("History", "السجل")}
          </a>
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
            <p>{tx("Ask about your customers, conversations, tickets, bookings or numbers. Kewy proposes changes; you approve them.", "اسأل عن عملائك أو محادثاتك أو تذاكرك أو حجوزاتك أو أرقامك. يقترح كيوي التغييرات وأنت توافق عليها.")}</p>
            {starters.length > 0 && (
              <div className="copilot-starters">
                {starters.map((s) => (
                  <button key={s} type="button" className="copilot-chip" onClick={() => void send({ text: s, refs: [], attachments: [] })}>
                    {s}
                  </button>
                ))}
              </div>
            )}
            <p className="copilot-hint">{tx("Ctrl+J (⌘J on Mac) opens and closes Kewy.", "Ctrl+J (أو ⌘J على ماك) يفتح كيوي ويغلقه.")}</p>
          </div>
        ) : (
          <MessageList state={state} tx={tx} lang={lang} onCard={onCard} onStale={onStale} onRetry={retry} onNewChat={resetChat} />
        )}
        {sendError && (
          <div className="copilot-error" role="alert">
            {sendError}
          </div>
        )}
        <Composer ref={composer} tx={tx} lang={lang} disabled={state.running} onSend={send} onSuggestingChange={(v) => (suggestionOpen.current = v)} />
      </aside>
    </div>
  );
}
