import { Badge, type BadgeKind } from "@/components/Badge";
import { makeTx } from "@/lib/tx";
import type { Conversation, Lang } from "@/lib/types";

/**
 * What Kewy AI concluded once this thread went quiet (conversation
 * resolution). Nothing until it has been judged; cleared again when the
 * customer writes. A complaint or escalation also opened a Support ticket.
 */
export function ResolutionBadge({ conv, lang }: { conv: Conversation; lang: Lang }) {
  const tx = makeTx(lang);
  const issue = conv.resolutionIssue;
  let kind: BadgeKind | null = null;
  let label = "";
  if (issue === "escalation") {
    kind = "bad";
    label = tx("Escalation", "تصعيد");
  } else if (issue === "complaint") {
    kind = "warn";
    label = tx("Complaint", "شكوى");
  } else if (conv.resolutionStatus === "resolved") {
    kind = "ok";
    label = tx("Resolved", "تم الحل");
  } else if (conv.resolutionStatus === "closed") {
    kind = "";
    label = tx("Ended", "انتهت");
  }
  if (kind === null) return null;

  const title = [
    conv.resolutionSummary,
    issue === "complaint" || issue === "escalation"
      ? tx("A Support ticket was opened.", "تم فتح تذكرة دعم.")
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <span title={title || undefined}>
      <Badge kind={kind} dot>
        {label}
      </Badge>
    </span>
  );
}
