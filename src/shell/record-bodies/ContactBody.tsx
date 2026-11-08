import { ContactDetailContent } from "@/screens/contacts/ContactDetailDrawer";
import type { RecordBodyProps } from "../RecordSheet";

/** The contact drawer's content inside the sheet; the frame supplies the header. */
export function ContactBody({ summary, onClose, onChanged, onDeleted }: RecordBodyProps) {
  return (
    <ContactDetailContent
      contactId={summary.id}
      embedded
      onClose={onClose}
      onChanged={onChanged}
      onDeleted={onDeleted}
    />
  );
}
