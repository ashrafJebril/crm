/**
 * SP-13: one campaign's Zernio status and counters across its broadcasts
 * (one per partition). Pure.
 *
 * Status, in Zernio's vocabulary (`campaignStatusFor` maps it):
 * - no broadcasts: `draft`;
 * - every broadcast in the same status: that status;
 * - every broadcast scheduled: `scheduled`;
 * - every broadcast finished (completed, failed, cancelled): `completed`
 *   when any completed, else `failed` when any failed, else `cancelled`;
 * - anything else (one still sending, a draft, a mix of scheduled and
 *   finished, an unknown value): `sending`.
 * Counters are summed.
 */
export interface BroadcastStat {
  status: string;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
}

const FINISHED = new Set(["completed", "failed", "cancelled"]);

export function aggregateBroadcastStatus(stats: readonly BroadcastStat[]): BroadcastStat {
  const sum = (k: "sent" | "delivered" | "read" | "failed") => stats.reduce((n, s) => n + (Number(s[k]) || 0), 0);
  const counters = { sent: sum("sent"), delivered: sum("delivered"), read: sum("read"), failed: sum("failed") };
  if (stats.length === 0) return { status: "draft", ...counters };
  const statuses = stats.map((s) => s.status);
  let status: string;
  if (statuses.every((x) => x === statuses[0]) && (statuses[0] === "scheduled" || FINISHED.has(statuses[0]))) {
    status = statuses[0];
  } else if (statuses.every((x) => FINISHED.has(x))) {
    status = statuses.includes("completed") ? "completed" : statuses.includes("failed") ? "failed" : "cancelled";
  } else {
    status = "sending";
  }
  return { status, ...counters };
}
