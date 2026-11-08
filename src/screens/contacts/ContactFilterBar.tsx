import { useState, type CSSProperties } from "react";
import type { Tx } from "@/lib/tx";
import type { CustomFieldDef, Lang, Pipeline, TagRow, TeamMember } from "@/lib/types";
import { Popover } from "../inbox/Popover";
import {
  activeCount, EMPTY_CONTACT_FILTER, opsForType,
  type ContactFilter, type FieldFilter, type FieldOp,
} from "./contactFilter";
import { LIFECYCLES, lifecycleLabel } from "./lifecycle";

interface Props {
  tx: Tx;
  lang: Lang;
  filter: ContactFilter;
  onChange: (f: ContactFilter) => void;
  tags: TagRow[];
  team: TeamMember[];
  pipelines: Pipeline[];
  fieldDefs: CustomFieldDef[];
}

const FIELD: CSSProperties = {
  height: 30, padding: "0 8px", borderRadius: 6, border: "1px solid var(--line-soft)",
  background: "var(--bg-1)", color: "var(--ink)", fontSize: 12.5, fontFamily: "inherit", width: "100%",
};
const ROW: CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "5px 4px", fontSize: 13, cursor: "pointer" };
const PANEL: CSSProperties = { insetInlineEnd: "auto", insetInlineStart: 0, minWidth: 240 };

const chipClass = (active: boolean) => `btn sm ${active ? "primary" : "ghost"}`;

function opLabel(tx: Tx, op: FieldOp): string {
  switch (op) {
    case "eq": return tx("is", "يساوي");
    case "contains": return tx("contains", "يحتوي");
    case "gt": return tx("greater than", "أكبر من");
    case "lt": return tx("less than", "أقل من");
    case "set": return tx("has a value", "له قيمة");
    default: return tx("is empty", "فارغ");
  }
}

export const fieldName = (d: CustomFieldDef, lang: Lang) => (lang === "ar" ? d.labelAr || d.label : d.label);

