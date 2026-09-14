// Template helpers shared by the wizard: a rendered preview bubble and the
// "this template needs X info" warning copy.
import type { Lang } from "@/lib/types";
import { renderTemplate, type AutomationTemplate, type Token, type Trigger } from "@/lib/automations";
import { SAMPLE, triggerDef } from "./catalog";

const GROUP_LABEL: Record<Lang, Record<string, string>> = {
  en: { contact: "contact", deal: "deal", stage: "stage", conversation: "conversation", appointment: "appointment", tag: "tag" },
  ar: { contact: "جهة الاتصال", deal: "الصفقة", stage: "المرحلة", conversation: "المحادثة", appointment: "الموعد", tag: "الوسم" },
};

/** "This template needs deal info, but the trigger is New contact". */
export function warningText(missing: Token[], trigger: Trigger | null, lang: Lang): string {
  const groups = [...new Set(missing.map((m) => m.split(".")[0]))]
    .map((g) => GROUP_LABEL[lang][g] ?? g)
    .join(lang === "ar" ? " و" : " and ");
  if (!trigger) {
    return lang === "ar"
      ? `هذا القالب يحتاج معلومات ${groups}. اختر مشغّلاً يوفّرها.`
      : `This template needs ${groups} info. Choose a trigger that provides it.`;
  }
  const trig = lang === "ar" ? triggerDef(trigger.kind).ar : triggerDef(trigger.kind).en;
  return lang === "ar"
    ? `هذا القالب يحتاج معلومات ${groups}، لكن المشغّل هو "${trig}"`
    : `This template needs ${groups} info, but the trigger is "${trig}"`;
}

export function TemplatePreview({
  template,
  subject: subjectOverride,
}: {
  template: AutomationTemplate;
  subject?: string | null;
}) {
  const values = SAMPLE[template.lang];
  const body = renderTemplate(template.body, values, template.variableMap);
  const rawSubject = subjectOverride === undefined ? template.subject : subjectOverride;
  const subject = rawSubject ? renderTemplate(rawSubject, values, template.variableMap) : null;
  return (
    <div
      dir={template.lang === "ar" ? "rtl" : "ltr"}
      style={{
        background: template.channel === "whatsapp" ? "oklch(0.93 0.06 150)" : "var(--bg-1)",
        color: template.channel === "whatsapp" ? "oklch(0.2 0.02 150)" : "var(--ink)",
        border: template.channel === "whatsapp" ? undefined : "1px solid var(--line)",
        borderRadius: 12,
        padding: "10px 12px",
        fontSize: 13,
        lineHeight: 1.45,
        whiteSpace: "pre-wrap",
        maxWidth: 420,
      }}
    >
      {subject && <div style={{ fontWeight: 600, marginBottom: 6 }}>{subject}</div>}
      {body}
    </div>
  );
}
