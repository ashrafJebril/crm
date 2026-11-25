/**
 * SP-10 booking lifecycle: mirror of backend/src/bookings/booking-status.ts
 * (ruling 8). The board allows only these drops; the side panel offers only
 * these moves. Pure.
 */
import type { AppointmentStatus } from "@/lib/types";
import type { BadgeKind } from "@/components/Badge";

export const STATUS_ORDER: readonly AppointmentStatus[] = ["pending", "confirmed", "completed", "no-show", "cancelled"];

export const BOOKING_ALLOWED: Record<AppointmentStatus, AppointmentStatus[]> = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["completed", "no-show", "cancelled"],
  completed: [],
  cancelled: [],
  "no-show": [],
};

export const OPEN_STATUSES: readonly AppointmentStatus[] = ["pending", "confirmed"];
export const isOpenStatus = (s: string) => (OPEN_STATUSES as readonly string[]).includes(s);

export function allowedFrom(from: string): AppointmentStatus[] {
  return [...(BOOKING_ALLOWED[from as AppointmentStatus] ?? [])];
}

/** A drop from one board column to another: only the table's moves (same column is not a move). */
export function canDrop(from: string, to: string): boolean {
  return from !== to && (allowedFrom(from) as string[]).includes(to);
}

/** Status words (plan copy). */
export const STATUS_WORDS: Record<AppointmentStatus, [en: string, ar: string]> = {
  pending: ["Pending", "قيد الانتظار"],
  confirmed: ["Confirmed", "مؤكد"],
  completed: ["Completed", "مكتمل"],
  "no-show": ["No-show", "لم يحضر"],
  cancelled: ["Cancelled", "ملغي"],
};

export const STATUS_TONE: Record<AppointmentStatus, BadgeKind> = {
  pending: "warn",
  confirmed: "ok",
  completed: "info",
  "no-show": "bad",
  cancelled: "",
};

/** The verb for a move to `to` (side panel and board menu). */
export const MOVE_WORDS: Record<AppointmentStatus, [en: string, ar: string]> = {
  pending: ["Mark pending", "تعيين قيد الانتظار"],
  confirmed: ["Confirm", "تأكيد"],
  completed: ["Mark completed", "تعيين مكتمل"],
  "no-show": ["Mark no-show", "تعيين لم يحضر"],
  cancelled: ["Cancel booking", "إلغاء الحجز"],
};
