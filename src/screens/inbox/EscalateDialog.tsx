import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { makeTx } from "@/lib/tx";
import { useTweaks } from "@/tweaks/context";

export const ESCALATE_REASON_MAX = 500;

export function EscalateDialog({
  open,
  onClose,
  onConfirm,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
  busy?: boolean;
}) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (open) setReason("");
  }, [open]);
  if (!open) return null;
  const trimmed = reason.trim();
  const canSubmit = trimmed.length > 0 && !busy;
  return (
    <Modal onClose={onClose} width={460} label={tx("Escalate conversation", "تصعيد المحادثة")}>
      <h3 style={{ margin: "0 0 6px" }}>{tx("Escalate conversation", "تصعيد المحادثة")}</h3>
      <p style={{ margin: "0 0 12px", color: "var(--ink-3)", fontSize: 13 }}>
        {tx("Tell your team why this needs attention.", "أخبر فريقك لماذا تحتاج هذه المحادثة إلى اهتمام.")}
      </p>
      <textarea
        autoFocus
        value={reason}
        maxLength={ESCALATE_REASON_MAX}
        onChange={(e) => setReason(e.target.value)}
        rows={4}
        aria-label={tx("Reason", "السبب")}
        placeholder={tx("Reason (required)", "السبب (مطلوب)")}
        style={{ width: "100%", resize: "vertical", boxSizing: "border-box" }}
      />
      <div style={{ fontSize: 11.5, color: "var(--ink-3)", textAlign: "end", marginTop: 4 }}>
        {reason.length}/{ESCALATE_REASON_MAX}
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
        <button className="btn" onClick={onClose} disabled={busy}>
          {tx("Cancel", "إلغاء")}
        </button>
        <button className="btn primary" disabled={!canSubmit} onClick={() => onConfirm(trimmed)}>
          {tx("Escalate", "تصعيد")}
        </button>
      </div>
    </Modal>
  );
}
