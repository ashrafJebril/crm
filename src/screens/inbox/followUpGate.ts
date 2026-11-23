/**
 * Inbox → Schedule follow-up. A follow-up hangs off a stored contact, so the
 * button needs a DB conversation with a contact (live FB "t_"/IG "ig:"
 * threads have no stored contact) and the contacts.update permission that
 * every other "new activity" entry point requires.
 */
export function followUpContactId(
  conv: { id: string; contactId?: string | null },
  canUpdateContacts: boolean,
): string | null {
  if (!canUpdateContacts) return null;
  if (conv.id.startsWith("t_") || conv.id.startsWith("ig:")) return null;
  const contactId = (conv.contactId ?? "").trim();
  // A live thread may fall back to its own id as the contact id.
  if (!contactId || contactId === conv.id) return null;
  return contactId;
}
