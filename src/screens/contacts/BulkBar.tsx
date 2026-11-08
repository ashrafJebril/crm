import { useState, type CSSProperties } from "react";
import type { Tx } from "@/lib/tx";
import type { Lang, Pipeline, Segment, TeamMember } from "@/lib/types";
import { IconArchive, IconTag } from "@/icons";
import { Popover } from "../inbox/Popover";

export type BulkAction =
  | { op: "removeTags" }
  | { op: "setOwner"; ownerId: string | null }
  | { op: "setOptOut"; value: boolean }
  | { op: "setNotALead"; value: boolean }
  | { op: "addToPipeline"; pipelineId: string; stageId?: string }
  | { op: "addToGroup"; segmentId: string };

interface Props {
  tx: Tx;
  lang: Lang;
  count: number;
  /** Total rows matching the current filter (for "Select all n matching"). */
  totalMatching: number;
  pageAllSelected: boolean;
  selectingAll: boolean;
  truncated: boolean;
  busy: boolean;
  team: TeamMember[];
  pipelines: Pipeline[];
  manualGroups: Segment[];
  error: string | null;
  onSelectAllMatching: () => void;
  onClear: () => void;
  onTag: () => void;
  onRemoveTag: () => void;
  onDelete: () => void;
  onAction: (a: BulkAction) => void;
}

/** Server cap for "Add to pipeline" (each new ticket can start automations). */
export const PIPELINE_BULK_CAP = 500;

const FIELD: CSSProperties = {
  height: 30, padding: "0 8px", borderRadius: 6, border: "1px solid var(--line-soft)",
  background: "var(--bg-1)", color: "var(--ink)", fontSize: 12.5, fontFamily: "inherit", width: "100%",
};
const PANEL: CSSProperties = { insetInlineEnd: "auto", insetInlineStart: 0, minWidth: 220 };

