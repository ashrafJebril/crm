import type { Tx } from "@/lib/tx";
import type { CampaignPreviewV2, NumberTotals, SenderOption } from "@/lib/types";

/**
 * SP-13 "Send from" model (Tkana's campaign-senders.ts, adapted). Pure, so
 * the split and the picker rules are unit-tested.
 */

export const eligibleSenders = (senders: readonly SenderOption[]): SenderOption[] => senders.filter((s) => s.eligible);

const defaultId = (senders: readonly SenderOption[]): string | null =>
  senders.find((s) => s.isDefault && s.eligible)?.channelId ?? eligibleSenders(senders)[0]?.channelId ?? null;

/**
 * The picker shows with two or more eligible numbers, or when a saved choice
 * is not just the default number (so it can be seen and changed back).
 */
export function showSendFrom(senders: readonly SenderOption[], saved: readonly string[]): boolean {
  if (eligibleSenders(senders).length >= 2) return true;
  if (saved.length === 0) return false;
  const def = defaultId(senders);
  return !(saved.length === 1 && saved[0] === def);
}

/** The ticked numbers; an empty choice means the default number. */
export function effectiveSelection(ids: readonly string[], senders: readonly SenderOption[]): string[] {
  if (ids.length) return [...ids];
  const def = defaultId(senders);
  return def ? [def] : [];
}

/** Tick or untick; the last number stays ticked, and the plan limit caps additions (a limit of 1 swaps). */
export function toggleSender(ids: readonly string[], id: string, limit: number): string[] {
  if (ids.includes(id)) return ids.length > 1 ? ids.filter((x) => x !== id) : [...ids];
  if (limit <= 1) return [id];
  if (ids.length >= limit) return [...ids];
  return [...ids, id];
}

/** Moves a ticked number to the front: the primary holds skipped rows and the template copy. */
export function makePrimary(ids: readonly string[], id: string): string[] {
  if (!ids.includes(id)) return [...ids];
  return [id, ...ids.filter((x) => x !== id)];
}

/** Backend `assignSender`: recipient i (in contact-id order) goes out from senders[i % k]. */
export const assignSender = <T,>(index: number, senders: readonly T[]): T => senders[index % senders.length]!;

/** Backend closed form `ceil((n - i) / k)` per sender, in sender order. */
export function splitCounts(n: number, senders: readonly unknown[]): number[] {
  const k = senders.length;
  return senders.map((_, i) => Math.max(0, Math.ceil((n - i) / k)));
}

/** Why a number can't send campaigns, or null when it can. */
export function senderUnavailable(s: Pick<SenderOption, "eligible" | "reason">, tx: Tx): string | null {
  if (s.eligible) return null;
  if (s.reason === "provider_meta") return tx("Campaigns send through Zernio numbers only", "ترسل الحملات عبر أرقام Zernio فقط");
  if (s.reason === "not_active") return tx("This number isn't active. Check it in Channels.", "هذا الرقم غير نشط. تحقق منه في القنوات.");
  return tx("This number can't send campaigns", "لا يمكن لهذا الرقم إرسال الحملات");
}

/** Left-to-right isolate (U+2066 … U+2069) for a number inside an <option> or a plain string. */
export const isolateLtr = (s: string): string => `⁦${s}⁩`;

/** "Name · +962…" for an option or a sentence, with the number isolated. */
export function senderText(s: { displayName?: string | null; phoneNumber?: string | null }): string {
  const name = s.displayName?.trim() ?? "";
  const phone = s.phoneNumber?.trim() ? isolateLtr(s.phoneNumber.trim()) : "";
  return name && phone ? `${name} · ${phone}` : name || phone;
}

export type SplitRow = CampaignPreviewV2["split"][number] & { pct: number };

/** The preview split, largest first, with whole-number shares. */
export function splitRows(split: CampaignPreviewV2["split"]): SplitRow[] {
  const total = split.reduce((a, r) => a + r.recipients, 0);
  return [...split]
    .sort((a, b) => b.recipients - a.recipients)
    .map((r) => ({ ...r, pct: total > 0 ? Math.round((r.recipients / total) * 100) : 0 }));
}

/**
 * Tkana's `showNumberTable`: the per-number report shows with more than one
 * number, or with one number that is not the workspace default.
 */
export function showNumberTable(byNumber: readonly NumberTotals[], defaultChannelId: string | null): boolean {
  if (byNumber.length > 1) return true;
  if (byNumber.length === 0 || !defaultChannelId) return false;
  return byNumber[0]!.channelId !== defaultChannelId;
}
