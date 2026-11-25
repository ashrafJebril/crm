import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/api/client";
import { openRecord } from "@/lib/openRecord";
import type { Tx } from "@/lib/tx";
import type { Lang } from "@/lib/types";
import { NO_PERMISSION_AR, NO_PERMISSION_EN } from "@/auth/usePermissions";
import { canUndoNow, eventText, undoErrorText, UNDO_WINDOW_MS, type ThreadEventItem } from "./threadModel";

const ICON: Record<string, string> = {
  stage_changed: "↔",
  ticket_created: "＋",
  ticket_won: "✓",
  ticket_lost: "✕",
  booking_created: "◷",
  booking_status: "◷",
  activity_done: "✓",
};

/** Inline system event (stage move, ticket/booking change, finished activity).
 *  Stage moves made recently by the viewer can be undone from here. */
export function ThreadEvent({
  event,
  tx,
  lang,
  onUndone,
}: {
  event: ThreadEventItem;
  tx: Tx;
  lang: Lang;
  /** Called after a successful undo, so the thread and conversation refetch. */
  onUndone?: () => void;
}) {
  const qc = useQueryClient();
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-evaluate the window while the button is still enabled.
  const at = Date.parse(event.at);
  useEffect(() => {
    if (event.undoable !== true || Number.isNaN(at)) return;
    const left = at + UNDO_WINDOW_MS - Date.now();
    if (left <= 0) {
      setNow(Date.now());
      return;
    }
    const id = window.setTimeout(() => setNow(Date.now()), left + 250);
    return () => window.clearTimeout(id);
  }, [event.undoable, at]);

  const showUndo = event.kind === "stage_changed" && event.undoable === true && !!event.ticketId;
  const expired = showUndo && !canUndoNow(event, now);

  const undo = async () => {
    if (!event.ticketId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/tickets/${event.ticketId}/undo-stage`, {});
      void qc.invalidateQueries({ queryKey: ["thread"] });
      void qc.invalidateQueries({ queryKey: ["tickets"] });
      // LinkedItemsCard reads /contacts/:id/tickets through useFetch; the author's own socket skips ticket.moved.
      void qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === "string" && (q.queryKey[0] as string).startsWith("/contacts/") });
      void qc.invalidateQueries({ queryKey: ["record", "ticket", event.ticketId] });
      void qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === "string" && (q.queryKey[0] as string).startsWith("/conversations") });
      onUndone?.();
    } catch (e) {
      if (e instanceof ApiError) {
        setError(
          undoErrorText(e.message, tx) ??
            (e.code ? undoErrorText(e.code, tx) : null) ??
            (e.status === 403 ? tx(NO_PERMISSION_EN, NO_PERMISSION_AR) : e.message),
        );
      } else {
        setError(tx("Request failed", "فشل الطلب"));
      }
    } finally {
      setBusy(false);
    }
  };

  const time = Number.isNaN(at)
    ? ""
    : new Date(at).toLocaleTimeString(lang === "ar" ? "ar" : [], { hour: "2-digit", minute: "2-digit" });
  const openId = event.ticketId ?? event.appointmentId;
  const openKind = event.ticketId ? "ticket" : event.appointmentId ? "booking" : null;

  return (
    <div style={{ display: "flex", justifyContent: "center" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
          justifyContent: "center",
          maxWidth: "80%",
          padding: "5px 12px",
          borderRadius: 10,
          border: "1px dashed var(--line)",
          background: "var(--bg-1)",
          color: "var(--ink-2)",
          fontSize: 12,
        }}
      >
        <span aria-hidden style={{ color: "var(--accent)", fontWeight: 700 }}>
          {ICON[event.kind] ?? "•"}
        </span>
        {openKind && openId ? (
          <button
            type="button"
            onClick={() => openRecord(openKind, openId)}
            dir="auto"
            style={{
              all: "unset",
              cursor: "pointer",
              textDecoration: "underline",
              textUnderlineOffset: 2,
            }}
          >
            {eventText(event, tx)}
          </button>
        ) : (
          <span dir="auto">{eventText(event, tx)}</span>
        )}
        <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-4)" }}>
          {time}
        </span>
        {showUndo && (
          <button
            type="button"
            className="btn ghost sm"
            onClick={undo}
            disabled={expired || busy}
            aria-busy={busy}
            title={
              expired
                ? tx("Undo is only available for 10 minutes", "التراجع متاح لمدة 10 دقائق فقط")
                : tx("Move the ticket back to its previous stage", "إعادة التذكرة إلى مرحلتها السابقة")
            }
          >
            {busy ? tx("Undoing…", "جارٍ التراجع…") : tx("Undo", "تراجع")}
          </button>
        )}
        {error && (
          <span role="alert" style={{ flexBasis: "100%", textAlign: "center", color: "var(--bad)", fontSize: 11.5 }}>
            {error}
          </span>
        )}
      </div>
    </div>
  );
}
