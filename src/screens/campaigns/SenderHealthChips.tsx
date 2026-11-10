import type { Tx } from "@/lib/tx";
import { signalView, tierView } from "@/screens/channels/health/healthModel";
import { ToneChip } from "@/screens/channels/health/healthUi";

/**
 * SP-14 (R16): a sender's daily limit and quality from its health snapshot.
 * Display only; it never changes which numbers can be ticked. Unknown is
 * muted, never green.
 */
export function SenderHealthChips({ tx, tier, quality }: { tx: Tx; tier?: string; quality?: string }) {
  // Older backends send neither field: show nothing rather than a fake value.
  if (tier === undefined && quality === undefined) return null;
  const t = tierView(tier ?? "unknown", tx);
  const tUnknown = !tier || tier === "unknown";
  const q = signalView("quality", { value: quality ?? "unknown", checkedAt: null, error: null }, tx);
  return (
    <>
      <ToneChip tone="neutral" unknown={tUnknown} title={t.note}>
        {tx("Limit", "الحد")}: <bdi dir="ltr">{t.label}</bdi>
      </ToneChip>
      <ToneChip tone={q.tone} unknown={q.unknown} title={q.unknown ? tx("Not known yet for this number", "غير معروف بعد لهذا الرقم") : undefined}>
        {tx("Quality", "الجودة")}: {q.label}
      </ToneChip>
    </>
  );
}
