import type { Tx } from "@/lib/tx";
import type { Lang } from "@/lib/types";
import { senderChipsView } from "@/screens/channels/health/healthModel";
import { ToneChip, fmtWhen } from "@/screens/channels/health/healthUi";

/**
 * SP-14 (R16): a sender's daily limit and quality from its health snapshot.
 * Display only; it never changes which numbers can be ticked. Unknown is
 * muted, never green. Final review M1: the values count only with a check
 * time no older than 7 days (shown in the tooltip); otherwise both chips are
 * Unknown with the reason.
 */
export function SenderHealthChips({
  tx,
  tier,
  quality,
  healthCheckedAt,
  now = Date.now(),
}: {
  tx: Tx;
  tier?: string;
  quality?: string;
  healthCheckedAt?: string | null;
  now?: number;
}) {
  // Older backends send neither field: show nothing rather than a fake value.
  const v = senderChipsView({ tier, quality, healthCheckedAt }, now, tx);
  if (!v) return null;
  const lang = tx("en", "ar") as Lang;
  const checked = v.checkedAt ? `${tx("Checked", "فُحص")}: ${fmtWhen(v.checkedAt, lang, tx)}` : undefined;
  const why = v.reason ?? tx("Not known yet for this number", "غير معروف بعد لهذا الرقم");
  return (
    <>
      <ToneChip tone="neutral" unknown={v.tier.unknown} title={v.tier.unknown ? why : [checked, v.tier.note].filter(Boolean).join("\n")}>
        {tx("Limit", "الحد")}: <bdi dir="ltr">{v.tier.label}</bdi>
      </ToneChip>
      <ToneChip tone={v.quality.tone} unknown={v.quality.unknown} title={v.quality.unknown ? why : checked}>
        {tx("Quality", "الجودة")}: {v.quality.label}
      </ToneChip>
    </>
  );
}
