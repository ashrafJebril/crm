import type { Tx } from "@/lib/tx";
import { inputStyle } from "../form";
import {
  MAX_LOST_REASONS,
  addLostReason,
  moveLostReason,
  removeLostReason,
  updateLostReason,
  type DraftError,
  type PipelineDraft,
} from "./draft";

const small: React.CSSProperties = { ...inputStyle, height: 32, fontSize: 12.5, padding: "0 8px" };
const iconBtn: React.CSSProperties = {
  background: "var(--bg-2)",
  border: "1px solid var(--line)",
  borderRadius: 6,
  color: "var(--ink-2)",
  width: 28,
  height: 28,
  cursor: "pointer",
  fontSize: 13,
};

export function LostReasonsEditor({
  draft,
  onChange,
  readOnly,
  errors,
  tx,
}: {
  draft: PipelineDraft;
  onChange: (d: PipelineDraft) => void;
  readOnly: boolean;
  errors: DraftError[];
  tx: Tx;
}) {
  const errored = new Set(errors.filter((e) => e.reason).map((e) => e.reason));
  const n = draft.lostReasons.length;
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {draft.lostReasons.map((r, i) => (
        <div
          key={r.clientId}
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap",
            padding: 8,
            borderRadius: 8,
            border: `1px solid ${errored.has(r.clientId) ? "var(--bad, #ef4444)" : "var(--line-soft)"}`,
          }}
        >
          <input
            dir="auto"
            style={{ ...small, flex: "1 1 140px", width: "auto" }}
            value={r.label}
            disabled={readOnly}
            maxLength={60}
            placeholder={tx("Reason (English)", "السبب (إنجليزي)")}
            aria-label={tx("Lost reason in English", "سبب الخسارة بالإنجليزية")}
            onChange={(e) => onChange(updateLostReason(draft, r.clientId, { label: e.target.value }))}
          />
          <input
            dir="rtl"
            style={{ ...small, flex: "1 1 140px", width: "auto" }}
            value={r.labelAr}
            disabled={readOnly}
            maxLength={60}
            placeholder={tx("Reason (Arabic)", "السبب (عربي)")}
            aria-label={tx("Lost reason in Arabic", "سبب الخسارة بالعربية")}
            onChange={(e) => onChange(updateLostReason(draft, r.clientId, { labelAr: e.target.value }))}
          />
          {!readOnly ? (
            <div style={{ display: "flex", gap: 4 }}>
              <button
                type="button"
                style={iconBtn}
                disabled={i === 0}
                aria-label={tx("Move up", "تحريك لأعلى")}
                onClick={() => onChange(moveLostReason(draft, r.clientId, -1))}
              >
                ↑
              </button>
              <button
                type="button"
                style={iconBtn}
                disabled={i === n - 1}
                aria-label={tx("Move down", "تحريك لأسفل")}
                onClick={() => onChange(moveLostReason(draft, r.clientId, 1))}
              >
                ↓
              </button>
              <button
                type="button"
                style={{ ...iconBtn, color: "var(--bad, #ef4444)" }}
                aria-label={tx("Remove reason", "حذف السبب")}
                title={
                  r.id
                    ? tx("Reasons already used by tickets are archived, not deleted", "الأسباب المستخدمة في تذاكر تُؤرشف ولا تُحذف")
                    : undefined
                }
                onClick={() => onChange(removeLostReason(draft, r.clientId))}
              >
                ✕
              </button>
            </div>
          ) : null}
        </div>
      ))}
      {!readOnly ? (
        <div>
          <button
            type="button"
            className="btn"
            disabled={n >= MAX_LOST_REASONS}
            onClick={() => onChange(addLostReason(draft))}
          >
            + {tx("Add reason", "إضافة سبب")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
