// React-free catalog for the Automations builder: trigger definitions,
// sample data for previews, mocked templates, starter recipes, and the
// sentence summarizer. Keeping this pure lets vitest run it in node.
import type { Lang } from "@/lib/types";
import {
  BASE_TOKENS,
  newAutomation,
  newStep,
  type Automation,
  type AutomationTemplate,
  type Step,
  type Token,
  type Trigger,
  type TriggerKind,
} from "@/lib/automations";

export interface TriggerDef {
  kind: TriggerKind;
  en: string;
  ar: string;
  descEn: string;
  descAr: string;
  supplies: readonly Token[];
  defaults: Trigger;
}

const withBase = (...extra: Token[]): readonly Token[] => [...BASE_TOKENS, ...extra];

export const TRIGGERS: readonly TriggerDef[] = [
  {
    kind: "contact.created",
    en: "New contact added",
    ar: "إضافة جهة اتصال جديدة",
    descEn: "Runs when a contact is created from any source.",
    descAr: "يعمل عند إنشاء جهة اتصال من أي مصدر.",
    supplies: withBase(),
    defaults: { kind: "contact.created" },
  },
  {
    kind: "deal.stage_changed",
    en: "Deal moves to a stage",
    ar: "انتقال صفقة إلى مرحلة",
    descEn: "Runs when a deal enters the stage you pick, including Won or Lost.",
    descAr: "يعمل عند انتقال صفقة إلى المرحلة التي تختارها، بما فيها الفوز أو الخسارة.",
    supplies: withBase("deal.title", "deal.value", "stage.label"),
    defaults: { kind: "deal.stage_changed", pipelineId: "", stageId: "" },
  },
  {
    kind: "conversation.started",
    en: "New conversation starts",
    ar: "بدء محادثة جديدة",
    descEn: "Runs on the first inbound message from a contact.",
    descAr: "يعمل عند أول رسالة واردة من جهة اتصال.",
    supplies: withBase("conversation.channel"),
    defaults: { kind: "conversation.started", channel: "any" },
  },
  {
    kind: "appointment.booked",
    en: "Appointment booked",
    ar: "حجز موعد",
    descEn: "Runs as soon as an appointment is created.",
    descAr: "يعمل فور إنشاء موعد.",
    supplies: withBase("appointment.time", "appointment.service"),
    defaults: { kind: "appointment.booked" },
  },
  {
    kind: "appointment.upcoming",
    en: "Appointment coming up",
    ar: "موعد قريب",
    descEn: "Runs a set number of hours before an appointment.",
    descAr: "يعمل قبل الموعد بعدد ساعات تحدده.",
    supplies: withBase("appointment.time", "appointment.service"),
    defaults: { kind: "appointment.upcoming", hoursBefore: 24 },
  },
  {
    kind: "contact.tagged",
    en: "Tag added to contact",
    ar: "إضافة وسم لجهة اتصال",
    descEn: "Runs when the tag you pick is added to a contact.",
    descAr: "يعمل عند إضافة الوسم الذي تختاره إلى جهة اتصال.",
    supplies: withBase("tag.name"),
    defaults: { kind: "contact.tagged", tagId: "" },
  },
];

export function triggerDef(kind: TriggerKind): TriggerDef {
  const def = TRIGGERS.find((t) => t.kind === kind);
  if (!def) throw new Error(`unknown trigger ${kind}`);
  return def;
}

export function suppliedTokens(trigger: Trigger | null): readonly Token[] {
  return trigger ? triggerDef(trigger.kind).supplies : BASE_TOKENS;
}

