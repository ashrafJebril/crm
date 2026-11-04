// Labels, summaries, validation and variables for workflow steps and triggers.
// Validation mirrors the backend's strict rules (backend/src/workflows/
// workflow-steps.ts) so the builder can explain why Activate is blocked
// before the server rejects it.
import type { Tx } from "@/lib/tx";
import type {
  WorkflowStep,
  WorkflowStepGraph,
  WorkflowStepType,
  WorkflowTriggerType,
} from "@/lib/types";
import { ancestorIds, orderedStepIds } from "./graph";

export type StepGroup = "message" | "ai" | "logic" | "data";

interface Meta {
  en: string;
  ar: string;
  descEn: string;
  descAr: string;
}

export const STEP_META: Record<WorkflowStepType, Meta & { group: StepGroup }> = {
  send_whatsapp: {
    group: "message",
    en: "Send WhatsApp",
    ar: "إرسال واتساب",
    descEn: "Message the contact, with variables",
    descAr: "أرسل رسالة لجهة الاتصال مع متغيرات",
  },
  send_whatsapp_template: {
    group: "message",
    en: "Send WhatsApp template",
    ar: "إرسال قالب واتساب",
    descEn: "An approved template; works any time, not just within 24h",
    descAr: "قالب معتمد؛ يعمل في أي وقت وليس خلال 24 ساعة فقط",
  },
  ask_agent: {
    group: "ai",
    en: "Ask AI agent",
    ar: "اسأل وكيل الذكاء",
    descEn: "Have Kewy AI draft, answer or decide",
    descAr: "دع وكيل الذكاء يكتب أو يجيب أو يقرر",
  },
  condition: {
    group: "logic",
    en: "Condition",
    ar: "شرط",
    descEn: "Split into Yes / No by a field value",
    descAr: "قسّم إلى نعم / لا حسب قيمة حقل",
  },
  ai_condition: {
    group: "ai",
    en: "AI condition",
    ar: "شرط بالذكاء الاصطناعي",
    descEn: "Split by a yes/no question to the AI",
    descAr: "قسّم حسب سؤال نعم/لا لوكيل الذكاء",
  },
  delay: {
    group: "logic",
    en: "Delay",
    ar: "تأخير",
    descEn: "Wait minutes, hours or days",
    descAr: "انتظر دقائق أو ساعات أو أيام",
  },
  update_data: {
    group: "data",
    en: "Update CRM data",
    ar: "تحديث بيانات العميل",
    descEn: "Tag, move a ticket stage, edit a field",
    descAr: "وسم، نقل مرحلة تذكرة، تعديل حقل",
  },
};

export const GROUP_LABEL: Record<StepGroup, [string, string]> = {
  message: ["Message", "رسالة"],
  ai: ["AI", "ذكاء اصطناعي"],
  logic: ["Logic", "منطق"],
  data: ["CRM data", "بيانات العميل"],
};

/** Step picker sections, in display order. */
export const PICKER_SECTIONS: Array<{ label: [string, string]; types: WorkflowStepType[] }> = [
  { label: ["Messages", "الرسائل"], types: ["send_whatsapp", "send_whatsapp_template", "ask_agent"] },
  { label: ["Logic", "المنطق"], types: ["condition", "ai_condition", "delay"] },
  { label: ["CRM data", "بيانات العميل"], types: ["update_data"] },
];

export const TRIGGER_META: Record<WorkflowTriggerType, Meta> = {
  contact_created: {
    en: "New contact",
    ar: "جهة اتصال جديدة",
    descEn: "Runs once for every contact created in this workspace.",
    descAr: "يعمل مرة لكل جهة اتصال تُنشأ في مساحة العمل.",
  },
  message_received: {
    en: "Message received",
    ar: "رسالة واردة",
    descEn: "Runs for every inbound customer message.",
    descAr: "يعمل مع كل رسالة واردة من العميل.",
  },
  ticket_created: {
    en: "Ticket created",
    ar: "تذكرة جديدة",
    descEn: "Runs when a ticket is opened in any pipeline.",
    descAr: "يعمل عند فتح تذكرة في أي مسار.",
  },
  ticket_stage_changed: {
    en: "Ticket stage changed",
    ar: "تغيّر مرحلة التذكرة",
    descEn: "Runs when a ticket moves to another stage.",
    descAr: "يعمل عند انتقال التذكرة إلى مرحلة أخرى.",
  },
  schedule: {
    en: "Schedule",
    ar: "جدولة",
    descEn: "Runs on a repeating schedule.",
    descAr: "يعمل وفق جدول متكرر.",
  },
  webhook: {
    en: "Webhook",
    ar: "ويبهوك",
    descEn: "Runs when another system calls this workflow's URL.",
    descAr: "يعمل عندما يستدعي نظام آخر رابط هذه الأتمتة.",
  },
  appointment_completed: {
    en: "Appointment completed",
    ar: "اكتمال الموعد",
    descEn: "Runs when an appointment is marked completed in the Calendar.",
    descAr: "يعمل عند تعليم الموعد كمكتمل في التقويم.",
  },
  sale_completed: {
    en: "Sale completed (HJZ)",
    ar: "اكتمال عملية بيع (HJZ)",
    descEn: "Runs when a sale is fully paid in HJZ, for customers who are in the CRM.",
    descAr: "يعمل عند دفع عملية بيع بالكامل في HJZ، للعملاء الموجودين في النظام.",
  },
};

