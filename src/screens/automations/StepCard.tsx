import { useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { missingTokens, type Step, type StepKind, type Trigger } from "@/lib/automations";
import { IconAlert, IconChevDown, IconClock, IconMore, IconPlus, IconSend, IconTrash } from "@/icons";
import { stepLabel, suppliedTokens, templateById } from "./catalog";
import { TemplatePicker, TemplatePreview, warningText } from "./TemplatePicker";

const WAIT_CHIPS: { amount: number; unit: "hours" | "days" }[] = [
  { amount: 1, unit: "hours" },
  { amount: 1, unit: "days" },
  { amount: 2, unit: "days" },
  { amount: 3, unit: "days" },
];

interface StepCardProps {
  step: Step;
  trigger: Trigger | null;
  expanded: boolean;
  onToggle: () => void;
  onChange: (s: Step) => void;
  onRemove: () => void;
}

export function StepCard({ step, trigger, expanded, onToggle, onChange, onRemove }: StepCardProps) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: step.id });

  const tpl = step.kind === "wait" ? undefined : templateById(step.templateId);
  const missing = tpl ? missingTokens(tpl, suppliedTokens(trigger)) : [];

  const Icon = step.kind === "wait" ? IconClock : IconSend;
  const kindLabel =
    step.kind === "whatsapp" ? tx("Send WhatsApp", "إرسال واتساب")
    : step.kind === "email" ? tx("Send Email", "إرسال بريد")
    : tx("Wait", "انتظار");

  return (
    <div
      ref={setNodeRef}
      className="card"
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.7 : 1,
        padding: 0,
        overflow: "hidden",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px" }}>
        <button
          type="button"
          aria-label={tx("Drag to reorder", "اسحب لإعادة الترتيب")}
          {...attributes}
          {...listeners}
          style={{ cursor: "grab", background: "transparent", border: 0, color: "var(--ink-3)", padding: 4, touchAction: "none" }}
        >
          <IconMore w={14} />
        </button>
        <Icon w={16} />
        <button
          type="button"
          onClick={onToggle}
          style={{ flex: 1, textAlign: "start", background: "transparent", border: 0, color: "inherit", cursor: "pointer", minWidth: 0 }}
        >
          <div style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{kindLabel}</div>
          <div style={{ fontSize: 14, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {stepLabel(step, t.lang)}
          </div>
        </button>
        {missing.length > 0 && !expanded && (
          <span title={warningText(missing, trigger, t.lang)} style={{ color: "var(--warn, #b7791f)", display: "flex" }}>
            <IconAlert w={14} />
          </span>
        )}
        <button type="button" className="btn" aria-label={tx("Remove step", "إزالة الخطوة")} style={{ padding: 6 }} onClick={onRemove}>
          <IconTrash w={13} />
        </button>
        <button
          type="button"
          className="btn"
          aria-label={expanded ? tx("Collapse", "طيّ") : tx("Expand", "توسيع")}
          style={{ padding: 6, transform: expanded ? "rotate(180deg)" : undefined }}
          onClick={onToggle}
        >
          <IconChevDown w={13} />
        </button>
      </div>

      {expanded && (
        <div style={{ borderTop: "1px solid var(--line-soft)", padding: 14, display: "grid", gap: 12, background: "var(--bg-2)" }}>
          {step.kind === "wait" && (
            <div style={{ display: "grid", gap: 10 }}>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {WAIT_CHIPS.map((c) => {
                  const active = step.amount === c.amount && step.unit === c.unit;
                  return (
                    <button
                      key={`${c.amount}${c.unit}`}
                      type="button"
                      className={`btn${active ? " primary" : ""}`}
                      onClick={() => onChange({ ...step, amount: c.amount, unit: c.unit })}
                    >
                      {stepLabel({ ...step, amount: c.amount, unit: c.unit }, t.lang).replace(/^(wait|انتظر) /, "")}
                    </button>
                  );
                })}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                <span style={{ color: "var(--ink-3)" }}>{tx("Custom", "مخصص")}</span>
                <input
                  type="number"
                  min={1}
                  value={step.amount}
                  onChange={(e) => onChange({ ...step, amount: Math.max(1, Number(e.target.value) || 1) })}
                  style={{ width: 72, padding: "6px 8px", border: "1px solid var(--line)", borderRadius: 8, background: "var(--bg-1)", color: "inherit" }}
                />
                <select
                  value={step.unit}
                  onChange={(e) => onChange({ ...step, unit: e.target.value as "hours" | "days" })}
                  style={{ padding: "6px 8px", border: "1px solid var(--line)", borderRadius: 8, background: "var(--bg-1)", color: "inherit" }}
                >
                  <option value="hours">{tx("hours", "ساعات")}</option>
                  <option value="days">{tx("days", "أيام")}</option>
                </select>
              </div>
            </div>
          )}

          {(step.kind === "whatsapp" || step.kind === "email") && (
            <>
              {step.kind === "email" && (
                <label style={{ display: "grid", gap: 4, fontSize: 12, color: "var(--ink-3)" }}>
                  {tx("Subject", "الموضوع")}
                  <input
                    value={step.subject}
                    onChange={(e) => onChange({ ...step, subject: e.target.value })}
                    placeholder={tx("Pick a template to prefill", "اختر قالباً لتعبئته")}
                    style={{ padding: "8px 10px", border: "1px solid var(--line)", borderRadius: 8, background: "var(--bg-1)", color: "inherit", fontSize: 13 }}
                  />
                </label>
              )}

              {tpl ? (
                <div style={{ display: "grid", gap: 8 }}>
                  <TemplatePreview template={tpl} subject={step.kind === "email" ? step.subject : undefined} />
                  {missing.length > 0 && (
                    <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--warn, #b7791f)", fontSize: 12 }}>
                      <IconAlert w={13} /> {warningText(missing, trigger, t.lang)}
                    </div>
                  )}
                  <button
                    type="button"
                    className="btn"
                    style={{ justifySelf: "start" }}
                    onClick={() => onChange({ ...step, templateId: null })}
                  >
                    {tx("Change template", "تغيير القالب")}
                  </button>
                </div>
              ) : (
                <TemplatePicker
                  channel={step.kind}
                  trigger={trigger}
                  selectedId={step.templateId}
                  onSelect={(chosen) =>
                    onChange(
                      step.kind === "email"
                        ? { ...step, templateId: chosen.id, subject: step.subject || chosen.subject || "" }
                        : { ...step, templateId: chosen.id },
                    )
                  }
                />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function AddStepMenu({ onAdd }: { onAdd: (kind: StepKind) => void }) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const [open, setOpen] = useState(false);
  const pick = (k: StepKind) => {
    onAdd(k);
    setOpen(false);
  };
  return (
    <div style={{ display: "grid", justifyItems: "center", gap: 8 }}>
      {!open ? (
        <button type="button" className="btn" onClick={() => setOpen(true)} style={{ borderStyle: "dashed" }}>
          <IconPlus w={14} /> {tx("Add step", "إضافة خطوة")}
        </button>
      ) : (
        <div className="card" style={{ padding: 6, display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center" }}>
          <button type="button" className="btn" onClick={() => pick("whatsapp")}><IconSend w={14} /> {tx("Send WhatsApp", "إرسال واتساب")}</button>
          <button type="button" className="btn" onClick={() => pick("email")}><IconSend w={14} /> {tx("Send Email", "إرسال بريد")}</button>
          <button type="button" className="btn" onClick={() => pick("wait")}><IconClock w={14} /> {tx("Wait", "انتظار")}</button>
          <button type="button" className="btn" onClick={() => setOpen(false)} aria-label={tx("Cancel", "إلغاء")}>✕</button>
        </div>
      )}
    </div>
  );
}
