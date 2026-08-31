// Templates screen extras. The shared `Template` type only carries 3
// categories and lacks body/buttons/updated, so we define a richer local
// `TemplateFull` interface here and a complementary library.

import type { Lang } from "@/lib/types";

export type TemplateCategory =
  | "TRANSACTIONAL"
  | "UTILITY"
  | "MARKETING"
  | "AUTHENTICATION";

// "local" = stored here but NOT submitted to / approved by Meta, so it
// cannot be sent. Meta owns approval; we never claim it on its behalf.
export type TemplateStatus = "approved" | "pending" | "rejected" | "local";

export interface TemplateFull {
  id: string;
  name: string;
  lang: Lang;
  category: TemplateCategory;
  status: TemplateStatus;
  uses: number;
  updated: string;
  body: string;
  buttons: string[];
}

export const TPL_LIBRARY: TemplateFull[] = [
  { id: "t1", name: "order_confirmed_v2",  lang: "en", category: "TRANSACTIONAL",  status: "approved", uses: 4812, updated: "Apr 22", body: "Hi {{1}} 👋 — your order #{{2}} for {{3}} is confirmed. ETA {{4}}. Track here: {{5}}", buttons: ["Track order", "Contact support"] },
  { id: "t2", name: "appointment_24h",     lang: "en", category: "UTILITY",        status: "approved", uses: 1304, updated: "Apr 18", body: "Reminder: your appointment with {{1}} is tomorrow at {{2}}. Reply 1 to confirm, 2 to reschedule.", buttons: ["Confirm", "Reschedule"] },
  { id: "t3", name: "abandoned_cart_24h",  lang: "en", category: "MARKETING",      status: "approved", uses: 412,  updated: "Apr 11", body: "Still thinking it over, {{1}}? Your cart with {{2}} items is waiting. 10% off if you check out today: {{3}}", buttons: ["Continue checkout"] },
  { id: "t4", name: "tahdid_eid_promo",    lang: "ar", category: "MARKETING",      status: "pending",  uses: 0,    updated: "Apr 30", body: "كل عام وأنتم بخير 🌙 — احتفل بعيد الفطر مع خصم {{1}}٪ على جميع المنتجات. صالح حتى {{2}}.", buttons: ["تسوق الآن"] },
  { id: "t5", name: "delivery_otp",        lang: "en", category: "AUTHENTICATION", status: "approved", uses: 9281, updated: "Mar 30", body: "Your verification code is {{1}}. Do not share. Expires in 5 minutes.", buttons: [] },
  { id: "t6", name: "feedback_request_v3", lang: "en", category: "UTILITY",        status: "approved", uses: 1842, updated: "Apr 02", body: "Thanks for visiting {{1}}! How was your experience? Tap a number — 1 (poor) to 5 (excellent).", buttons: ["1", "2", "3", "4", "5"] },
  { id: "t7", name: "winback_60d",         lang: "en", category: "MARKETING",      status: "rejected", uses: 0,    updated: "Apr 14", body: "Miss you, {{1}}. Here's 20% off — come back: {{2}}", buttons: ["Shop now"] },
  { id: "t8", name: "clinic_followup_ar",  lang: "ar", category: "UTILITY",        status: "approved", uses: 312,  updated: "Apr 08", body: "مرحباً {{1}}، نأمل أن تكون بصحة جيدة بعد زيارتك. هل تحتاج إلى موعد متابعة؟", buttons: ["نعم", "ليس الآن"] },
];

export interface QuickReply {
  id: string;
  short: string;
  body: string;
  used: number;
}

export const QUICK_REPLIES: QuickReply[] = [
  { id: "q1", short: "/hours",     body: "We're open Sat–Thu, 9am–11pm; closed Fridays.", used: 184 },
  { id: "q2", short: "/parking",   body: "Yes — complimentary valet at the main entrance.", used: 96 },
  { id: "q3", short: "/refund",    body: "Refunds are processed within 3–5 business days to your original payment method.", used: 142 },
  { id: "q4", short: "/menu_ar",   body: "تفضل قائمة الطعام: {{link}}", used: 73 },
  { id: "q5", short: "/eid_promo", body: "🌙 Eid promo: 15% off all orders > SAR 250 with code EID26.", used: 211 },
];

export interface MediaAsset {
  label: string;
  size: number; // KB
}

export const MEDIA_ASSETS: MediaAsset[] = [
  { label: "product-shot-eid",       size: 248 },
  { label: "menu-cover-ar",          size: 412 },
  { label: "clinic-room-1",          size: 188 },
  { label: "gym-trainer-portrait",   size: 624 },
  { label: "tower-floorplan",        size: 821 },
  { label: "trial-coupon",           size: 132 },
  { label: "shipping-label",         size: 96 },
  { label: "thank-you-card",         size: 274 },
];
