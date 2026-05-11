import type { Appointment } from "@/lib/types";

// Anchor today to the current Monday so the week view always has a stable layout.
function thisMonday(): Date {
  const now = new Date();
  const day = now.getDay();              // 0 = Sun
  const offset = day === 0 ? -6 : 1 - day;
  const m = new Date(now);
  m.setDate(now.getDate() + offset);
  m.setHours(0, 0, 0, 0);
  return m;
}

const M = thisMonday();
const dayAt = (offset: number, h: number, m = 0): string => {
  const d = new Date(M);
  d.setDate(M.getDate() + offset);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};

export const APPOINTMENTS: Appointment[] = [
  // Monday
  { id: "ap1",  contactId: "c1",  agentId: "luna",  staffId: "u3", service: "Property viewing — Olaya 18-B", serviceAr: "معاينة شقة — العليا ١٨-ب",        startAt: dayAt(0,  9, 30), durationMin: 60, status: "confirmed", source: "ai",           note: "VIP — bring building-access form", reminderSent: true },
  { id: "ap2",  contactId: "c5",  agentId: "atlas", staffId: "u3", service: "Dental cleaning",                  serviceAr: "تنظيف أسنان",                     startAt: dayAt(0, 11,  0), durationMin: 45, status: "confirmed", source: "ai",           reminderSent: true },
  { id: "ap3",  contactId: "c6",  agentId: "atlas", staffId: "u4", service: "Personal training intro",          serviceAr: "تدريب شخصي تعريفي",               startAt: dayAt(0, 14,  0), durationMin: 30, status: "pending",   source: "self-booking" },
  { id: "ap4",  contactId: "c3",                       staffId: "u3", service: "Restaurant catering call",         serviceAr: "اتصال طلبية مطعم",                startAt: dayAt(0, 16, 30), durationMin: 30, status: "confirmed", source: "human" },

  // Tuesday
  { id: "ap5",  contactId: "c8",  agentId: "luna",  staffId: "u2", service: "Villa walkthrough — Marbella",     serviceAr: "جولة فيلا — ماربيلا",             startAt: dayAt(1, 10,  0), durationMin: 90, status: "confirmed", source: "ai",           reminderSent: true },
  { id: "ap6",  contactId: "c4",  agentId: "nova",                  service: "Discovery call",                    serviceAr: "مكالمة استكشافية",                startAt: dayAt(1, 13,  0), durationMin: 30, status: "confirmed", source: "ai" },
  { id: "ap7",  contactId: "c9",  agentId: "nova",  staffId: "u4", service: "Fitting + reservation",            serviceAr: "قياس وحجز",                       startAt: dayAt(1, 15, 30), durationMin: 60, status: "no-show",   source: "ai" },

  // Wednesday
  { id: "ap8",  contactId: "c7",  agentId: "atlas", staffId: "u3", service: "Reservation — 4 guests",            serviceAr: "حجز - ٤ أشخاص",                   startAt: dayAt(2, 19,  0), durationMin: 90, status: "confirmed", source: "ai" },
  { id: "ap9",  contactId: "c2",                       staffId: "u3", service: "Onboarding call",                  serviceAr: "اتصال تهيئة",                     startAt: dayAt(2, 11,  0), durationMin: 45, status: "completed", source: "human" },

  // Thursday
  { id: "ap10", contactId: "c10", agentId: "atlas",                 service: "SaaS demo",                         serviceAr: "عرض تجريبي",                      startAt: dayAt(3, 14,  0), durationMin: 30, status: "pending",   source: "self-booking" },
  { id: "ap11", contactId: "c5",  agentId: "atlas", staffId: "u3", service: "Follow-up appointment",             serviceAr: "متابعة",                          startAt: dayAt(3, 16,  0), durationMin: 20, status: "confirmed", source: "ai",           reminderSent: true },

  // Friday
  { id: "ap12", contactId: "c1",  agentId: "luna",  staffId: "u2", service: "Lease signing",                     serviceAr: "توقيع عقد",                       startAt: dayAt(4, 11,  0), durationMin: 60, status: "confirmed", source: "ai",           note: "Bring printed contract" },
  { id: "ap13", contactId: "c3",  agentId: "atlas",                 service: "Catering pickup confirmation",      serviceAr: "تأكيد استلام طلب",                startAt: dayAt(4, 15,  0), durationMin: 15, status: "confirmed", source: "ai" },

  // Saturday
  { id: "ap14", contactId: "c1",  agentId: "luna",  staffId: "u3", service: "Olaya — viewing (rescheduled)",      serviceAr: "العليا — معاينة (محدّثة)",        startAt: dayAt(5, 17, 30), durationMin: 60, status: "confirmed", source: "ai",           reminderSent: true },
  { id: "ap15", contactId: "c8",  agentId: "luna",                  service: "Beach villa — second viewing",      serviceAr: "فيلا - معاينة ثانية",             startAt: dayAt(5, 12,  0), durationMin: 75, status: "confirmed", source: "self-booking" },

  // Sunday
  { id: "ap16", contactId: "c4",  agentId: "nova",  staffId: "u4", service: "Trial wrap-up",                     serviceAr: "ختام تجريبي",                     startAt: dayAt(6, 10,  0), durationMin: 30, status: "pending",   source: "ai" },

  // Past — completed/cancelled (for the list view + history filter)
  { id: "ap17", contactId: "c2",                       staffId: "u3", service: "Refund consult",                  serviceAr: "استشارة استرداد",                 startAt: dayAt(-3, 14,  0), durationMin: 30, status: "completed", source: "human" },
  { id: "ap18", contactId: "c6",  agentId: "atlas",                 service: "Class trial",                       serviceAr: "حصة تجريبية",                     startAt: dayAt(-2, 19,  0), durationMin: 60, status: "cancelled", source: "ai" },
];
