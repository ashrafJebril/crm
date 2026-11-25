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

/**
 * Final review M1: a detail-cache write from a raw row (realtime event, PATCH,
 * resolve). With nothing cached it stays a no-op (React Query ignores an
 * updater that returns undefined), so a raw row can never pose as a fresh
 * detail without `pipeline` / `activities` / `channel` for the staleTime.
 */
export function mergeCachedTicket<T extends { id: string }>(prev: T | undefined, next: T): T | undefined {
  return prev ? mergeTicket(prev, next) : prev;
}
