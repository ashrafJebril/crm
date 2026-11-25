import { useEffect, useState } from "react";
import { api } from "@/api/client";
import type { Tx } from "@/lib/tx";
import type { HandoverRefusal, OpenWork } from "@/lib/types";
import { bookingsNote, needsHandover, openWorkSummary, refusalText } from "./handoverModel";
import { memberErrorText } from "./memberErrors";

export interface HandoverCandidate {
  id: string;
  name: string;
}

interface Props {
  workspaceId: string;
  member: HandoverCandidate;
  mode: "handover" | "remove";
  /** Other members who may receive the work. */
  candidates: HandoverCandidate[];
  tx: Tx;
  dir: "rtl" | "ltr";
  onClose: () => void;
  onDone: (moved: OpenWork | null) => void;
}

/**
 * SP-26 handover (Review Focus 2): removing a member never orphans work. The
 * dialog shows the member's open work and, as the recipient changes, the
 * server's verdict (`open-work?handoverTo=`): a recipient without the needed
 * permission is refused, never silently skipped. Bookings are shown but not
 * moved; they link to the bookings board.
 */
export function MemberHandoverDialog({ workspaceId, member, mode, candidates, tx, dir, onClose, onDone }: Props) {
  const [to, setTo] = useState("");
  const [work, setWork] = useState<(OpenWork & { refusal?: HandoverRefusal }) | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = `/workspaces/${workspaceId}/members/${member.id}`;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get<OpenWork & { refusal?: HandoverRefusal }>(`${base}/open-work${to ? `?handoverTo=${encodeURIComponent(to)}` : ""}`)
      .then((w) => !cancelled && setWork(w))
      .catch((e) => !cancelled && setError(memberErrorText(e, tx)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, to]);

  const need = work ? needsHandover(work) : false;
  const refused = work?.refusal ?? null;
  const canSubmit = !!work && !busy && !loading && !refused && (mode === "remove" ? !need || !!to : need && !!to);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === "remove") {
        const res = await api.delete<{ ok: true; moved: OpenWork }>(base, to && need ? { handoverTo: to } : {});
        onDone(res?.moved ?? null);
      } else {
        const res = await api.post<{ moved: OpenWork }>(`${base}/handover`, { handoverTo: to });
        onDone(res.moved);
      }
    } catch (e) {
      setError(memberErrorText(e, tx));
    } finally {
      setBusy(false);
    }
  };

  const lines = work ? openWorkSummary(work, tx) : [];
  const bookings = work ? bookingsNote(work, tx) : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      dir={dir}
      style={{ position: "fixed", inset: 0, background: "oklch(0 0 0 / 0.5)", display: "grid", placeItems: "center", zIndex: 100 }}
      onClick={onClose}
    >
      <div className="card dialog" style={{ width: 480, maxWidth: "calc(100vw - 32px)", padding: 20, display: "grid", gap: 12, alignContent: "start" }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: 0, fontSize: 16 }}>
          {mode === "remove"
            ? tx(`Remove ${member.name}`, `إزالة ${member.name}`)
            : tx(`Hand over ${member.name}'s work`, `تسليم عمل ${member.name}`)}
        </h3>
        <div style={{ fontSize: 13, color: "var(--ink-2)" }}>{tx("Open work", "عمل مفتوح")}</div>
        {loading && !work ? (
          <div className="muted pulse" style={{ fontSize: 12 }}>{tx("loading…", "جارٍ التحميل…")}</div>
        ) : work && lines.length === 0 ? (
          <div className="muted" style={{ fontSize: 13 }}>{tx("No open work. Nothing needs to move.", "لا يوجد عمل مفتوح. لا شيء يحتاج إلى النقل.")}</div>
        ) : (
          <ul style={{ margin: 0, paddingInlineStart: 18, fontSize: 13, display: "grid", gap: 2 }}>
            {lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        )}
        {bookings && (
          <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
            {bookings} <a href="#/calendar">{tx("Open the bookings board", "افتح لوحة الحجوزات")}</a>
          </div>
        )}
        {(need || mode === "handover") && (
          <label style={{ display: "grid", gap: 6, fontSize: 13 }}>
            {tx("Hand the work over to", "سلّم العمل إلى")}
            <select value={to} onChange={(e) => setTo(e.target.value)} style={{ padding: "8px 10px", background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: "var(--r)", color: "var(--ink)" }}>
              <option value="">{tx("Choose a member…", "اختر عضوًا…")}</option>
              {candidates
                .filter((c) => c.id !== member.id)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </label>
        )}
        {refused && <div style={{ fontSize: 13, color: "var(--bad)" }}>{refusalText(refused, tx)}</div>}
        {error && <div style={{ fontSize: 13, color: "var(--bad)" }}>{error}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="btn ghost" onClick={onClose}>
            {tx("Cancel", "إلغاء")}
          </button>
          <button type="button" className={mode === "remove" ? "btn danger" : "btn primary"} disabled={!canSubmit} onClick={() => void submit()}>
            {busy
              ? tx("Working…", "جارٍ التنفيذ…")
              : mode === "remove"
                ? need
                  ? tx("Hand over and remove", "سلّم العمل وأزل العضو")
                  : tx("Remove member", "إزالة العضو")
                : tx("Hand over work", "تسليم العمل")}
          </button>
        </div>
      </div>
    </div>
  );
}
