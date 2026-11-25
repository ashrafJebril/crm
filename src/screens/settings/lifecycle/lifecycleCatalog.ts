/**
 * SP-24 Automatic messages: the frontend mirror of the backend catalog
 * (backend/src/lifecycle/lifecycle-catalog.ts). lifecycleCatalog.test.ts pins
 * the keys, audiences, trigger types and reminder bounds to that file.
 */
import type { LifecycleKey, WorkflowTriggerType } from "@/lib/types";

export const LIFECYCLE_KEYS: readonly LifecycleKey[] = [
  "booking_confirmed",
  "booking_reminder",
  "booking_cancelled",
  "ticket_opened",
  "ticket_resolved",
  "ticket_opened_staff",
  "new_lead_staff",
];

/** The backend's REMINDER_OFFSET_MIN / _MAX / _DEFAULT_MIN (minutes). */
export const REMINDER_OFFSET_MIN = 60;
export const REMINDER_OFFSET_MAX = 10080;
export const REMINDER_OFFSET_DEFAULT = 1440;

export type LifecycleGroup = "bookings" | "tickets" | "leads";
type Copy = [en: string, ar: string];

export interface LifecycleEntry {
  key: LifecycleKey;
  group: LifecycleGroup;
  audience: "customer" | "staff";
  triggerType: WorkflowTriggerType;
  title: Copy;
  description: Copy;
  /** Customer rows: what each template placeholder ({{1}}…) holds. */
  variables: Copy[];
}

const NAME: Copy = ["Customer name", "اسم العميل"];
const BOOKING_VARS: Copy[] = [NAME, ["Service", "الخدمة"], ["Date", "التاريخ"], ["Time", "الوقت"]];
const TICKET_VARS: Copy[] = [NAME, ["Request number", "رقم الطلب"]];

export const LIFECYCLE_CATALOG: Record<LifecycleKey, LifecycleEntry> = {
  booking_confirmed: {
    key: "booking_confirmed",
    group: "bookings",
    audience: "customer",
    triggerType: "appointment_confirmed",
    title: ["Booking confirmed", "تأكيد الحجز"],
    description: ["Sent to the customer when a booking is confirmed.", "تُرسل إلى العميل عند تأكيد الحجز."],
    variables: BOOKING_VARS,
  },
  booking_reminder: {
    key: "booking_reminder",
    group: "bookings",
    audience: "customer",
    triggerType: "appointment_reminder_due",
    title: ["Booking reminder", "تذكير بالحجز"],
    description: ["Reminds the customer before the booking starts.", "تذكّر العميل قبل موعد الحجز."],
    variables: BOOKING_VARS,
  },
  booking_cancelled: {
    key: "booking_cancelled",
    group: "bookings",
    audience: "customer",
    triggerType: "appointment_cancelled",
    title: ["Booking cancelled", "إلغاء الحجز"],
    description: ["Sent to the customer when a booking is cancelled.", "تُرسل إلى العميل عند إلغاء الحجز."],
    variables: BOOKING_VARS,
  },
  ticket_opened: {
    key: "ticket_opened",
    group: "tickets",
    audience: "customer",
    triggerType: "ticket_created",
    title: ["Ticket opened", "فتح تذكرة"],
    description: ["Tells the customer their support request was received.", "تُبلغ العميل باستلام طلب الدعم."],
    variables: TICKET_VARS,
  },
  ticket_resolved: {
    key: "ticket_resolved",
    group: "tickets",
    audience: "customer",
    triggerType: "ticket_resolved",
    title: ["Ticket resolved", "حل التذكرة"],
    description: ["Tells the customer their support request was resolved.", "تُبلغ العميل بحل طلب الدعم."],
    variables: TICKET_VARS,
  },
  ticket_opened_staff: {
    key: "ticket_opened_staff",
    group: "tickets",
    audience: "staff",
    triggerType: "ticket_created",
    title: ["New ticket for the team", "تذكرة جديدة للفريق"],
    description: ["Notifies the team in the app when a support ticket opens.", "تُنبّه الفريق داخل التطبيق عند فتح تذكرة دعم."],
    variables: [],
  },
  new_lead_staff: {
    key: "new_lead_staff",
    group: "leads",
    audience: "staff",
    triggerType: "ticket_created",
    title: ["New lead for the team", "عميل محتمل جديد للفريق"],
    description: ["Notifies the team in the app when a new lead arrives.", "تُنبّه الفريق داخل التطبيق عند وصول عميل محتمل جديد."],
    variables: [],
  },
};

export const GROUPS: { id: LifecycleGroup; title: Copy }[] = [
  { id: "bookings", title: ["Bookings", "الحجوزات"] },
  { id: "tickets", title: ["Tickets", "التذاكر"] },
  { id: "leads", title: ["Leads", "العملاء المحتملون"] },
];

export const AUDIENCE_COPY: Record<"customer" | "staff", Copy> = {
  customer: ["Customer", "العميل"],
  staff: ["Team", "الفريق"],
};

/** Reminder offsets offered (minutes); all within the server's bounds. */
export const REMINDER_OFFSETS: { minutes: number; label: Copy }[] = [
  { minutes: 60, label: ["1 hour before", "قبل ساعة"] },
  { minutes: 180, label: ["3 hours before", "قبل 3 ساعات"] },
  { minutes: 720, label: ["12 hours before", "قبل 12 ساعة"] },
  { minutes: 1440, label: ["1 day before", "قبل يوم"] },
  { minutes: 2880, label: ["2 days before", "قبل يومين"] },
  { minutes: 10080, label: ["1 week before", "قبل أسبوع"] },
];

/** Staff recipient choices. */
export const RECIPIENT_COPY: Record<"assignee" | "permitted" | "members", Copy> = {
  assignee: ["Assignee", "المسؤول"],
  permitted: ["Everyone who can see tickets", "كل من يرى التذاكر"],
  members: ["Specific members", "أعضاء محددون"],
};

/** Skip reasons recorded on runs (backend runner and template executor). */
export const SKIP_REASON_COPY: Record<string, Copy> = {
  opted_out: ["opted out", "ألغى الاشتراك"],
  channel_disconnected: ["number disconnected", "الرقم غير متصل"],
  template_not_approved: ["template not approved", "القالب غير معتمد"],
  template_not_found: ["template not found", "القالب غير موجود"],
  workflow_inactive: ["message turned off", "الرسالة متوقفة"],
  failed: ["failed", "فشل"],
};

export function skipReasonLabel(reason: string, lang: "en" | "ar"): string {
  const c = SKIP_REASON_COPY[reason];
  return c ? c[lang === "ar" ? 1 : 0] : reason.replace(/_/g, " ");
}

/** "Custom automations": the workflow builder, prefilled with this row's trigger (never the system-only reminder). */
export function customAutomationHref(key: LifecycleKey): string {
  const t = LIFECYCLE_CATALOG[key].triggerType;
  const trigger = t === "appointment_reminder_due" ? "appointment_confirmed" : t;
  return `#/workflows?new=1&trigger=${encodeURIComponent(trigger)}`;
}
