import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { useTweaks } from "@/tweaks/context";
import { useAuth } from "@/auth/context";
import { makeTx } from "@/lib/tx";
import { deleteSession, listSessions, openCopilot, useCopilotAvailable } from "@/copilot/copilotApi";
import { copilotErrorText } from "@/copilot/copilotErrors";
import { addPage, EMPTY_HISTORY, removeSession, type HistoryState } from "@/copilot/historyPaging";

/**
 * SP-18 "Ask Kewy" history (`#/copilot`): the member's own chats (the server
 * lists only theirs), 20 per page by keyset cursor, newest first. Open puts
 * the chat in the drawer; Delete asks first.
 */
export default function CopilotHistory() {
  const { t } = useTweaks();
  const lang = t.lang;
  const tx = makeTx(lang);
  const { activeWorkspace } = useAuth();
  const available = useCopilotAvailable();
  const [state, setState] = useState<HistoryState>(EMPTY_HISTORY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (cursor: string | null) => {
    setBusy(true);
    setError(null);
    try {
      const page = await listSessions(cursor);
      setState((s) => addPage(s, page, cursor === null));
    } catch (e) {
      setError(copilotErrorText(e, tx));
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang]);

  useEffect(() => {
    setState(EMPTY_HISTORY);
    void load(null);
  }, [activeWorkspace?.id, load]);

  const remove = async (id: string, title: string) => {
    if (!window.confirm(tx(`Delete the chat "${title}"? This can't be undone.`, `حذف المحادثة "${title}"؟ لا يمكن التراجع عن ذلك.`))) return;
    try {
      await deleteSession(id);
      setState((s) => removeSession(s, id));
    } catch (e) {
      setError(copilotErrorText(e, tx));
    }
  };

  const when = (iso: string) =>
    new Date(iso).toLocaleString(lang === "ar" ? "ar-u-nu-latn" : "en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

  return (
    <div style={{ overflowY: "auto", flex: 1 }}>
      <PageHeader
        title={tx("Ask Kewy history", "سجل اسأل كيوي")}
        subtitle={tx("Your chats with Kewy. Only you can see them.", "محادثاتك مع كيوي. لا يراها غيرك.")}
        actions={
          available ? (
            <button type="button" className="btn primary" onClick={() => openCopilot()}>
              {tx("New chat", "محادثة جديدة")}
            </button>
          ) : undefined
        }
      />
      <div style={{ paddingBlock: "0 24px", paddingInline: 24 }}>
        {error && (
          <div className="copilot-error" role="alert">
            {error}
          </div>
        )}
        {state.loaded && state.items.length === 0 && <p className="muted">{tx("No chats yet.", "لا توجد محادثات بعد.")}</p>}
        <ul className="copilot-history">
          {state.items.map((s) => {
            const title = s.title || tx("Untitled chat", "محادثة بلا عنوان");
            return (
              <li key={s.id} className="copilot-history-row">
                <button type="button" className="copilot-history-open" onClick={() => openCopilot({ sessionId: s.id })} disabled={!available}>
                  <bdi dir="auto">{title}</bdi>
                  <span className="mono copilot-hint">
                    {when(s.updatedAt)}
                    {s.running ? ` · ${tx("answering…", "يجيب…")}` : ""}
                  </span>
                </button>
                <button type="button" className="btn ghost sm" onClick={() => void remove(s.id, title)} disabled={s.running}>
                  {tx("Delete", "حذف")}
                </button>
              </li>
            );
          })}
        </ul>
        {state.nextCursor && (
          <button type="button" className="btn" disabled={busy} onClick={() => void load(state.nextCursor)}>
            {busy ? tx("Loading…", "جارٍ التحميل…") : tx("Load more", "تحميل المزيد")}
          </button>
        )}
      </div>
    </div>
  );
}