export const TRIGGER_ORDER: WorkflowTriggerType[] = [
  "contact_created",
  "message_received",
  "ticket_created",
  "ticket_stage_changed",
  "appointment_completed",
  "sale_completed",
  "schedule",
  "webhook",
];

/**
 * Triggers that carry no conversation, so a plain Send WhatsApp step fails.
 * (The template step looks up the contact's WhatsApp chat itself.)
 */
export const NO_CONVERSATION_TRIGGERS: WorkflowTriggerType[] = [
  "contact_created",
  "schedule",
  "webhook",
  "appointment_completed",
  "sale_completed",
];

export interface WorkflowVariable {
  path: string;
  label: string;
}

const TRIGGER_VARIABLES: Record<WorkflowTriggerType, Array<{ path: string; label: [string, string] }>> = {
  contact_created: [
    { path: "trigger.contact.name", label: ["Contact name", "اسم جهة الاتصال"] },
    { path: "trigger.contact.phone", label: ["Contact phone", "هاتف جهة الاتصال"] },
    { path: "trigger.contact.lifecycle", label: ["Contact lifecycle", "دورة حياة جهة الاتصال"] },
  ],
  message_received: [
    { path: "trigger.contact.name", label: ["Contact name", "اسم جهة الاتصال"] },
    { path: "trigger.message.body", label: ["Message body", "نص الرسالة"] },
    { path: "trigger.conversation.channel", label: ["Channel", "القناة"] },
  ],
  ticket_created: [
    { path: "trigger.ticket.title", label: ["Ticket title", "عنوان التذكرة"] },
    { path: "trigger.ticket.number", label: ["Ticket number", "رقم التذكرة"] },
  ],
  ticket_stage_changed: [
    { path: "trigger.ticket.title", label: ["Ticket title", "عنوان التذكرة"] },
    { path: "trigger.ticket.stageId", label: ["New stage id", "معرّف المرحلة الجديدة"] },
  ],
  appointment_completed: [
    { path: "trigger.contact.name", label: ["Contact name", "اسم جهة الاتصال"] },
    { path: "trigger.appointment.service", label: ["Service", "الخدمة"] },
    { path: "trigger.appointment.serviceAr", label: ["Service (Arabic)", "الخدمة (عربي)"] },
  ],
  sale_completed: [
    { path: "trigger.contact.name", label: ["Contact name", "اسم جهة الاتصال"] },
    { path: "trigger.sale.receiptNumber", label: ["Receipt number", "رقم الإيصال"] },
    { path: "trigger.sale.itemsText", label: ["Items", "الأصناف"] },
    { path: "trigger.sale.total", label: ["Total", "الإجمالي"] },
    { path: "trigger.sale.paid", label: ["Amount paid", "المبلغ المدفوع"] },
    { path: "trigger.sale.currency", label: ["Currency", "العملة"] },
    { path: "trigger.sale.branch", label: ["Branch", "الفرع"] },
  ],
  schedule: [],
  webhook: [],
};

/**
 * Variables a step can use: the trigger's fields plus the answer of every
 * Ask-AI step that runs before it (the runner stores it as steps.<id>.answer).
 */
export function variablesFor(
  triggerType: WorkflowTriggerType,
  graph: WorkflowStepGraph,
  stepId: string | null,
  tx: Tx,
): WorkflowVariable[] {
  const vars = TRIGGER_VARIABLES[triggerType].map((v) => ({ path: v.path, label: tx(v.label[0], v.label[1]) }));
  if (!stepId) return vars;
  const order = orderedStepIds(graph);
  for (const id of ancestorIds(graph, stepId)) {
    if (graph.steps[id]?.type === "ask_agent") {
      const n = order.indexOf(id) + 1;
      vars.push({ path: `steps.${id}.answer`, label: tx(`AI answer (step ${n})`, `إجابة الذكاء (الخطوة ${n})`) });
    }
  }
  return vars;
}

