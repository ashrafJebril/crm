import { Fragment, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx, type Tx } from "@/lib/tx";
import type { Lang, Pipeline, TagRow } from "@/lib/types";
import { useFetch } from "@/api/useFetch";
import {
  canSave,
  missingTokens,
  renderTemplate,
  type Automation,
  type AutomationTemplate,
  type ConversationChannel,
  type Trigger,
} from "@/lib/automations";
import { Toggle } from "@/components/Toggle";
import { Modal } from "@/components/Modal";
import { PhonePreview } from "@/components/PhonePreview";
import { IconArrow, IconCheck, IconChev } from "@/icons";
import {
  MOCK_TEMPLATES,
  SAMPLE,
  TRIGGERS,
  suggestName,
  summarize,
  suppliedTokens,
  templateById,
  triggerDef,
  triggerLabel,
  type LabelContext,
} from "./catalog";
import {
  CUSTOM_DELAY,
  DELAY_PRESETS,
  delayKey,
  delayLabel,
  messagesFromSteps,
  messagesReady,
  stepsFromMessages,
  type ChannelDraft,
  type Delay,
  type MessagesDraft,
} from "./wizard";
import { CHANNEL_META, TRIGGER_ICON, TRIGGER_TINT, TintIcon, type Channel } from "./triggerMeta";
import { TemplatePreview, warningText } from "./TemplatePicker";
import { useLabelContext } from "./useLabelContext";

// ─── shared bits (same look as the Campaigns wizard) ─────────────────────

const INPUT_STYLE: CSSProperties = {
  height: 34,
  padding: "0 10px",
  borderRadius: 8,
  background: "var(--bg-1)",
  border: "1px solid var(--line-soft)",
  color: "var(--ink)",
  fontSize: 13,
  outline: 0,
  fontFamily: "inherit",
  minWidth: 0,
};

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: "grid", gridTemplateColumns: "140px minmax(0, 1fr)", alignItems: "center", gap: 12 }}>
      <span style={{ fontSize: 12, color: "var(--ink-2)" }}>{label}</span>
      {children}
    </label>
  );
}

const triggerIncomplete = (tr: Trigger | null): boolean =>
  !!tr &&
  ((tr.kind === "deal.stage_changed" && (!tr.pipelineId || !tr.stageId)) ||
    (tr.kind === "contact.tagged" && !tr.tagId));

// ─── Step 1: When ────────────────────────────────────────────────────────

interface TriggerStepProps {
  tx: Tx;
  lang: Lang;
  trigger: Trigger | null;
  onChange: (t: Trigger) => void;
}

