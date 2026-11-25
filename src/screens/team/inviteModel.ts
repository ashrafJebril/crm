import type { Tx } from "@/lib/tx";
import type { Invitation, InvitationStatus } from "@/lib/types";

/** Mirrors backend/src/members/members-constants.ts. */
export const INVITE_RESEND_MAX = 5;
export const INVITE_RESEND_GAP_MS = 60_000;
export const INVITE_MAX_LIFETIME_MS = 14 * 24 * 3600 * 1000;

export type InviteFilter = "all" | InvitationStatus;
export const INVITE_FILTERS: InviteFilter[] = ["all", "pending", "accepted", "expired", "revoked"];

type Dated = Pick<Invitation, "status" | "expiresAt">;

/** The status to show now: a pending invitation past `expiresAt` is expired
 *  even if the list was fetched before it lapsed. */
export function inviteStatus(inv: Dated, now: Date): InvitationStatus {
  if (inv.status === "pending" && new Date(inv.expiresAt).getTime() <= now.getTime()) return "expired";
  return inv.status;
}

export function filterCounts(list: Dated[], now: Date): Record<InviteFilter, number> {
  const out: Record<InviteFilter, number> = { all: list.length, pending: 0, accepted: 0, expired: 0, revoked: 0 };
  for (const inv of list) out[inviteStatus(inv, now)]++;
  return out;
}

export function filterInvites<T extends Dated>(list: T[], filter: InviteFilter, now: Date): T[] {
  return filter === "all" ? list : list.filter((i) => inviteStatus(i, now) === filter);
}

/** Resend is offered for pending or expired invitations under the send cap,
 *  a minute after the last send, and within 14 days of creation. */
export function canResend(inv: Pick<Invitation, "status" | "expiresAt" | "sendCount" | "lastSentAt" | "createdAt">, now: Date): boolean {
  const s = inviteStatus(inv, now);
  if (s !== "pending" && s !== "expired") return false;
  if (inv.sendCount >= INVITE_RESEND_MAX) return false;
  if (now.getTime() - new Date(inv.lastSentAt).getTime() < INVITE_RESEND_GAP_MS) return false;
  return new Date(inv.createdAt).getTime() + INVITE_MAX_LIFETIME_MS > now.getTime();
}

export function canRevoke(inv: Dated, now: Date): boolean {
  const s = inviteStatus(inv, now);
  return s === "pending" || s === "expired";
}

export function statusChip(status: InvitationStatus, tx: Tx): { label: string; kind: "warn" | "ok" | "bad" | "" } {
  switch (status) {
    case "pending":
      return { label: tx("Pending", "بانتظار القبول"), kind: "warn" };
    case "accepted":
      return { label: tx("Active", "نشط"), kind: "ok" };
    case "expired":
      return { label: tx("Expired", "منتهية"), kind: "" };
    case "revoked":
      return { label: tx("Revoked", "ملغاة"), kind: "bad" };
  }
}

export function filterLabel(f: InviteFilter, tx: Tx): string {
  return f === "all" ? tx("All", "الكل") : statusChip(f, tx).label;
}
