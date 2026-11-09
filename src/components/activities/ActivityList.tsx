import { useState } from "react";
import { api } from "@/api/client";
import { useFetch } from "@/api/useFetch";
import { useToast } from "@/components/Toast";
import { usePermissions } from "@/auth/usePermissions";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { formatDue, type Activity, type ActivityKind } from "@/screens/followups/followupsLogic";
import { ActivityDialog } from "./ActivityDialog";
import { activityError, kindGlyph, kindLabel, useInvalidateActivities, useWorkspaceTz } from "./activityApi";

/** Activities of one contact or ticket, with a schedule action. */
export function ActivityList({ contactId, ticketId }: { contactId?: string; ticketId?: string }) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const tz = useWorkspaceTz();
  const { can } = usePermissions();
  const { toast } = useToast();
  const invalidate = useInvalidateActivities();
  const canUpdateContact = can("contacts.update");
  const canUpdateTicket = can("tickets.update");
  // Per row: ticket-linked activities follow tickets.update, the rest contacts.update.
  const canEditRow = (a: Activity) => (a.ticketId ? canUpdateTicket : canUpdateContact);
  const canUpdate = ticketId ? canUpdateTicket : canUpdateContact; // new activities
  const q = useFetch<{ items: Activity[]; nextCursor: string | null }>(
    `/activities?${ticketId ? `ticketId=${ticketId}` : `contactId=${contactId}`}&limit=20`,
  );
  const [dialog, setDialog] = useState<{ activity?: Activity; kind?: ActivityKind } | null>(null);
  const items = q.data?.items ?? [];
  const now = new Date();

  const markDone = async (a: Activity) => {
    try {
      await api.post(`/activities/${a.id}/complete`, {});
      invalidate();
    } catch (e) {
      toast(activityError(tx, e), "error");
    }
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
        <button type="button" className="btn sm" disabled={!canUpdate} onClick={() => setDialog({})}>
          {tx("Schedule follow-up", "جدولة متابعة")}
        </button>
        <button type="button" className="btn sm ghost" disabled={!canUpdate} onClick={() => setDialog({ kind: "call" })}>
          {tx("Log activity", "تسجيل نشاط")}
        </button>
      </div>
      {q.loading && items.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--ink-3)" }}>{tx("Loading…", "جارٍ التحميل…")}</div>
      ) : items.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--ink-3)" }}>{tx("No activities yet.", "لا توجد أنشطة بعد.")}</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {items.map((a) => {
            const rowCan = canEditRow(a);
            const overdue = !a.doneAt && a.dueAt && new Date(a.dueAt) < now;
            return (
              <div
                key={a.id}
                style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "8px 10px", border: "1px solid var(--line-soft)", borderRadius: 8, background: "var(--bg-1)" }}
              >
                <input
                  type="checkbox"
                  checked={!!a.doneAt}
                  disabled={!!a.doneAt || !rowCan}
                  aria-label={tx("Mark done", "تم الإنجاز")}
                  onChange={() => void markDone(a)}
                  style={{ marginTop: 3 }}
                />
                <button
                  type="button"
                  onClick={() => rowCan && setDialog({ activity: a })}
                  style={{ all: "unset", flex: 1, minWidth: 0, cursor: rowCan ? "pointer" : "default" }}
                >
                  <div dir="auto" style={{ fontSize: 13, textDecoration: a.doneAt ? "line-through" : "none", color: a.doneAt ? "var(--ink-3)" : "var(--ink)" }}>
                    <span aria-hidden>{kindGlyph[a.kind]}</span> {a.title}
                  </div>
                  <div style={{ fontSize: 11, color: overdue ? "var(--bad)" : "var(--ink-3)", marginTop: 2 }}>
                    {kindLabel(tx, a.kind)}
                    {a.dueAt ? ` · ${formatDue(a.dueAt, now, tz, t.lang)}` : ""}
                    {a.outcome ? <> · <span dir="auto">{a.outcome}</span></> : null}
                  </div>
                </button>
              </div>
            );
          })}
        </div>
      )}
      {dialog && (
        <div onClick={(e) => e.stopPropagation()}>
          <ActivityDialog
            activity={dialog.activity}
            defaultKind={dialog.kind}
            contactId={contactId}
            ticketId={ticketId}
            onClose={() => setDialog(null)}
          />
        </div>
      )}
    </div>
  );
}
