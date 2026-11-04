import type { Tx } from "@/lib/tx";
import { useFetch } from "@/api/useFetch";
import type {
  Template,
  WorkflowAskAgentConfig,
  WorkflowSendWhatsappConfig,
  WorkflowSendWhatsappTemplateConfig,
  WorkflowTriggerType,
} from "@/lib/types";
import { IconAlert } from "@/icons";
import { VariableMentionField } from "../VariableMentionField";
import { NO_CONVERSATION_TRIGGERS, renderSample, type WorkflowVariable } from "../stepMeta";

export function SendWhatsappConfigForm({
  config,
  onChange,
  triggerType,
  variables,
  tx,
}: {
  config: WorkflowSendWhatsappConfig;
  onChange: (c: WorkflowSendWhatsappConfig) => void;
  triggerType: WorkflowTriggerType;
  variables: WorkflowVariable[];
  tx: Tx;
}) {
  return (
    <>
      {NO_CONVERSATION_TRIGGERS.includes(triggerType) && (
        <div className="wf-callout warn" role="note">
          <IconAlert w={14} />
          <span>
            {tx(
              "This trigger has no conversation to reply in, so a plain message will fail. Use a Send WhatsApp template step instead: it finds the customer's WhatsApp chat and works outside the 24-hour window.",
              "لا توجد محادثة للرد عليها لهذا المُشغّل، لذا ستفشل الرسالة العادية. استخدم خطوة إرسال قالب واتساب بدلاً منها: فهي تجد محادثة العميل على واتساب وتعمل خارج نافذة 24 ساعة.",
            )}
          </span>
        </div>
      )}
      <div className="wf-field">
        <span className="wf-label">{tx("Message", "الرسالة")}</span>
        <VariableMentionField
          value={config.message}
          onChange={(message) => onChange({ message })}
          variables={variables}
          placeholder={tx("Type your message…", "اكتب رسالتك…")}
          hint={tx("Type “{{” or click a variable to insert it.", "اكتب «{{» أو انقر متغيراً لإدراجه.")}
          insertLabel={tx("Insert:", "إدراج:")}
        />
      </div>
      <div className="wf-field">
        <span className="wf-label">{tx("Preview", "معاينة")}</span>
        <div className="wf-preview">
          {config.message.trim() ? (
            <>
              <div className="wf-bubble" dir="auto">
                {renderSample(config.message)}
              </div>
              <div className="wf-bubble-meta">{tx("Sample values", "قيم تجريبية")}</div>
            </>
          ) : (
            <p className="wf-hint">{tx("Your message will appear here.", "ستظهر رسالتك هنا.")}</p>
          )}
        </div>
      </div>
      <div className="wf-callout info">
        {tx(
          "WhatsApp only allows free-form messages within 24 hours of the customer's last message.",
          "يسمح واتساب بالرسائل الحرة فقط خلال 24 ساعة من آخر رسالة للعميل.",
        )}
      </div>
    </>
  );
}

export function AskAgentConfigForm({
  config,
  onChange,
  variables,
  stepId,
  tx,
}: {
  config: WorkflowAskAgentConfig;
  onChange: (c: WorkflowAskAgentConfig) => void;
  variables: WorkflowVariable[];
  stepId: string;
  tx: Tx;
}) {
  return (
    <>
      <div className="wf-field">
        <span className="wf-label">{tx("Prompt", "الطلب")}</span>
        <VariableMentionField
          value={config.prompt}
          onChange={(prompt) => onChange({ prompt })}
          variables={variables}
          placeholder={tx("Ask the AI agent…", "اسأل وكيل الذكاء…")}
          hint={tx("Type “{{” or click a variable to insert it.", "اكتب «{{» أو انقر متغيراً لإدراجه.")}
          insertLabel={tx("Insert:", "إدراج:")}
        />
      </div>
      <p className="wf-hint">
        {tx("Later steps can use the reply as ", "يمكن للخطوات اللاحقة استخدام الرد كـ ")}
        <span className="wf-var" dir="ltr">{`steps.${stepId}.answer`}</span>
      </p>
    </>
  );
}

/** Highest {{n}} placeholder in a Meta template body (0 when there are none). */
export function templatePlaceholderCount(body: string | null | undefined): number {
  let max = 0;
  for (const m of (body ?? "").matchAll(/\{\{\s*(\d+)\s*\}\}/g)) max = Math.max(max, Number(m[1]));
  return max;
}

