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

/** SP-16: what a campaign's audience is, for its badge. */
export type AudienceKind = "all" | "smart" | "group" | "deleted" | "unknown";

/**
 * `segmentId` null is everyone. A segment id missing from `GET /segments` is a
 * deleted audience (launch answers `campaigns.audience_missing`); while the
 * list is still loading it is "unknown", never "deleted".
 */
export function audienceKind(
  segmentId: string | null | undefined,
  segments: readonly { id: string; origin: string }[] | null | undefined,
): AudienceKind {
  if (!segmentId) return "all";
  if (!segments) return "unknown";
  const s = segments.find((x) => x.id === segmentId);
  if (!s) return "deleted";
  return s.origin === "crm" ? "smart" : "group";
}

export function audienceKindLabel(kind: AudienceKind, tx: Tx): string | null {
  switch (kind) {
    case "smart": return tx("Smart", "ذكي");
    case "group": return tx("Group", "مجموعة");
    case "deleted": return tx("Deleted audience", "جمهور محذوف");
    default: return null;
  }
}

/**
 * SP-16 final review M1: a draft or scheduled campaign on a smart audience has
 * no real recipient count yet (it is worked out when the campaign starts), so
 * the list shows "—" rather than a stored 0 or a stale number.
 */
export function recipientsLabel(
  c: { status: string; recipients: number },
  kind: AudienceKind,
  tx: Tx,
): { text: string; title: string | undefined } {
  if (kind === "smart" && (c.status === "draft" || c.status === "scheduled")) {
    return { text: "—", title: tx("Worked out when the campaign starts", "يُحدَّد عند بدء الحملة") };
  }
  return { text: c.recipients.toLocaleString("en-US"), title: undefined };
}
