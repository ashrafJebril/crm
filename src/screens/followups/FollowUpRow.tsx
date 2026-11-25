import { useState } from "react";
import { api } from "@/api/client";
import { Modal } from "@/components/Modal";
import { useToast } from "@/components/Toast";
import { activityError, kindGlyph, kindLabel, useInvalidateActivities, useTeam, useWorkspaceTz } from "@/components/activities/activityApi";
import { usePermissions } from "@/auth/usePermissions";
import { useTweaks } from "@/tweaks/context";
import { makeTx, type Tx } from "@/lib/tx";
import { openRecord } from "@/lib/openRecord";
import { formatDue, fromLocalInput, quickReschedule, toLocalInput, type Activity, type QuickChoice } from "./followupsLogic";

export type RowAction = "done" | "reschedule" | "reassign";

const LABEL = { display: "block", fontSize: 11, color: "var(--ink-3)", margin: "12px 0 4px" } as const;

/** One dialog for the three row actions; `ids.length > 1` goes through the bulk
 *  endpoint (which has no outcome, so "done" is single-row only). */
export function FollowUpActionDialog({ action, ids, initialDueAt, onClose, onDone }: {
  action: RowAction;
  ids: string[];
  initialDueAt?: string | null;
  onClose: () => void;
  onDone: (res?: { affected: number; skipped: number }) => void;
}) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const tz = useWorkspaceTz();
  const team = useTeam();
  const { toast } = useToast();
  const invalidate = useInvalidateActivities();
  const [outcome, setOutcome] = useState("");
  const [due, setDue] = useState(() => toLocalInput((initialDueAt ? new Date(initialDueAt) : quickReschedule(new Date(), "tomorrow9", tz)).toISOString(), tz));
  const [assignee, setAssignee] = useState("");
  const [busy, setBusy] = useState(false);
  const bulk = ids.length > 1;
  const dueDate = fromLocalInput(due, tz);

  const submit = async (dueOverride?: Date) => {
    const when = dueOverride ?? dueDate;
    setBusy(true);
    try {
      let res: { affected: number; skipped: number } | undefined;
      if (bulk) {
        const op = action;
        res = await api.post<{ affected: number; skipped: number }>("/activities/bulk", {
          ids, op,
          ...(op === "reschedule" ? { dueAt: when?.toISOString() } : {}),
          ...(op === "reassign" ? { assigneeId: assignee } : {}),
        });
      } else if (action === "done") {
        await api.post(`/activities/${ids[0]}/complete`, { outcome: outcome.trim() || undefined });
      } else if (action === "reschedule") {
        await api.patch(`/activities/${ids[0]}`, { dueAt: when?.toISOString() });
      } else {
        await api.patch(`/activities/${ids[0]}`, { assigneeId: assignee || null });
      }
      invalidate();
      onDone(res);
      onClose();
    } catch (e) {
      toast(activityError(tx, e), "error");
      setBusy(false);
    }
  };

  const quick = (c: QuickChoice, label: string) => (
    <button type="button" className="btn sm" disabled={busy} onClick={() => void submit(quickReschedule(new Date(), c, tz))}>{label}</button>
  );

  return (
    <Modal onClose={onClose} width={400} label={action}>
      {action === "done" && (
        <>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{tx("Mark as done", "تحديد كمنجز")}</div>
          <label style={LABEL}>{tx("Outcome (optional)", "النتيجة (اختياري)")}</label>
          <input className="input" dir="auto" style={{ width: "100%" }} autoFocus value={outcome} onChange={(e) => setOutcome(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
            placeholder={tx("What happened?", "ماذا حدث؟")} />
        </>
      )}
      {action === "reschedule" && (
        <>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{tx("Reschedule", "إعادة الجدولة")}</div>
          <div style={{ display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap" }}>
            {quick("plus1h", tx("+1 hour", "بعد ساعة"))}
            {quick("tomorrow9", tx("Tomorrow 9:00", "غدًا 9:00"))}
            {quick("nextWeek", tx("Next week", "الأسبوع القادم"))}
          </div>
          <label style={LABEL}>{tx("Custom time", "وقت مخصص")} · <span className="mono" dir="ltr">{tz}</span></label>
          <input className="input" type="datetime-local" dir="ltr" style={{ width: "100%" }} value={due} onChange={(e) => setDue(e.target.value)} />
        </>
      )}
      {action === "reassign" && (
        <>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{tx("Reassign", "إعادة الإسناد")}</div>
          <label style={LABEL}>{tx("Assignee", "المسؤول")}</label>
          <select className="input" style={{ width: "100%" }} value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">{bulk ? tx("Choose…", "اختر…") : tx("Unassigned", "غير مسند")}</option>
            {team.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </>
      )}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 18 }}>
        <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>{tx("Cancel", "إلغاء")}</button>
        <button
          type="button" className="btn primary"
          disabled={busy || (action === "reschedule" && !dueDate) || (action === "reassign" && bulk && !assignee)}
          onClick={() => void submit()}
        >
          {action === "done" ? tx("Done", "تم") : action === "reschedule" ? tx("Reschedule", "إعادة الجدولة") : tx("Reassign", "إعادة الإسناد")}
        </button>
      </div>
    </Modal>
  );
}

export function bulkResultText(tx: Tx, r: { affected: number; skipped: number }): string {
  return r.skipped > 0
    ? tx(`${r.affected} updated, ${r.skipped} skipped`, `تم تحديث ${r.affected}، وتم تخطي ${r.skipped}`)
    : tx(`${r.affected} updated`, `تم تحديث ${r.affected}`);
}

export function FollowUpRow({ a, selected, onToggle, assigneeName, onChanged }: {
  a: Activity;
  selected: boolean;
  onToggle: () => void;
  assigneeName: string | null;
  onChanged: () => void;
}) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const tz = useWorkspaceTz();
  const { can } = usePermissions();
  const [action, setAction] = useState<RowAction | null>(null);
  const canUpdate = a.ticketId ? can("tickets.update") : can("contacts.update");
  const overdue = !!a.dueAt && new Date(a.dueAt) < new Date();
  const link = { all: "unset", cursor: "pointer", color: "var(--accent)" } as const;

  return (
    <div className="fu-row" style={{ borderBottom: "1px solid var(--line-soft)" }}>
      <label className="fu-row-check">
        <input type="checkbox" checked={selected} onChange={onToggle} aria-label={tx("Select", "تحديد")} />
      </label>
      <span aria-hidden style={{ width: 20, textAlign: "center" }}>{kindGlyph[a.kind]}</span>
      <div className="fu-row-main">
        <div dir="auto" style={{ fontSize: 13, fontWeight: 500, overflowWrap: "anywhere" }}>{a.title}</div>
        <div style={{ fontSize: 11, color: "var(--ink-3)", display: "flex", gap: 8, flexWrap: "wrap", marginTop: 2 }}>
          <span>{kindLabel(tx, a.kind)}</span>
          {a.contact && (
            <button type="button" dir="auto" style={link} onClick={() => openRecord("contact", a.contact!.id)}>{a.contact.name}</button>
          )}
          {a.ticket && (
            <button type="button" dir="auto" style={link} onClick={() => openRecord("ticket", a.ticket!.id)}>
              #{String(a.ticket.number).padStart(3, "0")} {a.ticket.title}
            </button>
          )}
          {assigneeName && <span dir="auto">{assigneeName}</span>}
        </div>
      </div>
      <div className="mono fu-row-due" style={{ fontSize: 12, color: overdue ? "var(--bad)" : "var(--ink-2)" }}>
        {a.dueAt ? formatDue(a.dueAt, new Date(), tz, t.lang) : "—"}
      </div>
      <div className="fu-row-actions">
        <button type="button" className="btn sm" disabled={!canUpdate} onClick={() => setAction("done")}>{tx("Done", "تم")}</button>
        <button type="button" className="btn sm" disabled={!canUpdate} onClick={() => setAction("reschedule")}>{tx("Reschedule", "إعادة الجدولة")}</button>
        <button type="button" className="btn sm ghost" disabled={!canUpdate} onClick={() => setAction("reassign")}>{tx("Reassign", "إعادة الإسناد")}</button>
        <button
          type="button" className="btn sm ghost"
          onClick={() => (a.ticketId ? openRecord("ticket", a.ticketId) : a.contactId && openRecord("contact", a.contactId))}
        >
          {tx("Open", "فتح")}
        </button>
      </div>
      {action && (
        <FollowUpActionDialog action={action} ids={[a.id]} initialDueAt={a.dueAt} onClose={() => setAction(null)} onDone={onChanged} />
      )}
    </div>
  );
}
