import type { Tx } from "@/lib/tx";
import type { HandoverRefusal, OpenWork } from "@/lib/types";

export const latn = (n: number): string => new Intl.NumberFormat("en-US").format(n);

/** One line per non-zero kind of open work that moves (bookings excluded). */
export function openWorkSummary(w: OpenWork, tx: Tx): string[] {
  const lines: Array<[number, string, string]> = [
    [w.conversations, "open conversations", "محادثات مفتوحة"],
    [w.tickets.deals, "open deals", "صفقات مفتوحة"],
    [w.tickets.leads, "open leads", "عملاء محتملون مفتوحون"],
    [w.tickets.support, "open support tickets", "تذاكر دعم مفتوحة"],
    [w.followUps, "open follow-ups", "متابعات مفتوحة"],
    [w.contacts, "owned contacts", "جهات اتصال مملوكة"],
  ];
  return lines.filter(([n]) => n > 0).map(([n, en, ar]) => `${latn(n)} ${tx(en, ar)}`);
}

/** Bookings are shown but never moved (staff need a schedule fit). */
export function bookingsNote(w: OpenWork, tx: Tx): string | null {
  if (w.bookings <= 0) return null;
  return tx(
    `${latn(w.bookings)} upcoming bookings stay with this member; reassign them on the bookings board.`,
    `${latn(w.bookings)} حجوزات قادمة تبقى مع هذا العضو؛ أعد إسنادها من لوحة الحجوزات.`,
  );
}

/** A recipient is required when anything would be left behind. */
export function needsHandover(w: OpenWork): boolean {
  return w.total > 0;
}

const RESOURCE: Record<NonNullable<HandoverRefusal["resource"]>, [string, string]> = {
  conversations: ["conversations", "المحادثات"],
  tickets: ["tickets", "التذاكر"],
  contacts: ["contacts", "جهات الاتصال"],
};

export function refusalText(r: HandoverRefusal, tx: Tx): string {
  if (r.reason === "same_user") return tx("Choose someone else to receive the work.", "اختر عضوًا آخر لاستلام العمل.");
  if (r.reason === "not_member") return tx("The recipient is not a member of this workspace.", "المستلم ليس عضوًا في مساحة العمل هذه.");
  const [en, ar] = RESOURCE[r.resource ?? "tickets"];
  return tx(`The recipient can't edit ${en}, so they can't take this work.`, `لا يملك المستلم صلاحية تعديل ${ar}، لذا لا يمكنه استلام هذا العمل.`);
}
