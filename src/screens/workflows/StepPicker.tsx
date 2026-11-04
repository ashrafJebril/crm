import { useEffect, useRef, useState } from "react";
import type { Tx } from "@/lib/tx";
import type { WorkflowStepType } from "@/lib/types";
import { PICKER_SECTIONS, STEP_META } from "./stepMeta";
import { StepIcon } from "./StepNode";

/** Grouped, searchable step menu anchored under an add slot. */
export function StepPicker({
  onPick,
  onClose,
  tx,
}: {
  onPick: (type: WorkflowStepType) => void;
  onClose: () => void;
  tx: Tx;
}) {
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      // The anchor button toggles the picker itself; ignore clicks on it here.
      const anchor = ref.current?.parentElement?.querySelector("[aria-haspopup]");
      if (ref.current?.contains(e.target as Node) || anchor?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const q = query.trim().toLowerCase();
  const matches = (type: WorkflowStepType) => {
    if (!q) return true;
    const m = STEP_META[type];
    return [m.en, m.ar, m.descEn, m.descAr].some((s) => s.toLowerCase().includes(q));
  };
  const sections = PICKER_SECTIONS.map((s) => ({ ...s, types: s.types.filter(matches) })).filter((s) => s.types.length);

  return (
    <div ref={ref} className="wf-picker" role="menu" aria-label={tx("Add a step", "إضافة خطوة")}>
      <input
        autoFocus
        className="wf-input wf-picker-search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && sections[0]) onPick(sections[0].types[0]);
          if (e.key === "ArrowDown") {
            e.preventDefault();
            ref.current?.querySelector<HTMLButtonElement>(".wf-picker-item")?.focus();
          }
        }}
        placeholder={tx("Search steps…", "ابحث عن خطوة…")}
        aria-label={tx("Search steps", "ابحث عن خطوة")}
      />
      {sections.length === 0 && <div className="wf-picker-empty">{tx("No matching steps.", "لا توجد خطوات مطابقة.")}</div>}
      {sections.map((section) => (
        <div key={section.label[0]}>
          <div className="wf-picker-group">{tx(section.label[0], section.label[1])}</div>
          {section.types.map((type) => {
            const m = STEP_META[type];
            return (
              <button
                key={type}
                type="button"
                role="menuitem"
                className="wf-picker-item"
                onClick={() => onPick(type)}
                onKeyDown={(e) => {
                  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
                  e.preventDefault();
                  const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>(".wf-picker-item") ?? [])];
                  const i = items.indexOf(e.currentTarget);
                  items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
                }}
              >
                <StepIcon type={type} />
                <span>
                  <b>{tx(m.en, m.ar)}</b>
                  <small>{tx(m.descEn, m.descAr)}</small>
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
