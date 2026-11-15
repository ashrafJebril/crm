/**
 * SP-09: PATCH /tickets/:id and the realtime ticket.* payloads carry the raw
 * row, without the read-time fields (`channel`, `attachmentCount`) and, for
 * the detail cache, without `pipeline` / `activities`. Merging keeps what the
 * new row does not carry instead of blanking it until the next refetch.
 */
export function mergeTicket<T extends { id: string }>(prev: T | undefined, next: T): T {
  if (!prev || prev.id !== next.id) return next;
  const out = { ...prev } as Record<string, unknown>;
  for (const [k, v] of Object.entries(next)) if (v !== undefined) out[k] = v;
  return out as T;
}