function TriggerStep({ tx, lang, trigger, onChange }: TriggerStepProps) {
  const pipelinesQ = useFetch<Pipeline[]>("/pipelines", { enabled: trigger?.kind === "deal.stage_changed" });
  const tagsQ = useFetch<TagRow[]>("/tags", { enabled: trigger?.kind === "contact.tagged" });
  const pipelines = pipelinesQ.data ?? [];
  const pipeline =
    trigger?.kind === "deal.stage_changed"
      ? pipelines.find((p) => p.id === trigger.pipelineId) ?? pipelines.find((p) => p.isDefault) ?? pipelines[0]
      : undefined;

  // Keep the model in step with the pipeline the select displays.
  useEffect(() => {
    if (trigger?.kind === "deal.stage_changed" && trigger.pipelineId === "" && pipeline) {
      onChange({ ...trigger, pipelineId: pipeline.id });
    }
  }, [trigger, pipeline, onChange]);

  return (
    <div className="card">
      <div className="card-h">
        <div>
          <h3>{tx("What starts this automation?", "ما الذي يبدأ هذه الأتمتة؟")}</h3>
          <div className="sub">{tx("Pick one event. You can change it later.", "اختر حدثاً واحداً. يمكنك تغييره لاحقاً.")}</div>
        </div>
      </div>
      <div style={{ padding: 18, display: "grid", gap: 18 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: 10 }}>
          {TRIGGERS.map((def) => {
            const active = trigger?.kind === def.kind;
            const Icon = TRIGGER_ICON[def.kind];
            return (
              <button
                key={def.kind}
                type="button"
                onClick={() => onChange(active && trigger ? trigger : def.defaults)}
                aria-pressed={active}
                style={{
                  textAlign: "start",
                  padding: 14,
                  borderRadius: 12,
                  border: `1px solid ${active ? "var(--accent-ring)" : "var(--line-soft)"}`,
                  background: active ? "var(--accent-soft)" : "var(--bg-1)",
                  color: "inherit",
                  cursor: "pointer",
                  display: "grid",
                  gridTemplateColumns: "auto 1fr auto",
                  alignItems: "start",
                  gap: 12,
                }}
              >
                <TintIcon Icon={Icon} tint={TRIGGER_TINT[def.kind]} />
                <span style={{ display: "grid", gap: 3 }}>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{tx(def.en, def.ar)}</span>
                  <span style={{ fontSize: 12, color: "var(--ink-3)", lineHeight: 1.35 }}>{tx(def.descEn, def.descAr)}</span>
                </span>
                {active && <IconCheck w={14} />}
              </button>
            );
          })}
        </div>

        {trigger && (
          <div style={{ borderTop: "1px solid var(--line-soft)", paddingTop: 16, display: "grid", gap: 12 }}>
            {trigger.kind === "deal.stage_changed" && (
              <>
                <Field label={tx("Pipeline", "المسار")}>
                  <select
                    style={INPUT_STYLE}
                    value={pipeline?.id ?? ""}
                    onChange={(e) => onChange({ ...trigger, pipelineId: e.target.value, stageId: "" })}
                  >
                    <option value="" disabled>{tx("Select…", "اختر…")}</option>
                    {pipelines.map((p) => (
                      <option key={p.id} value={p.id}>{lang === "ar" ? p.nameAr || p.name : p.name}</option>
                    ))}
                  </select>
                </Field>
                <Field label={tx("Stage", "المرحلة")}>
                  <select
                    style={INPUT_STYLE}
                    value={trigger.stageId}
                    disabled={!pipeline}
                    onChange={(e) => onChange({ ...trigger, pipelineId: pipeline?.id ?? trigger.pipelineId, stageId: e.target.value })}
                  >
                    <option value="" disabled>{tx("Select a stage…", "اختر مرحلة…")}</option>
                    {(pipeline?.stages ?? []).map((s) => (
                      <option key={s.id} value={s.id}>{lang === "ar" ? s.labelAr || s.label : s.label}</option>
                    ))}
                  </select>
                </Field>
              </>
            )}
            {trigger.kind === "conversation.started" && (
              <Field label={tx("Channel", "القناة")}>
                <select
                  style={INPUT_STYLE}
                  value={trigger.channel}
                  onChange={(e) => onChange({ ...trigger, channel: e.target.value as ConversationChannel })}
                >
                  <option value="any">{tx("Any channel", "أي قناة")}</option>
                  <option value="whatsapp">WhatsApp</option>
                  <option value="instagram">Instagram</option>
                  <option value="facebook">Facebook</option>
                </select>
              </Field>
            )}
            {trigger.kind === "appointment.upcoming" && (
              <Field label={tx("Remind", "التذكير")}>
                <select
                  style={INPUT_STYLE}
                  value={trigger.hoursBefore}
                  onChange={(e) => onChange({ ...trigger, hoursBefore: Number(e.target.value) })}
                >
                  {[1, 2, 24, 48].map((h) => (
                    <option key={h} value={h}>
                      {lang === "ar" ? `قبل ${h} ساعة` : `${h} hour${h === 1 ? "" : "s"} before`}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {trigger.kind === "contact.tagged" && (
              <Field label={tx("Tag", "الوسم")}>
                <select style={INPUT_STYLE} value={trigger.tagId} onChange={(e) => onChange({ ...trigger, tagId: e.target.value })}>
                  <option value="" disabled>{tx("Pick a tag…", "اختر وسماً…")}</option>
                  {(tagsQ.data ?? []).map((tag) => (
                    <option key={tag.id} value={tag.id}>{tag.name}</option>
                  ))}
                </select>
              </Field>
            )}
            {(trigger.kind === "contact.created" || trigger.kind === "appointment.booked") && (
              <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
                {tx("No settings needed for this trigger.", "لا يحتاج هذا المشغّل إلى إعدادات.")}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Step 2: Messages ────────────────────────────────────────────────────

interface ChannelPanelProps {
  tx: Tx;
  lang: Lang;
  channel: Channel;
  draft: ChannelDraft;
  trigger: Trigger | null;
  onChange: (d: ChannelDraft) => void;
}

function ChannelPanel({ tx, lang, channel, draft, trigger, onChange }: ChannelPanelProps) {
  const meta = CHANNEL_META[channel];
  const supplied = suppliedTokens(trigger);
  const templates = MOCK_TEMPLATES.filter((t) => t.channel === channel);
  const selected = templateById(draft.templateId);
  const selectedMissing = selected ? missingTokens(selected, supplied) : [];
  const presetKeys = DELAY_PRESETS.map(delayKey);
  const isCustom = !presetKeys.includes(delayKey(draft.delay));

  const pick = (tpl: AutomationTemplate) =>
    onChange({
      ...draft,
      templateId: tpl.id,
      subject: channel === "email" ? draft.subject || tpl.subject || "" : draft.subject,
    });

  return (
    <div
      className="card"
      style={{ borderColor: draft.on ? meta.fg : undefined, transition: "border-color 0.15s" }}
    >
      <div className="card-h" style={{ alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <TintIcon Icon={meta.Icon} tint={meta} />
          <div>
            <h3>{tx(`Send ${meta.en}`, `إرسال ${meta.ar}`)}</h3>
            <div className="sub">
              {channel === "whatsapp"
                ? tx("Approved template, delivered any time.", "قالب معتمد، يُرسل في أي وقت.")
                : tx("Subject and template.", "الموضوع والقالب.")}
            </div>
          </div>
        </div>
        <Toggle on={draft.on} onChange={(on) => onChange({ ...draft, on })} label={draft.on ? tx("On", "مفعّل") : tx("Off", "متوقف")} />
      </div>

      {draft.on && (
        <div style={{ padding: 18, display: "grid", gap: 12 }}>
          <Field label={tx("Template", "القالب")}>
            <select
              style={INPUT_STYLE}
              value={draft.templateId ?? ""}
              onChange={(e) => {
                const tpl = templateById(e.target.value);
                if (tpl) pick(tpl);
              }}
            >
              <option value="" disabled>{tx("Choose a template…", "اختر قالباً…")}</option>
              {templates.map((tpl) => {
                const missing = missingTokens(tpl, supplied);
                const blocked = missing.length > 0;
                return (
                  <option key={tpl.id} value={tpl.id} disabled={blocked}>
                    {tpl.name} · {tpl.lang.toUpperCase()}
                    {blocked ? ` — ${tx("needs", "يحتاج")} ${[...new Set(missing.map((m) => m.split(".")[0]))].join(", ")}` : ""}
                  </option>
                );
              })}
            </select>
          </Field>

          {channel === "email" && (
            <Field label={tx("Subject", "الموضوع")}>
              <input
                style={INPUT_STYLE}
                value={draft.subject}
                placeholder={tx("Pick a template to prefill", "اختر قالباً لتعبئته")}
                onChange={(e) => onChange({ ...draft, subject: e.target.value })}
              />
            </Field>
          )}

          <Field label={tx("Send", "الإرسال")}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <select
                style={{ ...INPUT_STYLE, flex: 1 }}
                value={isCustom ? CUSTOM_DELAY : delayKey(draft.delay)}
                onChange={(e) => {
                  if (e.target.value === CUSTOM_DELAY) {
                    onChange({ ...draft, delay: { amount: 4, unit: "hours" } });
                    return;
                  }
                  const d = DELAY_PRESETS.find((p) => delayKey(p) === e.target.value);
                  if (d) onChange({ ...draft, delay: d });
                }}
              >
                {DELAY_PRESETS.map((d) => (
                  <option key={delayKey(d)} value={delayKey(d)}>{delayLabel(d, lang)}</option>
                ))}
                <option value={CUSTOM_DELAY}>{tx("Custom…", "مخصص…")}</option>
              </select>
              {isCustom && (
                <>
                  <input
                    type="number"
                    min={1}
                    style={{ ...INPUT_STYLE, width: 80 }}
                    value={draft.delay.amount}
                    onChange={(e) => onChange({ ...draft, delay: { ...draft.delay, amount: Math.max(1, Math.floor(Number(e.target.value) || 1)) } })}
                  />
                  <select
                    style={INPUT_STYLE}
                    value={draft.delay.unit}
                    onChange={(e) => onChange({ ...draft, delay: { ...draft.delay, unit: e.target.value as Delay["unit"] } })}
                  >
                    <option value="hours">{tx("hours", "ساعات")}</option>
                    <option value="days">{tx("days", "أيام")}</option>
                  </select>
                </>
              )}
            </div>
          </Field>

          {selectedMissing.length > 0 && (
            <div style={{ fontSize: 12, color: "var(--warn, #b7791f)" }}>{warningText(selectedMissing, trigger, lang)}</div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Step 3: Review ──────────────────────────────────────────────────────

interface ReviewStepProps {
  tx: Tx;
  lang: Lang;
  automation: Automation;
  msgs: MessagesDraft;
  ctx: LabelContext;
}

function ReviewStep({ tx, lang, automation, msgs, ctx }: ReviewStepProps) {
  const tr = automation.trigger;
  const rows: { icon: ReactNode; title: string; sub: string; body?: string }[] = [];
  if (tr) {
    rows.push({
      icon: <TintIcon Icon={TRIGGER_ICON[tr.kind]} tint={TRIGGER_TINT[tr.kind]} size={32} />,
      title: triggerLabel(tr, lang, ctx),
      sub: tx(triggerDef(tr.kind).descEn, triggerDef(tr.kind).descAr),
    });
  }
  (["whatsapp", "email"] as Channel[]).forEach((ch) => {
    const d = msgs[ch];
    if (!d.on || !d.templateId) return;
    const tpl = templateById(d.templateId);
    if (!tpl) return;
    const meta = CHANNEL_META[ch];
    rows.push({
      icon: <TintIcon Icon={meta.Icon} tint={meta} size={32} />,
      title: `${tx(meta.en, meta.ar)}: ${tpl.name}`,
      sub: delayLabel(d.delay, lang),
      body: renderTemplate(ch === "email" && d.subject ? `${d.subject}\n${tpl.body}` : tpl.body, SAMPLE[tpl.lang], tpl.variableMap),
    });
  });

  return (
    <div className="card">
      <div className="card-h">
        <div>
          <h3>{tx("Review", "مراجعة")}</h3>
          <div className="sub">{summarize(automation, lang, ctx)}</div>
        </div>
      </div>
      <div style={{ padding: 18, display: "grid" }}>
        {rows.map((r, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 14 }}>
            <div style={{ display: "grid", justifyItems: "center" }}>
              {r.icon}
              {i < rows.length - 1 && <div style={{ width: 2, flex: 1, minHeight: 18, background: "var(--line)", marginBlock: 4 }} />}
            </div>
            <div style={{ paddingBottom: i < rows.length - 1 ? 16 : 0, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{r.title}</div>
              <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 2 }}>{r.sub}</div>
              {r.body && (
                <div
                  style={{
                    marginTop: 8,
                    padding: "8px 10px",
                    borderRadius: 10,
                    background: "var(--bg-2)",
                    border: "1px solid var(--line-soft)",
                    fontSize: 12.5,
                    lineHeight: 1.45,
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {r.body}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Wizard shell ────────────────────────────────────────────────────────

interface AutomationWizardProps {
  initial: Automation;
  onSave: (a: Automation) => void;
  onBack: () => void;
}

export default function AutomationWizard({ initial, onSave, onBack }: AutomationWizardProps) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const ctx = useLabelContext();
  const [draft, setDraft] = useState<Automation>(initial);
  const [msgs, setMsgs] = useState<MessagesDraft>(() => messagesFromSteps(initial.steps));
  const [step, setStep] = useState<1 | 2 | 3>(initial.trigger ? (messagesReady(messagesFromSteps(initial.steps)) ? 3 : 2) : 1);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const built = useMemo<Automation>(
    () => ({ ...draft, steps: stepsFromMessages(msgs, initial.steps) }),
    [draft, msgs, initial.steps],
  );
  const dirty = useMemo(() => JSON.stringify(built) !== JSON.stringify(initial), [built, initial]);
  const displayName = draft.nameEdited ? draft.name : suggestName(built, t.lang, ctx);

  const step1Ok = !!draft.trigger && !triggerIncomplete(draft.trigger);
  const step2Ok = messagesReady(msgs);
  const saveOk = step1Ok && step2Ok && canSave(built);

  const steps = [
    { id: 1 as const, label: tx("When", "عندما") },
    { id: 2 as const, label: tx("Messages", "الرسائل") },
    { id: 3 as const, label: tx("Review", "مراجعة") },
  ];
  const canJump = (id: 1 | 2 | 3) => id === 1 || (id === 2 && step1Ok) || (id === 3 && step1Ok && step2Ok);

  const back = () => (dirty ? setConfirmLeave(true) : onBack());

  // Right column: WhatsApp bubble, plus the email card under it when on.
  const waTpl = msgs.whatsapp.on ? templateById(msgs.whatsapp.templateId) : undefined;
  const emTpl = msgs.email.on ? templateById(msgs.email.templateId) : undefined;
  const previewBody = waTpl
    ? renderTemplate(waTpl.body, SAMPLE[waTpl.lang], waTpl.variableMap)
    : tx("Turn on WhatsApp and pick a template to preview it here.", "فعّل واتساب واختر قالباً لمعاينته هنا.");

  return (
    <div style={{ overflowY: "auto", flex: 1 }}>
      <div style={{ padding: "20px 24px 0", display: "flex", alignItems: "center", gap: 12 }}>
        <button type="button" className="btn" onClick={back} aria-label={tx("Back to list", "العودة للقائمة")} style={{ padding: 6 }}>
          <span style={{ display: "inline-flex", transform: t.lang === "ar" ? "none" : "rotate(180deg)" }}><IconArrow w={14} /></span>
        </button>
        <input
          value={displayName}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value, nameEdited: true }))}
          aria-label={tx("Automation name", "اسم الأتمتة")}
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 20,
            fontWeight: 600,
            border: 0,
            background: "transparent",
            outline: 0,
            letterSpacing: "-0.02em",
            color: "var(--ink)",
            fontFamily: "inherit",
          }}
        />
        <Toggle on={draft.enabled} onChange={(v) => setDraft((d) => ({ ...d, enabled: v }))} label={tx("Enabled", "مفعّلة")} />
      </div>

      <div style={{ padding: "16px 24px 0", display: "flex", gap: 8, flexWrap: "wrap" }}>
        {steps.map((s, i) => {
          const done = step > s.id;
          const active = step === s.id;
          return (
            <Fragment key={s.id}>
              <button
                type="button"
                disabled={!canJump(s.id)}
                onClick={() => setStep(s.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "8px 14px",
                  borderRadius: 999,
                  background: active ? "var(--accent-soft)" : done ? "var(--bg-2)" : "transparent",
                  color: active ? "var(--accent)" : done ? "var(--ink-1)" : "var(--ink-3)",
                  border: `1px solid ${active ? "var(--accent-ring)" : "var(--line-soft)"}`,
                  cursor: canJump(s.id) ? "pointer" : "default",
                  fontSize: 13,
                  fontWeight: 500,
                }}
              >
                <span className="mono" style={{ fontSize: 11, opacity: 0.7 }}>{String(s.id).padStart(2, "0")}</span>
                <span>{s.label}</span>
                {done && <IconCheck w={12} />}
              </button>
              {i < steps.length - 1 && <span style={{ alignSelf: "center", color: "var(--ink-4)" }}>—</span>}
            </Fragment>
          );
        })}
      </div>

      <div style={{ padding: 24, display: "grid", gridTemplateColumns: "minmax(0, 1fr) 340px", gap: 24 }}>
        <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
          {step === 1 && (
            <TriggerStep tx={tx} lang={t.lang} trigger={draft.trigger} onChange={(tr) => setDraft((d) => ({ ...d, trigger: tr }))} />
          )}
          {step === 2 && (
            <>
              <ChannelPanel tx={tx} lang={t.lang} channel="whatsapp" draft={msgs.whatsapp} trigger={draft.trigger} onChange={(d) => setMsgs((m) => ({ ...m, whatsapp: d }))} />
              <ChannelPanel tx={tx} lang={t.lang} channel="email" draft={msgs.email} trigger={draft.trigger} onChange={(d) => setMsgs((m) => ({ ...m, email: d }))} />
              {!step2Ok && (
                <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
                  {tx("Turn on at least one channel and choose a template.", "فعّل قناة واحدة على الأقل واختر قالباً.")}
                </div>
              )}
            </>
          )}
          {step === 3 && <ReviewStep tx={tx} lang={t.lang} automation={built} msgs={msgs} ctx={ctx} />}

          <div style={{ display: "flex", justifyContent: "space-between", paddingTop: 8 }}>
            <button type="button" className="btn" onClick={() => (step === 1 ? back() : setStep((s) => (s === 3 ? 2 : 1)))}>
              {tx("Back", "رجوع")}
            </button>
            {step < 3 ? (
              <button
                type="button"
                className="btn primary"
                disabled={step === 1 ? !step1Ok : !step2Ok}
                onClick={() => setStep((s) => (s === 1 ? 2 : 3))}
              >
                {tx("Continue", "متابعة")}
                <span className="flip-rtl" style={{ display: "inline-flex" }}><IconChev w={12} /></span>
              </button>
            ) : (
              <button type="button" className="btn primary" disabled={!saveOk} onClick={() => onSave({ ...built, name: displayName })}>
                {draft.enabled ? tx("Turn on", "تفعيل") : tx("Save", "حفظ")}
              </button>
            )}
          </div>
        </div>

        <PhonePreview
          tx={tx}
          body={previewBody}
          dir={waTpl ? (waTpl.lang === "ar" ? "rtl" : "ltr") : undefined}
          footer={
            emTpl ? (
              <div>
                <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", marginBottom: 8, letterSpacing: 0.06 }}>
                  {tx("Email preview", "معاينة البريد")}
                </div>
                <TemplatePreview template={emTpl} subject={msgs.email.subject} />
              </div>
            ) : null
          }
        />
      </div>

      {confirmLeave && (
        <Modal onClose={() => setConfirmLeave(false)} label={tx("Unsaved changes", "تغييرات غير محفوظة")}>
          <h3 style={{ marginTop: 0 }}>{tx("Leave without saving?", "الخروج دون حفظ؟")}</h3>
          <p style={{ color: "var(--ink-3)", fontSize: 13 }}>
            {tx("Your changes to this automation will be lost.", "ستفقد تغييراتك على هذه الأتمتة.")}
          </p>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className="btn" onClick={() => setConfirmLeave(false)}>{tx("Keep editing", "متابعة التحرير")}</button>
            <button type="button" className="btn primary" onClick={onBack}>{tx("Leave", "خروج")}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
