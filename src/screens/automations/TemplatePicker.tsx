import { useMemo, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import type { Lang } from "@/lib/types";
import {
  missingTokens,
  renderTemplate,
  type AutomationTemplate,
  type Token,
  type Trigger,
} from "@/lib/automations";
import { Badge } from "@/components/Badge";
import { IconAlert, IconCheck, IconSearch } from "@/icons";
import { MOCK_TEMPLATES, SAMPLE, suppliedTokens, triggerDef } from "./catalog";

const GROUP_LABEL: Record<Lang, Record<string, string>> = {
  en: { contact: "contact", deal: "deal", stage: "stage", conversation: "conversation", appointment: "appointment", tag: "tag" },
  ar: { contact: "جهة الاتصال", deal: "الصفقة", stage: "المرحلة", conversation: "المحادثة", appointment: "الموعد", tag: "الوسم" },
};

/** "This template needs deal info, but the trigger is New contact". */
export function warningText(missing: Token[], trigger: Trigger | null, lang: Lang): string {
  const groups = [...new Set(missing.map((m) => m.split(".")[0]))]
    .map((g) => GROUP_LABEL[lang][g] ?? g)
    .join(lang === "ar" ? " و" : " and ");
  const trig = trigger ? (lang === "ar" ? triggerDef(trigger.kind).ar : triggerDef(trigger.kind).en) : "";
  return lang === "ar"
    ? `هذا القالب يحتاج معلومات ${groups}، لكن المشغّل هو "${trig}"`
    : `This template needs ${groups} info, but the trigger is "${trig}"`;
}

export function TemplatePreview({ template, lang }: { template: AutomationTemplate; lang: Lang }) {
  const values = SAMPLE[lang];
  const body = renderTemplate(template.body, values, template.variableMap);
  const subject = template.subject ? renderTemplate(template.subject, values, template.variableMap) : null;
  return (
    <div
      dir={template.lang === "ar" ? "rtl" : "ltr"}
      style={{
        background: template.channel === "whatsapp" ? "oklch(0.93 0.06 150)" : "var(--bg-2)",
        color: "oklch(0.2 0.02 150)",
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

interface TemplatePickerProps {
  channel: "whatsapp" | "email";
  trigger: Trigger | null;
  selectedId: string | null;
  onSelect: (t: AutomationTemplate) => void;
}

export function TemplatePicker({ channel, trigger, selectedId, onSelect }: TemplatePickerProps) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const [q, setQ] = useState("");
  const supplied = suppliedTokens(trigger);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return MOCK_TEMPLATES.filter((tpl) => tpl.channel === channel)
      .filter((tpl) => !needle || tpl.name.toLowerCase().includes(needle))
      .map((tpl) => ({ tpl, missing: missingTokens(tpl, supplied) }))
      // Compatible first, then keep catalog order.
      .sort((a, b) => Number(a.missing.length > 0) - Number(b.missing.length > 0));
  }, [channel, q, supplied]);

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 10px",
          border: "1px solid var(--line)",
          borderRadius: 8,
          background: "var(--bg-1)",
        }}
      >
        <IconSearch w={14} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={tx("Search templates", "ابحث في القوالب")}
          style={{ border: 0, background: "transparent", outline: "none", flex: 1, fontSize: 13, color: "inherit" }}
        />
      </label>

      <div style={{ display: "grid", gap: 6, maxHeight: 360, overflowY: "auto" }}>
        {rows.length === 0 && (
          <div style={{ color: "var(--ink-3)", fontSize: 13, padding: 12 }}>{tx("No templates match.", "لا توجد قوالب مطابقة.")}</div>
        )}
        {rows.map(({ tpl, missing }) => {
          const selected = tpl.id === selectedId;
          return (
            <button
              key={tpl.id}
              type="button"
              onClick={() => onSelect(tpl)}
              style={{
                textAlign: "start",
                padding: 12,
                borderRadius: 10,
                border: `1px solid ${selected ? "var(--accent)" : "var(--line-soft)"}`,
                background: selected ? "var(--bg-2)" : "var(--bg-1)",
                cursor: "pointer",
                color: "inherit",
                display: "grid",
                gap: 8,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>{tpl.name}</span>
                <Badge kind="">{tpl.lang.toUpperCase()}</Badge>
                <Badge kind="ok" dot>{tx("Approved", "معتمد")}</Badge>
                {selected && <IconCheck w={14} />}
              </div>
              <TemplatePreview template={tpl} lang={t.lang} />
              {missing.length > 0 && (
                <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--warn, #b7791f)", fontSize: 12 }}>
                  <IconAlert w={13} />
                  {warningText(missing, trigger, t.lang)}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
