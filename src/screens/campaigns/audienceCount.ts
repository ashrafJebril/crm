import type { Tx } from "@/lib/tx";

/**
 * SP-16: an audience count may be `null` (the count timed out on the
 * server). Show it as "—" with a tooltip; never 0 and never a crash.
 */
export function audienceCountLabel(
  n: number | null | undefined,
  tx: Tx,
): { text: string; unknown: boolean; title: string | undefined } {
  if (typeof n !== "number" || !Number.isFinite(n)) {
    return { text: "—", unknown: true, title: tx("Too large to count right now", "العدد كبير جدًا لحسابه الآن") };
  }
  return { text: n.toLocaleString(), unknown: false, title: undefined };
}
