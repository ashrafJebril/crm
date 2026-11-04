// Ready-made workflows people can install and then adjust. Every template
// only uses steps the backend runner supports today. Most install complete;
// the ones that send an approved WhatsApp template carry a `setup` note,
// because only the workspace can pick which of its templates to use.
import type { Tx } from "@/lib/tx";
import type { WorkflowStep, WorkflowStepGraph, WorkflowTriggerType } from "@/lib/types";

export interface WorkflowDraft {
  name: string;
  triggerType: WorkflowTriggerType;
  triggerConfig: Record<string, unknown>;
  graph: WorkflowStepGraph;
}

export interface WorkflowTemplate {
  id: string;
  name: [string, string];
  description: [string, string];
  triggerType: WorkflowTriggerType;
  /** Step ids here are symbolic; installing gives every step a fresh id. */
  steps: WorkflowStepGraph | ((tx: Tx) => WorkflowStepGraph);
  /** What the user still has to do after installing (pick a WhatsApp template). */
  setup?: [string, string];
}

const chain = (...steps: WorkflowStep[]): WorkflowStepGraph => ({
  entry: steps[0]?.id ?? null,
  steps: Object.fromEntries(steps.map((s) => [s.id, s])),
});

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: "hot-lead-tagger",
    name: ["Tag hot leads", "وسم العملاء المهتمين"],
    description: [
      "The AI reads each new message and tags the contact “hot-lead” when they sound ready to buy.",
      "يقرأ الذكاء الاصطناعي كل رسالة جديدة ويضع وسم «hot-lead» على العميل عندما يبدو مستعدًا للشراء.",
    ],
    triggerType: "message_received",
    steps: (tx) =>
      chain(
        {
          id: "intent",
          type: "ai_condition",
          config: {
            prompt: tx(
              "Does this customer message show clear interest in buying, such as asking about price, availability, ordering or delivery? Message: {{trigger.message.body}}",
              "هل تُظهر رسالة العميل هذه اهتمامًا واضحًا بالشراء، مثل السؤال عن السعر أو التوفر أو الطلب أو التوصيل؟ الرسالة: {{trigger.message.body}}",
            ),
          },
          thenNext: "tag",
        },
        { id: "tag", type: "update_data", config: { operation: "add_tag", tag: "hot-lead" } },
      ),
  },
  {
    id: "request-received",
    name: ["Confirm new requests", "تأكيد استلام الطلبات"],
    description: [
      "When a ticket is opened, tell the customer you've got their request and are on it.",
      "عند فتح تذكرة، أخبر العميل أنك استلمت طلبه وتعمل عليه.",
    ],
    triggerType: "ticket_created",
    steps: (tx) =>
      chain({
        id: "ack",
        type: "send_whatsapp",
        config: {
          message: tx(
            "Hi! We've received your request (#{{trigger.ticket.number}}) and our team is on it. We'll get back to you shortly.",
            "مرحبًا! استلمنا طلبك (#{{trigger.ticket.number}}) وفريقنا يعمل عليه. سنعود إليك قريبًا.",
          ),
        },
      }),
  },
  {
    id: "next-day-check-in",
    name: ["Check in a day later", "المتابعة بعد يوم"],
    description: [
      "A day after a ticket is opened, check whether the customer still needs anything.",
      "بعد يوم من فتح التذكرة، تحقّق مما إذا كان العميل ما زال يحتاج شيئًا.",
    ],
    triggerType: "ticket_created",
    steps: (tx) =>
      chain(
        { id: "wait", type: "delay", config: { amount: 1, unit: "days" }, next: "checkin" },
        {
          id: "checkin",
          type: "send_whatsapp",
          config: {
            message: tx(
              "Hi again! Just checking in on your request #{{trigger.ticket.number}}. Is there anything else we can help with?",
              "مرحبًا مجددًا! نطمئن على طلبك رقم #{{trigger.ticket.number}}. هل هناك أي شيء آخر يمكننا مساعدتك به؟",
            ),
          },
        },
      ),
  },
  {
    id: "deal-won-thanks",
    name: ["Thank-you and review request", "شكر وطلب تقييم"],
    description: [
      "When a deal moves to Won, thank the customer, then ask for a review two days later.",
      "عند انتقال الصفقة إلى «تم الفوز»، اشكر العميل ثم اطلب تقييمًا بعد يومين.",
    ],
    triggerType: "ticket_stage_changed",
    steps: (tx) =>
      chain(
        {
          id: "thanks",
          type: "send_whatsapp",
          config: {
            message: tx(
              "Thank you for your order! We really appreciate your trust in us. 🙏",
              "شكرًا لطلبك! نقدّر ثقتك بنا كثيرًا. 🙏",
            ),
          },
          next: "wait",
        },
        { id: "wait", type: "delay", config: { amount: 2, unit: "days" }, next: "review" },
        {
          id: "review",
          type: "send_whatsapp",
          config: {
            message: tx(
              "We hope you're happy with your order! Would you mind leaving us a quick review? It helps us a lot.",
              "نتمنى أن يكون طلبك قد نال رضاك! هل تمانع في ترك تقييم سريع لنا؟ يساعدنا ذلك كثيرًا.",
            ),
          },
        },
      ),
  },
  {
    id: "receipt-after-sale",
    name: ["WhatsApp receipt after a sale", "إيصال واتساب بعد البيع"],
    description: [
      "When a sale is fully paid in HJZ, send the customer their receipt: items, receipt number and total.",
      "عند دفع عملية بيع بالكامل في HJZ، أرسل للعميل إيصاله: الأصناف ورقم الإيصال والإجمالي.",
    ],
    triggerType: "sale_completed",
    setup: [
      "Pick your approved receipt template. Suggested text: “Hi {{1}}, thank you for your visit! Receipt {{2}}: {{3}}. Total: {{4}}.” The variables below are already filled in for that text.",
      "اختر قالب الإيصال المعتمد. نص مقترح: «مرحبًا {{1}}، شكرًا لزيارتك! الإيصال {{2}}: {{3}}. الإجمالي: {{4}}.» المتغيرات أدناه معبأة مسبقًا لهذا النص.",
    ],
    steps: () =>
      chain({
        id: "receipt",
        type: "send_whatsapp_template",
        config: {
          name: "",
          language: "",
          variables: [
            "{{trigger.contact.name}}",
            "{{trigger.sale.receiptNumber}}",
            "{{trigger.sale.itemsText}}",
            "{{trigger.sale.total}} {{trigger.sale.currency}}",
          ],
        },
      }),
  },
  {
    id: "thanks-after-appointment",
    name: ["Thank-you after an appointment", "شكر بعد الموعد"],
    description: [
      "An hour after an appointment is marked completed, thank the customer for visiting.",
      "بعد ساعة من تعليم الموعد كمكتمل، اشكر العميل على زيارته.",
    ],
    triggerType: "appointment_completed",
    setup: [
      "Pick your approved thank-you template. Suggested text: “Hi {{1}}, thank you for visiting us for your {{2}}! We'd love to see you again.” The variables below are already filled in for that text.",
      "اختر قالب الشكر المعتمد. نص مقترح: «مرحبًا {{1}}، شكرًا لزيارتك لنا من أجل {{2}}! يسعدنا أن نراك مجددًا.» المتغيرات أدناه معبأة مسبقًا لهذا النص.",
    ],
    steps: (tx) =>
      chain(
        { id: "wait", type: "delay", config: { amount: 1, unit: "hours" }, next: "thanks" },
        {
          id: "thanks",
          type: "send_whatsapp_template",
          config: {
            name: "",
            language: "",
            variables: ["{{trigger.contact.name}}", tx("{{trigger.appointment.service}}", "{{trigger.appointment.serviceAr}}")],
          },
        },
      ),
  },
  {
    id: "new-contact-setup",
    name: ["Set up new contacts", "تجهيز جهات الاتصال الجديدة"],
    description: [
      "Mark every new contact as a lead and tag them “new-contact” so they're easy to find.",
      "صنّف كل جهة اتصال جديدة كعميل محتمل وضع وسم «new-contact» ليسهل العثور عليها.",
    ],
    triggerType: "contact_created",
    steps: () =>
      chain(
        {
          id: "lifecycle",
          type: "update_data",
          config: { operation: "update_contact_field", field: "lifecycle", value: "lead" },
          next: "tag",
        },
        { id: "tag", type: "update_data", config: { operation: "add_tag", tag: "new-contact" } },
      ),
  },
];