/** Bulk actions for the selected contacts, plus the "select all n matching" affordance. */
export function BulkBar(p: Props) {
  const { tx, lang } = p;
  const [pipelineId, setPipelineId] = useState("");
  const [stageId, setStageId] = useState("");
  const pipeline = p.pipelines.find((x) => x.id === pipelineId);
  const showSelectAll = p.pageAllSelected && p.totalMatching > p.count && !p.selectingAll && !p.truncated;
  const nameOf = (a: string, b: string | null | undefined) => (lang === "ar" ? b || a : a);
  const overPipelineCap = p.count > PIPELINE_BULK_CAP;
  const pipelineCapMsg = tx(
    "Add to pipeline works on up to 500 contacts at a time.",
    "الإضافة إلى المسار متاحة لـ ٥٠٠ جهة اتصال كحد أقصى في كل مرة.",
  );

  return (
    <div
      role="toolbar"
      aria-label={tx("Bulk actions", "إجراءات جماعية")}
      style={{
        padding: "10px 14px",
        border: "1px solid var(--line-soft)",
        borderRadius: 10,
        background: "var(--accent-soft)",
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
      }}
    >
      <span style={{ fontSize: 13, color: "var(--accent)", fontWeight: 500 }}>
        {p.count.toLocaleString()} {tx("selected", "محدد")}
      </span>
      {showSelectAll && (
        <button type="button" className="btn ghost sm" onClick={p.onSelectAllMatching}>
          {tx(`Select all ${p.totalMatching.toLocaleString()} matching`, `تحديد كل ${p.totalMatching.toLocaleString("ar")} المطابقة`)}
        </button>
      )}
      {p.selectingAll && <span className="muted" style={{ fontSize: 12 }}>{tx("Selecting…", "جارٍ التحديد…")}</span>}
      {p.truncated && (
        <span role="status" style={{ fontSize: 12, color: "var(--warn)" }}>
          {tx("Only the first 10,000 will be included.", "سيتم تضمين أول ١٠٬٠٠٠ فقط.")}
        </span>
      )}
      <button type="button" className="btn ghost sm" onClick={p.onClear}>{tx("Clear", "مسح")}</button>
      <span style={{ flex: 1 }} />
      {p.error && <span role="alert" style={{ fontSize: 11, color: "var(--bad)" }}>{p.error}</span>}
      {overPipelineCap && <span role="note" className="muted" style={{ fontSize: 11 }}>{pipelineCapMsg}</span>}

      <button type="button" className="btn sm" disabled={p.busy} onClick={p.onTag}>
        <IconTag w={12} /> {tx("Tag", "وسم")}
      </button>
      <button type="button" className="btn sm" disabled={p.busy} onClick={p.onRemoveTag}>
        {tx("Remove tag", "إزالة وسم")}
      </button>

      <Popover role="dialog" disabled={p.busy} ariaLabel={tx("Set owner", "تعيين المسؤول")} triggerClassName="btn sm" panelStyle={PANEL}
        trigger={tx("Set owner", "تعيين المسؤول")}>
        {(close) => (
          <div style={{ display: "grid", gap: 2 }}>
            {[{ id: null as string | null, name: tx("Unassigned", "غير مسند") }, ...p.team.map((m) => ({ id: m.id as string | null, name: m.name }))].map((o) => (
              <button key={o.id ?? "none"} type="button" dir="auto" className="btn ghost sm" style={{ justifyContent: "flex-start" }}
                onClick={() => { close(); p.onAction({ op: "setOwner", ownerId: o.id }); }}>
                {o.name}
              </button>
            ))}
          </div>
        )}
      </Popover>

      <Popover role="dialog" disabled={p.busy || overPipelineCap} ariaLabel={tx("Add to pipeline", "إضافة إلى مسار")} triggerClassName="btn sm" panelStyle={PANEL}
        title={overPipelineCap ? pipelineCapMsg : undefined}
        trigger={tx("Add to pipeline", "إضافة إلى مسار")}>
        {(close) => (
          <div style={{ display: "grid", gap: 8 }}>
            <select style={FIELD} aria-label={tx("Pipeline", "المسار")} value={pipelineId} onChange={(e) => { setPipelineId(e.target.value); setStageId(""); }}>
              <option value="">{tx("Choose a pipeline…", "اختر مسارًا…")}</option>
              {p.pipelines.map((x) => (
                <option key={x.id} value={x.id}>{nameOf(x.name, x.nameAr)}</option>
              ))}
            </select>
            {pipeline && (
              <select style={FIELD} aria-label={tx("Stage", "المرحلة")} value={stageId} onChange={(e) => setStageId(e.target.value)}>
                <option value="">{tx("First stage", "المرحلة الأولى")}</option>
                {[...pipeline.stages].sort((a, b) => a.order - b.order).map((s) => (
                  <option key={s.id} value={s.id}>{nameOf(s.label, s.labelAr)}</option>
                ))}
              </select>
            )}
            <button type="button" className="btn primary sm" disabled={!pipelineId}
              onClick={() => { close(); p.onAction({ op: "addToPipeline", pipelineId, ...(stageId ? { stageId } : {}) }); }}>
              {tx("Add", "إضافة")}
            </button>
          </div>
        )}
      </Popover>

      <Popover role="dialog" disabled={p.busy} ariaLabel={tx("More actions", "المزيد")} triggerClassName="btn sm" panelStyle={PANEL}
        trigger={tx("Marketing & lead", "التسويق والعملاء المحتملون")}>
        {(close) => {
          const run = (a: BulkAction) => () => { close(); p.onAction(a); };
          return (
            <div style={{ display: "grid", gap: 2 }}>
              <button type="button" className="btn ghost sm" style={{ justifyContent: "flex-start" }} onClick={run({ op: "setOptOut", value: true })}>
                {tx("Opt out", "إلغاء الاشتراك")}
              </button>
              <button type="button" className="btn ghost sm" style={{ justifyContent: "flex-start" }} onClick={run({ op: "setOptOut", value: false })}>
                {tx("Opt in", "إعادة الاشتراك")}
              </button>
              <button type="button" className="btn ghost sm" style={{ justifyContent: "flex-start" }} onClick={run({ op: "setNotALead", value: true })}>
                {tx("Mark not a lead", "تعليم كغير عميل محتمل")}
              </button>
              <button type="button" className="btn ghost sm" style={{ justifyContent: "flex-start" }} onClick={run({ op: "setNotALead", value: false })}>
                {tx("Mark as lead", "تعليم كعميل محتمل")}
              </button>
            </div>
          );
        }}
      </Popover>

      <select
        aria-label={tx("Add to group", "أضف إلى مجموعة")}
        disabled={p.busy}
        value=""
        onChange={(e) => {
          const id = e.target.value;
          if (id) p.onAction({ op: "addToGroup", segmentId: id });
        }}
        style={{ ...FIELD, width: 168 }}
      >
        <option value="">{tx("Add to group…", "أضف إلى مجموعة…")}</option>
        {p.manualGroups.map((g) => (
          <option key={g.id} value={g.id}>{nameOf(g.name, g.nameAr)}</option>
        ))}
      </select>

      <button type="button" className="btn sm" disabled={p.busy} onClick={p.onDelete}>
        <IconArchive w={12} /> {tx("Delete", "حذف")}
      </button>
    </div>
  );
}