export function SendWhatsappTemplateConfigForm({
  config,
  onChange,
  variables,
  tx,
}: {
  config: WorkflowSendWhatsappTemplateConfig;
  onChange: (c: WorkflowSendWhatsappTemplateConfig) => void;
  variables: WorkflowVariable[];
  tx: Tx;
}) {
  const templatesQ = useFetch<Template[]>("/templates");
  const approved = (templatesQ.data ?? []).filter((t) => t.status === "approved" && t.body);
  const key = (t: { name: string; lang: string }) => `${t.name}|${t.lang}`;
  const selected = approved.find((t) => t.name === config.name && t.lang === config.language) ?? null;
  const count = selected ? templatePlaceholderCount(selected.body) : config.variables.length;
  const missing = Boolean(config.name) && !templatesQ.loading && templatesQ.data !== null && !selected;

  const preview = selected?.body
    ? selected.body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_m, n: string) => {
        const v = config.variables[Number(n) - 1];
        return v?.trim() ? renderSample(v).replace(/\s*[\r\n]+\s*/g, " · ") : `{{${n}}}`;
      })
    : null;

  return (
    <>
      <div className="wf-field">
        <label className="wf-label" htmlFor="wf-tpl-pick">
          {tx("Approved template", "القالب المعتمد")}
        </label>
        <select
          id="wf-tpl-pick"
          className="wf-input"
          value={selected ? key(selected) : ""}
          onChange={(e) => {
            const t = approved.find((x) => key(x) === e.target.value);
            if (!t) return onChange({ name: "", language: "", variables: [] });
            const n = templatePlaceholderCount(t.body);
            onChange({ name: t.name, language: t.lang, variables: Array.from({ length: n }, (_, i) => config.variables[i] ?? "") });
          }}
        >
          <option value="">
            {templatesQ.loading && !templatesQ.data ? tx("Loading templates…", "جارٍ تحميل القوالب…") : tx("Choose a template…", "اختر قالبًا…")}
          </option>
          {approved.map((t) => (
            <option key={key(t)} value={key(t)}>
              {t.name} · {t.lang.toUpperCase()}
            </option>
          ))}
        </select>
        {templatesQ.data && approved.length === 0 && (
          <p className="wf-hint">
            {tx(
              "No approved templates yet. Create one under Templates and wait for Meta to approve it.",
              "لا توجد قوالب معتمدة بعد. أنشئ قالبًا من صفحة القوالب وانتظر موافقة Meta.",
            )}
          </p>
        )}
      </div>

      {missing && (
        <div className="wf-callout warn" role="alert">
          <IconAlert w={14} />
          <span>
            {tx(
              `“${config.name}” isn't an approved template any more. Pick another one.`,
              `«${config.name}» لم يعد قالبًا معتمدًا. اختر قالبًا آخر.`,
            )}
          </span>
        </div>
      )}

      {Array.from({ length: count }, (_, i) => (
        <div className="wf-field" key={`${config.name}-${i}`}>
          <span className="wf-label">{tx(`Variable {{${i + 1}}}`, `المتغير {{${i + 1}}}`)}</span>
          <VariableMentionField
            value={config.variables[i] ?? ""}
            onChange={(v) => {
              const next = Array.from({ length: count }, (_, j) => config.variables[j] ?? "");
              next[i] = v;
              onChange({ ...config, variables: next });
            }}
            variables={variables}
            hint={tx("Type “{{” or click a variable to insert it.", "اكتب «{{» أو انقر متغيراً لإدراجه.")}
            insertLabel={tx("Insert:", "إدراج:")}
          />
        </div>
      ))}

      {preview && (
        <div className="wf-field">
          <span className="wf-label">{tx("Preview", "معاينة")}</span>
          <div className="wf-preview">
            <div className="wf-bubble" dir="auto">
              {preview}
            </div>
            <div className="wf-bubble-meta">{tx("Sample values", "قيم تجريبية")}</div>
          </div>
        </div>
      )}

      <div className="wf-callout info">
        {tx(
          "Sends into the customer's WhatsApp chat. A customer who has never messaged you can't be reached yet.",
          "يُرسل إلى محادثة العميل على واتساب. لا يمكن الوصول بعد إلى عميل لم يراسلك أبدًا.",
        )}
      </div>
    </>
  );
}
