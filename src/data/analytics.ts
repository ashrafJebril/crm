import type { Intent, Template } from "@/lib/types";

export const HOURLY = [4, 3, 2, 1, 1, 2, 3, 8, 21, 38, 52, 61, 68, 72, 67, 70, 74, 82, 69, 55, 42, 31, 22, 12];

export const DAILY = {
  conversations: [184, 212, 248, 276, 261, 309, 342],
  resolved:      [142, 178, 211, 240, 224, 268, 297],
  ai_pct:        [0.74, 0.78, 0.81, 0.79, 0.83, 0.84, 0.86],
  csat:          [88, 89, 91, 90, 92, 91, 93],
  responseTime:  [42, 38, 31, 28, 24, 22, 19],
};

export const INTENTS: Intent[] = [
  { name: "Order status",     pct: 28, count: 384 },
  { name: "Booking / appt",   pct: 19, count: 261 },
  { name: "Pricing",          pct: 14, count: 192 },
  { name: "Refund",           pct: 9,  count: 124 },
  { name: "Reschedule",       pct: 7,  count: 96 },
  { name: "Hours / location", pct: 6,  count: 82 },
  { name: "Other",            pct: 17, count: 233 },
];

export const TEMPLATES: Template[] = [
  { id: "t1", name: "order_confirmed_v2", lang: "en", category: "TRANSACTIONAL", status: "approved", uses: 4812 },
  { id: "t2", name: "appointment_24h",    lang: "en", category: "UTILITY",       status: "approved", uses: 1304 },
  { id: "t3", name: "abandoned_cart_24h", lang: "en", category: "MARKETING",     status: "approved", uses: 412 },
  { id: "t4", name: "tahdid_eid_promo",   lang: "ar", category: "MARKETING",     status: "pending",  uses: 0 },
];
