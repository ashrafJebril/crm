import { IconSparkles } from "@/icons";
import type { Tx } from "@/lib/tx";
import type { AdsPendingActionDto } from "@/api/ads";

interface ActionCardProps {
  proposal: AdsPendingActionDto;
  tx: Tx;
  /** This card's own request is in flight. */
  busy: boolean;
  /** Some other card's request is in flight — block the whole set. */
  disabled: boolean;
  /** Viewer's workspace role can approve (owner/admin). Mirrors the server guard. */
  canManage: boolean;
  onApprove: () => void;
  onReject: () => void;
}

/**
 * Gated write proposal — the approval CARD. Salma PROPOSED a change; it runs
 * ONLY through this card's Approve button (→ POST /ads/actions/:id/approve,
 * authenticated as the viewer). Approve is refused while `summaryIsPlaceholder`
 * (no machine-rendered summary yet — the server refuses it too) or once
 * expired. Reject stays available while PENDING. Typing "approve" into the chat
 * NEVER approves anything; only this button reaches the endpoint.
 *
 * Renders at thread end, one card per open proposal.
 */
export function ActionCard({
  proposal,
  tx,
  busy,
  disabled,
  canManage,
  onApprove,
  onReject,
}: ActionCardProps) {
  const isExpired = new Date(proposal.expiresAt).getTime() <= Date.now();
  const actionable = proposal.status === "PENDING" && !isExpired && canManage;
  const canApprove = actionable && !proposal.summaryIsPlaceholder && !busy && !disabled;
  const canReject = actionable && !busy && !disabled;

  const note = isExpired
    ? tx("This proposal has expired — ask for it again", "انتهت صلاحية هذا المقترح — اطلبه من جديد")
    : proposal.summaryIsPlaceholder
      ? tx(
          "This action's summary isn't ready yet — approval opens soon",
          "لسا عم يتجهّز وصف هالإجراء — الموافقة رح تنفتح قريب",
        )
      : !canManage
        ? tx(
            "Only a workspace owner or admin can approve this.",
            "الموافقة على هذا الإجراء متاحة لمالك مساحة العمل أو المشرف فقط.",
          )
        : tx(
            "Awaiting your approval — nothing runs until you approve",
            "بانتظار موافقتك — ما بينفّذ إلا بعد ما توافق",
          );

  return (
    <div className="ads-action" dir="auto">
      <div className="head">
        <span style={{ display: "flex", color: "var(--accent)" }}>
          <IconSparkles w={16} />
        </span>
        <span className="title">{tx("Needs your approval", "إجراء يحتاج موافقتك")}</span>
        <span className="tool mono" dir="ltr">
          {proposal.tool}
        </span>
      </div>

      <div className="summary">{proposal.summary}</div>

      {proposal.spendWarn && (
        <div className="warn">
          {tx("⚠️ High spend — review before approving", "⚠️ مبلغ إنفاق مرتفع — راجع قبل الموافقة")}
        </div>
      )}

      <div className="note">{note}</div>

      <div className="row">
        <button type="button" className="btn sm" onClick={onReject} disabled={!canReject}>
          {busy ? tx("Working…", "جاري…") : tx("Reject", "رفض")}
        </button>
        <button type="button" className="btn primary sm" onClick={onApprove} disabled={!canApprove}>
          {busy ? tx("Working…", "جاري…") : tx("Approve", "موافق")}
        </button>
      </div>
    </div>
  );
}