const TOKEN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

export type TemplatePart = { kind: "text"; text: string } | { kind: "var"; path: string };

export function splitTemplate(template: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let last = 0;
  for (const m of template.matchAll(TOKEN)) {
    if (m.index! > last) parts.push({ kind: "text", text: template.slice(last, m.index) });
    parts.push({ kind: "var", path: m[1] });
    last = m.index! + m[0].length;
  }
  if (last < template.length) parts.push({ kind: "text", text: template.slice(last) });
  return parts;
}

const SAMPLE_VALUES: Record<string, string> = {
  "trigger.contact.name": "Lina",
  "trigger.contact.phone": "+962 79 123 4567",
  "trigger.contact.lifecycle": "lead",
  "trigger.message.body": "Hi, is this still available?",
  "trigger.conversation.channel": "whatsapp",
  "trigger.ticket.title": "Order #1042 not delivered",
  "trigger.ticket.number": "1042",
  "trigger.appointment.service": "Haircut",
  "trigger.appointment.serviceAr": "قص شعر",
  "trigger.sale.receiptNumber": "SAL-1042",
  "trigger.sale.itemsText": "Haircut ×1 (15.00) · Beard trim ×1 (10.00)",
  "trigger.sale.total": "25.00",
  "trigger.sale.paid": "25.00",
  "trigger.sale.currency": "JOD",
  "trigger.sale.branch": "Abdoun",
};

/** Fills a message template with sample values for the WhatsApp preview. */
export function renderSample(template: string): string {
  return template.replace(TOKEN, (_m, path: string) => {
    if (SAMPLE_VALUES[path]) return SAMPLE_VALUES[path];
    if (/^steps\.[^.]+\.answer$/.test(path)) return "Yes, they asked for a quote.";
    return `[${path}]`;
  });
}

export interface SummaryCtx {
  tx: Tx;
  variableLabel: (path: string) => string;
  stageLabel: (id: string) => string | undefined;
}

const CONTACT_FIELD_LABEL: Record<string, [string, string]> = {
  name: ["Name", "الاسم"],
  phone: ["Phone", "الهاتف"],
  industry: ["Industry", "القطاع"],
  lifecycle: ["Lifecycle", "دورة الحياة"],
  source: ["Source", "المصدر"],
  value: ["Value", "القيمة"],
};

const OPERATOR_LABEL: Record<string, [string, string]> = {
  equals: ["equals", "يساوي"],
  not_equals: ["does not equal", "لا يساوي"],
  contains: ["contains", "يحتوي على"],
  not_contains: ["does not contain", "لا يحتوي على"],
};

const UNIT_LABEL: Record<string, [string, string, string]> = {
  minutes: ["minute", "minutes", "دقيقة"],
  hours: ["hour", "hours", "ساعة"],
  days: ["day", "days", "يوم"],
};

