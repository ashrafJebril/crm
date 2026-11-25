import { useState } from "react";
import { api, ApiError } from "@/api/client";
import { Modal } from "@/components/Modal";
import type { Tx } from "@/lib/tx";

interface Linked {
  tickets: number;
  appointments: number;
}

function linkedFrom(e: ApiError): Linked | null {
  const b = e.body;
  if (typeof b !== "object" || b === null) return null;
  const l = (b as { linked?: unknown }).linked;
  if (typeof l !== "object" || l === null) return null;
  const { tickets, appointments } = l as Record<string, unknown>;
  return { tickets: Number(tickets) || 0, appointments: Number(appointments) || 0 };
}

/** Confirm delete; on 409 shows the linked-record counts and offers "Delete anyway" (?force=1). */
export function DeleteContactDialog({
  tx,
  contactId,
  contactName,
  onClose,
  onDeleted,
}: {
  tx: Tx;
  contactId: string;
  contactName: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [linked, setLinked] = useState<Linked | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (force: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.delete(`/contacts/${contactId}${force ? "?force=1" : ""}`);
      onDeleted();
    } catch (e) {
      const l = e instanceof ApiError && e.status === 409 ? linkedFrom(e) : null;
      if (l) setLinked(l);
      else setError(e instanceof Error ? e.message : tx("Could not delete", "تعذّر الحذف"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={busy ? () => undefined : onClose} label={tx("Delete contact", "حذف جهة الاتصال")} zIndex={110}>
      <h2 style={{ margin: 0, fontSize: 15 }}>{tx("Delete contact", "حذف جهة الاتصال")}</h2>
      <p style={{ fontSize: 13, color: "var(--ink-2)" }}>
        {tx("Delete ", "هل تريد حذف ")}
        <strong dir="auto">{contactName}</strong>
        {tx("? This cannot be undone.", "؟ لا يمكن التراجع عن ذلك.")}
      </p>
      {linked && (
        <div
          role="alert"
          style={{ fontSize: 12.5, padding: 10, borderRadius: 8, border: "1px solid var(--warn)", color: "var(--ink)" }}
        >
          {tx(
            `This contact has linked records: ${linked.tickets} ticket(s) and ${linked.appointments} booking(s). Deleting anyway will remove them too.`,
            `لدى جهة الاتصال سجلات مرتبطة: ${linked.tickets.toLocaleString("ar")} تذكرة و${linked.appointments.toLocaleString("ar")} حجز. الحذف سيزيلها أيضًا.`,
          )}
        </div>
      )}
      {error && (
        <div role="alert" style={{ fontSize: 11.5, color: "var(--bad)", marginTop: 8 }} dir="auto">
          {error}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
        <button type="button" className="btn" disabled={busy} onClick={onClose}>
          {tx("Cancel", "إلغاء")}
        </button>
        {linked ? (
          <button type="button" className="btn danger" disabled={busy} onClick={() => void run(true)}>
            {busy ? tx("Deleting…", "جارٍ الحذف…") : tx("Delete anyway", "احذف على أي حال")}
          </button>
        ) : (
          <button type="button" className="btn danger" disabled={busy} onClick={() => void run(false)}>
            {busy ? tx("Deleting…", "جارٍ الحذف…") : tx("Delete", "حذف")}
          </button>
        )}
      </div>
    </Modal>
  );
}
