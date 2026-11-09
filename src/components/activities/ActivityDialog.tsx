import { useMemo, useState } from "react";
import { api } from "@/api/client";
import { Modal } from "@/components/Modal";
import { useToast } from "@/components/Toast";
import { useAuth } from "@/auth/context";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import {
  fromLocalInput, quickReschedule, toLocalInput, type Activity, type ActivityKind, type QuickChoice,
} from "@/screens/followups/followupsLogic";
import { KINDS, kindLabel, needsDue, useInvalidateActivities, useTeam, useWorkspaceTz, activityError } from "./activityApi";

interface Props {
  /** Edit an existing activity; omit to create. */
  activity?: Pick<Activity, "id" | "kind" | "title" | "notes" | "dueAt" | "doneAt" | "outcome" | "assigneeId">;
  contactId?: string | null;
  ticketId?: string | null;
  defaultKind?: ActivityKind;
  onClose: () => void;
  onSaved?: () => void;
}

const LABEL = { display: "block", fontSize: 11, color: "var(--ink-3)", margin: "12px 0 4px" } as const;
const FIELD = { width: "100%" } as const;

export function ActivityDialog({ activity, contactId, ticketId, defaultKind = "follow_up", onClose, onSaved }: Props) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const { user } = useAuth();
  const tz = useWorkspaceTz();
  const team = useTeam();
  const { toast } = useToast();
  const invalidate = useInvalidateActivities();

  const editing = !!activity;
  const [kind, setKind] = useState<ActivityKind>(activity?.kind ?? defaultKind);
  const [title, setTitle] = useState(activity?.title ?? "");
  const [due, setDue] = useState(() =>
    activity?.dueAt
      ? toLocalInput(activity.dueAt, tz)
      : needsDue(defaultKind)
        ? toLocalInput(quickReschedule(new Date(), "tomorrow9", tz).toISOString(), tz)
        : "",
  );
  const [assigneeId, setAssigneeId] = useState(activity ? (activity.assigneeId ?? "") : (user?.id ?? ""));
  const [assigneeTouched, setAssigneeTouched] = useState(false);
  const [notes, setNotes] = useState(activity?.notes ?? "");
  const [outcome, setOutcome] = useState(activity?.outcome ?? "");
  const [busy, setBusy] = useState(false);
  const done = !!activity?.doneAt;

  const dueDate = useMemo(() => fromLocalInput(due, tz), [due, tz]);
  const dueRequired = needsDue(kind);
  const valid = title.trim().length > 0 && (!dueRequired || !!dueDate);

  const quick = (c: QuickChoice) => setDue(toLocalInput(quickReschedule(new Date(), c, tz).toISOString(), tz));

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      invalidate();
      onSaved?.();
      onClose();
    } catch (e) {
      toast(activityError(tx, e), "error");
      setBusy(false);
    }
  };

  const save = () =>
    run(() => {
      const body = {
        title: title.trim(),
        notes: notes.trim() || undefined,
        dueAt: dueDate ? dueDate.toISOString() : undefined,
        outcome: outcome.trim() || undefined,
      };
      if (activity) return api.patch(`/activities/${activity.id}`, { ...body, ...(assigneeTouched ? { assigneeId: assigneeId || null } : {}) });
      return api.post("/activities", {
        ...body,
        kind,
        assigneeId: assigneeId || undefined,
        contactId: contactId || undefined,
        ticketId: ticketId || undefined,
      });
    });
  const complete = () =>
    run(() => api.post(`/activities/${activity!.id}/complete`, { outcome: outcome.trim() || undefined }));

  return (
    <Modal onClose={onClose} width={480} label={editing ? tx("Edit activity", "تعديل النشاط") : tx("New activity", "نشاط جديد")}>
      <div style={{ fontSize: 15, fontWeight: 600 }}>
        {editing ? tx("Edit activity", "تعديل النشاط") : tx("Log activity / schedule follow-up", "تسجيل نشاط / جدولة متابعة")}
      </div>

      {!editing && (
        <>
          <label style={LABEL}>{tx("Kind", "النوع")}</label>
          <select className="input" style={FIELD} value={kind} onChange={(e) => setKind(e.target.value as ActivityKind)}>
            {KINDS.map((k) => <option key={k} value={k}>{kindLabel(tx, k)}</option>)}
          </select>
        </>
      )}

      <label style={LABEL}>{tx("Title", "العنوان")}</label>
      <input
        className="input" dir="auto" style={FIELD} value={title} autoFocus
        onChange={(e) => setTitle(e.target.value)}
        placeholder={tx("e.g. Call about the quote", "مثال: الاتصال بخصوص عرض السعر")}
      />

      <label style={LABEL}>
        {dueRequired ? tx("Due", "الموعد") : tx("When (optional)", "الوقت (اختياري)")}
        {" · "}
        <span className="mono" dir="ltr">{tz}</span>
      </label>
      <input className="input" type="datetime-local" dir="ltr" style={FIELD} value={due} onChange={(e) => setDue(e.target.value)} />
      <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
        <button type="button" className="btn sm" onClick={() => quick("plus1h")}>{tx("+1 hour", "بعد ساعة")}</button>
        <button type="button" className="btn sm" onClick={() => quick("tomorrow9")}>{tx("Tomorrow 9:00", "غدًا 9:00")}</button>
        <button type="button" className="btn sm" onClick={() => quick("nextWeek")}>{tx("Next week", "الأسبوع القادم")}</button>
      </div>

      <label style={LABEL}>{tx("Assignee", "المسؤول")}</label>
      <select className="input" style={FIELD} value={assigneeId} onChange={(e) => { setAssigneeId(e.target.value); setAssigneeTouched(true); }}>
        <option value="">{tx("Unassigned", "غير مسند")}</option>
        {team.map((m) => (
          <option key={m.id} value={m.id}>{m.id === user?.id ? `${m.name} (${tx("me", "أنا")})` : m.name}</option>
        ))}
      </select>

      <label style={LABEL}>{tx("Notes", "ملاحظات")}</label>
      <textarea className="input" dir="auto" rows={3} style={FIELD} value={notes} onChange={(e) => setNotes(e.target.value)} />

      <label style={LABEL}>{tx("Outcome", "النتيجة")}</label>
      <input
        className="input" dir="auto" style={FIELD} value={outcome} onChange={(e) => setOutcome(e.target.value)}
        placeholder={tx("What happened?", "ماذا حدث؟")}
      />

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 18, flexWrap: "wrap" }}>
        <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>{tx("Cancel", "إلغاء")}</button>
        {editing && !done && (
          <button type="button" className="btn" onClick={complete} disabled={busy}>{tx("Mark done", "تم الإنجاز")}</button>
        )}
        <button type="button" className="btn primary" onClick={save} disabled={busy || !valid}>
          {editing ? tx("Save", "حفظ") : tx("Add", "إضافة")}
        </button>
      </div>
    </Modal>
  );
}