function clip(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** One-line, human description of what a step does. May contain {{variable}} tokens. */
export function summarizeStep(step: WorkflowStep, ctx: SummaryCtx): string {
  const { tx } = ctx;
  const notSet = tx("Not set up yet", "لم يُضبط بعد");
  switch (step.type) {
    case "condition": {
      const { field, operator, value } = step.config;
      if (!field) return notSet;
      const op = OPERATOR_LABEL[operator] ?? [operator, operator];
      return `${ctx.variableLabel(field)} ${tx(op[0], op[1])} “${value}”`;
    }
    case "ai_condition":
    case "ask_agent":
      return step.config.prompt.trim() ? clip(step.config.prompt) : notSet;
    case "send_whatsapp":
      return step.config.message.trim() ? clip(step.config.message) : tx("No message yet", "لا توجد رسالة بعد");
    case "send_whatsapp_template":
      return step.config.name
        ? tx(`Template “${step.config.name}”`, `القالب «${step.config.name}»`)
        : tx("No template picked yet", "لم يُختر قالب بعد");
    case "delay": {
      const u = UNIT_LABEL[step.config.unit];
      const unit = tx(step.config.amount === 1 ? u[0] : u[1], u[2]);
      return tx(`Wait ${step.config.amount} ${unit}`, `انتظر ${step.config.amount} ${unit}`);
    }
    case "update_data": {
      const c = step.config;
      if (c.operation === "add_tag") return c.tag ? tx(`Add tag “${c.tag}”`, `إضافة وسم “${c.tag}”`) : notSet;
      if (c.operation === "remove_tag") return c.tag ? tx(`Remove tag “${c.tag}”`, `إزالة وسم “${c.tag}”`) : notSet;
      if (c.operation === "move_ticket_stage") {
        if (!c.stageId) return notSet;
        const stage = ctx.stageLabel(c.stageId) ?? c.stageId;
        return tx(`Move ticket to ${stage}`, `نقل التذكرة إلى ${stage}`);
      }
      const f = CONTACT_FIELD_LABEL[c.field] ?? [c.field, c.field];
      return tx(`Set ${f[0]} to “${c.value}”`, `تعيين ${f[1]} إلى “${c.value}”`);
    }
  }
}

export function summarizeTrigger(
  type: WorkflowTriggerType,
  config: Record<string, unknown>,
  ctx: SummaryCtx,
): string {
  const { tx } = ctx;
  switch (type) {
    case "contact_created":
      return tx("Any source", "أي مصدر");
    case "message_received":
      return tx("Any channel", "أي قناة");
    case "ticket_created":
      return tx("Any pipeline", "أي مسار");
    case "ticket_stage_changed": {
      const id = config.stageId as string | undefined;
      if (!id) return tx("Any stage", "أي مرحلة");
      const stage = ctx.stageLabel(id) ?? id;
      return tx(`Into ${stage}`, `إلى ${stage}`);
    }
    case "schedule": {
      const cron = (config.cron as string | undefined)?.trim();
      if (!cron) return tx("No schedule yet", "لا يوجد جدول بعد");
      return `${cron} · ${(config.timezone as string | undefined) || "Asia/Riyadh"}`;
    }
    case "webhook":
      return tx("When your system calls the URL", "عند استدعاء نظامك للرابط");
    case "appointment_completed":
      return tx("Any service", "أي خدمة");
    case "sale_completed":
      return tx("Paid sales from HJZ", "المبيعات المدفوعة من HJZ");
  }
}

const blank = (s: string | undefined) => !s || !s.trim();

/** Why a step can't run yet, or null when it's complete. */
export function validateStep(step: WorkflowStep, tx: Tx): string | null {
  switch (step.type) {
    case "condition":
      if (blank(step.config.field)) return tx("Pick a field to check", "اختر حقلاً للفحص");
      if (blank(step.config.value)) return tx("Enter a value to compare", "أدخل قيمة للمقارنة");
      return null;
    case "ai_condition":
      return blank(step.config.prompt) ? tx("Write the yes/no question", "اكتب سؤال نعم/لا") : null;
    case "send_whatsapp":
      return blank(step.config.message) ? tx("Message is empty", "الرسالة فارغة") : null;
    case "send_whatsapp_template":
      if (blank(step.config.name)) return tx("Pick an approved template", "اختر قالبًا معتمدًا");
      return step.config.variables.some((v) => blank(v))
        ? tx("Fill in every template variable", "املأ جميع متغيرات القالب")
        : null;
    case "ask_agent":
      return blank(step.config.prompt) ? tx("Prompt is empty", "الطلب فارغ") : null;
    case "delay":
      return Number.isFinite(step.config.amount) && step.config.amount > 0
        ? null
        : tx("Wait time must be more than 0", "يجب أن تكون مدة الانتظار أكبر من 0");
    case "update_data": {
      const c = step.config;
      if ((c.operation === "add_tag" || c.operation === "remove_tag") && blank(c.tag)) return tx("Enter a tag", "أدخل وسماً");
      if (c.operation === "move_ticket_stage" && blank(c.stageId)) return tx("Pick a stage", "اختر مرحلة");
      if (c.operation === "update_contact_field" && blank(c.value)) return tx("Enter the new value", "أدخل القيمة الجديدة");
      return null;
    }
  }
}

export function validateTrigger(type: WorkflowTriggerType, config: Record<string, unknown>, tx: Tx): string | null {
  if (type === "schedule" && blank(config.cron as string | undefined)) return tx("Set when it runs", "حدّد وقت التشغيل");
  return null;
}

/**
 * Issues that block activation: the trigger plus every reachable step.
 * Unreachable steps don't count because the builder prunes them on save.
 */
export function countIssues(
  graph: WorkflowStepGraph,
  triggerType: WorkflowTriggerType,
  triggerConfig: Record<string, unknown>,
  tx: Tx,
): number {
  const stepIssues = orderedStepIds(graph).filter((id) => validateStep(graph.steps[id], tx) !== null).length;
  return stepIssues + (validateTrigger(triggerType, triggerConfig, tx) ? 1 : 0);
}
