import type { Tx } from "@/lib/tx";
import { API_BASE } from "@/api/client";
import type { WorkflowTriggerType } from "@/lib/types";

export function TriggerConfigFields({
  triggerType,
  triggerConfig,
  onChange,
  workflowId,
  webhookSecret,
  stageOptions,
  tx,
}: {
  triggerType: WorkflowTriggerType;
  triggerConfig: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
  workflowId: string | null;
  webhookSecret: string | null;
  stageOptions: Array<{ id: string; label: string }>;
  tx: Tx;
}) {
  if (triggerType === "ticket_stage_changed") {
    return (
      <div className="wf-field">
        <label className="wf-label" htmlFor="wf-trg-stage">
          {tx("Only for this stage (optional)", "لهذه المرحلة فقط (اختياري)")}
        </label>
        <select
          id="wf-trg-stage"
          className="wf-input"
          value={(triggerConfig.stageId as string) ?? ""}
          onChange={(e) => onChange({ ...triggerConfig, stageId: e.target.value || undefined })}
        >
          <option value="">{tx("Any stage", "أي مرحلة")}</option>
          {stageOptions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (triggerType === "schedule") {
    return (
      <>
        <div className="wf-field">
          <label className="wf-label" htmlFor="wf-trg-cron">
            {tx("Cron expression", "تعبير كرون")}
          </label>
          <input
            id="wf-trg-cron"
            className="wf-input mono"
            dir="ltr"
            value={(triggerConfig.cron as string) ?? ""}
            onChange={(e) => onChange({ ...triggerConfig, cron: e.target.value })}
            placeholder="0 9 * * *"
          />
          <p className="wf-hint">
            {tx("e.g. “0 9 * * *” runs every day at 9am.", "مثال: «0 9 * * *» يعمل كل يوم الساعة 9 صباحًا.")}
          </p>
        </div>
        <div className="wf-field">
          <label className="wf-label" htmlFor="wf-trg-tz">
            {tx("Timezone", "المنطقة الزمنية")}
          </label>
          <input
            id="wf-trg-tz"
            className="wf-input"
            dir="ltr"
            value={(triggerConfig.timezone as string) ?? "Asia/Riyadh"}
            onChange={(e) => onChange({ ...triggerConfig, timezone: e.target.value })}
          />
        </div>
      </>
    );
  }

  if (triggerType === "webhook") {
    if (!workflowId || !webhookSecret) {
      return (
        <div className="wf-callout info">
          {tx(
            "The webhook URL and secret will appear here after you save this workflow for the first time.",
            "سيظهر رابط الويبهوك والمفتاح السري هنا بعد حفظ هذه الأتمتة لأول مرة.",
          )}
        </div>
      );
    }
    const url = `${API_BASE}/webhooks/workflows/${workflowId}`;
    return (
      <>
        <div className="wf-field">
          <label className="wf-label" htmlFor="wf-trg-url">
            {tx("Webhook URL", "رابط الويبهوك")}
          </label>
          <input id="wf-trg-url" className="wf-input" dir="ltr" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
        </div>
        <div className="wf-field">
          <label className="wf-label" htmlFor="wf-trg-secret">
            {tx("Secret", "المفتاح السري")}
          </label>
          <input
            id="wf-trg-secret"
            className="wf-input"
            dir="ltr"
            readOnly
            value={webhookSecret}
            onFocus={(e) => e.currentTarget.select()}
          />
        </div>
        <p className="wf-hint">
          {tx(
            "Sign requests with an X-Workflow-Signature header: hex-encoded HMAC-SHA256 of the raw request body, keyed with this secret.",
            "وقّع الطلبات برأس X-Workflow-Signature: قيمة HMAC-SHA256 بترميز hex لجسم الطلب الخام، باستخدام هذا المفتاح السري.",
          )}
        </p>
      </>
    );
  }

  return null;
}
