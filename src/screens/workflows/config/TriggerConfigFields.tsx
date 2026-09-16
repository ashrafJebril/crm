import type { Tx } from "@/lib/tx";
import { useFetch } from "@/api/useFetch";
import type { Pipeline, WorkflowTriggerType } from "@/lib/types";

export function TriggerConfigFields({
  triggerType,
  triggerConfig,
  onChange,
  tx,
}: {
  triggerType: WorkflowTriggerType;
  triggerConfig: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
  tx: Tx;
}) {
  const { data: pipelines } = useFetch<Pipeline[]>(triggerType === "ticket_stage_changed" ? "/pipelines" : null);

  if (triggerType === "ticket_stage_changed") {
    const stages = (pipelines ?? []).flatMap((p) => p.stages.map((s) => ({ id: s.id, label: `${p.name} / ${s.label}` })));
    return (
      <div style={{ marginTop: 8 }}>
        <label style={{ fontSize: 12, color: "var(--ink-3)" }}>
          {tx("Only for this stage (optional)", "لهذه المرحلة فقط (اختياري)")}
        </label>
        <select
          value={(triggerConfig.stageId as string) ?? ""}
          onChange={(e) => onChange({ ...triggerConfig, stageId: e.target.value || undefined })}
          style={{ display: "block", width: "100%", marginTop: 4 }}
        >
          <option value="">{tx("Any stage", "أي مرحلة")}</option>
          {stages.map((s) => (
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
      <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
        <div>
          <label style={{ fontSize: 12, color: "var(--ink-3)" }}>
            {tx("Cron expression", "تعبير كرون")}
          </label>
          <input
            value={(triggerConfig.cron as string) ?? ""}
            onChange={(e) => onChange({ ...triggerConfig, cron: e.target.value })}
            placeholder="0 9 * * *"
            style={{ display: "block", width: "100%", marginTop: 4 }}
          />
          <p className="muted" style={{ fontSize: 11, marginTop: 2 }}>
            {tx("e.g. \"0 9 * * *\" runs every day at 9am.", "مثال: \"0 9 * * *\" يعمل كل يوم الساعة 9 صباحًا.")}
          </p>
        </div>
        <div>
          <label style={{ fontSize: 12, color: "var(--ink-3)" }}>{tx("Timezone", "المنطقة الزمنية")}</label>
          <input
            value={(triggerConfig.timezone as string) ?? "Asia/Riyadh"}
            onChange={(e) => onChange({ ...triggerConfig, timezone: e.target.value })}
            style={{ display: "block", width: "100%", marginTop: 4 }}
          />
        </div>
      </div>
    );
  }

  return null;
}