export const SAMPLE: Record<Lang, Record<Token, string>> = {
  en: {
    "contact.name": "Sara Ahmed",
    "contact.phone": "+971 50 123 4567",
    "workspace.name": "Aram Clinic",
    "agent.name": "Omar",
    "deal.title": "Laser package",
    "deal.value": "AED 2,400",
    "stage.label": "Won",
    "conversation.channel": "WhatsApp",
    "appointment.time": "Tuesday 3:00 PM",
    "appointment.service": "Consultation",
    "tag.name": "VIP",
  },
  ar: {
    "contact.name": "سارة أحمد",
    "contact.phone": "+971 50 123 4567",
    "workspace.name": "عيادة آرام",
    "agent.name": "عمر",
    "deal.title": "باقة الليزر",
    "deal.value": "2,400 درهم",
    "stage.label": "تم الفوز",
    "conversation.channel": "واتساب",
    "appointment.time": "الثلاثاء 3:00 م",
    "appointment.service": "استشارة",
    "tag.name": "VIP",
  },
};

export const MOCK_TEMPLATES: readonly AutomationTemplate[] = [
  {
    id: "wa_welcome_en",
    channel: "whatsapp",
    name: "Welcome",
    lang: "en",
    body: "Hi {{contact.name}}, welcome to {{workspace.name}}! I'm {{agent.name}}. Reply here any time and we'll help you out.",
  },
  {
    id: "wa_welcome_ar",
    channel: "whatsapp",
    name: "ترحيب",
    lang: "ar",
    body: "أهلاً {{contact.name}}، مرحباً بك في {{workspace.name}}! أنا {{agent.name}}. راسلنا هنا في أي وقت وسنساعدك.",
  },
  {
    id: "wa_deal_won_en",
    channel: "whatsapp",
    name: "Deal won thank-you",
    lang: "en",
    // Meta-style numbered placeholders, mapped to tokens.
    body: "Thank you {{1}}! Your {{2}} ({{3}}) is confirmed. {{4}} will be in touch with next steps.",
    variableMap: { "1": "contact.name", "2": "deal.title", "3": "deal.value", "4": "agent.name" },
  },
  {
    id: "wa_deal_won_ar",
    channel: "whatsapp",
    name: "شكر بعد إتمام الصفقة",
    lang: "ar",
    body: "شكراً {{1}}! تم تأكيد {{2}} ({{3}}). سيتواصل معك {{4}} بالخطوات التالية.",
    variableMap: { "1": "contact.name", "2": "deal.title", "3": "deal.value", "4": "agent.name" },
  },
  {
    id: "wa_appt_reminder_en",
    channel: "whatsapp",
    name: "Appointment reminder",
    lang: "en",
    body: "Hi {{contact.name}}, a reminder of your {{appointment.service}} at {{workspace.name}} on {{appointment.time}}. Reply 1 to confirm or 2 to reschedule.",
  },
  {
    id: "wa_appt_reminder_ar",
    channel: "whatsapp",
    name: "تذكير بالموعد",
    lang: "ar",
    body: "مرحباً {{contact.name}}، نذكرك بموعد {{appointment.service}} في {{workspace.name}} يوم {{appointment.time}}. أرسل 1 للتأكيد أو 2 لإعادة الجدولة.",
  },
  {
    id: "wa_new_chat_en",
    channel: "whatsapp",
    name: "First reply",
    lang: "en",
    body: "Thanks for reaching out on {{conversation.channel}}, {{contact.name}}! {{agent.name}} from {{workspace.name}} will reply shortly.",
  },
  {
    id: "em_onboarding_en",
    channel: "email",
    name: "Onboarding",
    lang: "en",
    subject: "Welcome aboard, {{contact.name}}",
    body: "Hi {{contact.name}},\n\nThanks for choosing {{workspace.name}} for {{deal.title}}. Here is what happens next and how to reach {{agent.name}} if you need anything.",
  },
  {
    id: "em_onboarding_ar",
    channel: "email",
    name: "بداية التعامل",
    lang: "ar",
    subject: "أهلاً بك، {{contact.name}}",
    body: "مرحباً {{contact.name}}،\n\nشكراً لاختيارك {{workspace.name}} لـ {{deal.title}}. إليك الخطوات التالية وكيفية التواصل مع {{agent.name}} عند الحاجة.",
  },
  {
    id: "em_welcome_en",
    channel: "email",
    name: "Welcome email",
    lang: "en",
    subject: "Welcome to {{workspace.name}}",
    body: "Hi {{contact.name}},\n\nGreat to have you with us. {{agent.name}} is your point of contact at {{workspace.name}}.",
  },
];