/**
 * Turns a template into an unsaved draft: fresh step ids, `steps.<id>`
 * variable references rewritten to match, text in the viewer's language, and
 * stage triggers pointed at the workspace's Won stage when there is one.
 */
export function instantiateTemplate(
  tpl: WorkflowTemplate,
  opts: { tx: Tx; newId: () => string; wonStageId: string | null },
): { draft: WorkflowDraft; needsStage: boolean; setupNote: string | null; focusStepId: string | null } {
  const source = typeof tpl.steps === "function" ? tpl.steps(opts.tx) : tpl.steps;
  const ids = new Map(Object.keys(source.steps).map((old) => [old, opts.newId()]));
  const remap = (id: string | undefined) => (id ? ids.get(id) : undefined);
  const rewriteRefs = (config: WorkflowStep["config"]) => {
    let json = JSON.stringify(config);
    for (const [oldId, newId] of ids) json = json.split(`steps.${oldId}.`).join(`steps.${newId}.`);
    return JSON.parse(json) as WorkflowStep["config"];
  };

  const steps: Record<string, WorkflowStep> = {};
  for (const step of Object.values(source.steps)) {
    const id = ids.get(step.id)!;
    const copy = { ...step, id, config: rewriteRefs(step.config) } as WorkflowStep;
    if (copy.type === "condition" || copy.type === "ai_condition") {
      copy.thenNext = remap(copy.thenNext);
      copy.elseNext = remap(copy.elseNext);
    } else {
      copy.next = remap(copy.next);
    }
    steps[id] = copy;
  }

  const isStageTrigger = tpl.triggerType === "ticket_stage_changed";
  const triggerConfig = isStageTrigger && opts.wonStageId ? { stageId: opts.wonStageId } : {};

  return {
    draft: {
      name: opts.tx(tpl.name[0], tpl.name[1]),
      triggerType: tpl.triggerType,
      triggerConfig,
      graph: { entry: remap(source.entry ?? undefined) ?? null, steps },
    },
    needsStage: isStageTrigger && !opts.wonStageId,
    setupNote: tpl.setup ? opts.tx(tpl.setup[0], tpl.setup[1]) : null,
    // Open setup templates on the template step, so the picker is right there.
    focusStepId: tpl.setup
      ? (Object.values(steps).find((s) => s.type === "send_whatsapp_template")?.id ?? null)
      : null,
  };
}
