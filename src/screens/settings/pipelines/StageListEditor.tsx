import { useState } from "react";
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
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Tx } from "@/lib/tx";
import { stageColor } from "@/screens/pipeline/stageColors";
import { inputStyle } from "../form";
import {
  STAGE_COLORS,
  addStage,
  moveStage,
  moveTargetsFor,
  isBuiltInStage,
  removeStage,
  reorderStages,
  restoreStage,
  setRemovedMoveTo,
  setStageLost,
  setStageWon,
  updateStage,
  type DraftError,
  type DraftStage,
  type PipelineDraft,
} from "./draft";

interface Props {
  draft: PipelineDraft;
  original: PipelineDraft;
  onChange: (d: PipelineDraft) => void;
  readOnly: boolean;
  errors: DraftError[];
  tx: Tx;
}

const small: React.CSSProperties = { ...inputStyle, height: 32, fontSize: 12.5, padding: "0 8px" };
const iconBtn: React.CSSProperties = {
  background: "var(--bg-2)",
  border: "1px solid var(--line)",
  borderRadius: 6,
  color: "var(--ink-2)",
  width: 28,
  height: 28,
  cursor: "pointer",
  fontSize: 13,
};

const COLOR_NAMES: Record<string, [string, string]> = {
  ink: ["Grey", "رمادي"],
  info: ["Blue", "أزرق"],
  ok: ["Green", "أخضر"],
  warn: ["Amber", "كهرماني"],
  bad: ["Red", "أحمر"],
  accent: ["Accent", "مميز"],
  human: ["Purple", "بنفسجي"],
};

