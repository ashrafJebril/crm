import { useMemo, useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { canSave, newStep, type Automation, type Step, type StepKind, type Trigger } from "@/lib/automations";
import { Toggle } from "@/components/Toggle";
import { Modal } from "@/components/Modal";
import { IconArrow } from "@/icons";
import { suggestName, summarize } from "./catalog";
import { TriggerPicker } from "./TriggerPicker";
import { AddStepMenu, StepCard } from "./StepCard";
import { useLabelContext } from "./useLabelContext";

interface AutomationBuilderProps {
  initial: Automation;
  onSave: (a: Automation) => void;
  onBack: () => void;
}

export default function AutomationBuilder({ initial, onSave, onBack }: AutomationBuilderProps) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const ctx = useLabelContext();
  const [draft, setDraft] = useState<Automation>(initial);
  const [expanded, setExpanded] = useState<string | null>(
    initial.steps.find((s) => s.kind !== "wait" && s.templateId === null)?.id ?? null,
  );
  const [confirmLeave, setConfirmLeave] = useState(false);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(initial), [draft, initial]);
  const displayName = draft.nameEdited ? draft.name : suggestName(draft, t.lang, ctx);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const patch = (p: Partial<Automation>) => setDraft((d) => ({ ...d, ...p }));
  const setTrigger = (trigger: Trigger) => patch({ trigger });
  const updateStep = (s: Step) => patch({ steps: draft.steps.map((x) => (x.id === s.id ? s : x)) });
  const removeStep = (id: string) => patch({ steps: draft.steps.filter((x) => x.id !== id) });
  const addStep = (kind: StepKind) => {
    const s = newStep(kind);
    patch({ steps: [...draft.steps, s] });
    setExpanded(s.id);
  };
  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = draft.steps.findIndex((s) => s.id === active.id);
    const to = draft.steps.findIndex((s) => s.id === over.id);
    if (from === -1 || to === -1) return;
    patch({ steps: arrayMove(draft.steps, from, to) });
  };

  const missingHint = !draft.trigger
    ? tx("Choose a trigger to continue.", "اختر مشغّلاً للمتابعة.")
    : !canSave(draft)
      ? tx("Add a WhatsApp or Email step and pick a template.", "أضف خطوة واتساب أو بريد واختر قالباً.")
      : null;

  const back = () => (dirty ? setConfirmLeave(true) : onBack());

  return (
    <div style={{ overflowY: "auto", flex: 1 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "16px 24px",
          borderBottom: "1px solid var(--line-soft)",
          position: "sticky",
          top: 0,
          background: "var(--bg-1)",
          zIndex: 2,
        }}
      >
        <button type="button" className="btn" onClick={back} aria-label={tx("Back", "رجوع")}>
          <span className="flip-rtl" style={{ display: "inline-flex", transform: "rotate(180deg)" }}><IconArrow w={14} /></span>
        </button>
        <input
          value={displayName}
          onChange={(e) => patch({ name: e.target.value, nameEdited: true })}
          aria-label={tx("Automation name", "اسم الأتمتة")}
          style={{ flex: 1, fontSize: 18, fontWeight: 600, border: 0, background: "transparent", color: "inherit", outline: "none", minWidth: 0 }}
        />
        <Toggle on={draft.enabled} onChange={(v) => patch({ enabled: v })} label={tx("Enabled", "مفعّلة")} />
        <button
          type="button"
          className="btn primary"
          disabled={!canSave(draft)}
          title={missingHint ?? undefined}
          onClick={() => onSave({ ...draft, name: displayName })}
        >
          {tx("Save", "حفظ")}
        </button>
      </div>

      <div style={{ maxWidth: 640, margin: "0 auto", padding: "24px 16px 60px", display: "grid", gap: 0 }}>
        <div style={{ color: "var(--ink-3)", fontSize: 13, marginBottom: 16 }}>{summarize(draft, t.lang, ctx)}</div>

        <TriggerPicker trigger={draft.trigger} onChange={setTrigger} ctx={ctx} />

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={draft.steps.map((s) => s.id)} strategy={verticalListSortingStrategy}>
            {draft.steps.map((s) => (
              <div key={s.id}>
                <Connector />
                <StepCard
                  step={s}
                  trigger={draft.trigger}
                  expanded={expanded === s.id}
                  onToggle={() => setExpanded(expanded === s.id ? null : s.id)}
                  onChange={updateStep}
                  onRemove={() => removeStep(s.id)}
                />
              </div>
            ))}
          </SortableContext>
        </DndContext>

        <Connector />
        <AddStepMenu onAdd={addStep} />

        {missingHint && (
          <div style={{ textAlign: "center", color: "var(--ink-3)", fontSize: 12, marginTop: 16 }}>{missingHint}</div>
        )}
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

/** Thin vertical line joining the cards. */
function Connector() {
  return (
    <div style={{ display: "grid", justifyItems: "center", height: 20 }}>
      <div style={{ width: 2, height: "100%", background: "var(--line)" }} />
    </div>
  );
}
