import { TicketDetailContent } from "@/screens/pipeline/TicketDetailDrawer";
import { openRecord } from "@/lib/openRecord";
import type { RecordBodyProps } from "../RecordSheet";

/** The ticket drawer's content inside the sheet. Pipeline and stage come from the
 *  ticket detail fetch inside the content, so nothing is needed from the caller. */
export function TicketBody({ summary, lang, onClose, onDeleted }: RecordBodyProps) {
  return (
    <TicketDetailContent
      ticketId={summary.id}
      lang={lang}
      embedded
      onClose={onClose}
      onDeleted={onDeleted}
      onOpenConversation={(cid) => openRecord("conversation", cid)}
    />
  );
}