function StageRow({
  stage,
  index,
  count,
  draft,
  onChange,
  readOnly,
  errored,
  tx,
}: {
  stage: DraftStage;
  index: number;
  count: number;
  draft: PipelineDraft;
  onChange: (d: PipelineDraft) => void;
  readOnly: boolean;
  errored: boolean;
  tx: Tx;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: stage.clientId,
    disabled: readOnly,
  });
  const [confirming, setConfirming] = useState(false);
  const [target, setTarget] = useState("");
  const targets = moveTargetsFor(draft, stage.clientId);
  const lost = stage.isTerminal && !stage.isWon;
  const patch = (p: Partial<DraftStage>) => onChange(updateStage(draft, stage.clientId, p));

  const onRemove = () => {
    if (
      isBuiltInStage(stage) &&
      !window.confirm(
        tx(
          "This is a built-in stage. Automations that rely on it will stop working.",
          "هذه مرحلة مدمجة. ستتوقف عمليات الأتمتة التي تعتمد عليها.",
        ),
      )
    )
      return;
    if (stage.id && stage.ticketCount > 0) {
      setConfirming(true);
      setTarget(targets[0]?.id ?? "");
    } else {
      onChange(removeStage(draft, stage.clientId));
    }
  };

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.6 : 1,
        background: "var(--bg-1)",
        border: `1px solid ${errored ? "var(--bad, #ef4444)" : "var(--line-soft)"}`,
        borderRadius: 10,
        padding: 10,
        display: "grid",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button
          type="button"
          aria-label={tx("Drag to reorder", "اسحب لإعادة الترتيب")}
          title={tx("Drag to reorder", "اسحب لإعادة الترتيب")}
          disabled={readOnly}
          style={{ ...iconBtn, cursor: readOnly ? "default" : "grab", touchAction: "none" }}
          {...attributes}
          {...listeners}
        >
          ⋮⋮
        </button>
        <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)", minWidth: 18 }}>
          {index + 1}
        </span>
        <input
          dir="auto"
          style={{ ...small, flex: "1 1 130px", width: "auto" }}
          value={stage.label}
          disabled={readOnly}
          placeholder={tx("Label (English)", "الاسم (إنجليزي)")}
          aria-label={tx("Stage label in English", "اسم المرحلة بالإنجليزية")}
          maxLength={60}
          onChange={(e) => patch({ label: e.target.value })}
        />
        <input
          dir="rtl"
          style={{ ...small, flex: "1 1 130px", width: "auto" }}
          value={stage.labelAr}
          disabled={readOnly}
          placeholder={tx("Label (Arabic)", "الاسم (عربي)")}
          aria-label={tx("Stage label in Arabic", "اسم المرحلة بالعربية")}
          maxLength={60}
          onChange={(e) => patch({ labelAr: e.target.value })}
        />
        {!readOnly ? (
          <div style={{ display: "flex", gap: 4 }}>
            <button
              type="button"
              style={iconBtn}
              disabled={index === 0}
              aria-label={tx("Move up", "تحريك لأعلى")}
              title={tx("Move up", "تحريك لأعلى")}
              onClick={() => onChange(moveStage(draft, stage.clientId, -1))}
            >
              ↑
            </button>
            <button
              type="button"
              style={iconBtn}
              disabled={index === count - 1}
              aria-label={tx("Move down", "تحريك لأسفل")}
              title={tx("Move down", "تحريك لأسفل")}
              onClick={() => onChange(moveStage(draft, stage.clientId, 1))}
            >
              ↓
            </button>
            <button
              type="button"
              style={{ ...iconBtn, color: "var(--bad, #ef4444)" }}
              aria-label={tx("Remove stage", "حذف المرحلة")}
              title={tx("Remove stage", "حذف المرحلة")}
              onClick={onRemove}
            >
              ✕
            </button>
          </div>
        ) : null}
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <div role="radiogroup" aria-label={tx("Colour", "اللون")} style={{ display: "flex", gap: 5 }}>
          {STAGE_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={stage.color === c}
              disabled={readOnly}
              title={tx(COLOR_NAMES[c][0], COLOR_NAMES[c][1])}
              aria-label={tx(COLOR_NAMES[c][0], COLOR_NAMES[c][1])}
              onClick={() => patch({ color: c })}
              style={{
                width: 20,
                height: 20,
                borderRadius: 999,
                background: stageColor[c],
                border: stage.color === c ? "2px solid var(--ink)" : "2px solid transparent",
                outline: "1px solid var(--line)",
                cursor: readOnly ? "default" : "pointer",
                padding: 0,
              }}
            />
          ))}
        </div>
        <label style={{ display: "flex", gap: 5, alignItems: "center", fontSize: 12 }}>
          <input
            type="checkbox"
            checked={stage.isWon}
            disabled={readOnly}
            onChange={(e) => onChange(setStageWon(draft, stage.clientId, e.target.checked))}
          />
          {tx("Won", "فوز")}
        </label>
        <label style={{ display: "flex", gap: 5, alignItems: "center", fontSize: 12 }}>
          <input
            type="checkbox"
            checked={lost}
            disabled={readOnly}
            onChange={(e) => onChange(setStageLost(draft, stage.clientId, e.target.checked))}
          />
          {tx("Lost", "خسارة")}
        </label>
        <label style={{ display: "flex", gap: 5, alignItems: "center", fontSize: 12 }}>
          <span className="muted">{tx("SLA (min)", "مدة الخدمة (دقيقة)")}</span>
          <input
            type="number"
            min={1}
            style={{ ...small, width: 84 }}
            value={stage.slaMinutes ?? ""}
            disabled={readOnly}
            onChange={(e) => patch({ slaMinutes: e.target.value === "" ? null : Number(e.target.value) })}
          />
        </label>
        {stage.id ? (
          <span className="muted" style={{ fontSize: 11 }}>
            {tx(`${stage.ticketCount} card(s)`, `${stage.ticketCount} بطاقة`)}
          </span>
        ) : (
          <span className="muted" style={{ fontSize: 11 }}>
            {tx("New", "جديدة")}
          </span>
        )}
      </div>

      {confirming ? (
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap",
            padding: 8,
            background: "var(--bg-2)",
            borderRadius: 8,
          }}
        >
          <span style={{ fontSize: 12 }}>{tx("Move cards to…", "نقل البطاقات إلى…")}</span>
          <select
            style={{ ...small, width: "auto", minWidth: 150 }}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            aria-label={tx("Move cards to", "نقل البطاقات إلى")}
          >
            {targets.length === 0 ? <option value="">—</option> : null}
            {targets.map((s) => (
              <option key={s.clientId} value={s.id}>
                {tx(s.label || "—", s.labelAr || s.label || "—")}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!target}
            className="btn primary"
            onClick={() => {
              onChange(removeStage(draft, stage.clientId, target));
              setConfirming(false);
            }}
          >
            {tx("Remove stage", "حذف المرحلة")}
          </button>
          <button type="button" className="btn" onClick={() => setConfirming(false)}>
            {tx("Cancel", "إلغاء")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function StageListEditor({ draft, original, onChange, readOnly, errors, tx }: Props) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const errored = new Set(errors.filter((e) => e.stage).map((e) => e.stage));

  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const from = draft.stages.findIndex((s) => s.clientId === e.active.id);
    const to = draft.stages.findIndex((s) => s.clientId === e.over!.id);
    onChange(reorderStages(draft, from, to));
  };

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={draft.stages.map((s) => s.clientId)} strategy={verticalListSortingStrategy}>
          {draft.stages.map((s, i) => (
            <StageRow
              key={s.clientId}
              stage={s}
              index={i}
              count={draft.stages.length}
              draft={draft}
              onChange={onChange}
              readOnly={readOnly}
              errored={errored.has(s.clientId)}
              tx={tx}
            />
          ))}
        </SortableContext>
      </DndContext>

      {!readOnly ? (
        <div>
          <button type="button" className="btn" onClick={() => onChange(addStage(draft))}>
            + {tx("Add stage", "إضافة مرحلة")}
          </button>
        </div>
      ) : null}

      {draft.removed.length > 0 ? (
        <div style={{ display: "grid", gap: 6, marginTop: 6 }}>
          <div className="mono muted" style={{ fontSize: 11, textTransform: "uppercase" }}>
            {tx("Removed on save", "ستُحذف عند الحفظ")}
          </div>
          {draft.removed.map((r) => {
            const needs = r.ticketCount > 0; // required only then; the select is always shown
            const targets = draft.stages.filter((s) => s.id);
            const bad = errors.some((e) => e.removedStage === r.stageId);
            return (
              <div
                key={r.stageId}
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  flexWrap: "wrap",
                  fontSize: 12,
                  padding: "6px 8px",
                  border: `1px solid ${bad ? "var(--bad, #ef4444)" : "var(--line-soft)"}`,
                  borderRadius: 8,
                }}
              >
                <span dir="auto" style={{ flex: "1 1 120px", textDecoration: "line-through" }}>
                  {tx(r.label || "—", r.labelAr || r.label || "—")}
                </span>
                {
                  <>
                    <span className="muted">
                      {needs
                        ? tx(`${r.ticketCount} card(s) move to`, `تنقل ${r.ticketCount} بطاقة إلى`)
                        : tx("Any new cards move to", "أي بطاقات جديدة تنقل إلى")}
                    </span>
                    <select
                      style={{ ...small, width: "auto", minWidth: 140 }}
                      value={r.moveTo ?? ""}
                      disabled={readOnly}
                      onChange={(e) => onChange(setRemovedMoveTo(draft, r.stageId, e.target.value || undefined))}
                      aria-label={tx("Move cards to", "نقل البطاقات إلى")}
                    >
                      <option value="">{tx("Choose…", "اختر…")}</option>
                      {targets.map((s) => (
                        <option key={s.clientId} value={s.id}>
                          {tx(s.label || "—", s.labelAr || s.label || "—")}
                        </option>
                      ))}
                    </select>
                  </>
                }
                {!readOnly ? (
                  <button type="button" className="btn" onClick={() => onChange(restoreStage(draft, r.stageId, original))}>
                    {tx("Undo", "تراجع")}
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
