import { useState } from "react";
import { Modal } from "@/components/Modal";
import type { Ticket, Lang } from "@/lib/types";

const REASONS: Array<{ id: string; en: string; ar: string }> = [
  { id: "price", en: "Price too high", ar: "السعر مرتفع" },
  { id: "found_cheaper", en: "Found cheaper alternative", ar: "وجد بديلاً أرخص" },
  { id: "no_response", en: "Customer went silent", ar: "توقف العميل" },
  { id: "wrong_fit", en: "Wrong product fit", ar: "غير مناسب" },
  { id: "other", en: "Other", ar: "أخرى" },
];

interface Props {
  ticket: Ticket;
  lang: Lang;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}

export function LostReasonModal({ ticket, lang, onCancel, onConfirm }: Props) {
  const [selected, setSelected] = useState<string>(REASONS[0].id);

  return (
    <Modal onClose={onCancel} width={420} label="Lost reason">
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <h3 style={{ margin: 0, fontSize: 15, color: "var(--ink)" }}>
          {lang === "ar" ? `سبب الخسارة لـ #${ticket.number}` : `Lost reason for #${ticket.number}`}
        </h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {REASONS.map((r) => (
            <label
              key={r.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: 8,
                border: "1px solid var(--line)",
                borderRadius: "var(--r)",
                cursor: "pointer",
                background: selected === r.id ? "var(--bg-2)" : "transparent",
              }}
            >
              <input
                type="radio"
                name="lost-reason"
                checked={selected === r.id}
                onChange={() => setSelected(r.id)}
              />
              <span style={{ fontSize: 13, color: "var(--ink)" }}>
                {lang === "ar" ? r.ar : r.en}
              </span>
            </label>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              padding: "8px 14px",
              background: "transparent",
              border: "1px solid var(--line)",
              borderRadius: "var(--r)",
              color: "var(--ink-2)",
              cursor: "pointer",
            }}
          >
            {lang === "ar" ? "إلغاء" : "Cancel"}
          </button>
          <button
            type="button"
            onClick={() => onConfirm(selected)}
            style={{
              padding: "8px 14px",
              background: "var(--accent)",
              border: 0,
              borderRadius: "var(--r)",
              color: "white",
              cursor: "pointer",
            }}
          >
            {lang === "ar" ? "تأكيد" : "Confirm"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
