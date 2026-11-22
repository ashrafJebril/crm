/**
 * Inbox views (wait time): what the newest message of a live Facebook /
 * Instagram thread says, from the `messages.limit(1){from,created_time}`
 * field expansion of the conversations list request (no extra Graph call).
 *
 * - newest from the customer → lastFrom "them" and lastInboundAt = its time;
 * - newest from the Page / IG account → lastFrom "page" and no lastInboundAt
 *   (the customer's last message is older and not in the payload; the inbox
 *   only shows a wait while the customer spoke last anyway);
 * - nothing usable → lastInboundAt null and no lastFrom.
 */
export function newestMessageInfo(
  msg: { from?: { id?: string }; created_time?: string } | undefined,
  ownId: string,
): { lastInboundAt: string | null; lastFrom?: "them" | "page" } {
  if (!msg?.from?.id) return { lastInboundAt: null };
  if (msg.from.id === ownId) return { lastInboundAt: null, lastFrom: "page" };
  const t = msg.created_time ? Date.parse(msg.created_time) : NaN;
  return { lastInboundAt: Number.isFinite(t) ? new Date(t).toISOString() : null, lastFrom: "them" };
}

/**
 * Did Graph refuse the `messages.limit(1){…}` field expansion? Our Graph
 * helpers turn a Graph 4xx into an HttpException with status 400 and Graph's
 * message; a refused field or a missing permission reads like
 * "(#100) Tried accessing nonexisting field (messages)" or "(#10) … permission".
 * Anything else (an expired token #190, rate limits, 5xx, network) is not
 * this and must not be retried.
 */
export function isExpansionRejected(e: unknown): boolean {
  const status = (e as { getStatus?: () => number })?.getStatus?.();
  if (status !== 400) return false;
  const msg = e instanceof Error ? e.message : String(e);
  if (/#190\b|access token|session has expired/i.test(msg)) return false;
  return /\bfield\b|nonexisting|permission|#10\b|#100\b|#200\b|#230\b/i.test(msg);
}

/**
 * The conversations list with the newest-message expansion, or — once, when
 * Graph refuses the expansion — the plain list exactly as before it existed.
 */
export async function withExpansionFallback<T>(
  withExpansion: () => Promise<T>,
  plain: () => Promise<T>,
  onFallback?: (e: unknown) => void,
): Promise<{ data: T; expanded: boolean }> {
  try {
    return { data: await withExpansion(), expanded: true };
  } catch (e) {
    if (!isExpansionRejected(e)) throw e;
    onFallback?.(e);
    return { data: await plain(), expanded: false };
  }
}

/** A Graph time ("2026-11-22T09:30:00+0000") as an ISO timestamp, or null. */
export function isoOrNull(t: string | undefined | null): string | null {
  const ms = t ? Date.parse(t) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
