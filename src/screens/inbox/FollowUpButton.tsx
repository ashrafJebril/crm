import { useState } from "react";
import { ActivityDialog } from "@/components/activities/ActivityDialog";
import { useToast } from "@/components/Toast";
import { IconClock } from "@/icons";

type Tx = (en: string, ar: string) => string;

/**
 * Chat header → schedule a follow-up for this conversation's contact without
 * leaving the Inbox. It lands on the contact (same as the contact drawer), so
 * it shows on the Follow-ups page and the contact's activity list.
 */
export function FollowUpButton({ contactId, tx }: { contactId: string; tx: Tx }) {
  const [open, setOpen] = useState(false);
  const { toast } = useToast();
  return (
    <>
      <button
        type="button"
        className="btn"
        onClick={() => setOpen(true)}
        title={tx("Schedule a follow-up for this contact", "جدولة متابعة لهذا العميل")}
      >
        <IconClock w={13} />
        {tx("Follow-up", "متابعة")}
      </button>
      {open && (
        <ActivityDialog
          contactId={contactId}
          defaultKind="follow_up"
          onClose={() => setOpen(false)}
          onSaved={() => toast(tx("Follow-up scheduled", "تمت جدولة المتابعة"), "success")}
        />
      )}
    </>
  );
}