export function templateById(id: string | null): AutomationTemplate | undefined {
  return id ? MOCK_TEMPLATES.find((t) => t.id === id) : undefined;
}

export interface LabelContext {
  stageLabel?: (stageId: string) => string | undefined;
  tagName?: (tagId: string) => string | undefined;
}

const CHANNEL_LABEL: Record<Lang, Record<string, string>> = {
  en: { any: "any channel", whatsapp: "WhatsApp", instagram: "Instagram", facebook: "Facebook" },
  ar: { any: "أي قناة", whatsapp: "واتساب", instagram: "إنستغرام", facebook: "فيسبوك" },
};

/** Sentence fragment for the trigger, e.g. "a deal moves to Won". */
function triggerClause(trigger: Trigger, lang: Lang, ctx: LabelContext): string {
  const ar = lang === "ar";
  switch (trigger.kind) {
    case "contact.created":
      return ar ? "تُضاف جهة اتصال جديدة" : "a new contact is added";
    case "deal.stage_changed": {
      const stage = (trigger.stageId && ctx.stageLabel?.(trigger.stageId)) || (ar ? "مرحلة" : "a stage");
      return ar ? `تنتقل صفقة إلى ${stage}` : `a deal moves to ${stage}`;
    }
    case "conversation.started": {
      const ch = CHANNEL_LABEL[lang][trigger.channel];
      return ar ? `تبدأ محادثة جديدة على ${ch}` : `a new conversation starts on ${ch}`;
    }
    case "appointment.booked":
      return ar ? "يُحجز موعد" : "an appointment is booked";
    case "appointment.upcoming":
      return ar
        ? `يقترب موعد (قبل ${trigger.hoursBefore} ساعة)`
        : `an appointment is ${trigger.hoursBefore}h away`;
    case "contact.tagged": {
      const tag = (trigger.tagId && ctx.tagName?.(trigger.tagId)) || (ar ? "وسم" : "a tag");
      return ar ? `يُضاف وسم ${tag} لجهة اتصال` : `tag ${tag} is added to a contact`;
    }
  }
}

/** Short trigger label for names, e.g. "Deal moves to Won". */
export function triggerLabel(trigger: Trigger | null, lang: Lang, ctx: LabelContext): string {
  if (!trigger) return lang === "ar" ? "اختر المشغّل" : "Choose a trigger";
  const def = triggerDef(trigger.kind);
  if (trigger.kind === "deal.stage_changed") {
    const stage = trigger.stageId && ctx.stageLabel?.(trigger.stageId);
    if (stage) return lang === "ar" ? `انتقال صفقة إلى ${stage}` : `Deal moves to ${stage}`;
  }
  if (trigger.kind === "contact.tagged") {
    const tag = trigger.tagId && ctx.tagName?.(trigger.tagId);
    if (tag) return lang === "ar" ? `إضافة وسم ${tag}` : `Tag ${tag} added`;
  }
  return lang === "ar" ? def.ar : def.en;
}

export function stepLabel(step: Step, lang: Lang): string {
  const ar = lang === "ar";
  switch (step.kind) {
    case "whatsapp": {
      const name = templateById(step.templateId)?.name ?? (ar ? "اختر قالباً" : "choose a template");
      return ar ? `واتساب: ${name}` : `WhatsApp: ${name}`;
    }
    case "email": {
      const name = templateById(step.templateId)?.name ?? (ar ? "اختر قالباً" : "choose a template");
      return ar ? `بريد: ${name}` : `Email: ${name}`;
    }
    case "wait": {
      if (ar) return `انتظر ${step.amount} ${step.unit === "days" ? "يوم" : "ساعة"}`;
      const unit = step.unit === "days" ? "day" : "hour";
      return `wait ${step.amount} ${unit}${step.amount === 1 ? "" : "s"}`;
    }
  }
}

