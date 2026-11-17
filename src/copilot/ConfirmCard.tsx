import { useState } from "react";
import type { Tx } from "@/lib/tx";
import type { PendingCard } from "@/lib/types";
import { openRecord } from "@/lib/openRecord";
import { ApiError } from "@/api/client";
import { approveAction, declineAction } from "./copilotApi";
import { copilotErrorText } from "./copilotErrors";
import { FEEDBACK_MAX } from "./copilotConstants";
import { cardStatusText, changeLabel, changeValue, receiptTarget, toolTitle } from "./cardText";

/**
 * SP-18 confirmation card: what will happen (a changes table), Approve, and
 * Decline with an optional note. The server re-checks everything at the click
 * (permission, record, expiry, one decision); a refusal shows its copy and
 * the card is re-read. A done card is a receipt with a link to the record.
 */
export function ConfirmCard({ card, tx, lang, onChanged, onStale }: { card: PendingCard; tx: Tx; lang: "en" | "ar"; onChanged: (c: PendingCard) => void; onStale: () => void }) {
  const [busy, setBusy] = useState<"approve" | "decline" | null>(null);
  const [declining, setDeclining] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const status = cardStatusText(card, tx);
  const open = card.status === "PENDING" && !status;
  const target = receiptTarget(card);

  const act = async (kind: "approve" | "decline") => {
    setBusy(kind);
    setError(null);
    try {
      const { action } = kind === "approve" ? await approveAction(card.id) : await declineAction(card.id, note.trim() || undefined);
      onChanged(action);
      setDeclining(false);
    } catch (e) {
      setError(copilotErrorText(e, tx));
      // 403 permission_revoked, 409 action_closed / card_outdated, 410 expired: the card changed server-side.
      if (e instanceof ApiError && [403, 404, 409, 410].includes(e.status)) onStale();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="copilot-card" data-status={card.status.toLowerCase()}>
      <div className="copilot-card-title">{card.status === "EXECUTED" ? `${tx("Done", "تم")}: ${toolTitle(card.tool, tx)}` : toolTitle(card.tool, tx)}</div>
      <table className="copilot-card-changes">
        <tbody>
          {card.changes.map((ch, i) => (
            <tr key={i}>
              <th scope="row">{changeLabel(ch.label, tx)}</th>
              <td dir="auto">
                {ch.before !== undefined && ch.before !== "" && (
                  <>
                    <bdi className="copilot-before">{changeValue(ch.label, ch.before, tx, lang)}</bdi>
                    <span aria-hidden="true"> → </span>
                  </>
                )}
                <bdi>{changeValue(ch.label, ch.after, tx, lang)}</bdi>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {status && <div className="copilot-card-status">{status}</div>}
      {card.feedback && <div className="copilot-card-note" dir="auto">{card.feedback}</div>}
      {target && (
        <div style={{ marginBlockStart: 6 }}>
          {"href" in target ? (
            <a href={target.href}>{tx("Open your knowledge", "افتح المعرفة")}</a>
          ) : (
            <button type="button" className="btn ghost sm" onClick={() => openRecord(target.kind, target.id)}>
              {target.kind === "ticket" ? tx("Open the ticket", "افتح التذكرة") : tx("Open the customer", "افتح العميل")}
            </button>
          )}
        </div>
      )}
      {open && !declining && (
        <div className="copilot-card-actions">
          <button type="button" className="btn primary sm" disabled={!!busy} onClick={() => act("approve")}>
            {busy === "approve" ? tx("Approving…", "جارٍ الموافقة…") : tx("Approve", "موافقة")}
          </button>
          <button type="button" className="btn sm" disabled={!!busy} onClick={() => setDeclining(true)}>
            {tx("Decline", "رفض")}
          </button>
        </div>
      )}
      {open && declining && (
        <div className="copilot-card-decline">
          <textarea
            dir="auto"
            rows={2}
            maxLength={FEEDBACK_MAX}
            value={note}
            placeholder={tx("Add a note (optional)", "أضف ملاحظة (اختياري)")}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="copilot-card-actions">
            <button type="button" className="btn sm" disabled={!!busy} onClick={() => act("decline")}>
              {busy === "decline" ? tx("Declining…", "جارٍ الرفض…") : tx("Decline", "رفض")}
            </button>
            <button type="button" className="btn ghost sm" disabled={!!busy} onClick={() => setDeclining(false)}>
              {tx("Back", "رجوع")}
            </button>
          </div>
        </div>
      )}
      {error && (
        <div className="copilot-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
