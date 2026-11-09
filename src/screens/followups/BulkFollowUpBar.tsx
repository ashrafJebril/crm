import { useState } from "react";
import { api } from "@/api/client";
import { useToast } from "@/components/Toast";
import { activityError, useInvalidateActivities } from "@/components/activities/activityApi";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { FollowUpActionDialog, bulkResultText, type RowAction } from "./FollowUpRow";

export function BulkFollowUpBar({ ids, onClear }: { ids: string[]; onClear: () => void }) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const { toast } = useToast();
  const invalidate = useInvalidateActivities();
  const [dialog, setDialog] = useState<Exclude<RowAction, "done"> | null>(null);
  const [busy, setBusy] = useState(false);

  const finish = (r?: { affected: number; skipped: number }) => {
    if (r) toast(bulkResultText(tx, r), r.skipped > 0 ? "info" : "success");
    onClear();
  };

  const markDone = async () => {
    setBusy(true);
    try {
      finish(await api.post<{ affected: number; skipped: number }>("/activities/bulk", { ids, op: "done" }));
      invalidate();
    } catch (e) {
      toast(activityError(tx, e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="toolbar"
      style={{ position: "sticky", insetBlockEnd: 12, display: "flex", gap: 8, alignItems: "center", padding: "8px 12px", background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 10, boxShadow: "0 4px 16px rgba(0,0,0,0.25)", flexWrap: "wrap" }}
    >
      <span style={{ fontSize: 12 }}>{tx(`${ids.length} selected`, `تم تحديد ${ids.length}`)}</span>
      <button type="button" className="btn sm" disabled={busy} onClick={() => void markDone()}>{tx("Mark done", "تحديد كمنجز")}</button>
      <button type="button" className="btn sm" onClick={() => setDialog("reschedule")}>{tx("Reschedule", "إعادة الجدولة")}</button>
      <button type="button" className="btn sm" onClick={() => setDialog("reassign")}>{tx("Reassign", "إعادة الإسناد")}</button>
      <button type="button" className="btn sm ghost" style={{ marginInlineStart: "auto" }} onClick={onClear}>{tx("Clear", "مسح")}</button>
      {dialog && <FollowUpActionDialog action={dialog} ids={ids} onClose={() => setDialog(null)} onDone={finish} />}
    </div>
  );
}