/** "When a deal moves to Won → WhatsApp: Thank you → wait 2 days → Email: Onboarding" */
export function summarize(a: Automation, lang: Lang, ctx: LabelContext): string {
  const ar = lang === "ar";
  const arrow = lang === "ar" ? " ← " : " → ";
  const head = a.trigger
    ? (ar ? "عندما " : "When ") + triggerClause(a.trigger, lang, ctx)
    : ar
      ? "لم يُحدَّد مشغّل"
      : "No trigger yet";
  const parts = [head, ...a.steps.map((s) => stepLabel(s, lang))];
  return parts.join(arrow);
}

/** "<trigger label> → <first action>" until the user edits the name. */
export function suggestName(a: Automation, lang: Lang, ctx: LabelContext): string {
  if (!a.trigger) return lang === "ar" ? "أتمتة جديدة" : "New automation";
  const arrow = lang === "ar" ? " ← " : " → ";
  const first = a.steps.find((s) => s.kind !== "wait");
  const action = !first
    ? "…"
    : first.kind === "whatsapp"
      ? lang === "ar" ? "واتساب" : "WhatsApp"
      : lang === "ar" ? "بريد" : "Email";
  return `${triggerLabel(a.trigger, lang, ctx)}${arrow}${action}`;
}

export interface Recipe {
  id: string;
  en: string;
  ar: string;
  descEn: string;
  descAr: string;
  build: (opts: { wonStageRef: { pipelineId: string; stageId: string } | null }) => Automation;
}

const message = (kind: "whatsapp" | "email", templateId: string): Step => {
  const s = newStep(kind);
  if (s.kind === "whatsapp" || s.kind === "email") s.templateId = templateId;
  if (s.kind === "email") s.subject = templateById(templateId)?.subject ?? "";
  return s;
};

const wait = (amount: number): Step => {
  const s = newStep("wait");
  if (s.kind === "wait") s.amount = amount;
  return s;
};

export const RECIPES: readonly Recipe[] = [
  {
    id: "welcome",
    en: "Welcome new contact",
    ar: "ترحيب بجهة اتصال جديدة",
    descEn: "Send a WhatsApp welcome the moment a contact is added.",
    descAr: "أرسل رسالة ترحيب عبر واتساب فور إضافة جهة اتصال.",
    build: () => {
      const a = newAutomation();
      a.trigger = { kind: "contact.created" };
      a.steps = [message("whatsapp", "wa_welcome_en")];
      return a;
    },
  },
  {
    id: "deal_won",
    en: "Deal won thank-you",
    ar: "شكر بعد الفوز بصفقة",
    descEn: "Thank the customer on WhatsApp, then email onboarding two days later.",
    descAr: "اشكر العميل عبر واتساب، ثم أرسل بريد البداية بعد يومين.",
    build: ({ wonStageRef }) => {
      const a = newAutomation();
      a.trigger = {
        kind: "deal.stage_changed",
        pipelineId: wonStageRef?.pipelineId ?? "",
        stageId: wonStageRef?.stageId ?? "",
      };
      a.steps = [message("whatsapp", "wa_deal_won_en"), wait(2), message("email", "em_onboarding_en")];
      return a;
    },
  },
  {
    id: "appt_reminder",
    en: "Appointment reminder",
    ar: "تذكير بالموعد",
    descEn: "Remind the contact on WhatsApp 24 hours before their appointment.",
    descAr: "ذكّر جهة الاتصال عبر واتساب قبل موعدها بـ 24 ساعة.",
    build: () => {
      const a = newAutomation();
      a.trigger = { kind: "appointment.upcoming", hoursBefore: 24 };
      a.steps = [message("whatsapp", "wa_appt_reminder_en")];
      return a;
    },
  },
];
