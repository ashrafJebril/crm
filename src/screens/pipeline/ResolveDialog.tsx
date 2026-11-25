import { useState } from "react";
import { Modal } from "@/components/Modal";
import { useToast } from "@/components/Toast";
import { makeTx } from "@/lib/tx";
import type { Lang } from "@/lib/types";
import { useResolveTicket } from "./hooks/useTicketSupport";
import { ticketErrorText } from "./ticketErrors";

/** Backend limit for the resolution note (ResolveTicketDto). */
export const RESOLVE_NOTE_MAX = 2000;

/**
 * SP-09 "Resolve": moves the ticket to its pipeline's resolved (won terminal)
 * stage with an optional note, which becomes the move's activity note. It
 * never messages the customer.
 */
export function ResolveDialog({ ticketId, lang, onClose }: { ticketId: string; lang: Lang; onClose: () => void }) {
  const tx = makeTx(lang);
  const { toast } = useToast();
  const resolve = useResolveTicket(ticketId);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const len = note.length;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (len > RESOLVE_NOTE_MAX) return;
    setError(null);
    resolve.mutate(note, {
      onSuccess: () => {
        toast(tx("Ticket resolved", "تم حل التذكرة"), "success");
        onClose();
      },
      onError: (err) => setError(ticketErrorText(err, tx, tx("Couldn't resolve the ticket.", "تعذّر حل التذكرة."))),
    });
  };

  return (
    <Modal onClose={onClose} width={440} label={tx("Resolve ticket", "حل التذكرة")} zIndex={120}>
      <form dir={lang === "ar" ? "rtl" : "ltr"} onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <h3 style={{ margin: 0, fontSize: 15, color: "var(--ink)" }}>{tx("Resolve ticket", "حل التذكرة")}</h3>
        <p style={{ margin: 0, fontSize: 12, color: "var(--ink-2)", lineHeight: 1.5 }}>
          {tx(
            "The ticket moves to the pipeline's resolved stage. The customer is not messaged.",
            "تنتقل التذكرة إلى مرحلة الحل في المسار. لن تُرسل أي رسالة إلى العميل.",
          )}
        </p>
        <label htmlFor="resolve-note" style={{ fontSize: 11, color: "var(--ink-3)" }}>
          {tx("Resolution note (optional)", "ملاحظة الحل (اختيارية)")}
        </label>
        <textarea
          id="resolve-note"
          dir="auto"
          rows={4}
          value={note}
          maxLength={RESOLVE_NOTE_MAX}
          onChange={(e) => setNote(e.target.value)}
          placeholder={tx("What was done for the customer?", "ما الذي تم للعميل؟")}
          style={{
            width: "100%",
            background: "var(--bg-2)",
            border: "1px solid var(--line)",
            borderRadius: 8,
            paddingInline: 12,
            paddingBlock: 8,
            color: "var(--ink)",
            fontSize: 13,
            resize: "vertical",
            fontFamily: "inherit",
          }}
        />
        <div style={{ fontSize: 10.5, color: len > RESOLVE_NOTE_MAX * 0.9 ? "var(--warn, #f59e0b)" : "var(--ink-3)", textAlign: "end" }}>
          <bdi>
            {len} / {RESOLVE_NOTE_MAX}
          </bdi>
        </div>
        {error ? (
          <div role="alert" style={{ fontSize: 12, color: "var(--bad, #ef4444)" }}>
            {error}
          </div>
        ) : null}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            onClick={onClose}
            style={{ paddingInline: 14, paddingBlock: 8, background: "transparent", border: "1px solid var(--line)", borderRadius: 8, color: "var(--ink-2)", cursor: "pointer" }}
          >
            {tx("Cancel", "إلغاء")}
          </button>
          <button
            type="submit"
            disabled={resolve.isPending}
            style={{ paddingInline: 14, paddingBlock: 8, background: "var(--ok, #10b981)", border: 0, borderRadius: 8, color: "white", fontWeight: 600, cursor: "pointer" }}
          >
            {resolve.isPending ? tx("Resolving…", "جارٍ الحل…") : tx("Resolve", "حل")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
