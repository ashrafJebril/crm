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