function Tri({ tx, value, onPick, yes, no }: { tx: Tx; value: boolean | null; onPick: (v: boolean | null) => void; yes: string; no: string }) {
  return (
    <div style={{ display: "grid", gap: 4 }}>
      {([[null, tx("Any", "الكل")], [true, yes], [false, no]] as const).map(([v, label]) => (
        <button
          key={String(v)}
          type="button"
          className={chipClass(value === v)}
          aria-pressed={value === v}
          onClick={() => onPick(v)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** Filter chips for the contacts list; each opens a popover. State is owned by the caller. */
export function ContactFilterBar({ tx, lang, filter, onChange, tags, team, pipelines, fieldDefs }: Props) {
  const set = (p: Partial<ContactFilter>) => onChange({ ...filter, ...p });
  const toggleIn = (arr: string[], v: string) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  const n = activeCount(filter);
  const pipeline = pipelines.find((p) => p.id === filter.pipelineId);
  const ownerName =
    filter.ownerId === "none" ? tx("Unassigned", "غير مسند") : team.find((m) => m.id === filter.ownerId)?.name;
  const yn = (v: boolean | null) => (v === null ? "" : v ? tx("Yes", "نعم") : tx("No", "لا"));
  const ownerOptions: { id: string | null; name: string }[] = [
    { id: null, name: tx("Any owner", "أي مسؤول") },
    { id: "none", name: tx("Unassigned", "غير مسند") },
    ...team.map((m) => ({ id: m.id, name: m.name })),
  ];

  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }} role="group" aria-label={tx("Filters", "المرشحات")}>
      <Popover role="dialog" ariaLabel={tx("Lifecycle", "المرحلة")} triggerClassName={chipClass(filter.lifecycle.length > 0)} panelStyle={PANEL}
        trigger={<>{tx("Lifecycle", "المرحلة")}{filter.lifecycle.length > 0 && ` · ${filter.lifecycle.length}`}</>}>
        {() => (
          <div>
            {LIFECYCLES.map((l) => (
              <label key={l} style={ROW}>
                <input type="checkbox" checked={filter.lifecycle.includes(l)} onChange={() => set({ lifecycle: toggleIn(filter.lifecycle, l) })} />
                {lifecycleLabel(tx, l)}
              </label>
            ))}
          </div>
        )}
      </Popover>

      <Popover role="dialog" ariaLabel={tx("Tags", "الوسوم")} triggerClassName={chipClass(filter.tags.length > 0)} panelStyle={PANEL}
        trigger={<>{tx("Tags", "الوسوم")}{filter.tags.length > 0 && ` · ${filter.tags.length}`}</>}>
        {() => (
          <div>
            <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
              {(["any", "all"] as const).map((m) => (
                <button key={m} type="button" className={chipClass(filter.tagMode === m)} aria-pressed={filter.tagMode === m} onClick={() => set({ tagMode: m })}>
                  {m === "any" ? tx("Any of", "أي من") : tx("All of", "كل")}
                </button>
              ))}
            </div>
            {tags.length === 0 && <div className="muted" style={{ fontSize: 12 }}>{tx("No tags yet.", "لا وسوم بعد.")}</div>}
            {tags.map((t) => (
              <label key={t.id} style={ROW}>
                <input type="checkbox" checked={filter.tags.includes(t.name)} onChange={() => set({ tags: toggleIn(filter.tags, t.name) })} />
                <span dir="auto">{t.name}</span>
              </label>
            ))}
          </div>
        )}
      </Popover>

      <Popover role="dialog" ariaLabel={tx("Owner", "المسؤول")} triggerClassName={chipClass(!!filter.ownerId)} panelStyle={PANEL}
        trigger={<span dir="auto">{tx("Owner", "المسؤول")}{filter.ownerId && ` · ${ownerName ?? "…"}`}</span>}>
        {(close) => (
          <div style={{ display: "grid", gap: 2 }}>
            {ownerOptions.map((o) => (
              <button key={o.id ?? "any"} type="button" dir="auto" className={chipClass(filter.ownerId === o.id)} style={{ justifyContent: "flex-start" }}
                onClick={() => { set({ ownerId: o.id }); close(); }}>
                {o.name}
              </button>
            ))}
          </div>
        )}
      </Popover>

      <Popover role="dialog" ariaLabel={tx("Pipeline", "المسار")} triggerClassName={chipClass(!!filter.pipelineId)} panelStyle={PANEL}
        trigger={<span dir="auto">{tx("Pipeline", "المسار")}{pipeline && ` · ${lang === "ar" ? pipeline.nameAr || pipeline.name : pipeline.name}`}</span>}>
        {() => (
          <div style={{ display: "grid", gap: 8 }}>
            <label style={{ fontSize: 11, color: "var(--ink-3)" }}>
              {tx("Has an open ticket in", "لديه تذكرة مفتوحة في")}
              <select style={{ ...FIELD, marginTop: 4 }} value={filter.pipelineId ?? ""} onChange={(e) => set({ pipelineId: e.target.value || null, stageId: null })}>
                <option value="">{tx("Any pipeline", "أي مسار")}</option>
                {pipelines.map((p) => (
                  <option key={p.id} value={p.id}>{lang === "ar" ? p.nameAr || p.name : p.name}</option>
                ))}
              </select>
            </label>
            {pipeline && (
              <label style={{ fontSize: 11, color: "var(--ink-3)" }}>
                {tx("Stage", "المرحلة")}
                <select style={{ ...FIELD, marginTop: 4 }} value={filter.stageId ?? ""} onChange={(e) => set({ stageId: e.target.value || null })}>
                  <option value="">{tx("Any stage", "أي مرحلة")}</option>
                  {[...pipeline.stages].sort((a, b) => a.order - b.order).map((s) => (
                    <option key={s.id} value={s.id}>{lang === "ar" ? s.labelAr || s.label : s.label}</option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}
      </Popover>

      <Popover role="dialog" ariaLabel={tx("Opted out", "إلغاء الاشتراك")} triggerClassName={chipClass(filter.optOut !== null)} panelStyle={PANEL}
        trigger={<>{tx("Opted out", "إلغاء الاشتراك")}{filter.optOut !== null && ` · ${yn(filter.optOut)}`}</>}>
        {() => <Tri tx={tx} value={filter.optOut} onPick={(v) => set({ optOut: v })} yes={tx("Opted out", "ألغى الاشتراك")} no={tx("Subscribed", "مشترك")} />}
      </Popover>

      <Popover role="dialog" ariaLabel={tx("Not a lead", "ليس عميلًا محتملًا")} triggerClassName={chipClass(filter.notALead !== null)} panelStyle={PANEL}
        trigger={<>{tx("Not a lead", "ليس عميلًا محتملًا")}{filter.notALead !== null && ` · ${yn(filter.notALead)}`}</>}>
        {() => <Tri tx={tx} value={filter.notALead} onPick={(v) => set({ notALead: v })} yes={tx("Not a lead", "ليس عميلًا محتملًا")} no={tx("Lead", "عميل محتمل")} />}
      </Popover>

      <Popover role="dialog" ariaLabel={tx("Custom field", "حقل مخصص")} triggerClassName={chipClass(filter.fields.length > 0)} panelStyle={{ ...PANEL, minWidth: 280 }}
        trigger={<>{tx("Field", "حقل")}{filter.fields.length > 0 && ` · ${filter.fields.length}`}</>}>
        {() => <FieldConditions tx={tx} lang={lang} defs={fieldDefs} filter={filter} onChange={onChange} />}
      </Popover>

      {n > 0 && (
        <button type="button" className="btn ghost sm" onClick={() => onChange(EMPTY_CONTACT_FILTER)}>
          {tx("Clear filters", "مسح المرشحات")} ({n})
        </button>
      )}
    </div>
  );
}

function FieldConditions({ tx, lang, defs, filter, onChange }: { tx: Tx; lang: Lang; defs: CustomFieldDef[]; filter: ContactFilter; onChange: (f: ContactFilter) => void }) {
  const active = defs.filter((d) => !d.archivedAt);
  const [defId, setDefId] = useState("");
  const [op, setOp] = useState<FieldOp>("eq");
  const [value, setValue] = useState("");
  const def = active.find((d) => d.id === defId);
  const ops = def ? opsForType(def.type) : [];
  const needsValue = op !== "set" && op !== "unset";
  const valid = !!def && (!needsValue || value !== "");

  const pickDef = (id: string) => {
    setDefId(id);
    const d = active.find((x) => x.id === id);
    setOp(d ? opsForType(d.type)[0] : "eq");
    setValue(d?.type === "boolean" ? "true" : "");
  };
  const add = () => {
    if (!def || !valid) return;
    const cond: FieldFilter = needsValue ? { defId: def.id, op, value } : { defId: def.id, op };
    onChange({ ...filter, fields: [...filter.fields, cond] });
    setValue(def.type === "boolean" ? "true" : "");
  };
  const describe = (c: FieldFilter) => {
    const d = defs.find((x) => x.id === c.defId);
    const name = d ? fieldName(d, lang) : "?";
    const v = c.value === undefined ? "" : d?.type === "boolean" ? (c.value === "true" ? tx("Yes", "نعم") : tx("No", "لا")) : c.value;
    return `${name} ${opLabel(tx, c.op)}${v ? ` ${v}` : ""}`;
  };

  return (
    <div style={{ display: "grid", gap: 8 }}>
      {filter.fields.map((c, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
          <span dir="auto" style={{ flex: 1 }}>{describe(c)}</span>
          <button type="button" className="btn ghost sm" aria-label={tx("Remove condition", "إزالة الشرط")}
            onClick={() => onChange({ ...filter, fields: filter.fields.filter((_, j) => j !== i) })}>×</button>
        </div>
      ))}
      {active.length === 0 ? (
        <div className="muted" style={{ fontSize: 12 }}>{tx("No custom fields yet.", "لا حقول مخصصة بعد.")}</div>
      ) : (
        <>
          <select style={FIELD} aria-label={tx("Field", "حقل")} value={defId} onChange={(e) => pickDef(e.target.value)}>
            <option value="">{tx("Choose a field…", "اختر حقلًا…")}</option>
            {active.map((d) => (
              <option key={d.id} value={d.id}>{fieldName(d, lang)}</option>
            ))}
          </select>
          {def && (
            <select style={FIELD} aria-label={tx("Operator", "العملية")} value={op} onChange={(e) => setOp(e.target.value as FieldOp)}>
              {ops.map((o) => (
                <option key={o} value={o}>{opLabel(tx, o)}</option>
              ))}
            </select>
          )}
          {def && needsValue && (def.type === "select" ? (
            <select style={FIELD} aria-label={tx("Value", "القيمة")} value={value} onChange={(e) => setValue(e.target.value)}>
              <option value="">{tx("Choose…", "اختر…")}</option>
              {(def.options ?? []).map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
          ) : def.type === "boolean" ? (
            <select style={FIELD} aria-label={tx("Value", "القيمة")} value={value} onChange={(e) => setValue(e.target.value)}>
              <option value="true">{tx("Yes", "نعم")}</option>
              <option value="false">{tx("No", "لا")}</option>
            </select>
          ) : (
            <input
              style={FIELD}
              dir="auto"
              aria-label={tx("Value", "القيمة")}
              type={def.type === "number" ? "number" : def.type === "date" ? "date" : "text"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") add(); }}
            />
          ))}
          <button type="button" className="btn sm primary" disabled={!valid} onClick={add}>{tx("Add condition", "إضافة شرط")}</button>
        </>
      )}
    </div>
  );
}
