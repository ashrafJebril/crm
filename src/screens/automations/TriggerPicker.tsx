import { useState, type ComponentType } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import type { Pipeline, TagRow } from "@/lib/types";
import type { ConversationChannel, Trigger, TriggerKind } from "@/lib/automations";
import { useFetch } from "@/api/useFetch";
import { IconBolt, IconCal, IconClock, IconInbox, IconLayers, IconTag, IconUsers } from "@/icons";
import { TRIGGERS, triggerDef, triggerLabel, type LabelContext } from "./catalog";

const ICONS: Record<TriggerKind, ComponentType<{ w?: number }>> = {
  "contact.created": IconUsers,
  "deal.stage_changed": IconLayers,
  "conversation.started": IconInbox,
  "appointment.booked": IconCal,
  "appointment.upcoming": IconClock,
  "contact.tagged": IconTag,
};

const selectStyle = {
  padding: "8px 10px",
  border: "1px solid var(--line)",
  borderRadius: 8,
  background: "var(--bg-1)",
  color: "inherit",
  fontSize: 13,
} as const;

interface TriggerPickerProps {
  trigger: Trigger | null;
  onChange: (t: Trigger) => void;
  ctx: LabelContext;
}

export function TriggerPicker({ trigger, onChange, ctx }: TriggerPickerProps) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const [choosing, setChoosing] = useState(trigger === null);
  const pipelinesQ = useFetch<Pipeline[]>("/pipelines", { enabled: trigger?.kind === "deal.stage_changed" });
  const tagsQ = useFetch<TagRow[]>("/tags", { enabled: trigger?.kind === "contact.tagged" });

  if (choosing || !trigger) {
    return (
      <div className="card" style={{ padding: 16, borderStyle: trigger ? "solid" : "dashed" }}>
        <div style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 10 }}>
          {tx("When…", "عندما…")}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8 }}>
          {TRIGGERS.map((def) => {
            const Icon = ICONS[def.kind];
            const active = trigger?.kind === def.kind;
            return (
              <button
                key={def.kind}
                type="button"
                onClick={() => {
                  onChange(active ? trigger : def.defaults);
                  setChoosing(false);
                }}
                style={{
                  textAlign: "start",
                  padding: 12,
                  borderRadius: 10,
                  border: `1px solid ${active ? "var(--accent)" : "var(--line-soft)"}`,
                  background: "var(--bg-1)",
                  color: "inherit",
                  cursor: "pointer",
                  display: "grid",
                  gap: 6,
                }}
              >
                <Icon w={16} />
                <div style={{ fontWeight: 600, fontSize: 13 }}>{tx(def.en, def.ar)}</div>
                <div style={{ fontSize: 12, color: "var(--ink-3)" }}>{tx(def.descEn, def.descAr)}</div>
              </button>
            );
          })}
        </div>
        {trigger && (
          <button type="button" className="btn" style={{ marginTop: 10 }} onClick={() => setChoosing(false)}>
            {tx("Cancel", "إلغاء")}
          </button>
        )}
      </div>
    );
  }

  const def = triggerDef(trigger.kind);
  const Icon = ICONS[trigger.kind];
  const pipelines = pipelinesQ.data ?? [];
  const pipeline =
    trigger.kind === "deal.stage_changed"
      ? pipelines.find((p) => p.id === trigger.pipelineId) ?? pipelines.find((p) => p.isDefault) ?? pipelines[0]
      : undefined;

  return (
    <div className="card" style={{ padding: 16, display: "grid", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <IconBolt w={14} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{tx("When…", "عندما…")}</div>
          <div style={{ fontSize: 15, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
            <Icon w={16} /> {triggerLabel(trigger, t.lang, ctx)}
          </div>
        </div>
        <button type="button" className="btn" onClick={() => setChoosing(true)}>{tx("Change", "تغيير")}</button>
      </div>
      <div style={{ fontSize: 12, color: "var(--ink-3)" }}>{tx(def.descEn, def.descAr)}</div>

      {trigger.kind === "deal.stage_changed" && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <select
            style={selectStyle}
            value={pipeline?.id ?? ""}
            onChange={(e) => onChange({ ...trigger, pipelineId: e.target.value, stageId: "" })}
          >
            <option value="" disabled>{tx("Pipeline", "المسار")}</option>
            {pipelines.map((p) => (
              <option key={p.id} value={p.id}>{t.lang === "ar" ? p.nameAr || p.name : p.name}</option>
            ))}
          </select>
          <select
            style={selectStyle}
            value={trigger.stageId}
            disabled={!pipeline}
            onChange={(e) => onChange({ ...trigger, pipelineId: pipeline?.id ?? trigger.pipelineId, stageId: e.target.value })}
          >
            <option value="" disabled>{tx("Stage", "المرحلة")}</option>
            {(pipeline?.stages ?? []).map((s) => (
              <option key={s.id} value={s.id}>{t.lang === "ar" ? s.labelAr || s.label : s.label}</option>
            ))}
          </select>
        </div>
      )}

      {trigger.kind === "conversation.started" && (
        <select
          style={selectStyle}
          value={trigger.channel}
          onChange={(e) => onChange({ ...trigger, channel: e.target.value as ConversationChannel })}
        >
          <option value="any">{tx("Any channel", "أي قناة")}</option>
          <option value="whatsapp">WhatsApp</option>
          <option value="instagram">Instagram</option>
          <option value="facebook">Facebook</option>
        </select>
      )}

      {trigger.kind === "appointment.upcoming" && (
        <select
          style={selectStyle}
          value={trigger.hoursBefore}
          onChange={(e) => onChange({ ...trigger, hoursBefore: Number(e.target.value) })}
        >
          {[1, 2, 24, 48].map((h) => (
            <option key={h} value={h}>
              {t.lang === "ar" ? `قبل ${h} ساعة` : `${h} hour${h === 1 ? "" : "s"} before`}
            </option>
          ))}
        </select>
      )}

      {trigger.kind === "contact.tagged" && (
        <select style={selectStyle} value={trigger.tagId} onChange={(e) => onChange({ ...trigger, tagId: e.target.value })}>
          <option value="" disabled>{tx("Pick a tag", "اختر وسماً")}</option>
          {(tagsQ.data ?? []).map((tag) => (
            <option key={tag.id} value={tag.id}>{tag.name}</option>
          ))}
        </select>
      )}
    </div>
  );
}
