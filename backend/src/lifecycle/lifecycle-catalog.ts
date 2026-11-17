/**
 * SP-24 lifecycle message catalog (in code; mirrored by the frontend's
 * `src/screens/settings/lifecycle/lifecycleCatalog.ts`, a test pins equality).
 * Each key is one system workflow `Workflow.systemKey = "lifecycle." + key`.
 */

export const LIFECYCLE_KEYS = [
  "booking_confirmed",
  "booking_reminder",
  "booking_cancelled",
  "ticket_opened",
  "ticket_resolved",
  "ticket_opened_staff",
  "new_lead_staff",
] as const;
export type LifecycleKey = (typeof LIFECYCLE_KEYS)[number];

export const REMINDER_OFFSET_DEFAULT_MIN = 1440;
export const REMINDER_OFFSET_MIN = 60;
export const REMINDER_OFFSET_MAX = 10080;
export const REMINDER_TICK_MS = 5 * 60_000;
export const REMINDER_LOOKBACK_MIN = 15;
export const LIFECYCLE_TEMPLATE_PREFIX = "kewy_";
/** Meta's footer limit. */
export const FOOTER_MAX = 60;

export type LifecycleLang = "ar" | "en";
export type Audience = "customer" | "staff";
export type StaffRecipientKind = "assignee" | "permitted" | "members";
export type StaffMessageKey = "lifecycle.ticket_opened" | "lifecycle.new_lead";

export interface LifecycleDef {
  key: LifecycleKey;
  audience: Audience;
  triggerType: "appointment_confirmed" | "appointment_reminder_due" | "appointment_cancelled" | "ticket_created" | "ticket_resolved";
  triggerConfig: Record<string, unknown>;
  /** Workflow name (the builder shows it; the lifecycle page has its own copy). */
  name: string;
  /** Customer keys: the template bodies ({{1}}…{{n}}, none at the start or end). */
  bodies?: Record<LifecycleLang, string>;
  /** Customer keys: one workflow variable per placeholder, in order, per language. */
  variables?: Record<LifecycleLang, string[]>;
  /** Staff keys: the notification title key. */
  messageKey?: StaffMessageKey;
}

const BOOKING_VARS = (lang: LifecycleLang) => [
  "{{trigger.contact.firstName}}",
  lang === "ar" ? "{{trigger.appointment.serviceAr}}" : "{{trigger.appointment.service}}",
  lang === "ar" ? "{{trigger.appointment.dateTextAr}}" : "{{trigger.appointment.dateTextEn}}",
  lang === "ar" ? "{{trigger.appointment.timeTextAr}}" : "{{trigger.appointment.timeTextEn}}",
];
const TICKET_VARS = ["{{trigger.contact.firstName}}", "{{trigger.ticket.number}}"];

export const LIFECYCLE_CATALOG: Record<LifecycleKey, LifecycleDef> = {
  booking_confirmed: {
    key: "booking_confirmed",
    audience: "customer",
    triggerType: "appointment_confirmed",
    triggerConfig: {},
    name: "Booking confirmed",
    bodies: {
      en: "Hello {{1}}, your booking for {{2}} on {{3}} at {{4}} is confirmed. Reply here if you need to change it.",
      ar: "مرحبًا {{1}}، تم تأكيد حجزك لخدمة {{2}} يوم {{3}} الساعة {{4}}. ردّ على هذه الرسالة إذا أردت تعديله.",
    },
    variables: { en: BOOKING_VARS("en"), ar: BOOKING_VARS("ar") },
  },
  booking_reminder: {
    key: "booking_reminder",
    audience: "customer",
    triggerType: "appointment_reminder_due",
    triggerConfig: { offsetMinutes: REMINDER_OFFSET_DEFAULT_MIN },
    name: "Booking reminder",
    bodies: {
      en: "Hello {{1}}, a reminder of your booking for {{2}} on {{3}} at {{4}}. We look forward to seeing you.",
      ar: "مرحبًا {{1}}، نذكّرك بحجزك لخدمة {{2}} يوم {{3}} الساعة {{4}}. بانتظارك.",
    },
    variables: { en: BOOKING_VARS("en"), ar: BOOKING_VARS("ar") },
  },
  booking_cancelled: {
    key: "booking_cancelled",
    audience: "customer",
    triggerType: "appointment_cancelled",
    triggerConfig: {},
    name: "Booking cancelled",
    bodies: {
      en: "Hello {{1}}, your booking for {{2}} on {{3}} at {{4}} has been cancelled. Reply here to book another time.",
      ar: "مرحبًا {{1}}، تم إلغاء حجزك لخدمة {{2}} يوم {{3}} الساعة {{4}}. ردّ على هذه الرسالة لحجز موعد آخر.",
    },
    variables: { en: BOOKING_VARS("en"), ar: BOOKING_VARS("ar") },
  },
  ticket_opened: {
    key: "ticket_opened",
    audience: "customer",
    triggerType: "ticket_created",
    triggerConfig: { pipelineKind: "support" },
    name: "Ticket opened",
    bodies: {
      en: "Hello {{1}}, we received your request #{{2}} and our team is on it. We will update you here.",
      ar: "مرحبًا {{1}}، استلمنا طلبك رقم {{2}} وفريقنا يعمل عليه. سنوافيك بالتحديثات هنا.",
    },
    variables: { en: TICKET_VARS, ar: TICKET_VARS },
  },
  ticket_resolved: {
    key: "ticket_resolved",
    audience: "customer",
    triggerType: "ticket_resolved",
    triggerConfig: { pipelineKind: "support" },
    name: "Ticket resolved",
    bodies: {
      en: "Hello {{1}}, your request #{{2}} has been resolved. Reply here if you need anything else.",
      ar: "مرحبًا {{1}}، تم حل طلبك رقم {{2}}. ردّ على هذه الرسالة إذا احتجت أي شيء آخر.",
    },
    variables: { en: TICKET_VARS, ar: TICKET_VARS },
  },
  ticket_opened_staff: {
    key: "ticket_opened_staff",
    audience: "staff",
    triggerType: "ticket_created",
    triggerConfig: { pipelineKind: "support" },
    name: "New ticket for the team",
    messageKey: "lifecycle.ticket_opened",
  },
  new_lead_staff: {
    key: "new_lead_staff",
    audience: "staff",
    triggerType: "ticket_created",
    triggerConfig: { pipelineKind: "leads" },
    name: "New lead for the team",
    messageKey: "lifecycle.new_lead",
  },
};

