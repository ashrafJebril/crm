/** Where a notification's record lives. Until the SP-06 record sheet exists we
 *  route by kind; screens that can open a specific record read `?open=<id>`. */
export function recordHref(kind: string | null | undefined, id: string | null | undefined): string | null {
  if (!kind || !id) return null;
  const open = encodeURIComponent(id);
  switch (kind) {
    case "conversation":
      return `#/inbox?open=${open}`;
    case "ticket":
      return `#/pipeline?open=${open}`;
    case "contact":
      return `#/contacts?open=${open}`;
    case "booking":
      return "#/calendar";
    case "campaign":
      return "#/campaigns";
    default:
      return null;
  }
}