export const isLifecycleKey = (v: unknown): v is LifecycleKey =>
  typeof v === "string" && (LIFECYCLE_KEYS as readonly string[]).includes(v);

export const systemKeyOf = (key: LifecycleKey) => `lifecycle.${key}`;
export const keyOfSystemKey = (systemKey: string | null | undefined): LifecycleKey | null => {
  const k = (systemKey ?? "").replace(/^lifecycle\./, "");
  return isLifecycleKey(k) ? k : null;
};

/** The Meta template name of a customer key's variant. */
export const templateName = (key: LifecycleKey, lang: LifecycleLang) => `${LIFECYCLE_TEMPLATE_PREFIX}${key}_${lang}`;

/** The workspace name as a template footer (≤ 60 chars). */
export function footerOf(workspaceName: string): string {
  const s = workspaceName.trim();
  return s.length <= FOOTER_MAX ? s : `${s.slice(0, FOOTER_MAX - 1).trimEnd()}…`;
}

/** Sample values Meta needs for each placeholder (review only). */
const SAMPLES: Record<LifecycleLang, Record<"booking" | "ticket", string[]>> = {
  en: { booking: ["Sara", "Haircut", "Monday 12 January", "10:30"], ticket: ["Sara", "1024"] },
  ar: { booking: ["سارة", "قص شعر", "الاثنين 12 يناير", "10:30"], ticket: ["سارة", "1024"] },
};

export interface TemplateDraft {
  name: string;
  lang: LifecycleLang;
  category: "UTILITY";
  body: string;
  footer: string;
  bodyExamples: string[];
}

/** The template a customer key's variant is created from (Set up). */
export function templateDraft(key: LifecycleKey, lang: LifecycleLang, workspaceName: string): TemplateDraft {
  const def = LIFECYCLE_CATALOG[key];
  if (def.audience !== "customer" || !def.bodies) throw new Error(`lifecycle ${key} has no template`);
  return {
    name: templateName(key, lang),
    lang,
    category: "UTILITY",
    body: def.bodies[lang],
    footer: footerOf(workspaceName),
    bodyExamples: SAMPLES[lang][key.startsWith("booking") ? "booking" : "ticket"],
  };
}

/** The default send step config for a customer key. */
export function templateStepConfig(key: LifecycleKey) {
  const def = LIFECYCLE_CATALOG[key];
  if (!def.variables) throw new Error(`lifecycle ${key} has no template`);
  return {
    name: templateName(key, "ar"),
    language: "ar",
    variables: def.variables.ar,
    variants: {
      ar: { name: templateName(key, "ar"), language: "ar", variables: def.variables.ar },
      en: { name: templateName(key, "en"), language: "en", variables: def.variables.en },
    },
  };
}

/** Recipient kinds allowed per audience. */
export const RECIPIENT_KINDS: Record<Audience, readonly string[]> = {
  customer: ["customer"],
  staff: ["assignee", "permitted", "members"],
};
export const MAX_RECIPIENT_USERS = 20;
