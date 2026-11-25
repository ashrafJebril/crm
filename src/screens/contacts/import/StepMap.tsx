import type { Permission } from "@/lib/permissions";
import { useMemo } from "react";
import type { Tx } from "@/lib/tx";
import type { CustomFieldDef, Lang, Pipeline, Segment, TeamMember } from "@/lib/types";
import { validateMapping, targetsFor } from "./importMapping";
import { messageText } from "./importMessages";
import type { ImportKind, ImportOptions, ImportUpload } from "./importApi";
import { ERROR_BOX, FIELD, LABEL } from "./styles";

/** Wizard-side option state (strings so inputs stay controlled). */
export interface OptionsDraft {
  matchBy: "phone_then_email" | "phone" | "email";
  updateExisting: boolean;
  tags: string;
  ownerId: string;
  groupMode: "none" | "existing" | "new";
  groupId: string;
  newGroupName: string;
  pipelineId: string;
  stageId: string;
}

export const EMPTY_OPTIONS = (kind: ImportKind): OptionsDraft => ({
  matchBy: "phone_then_email", updateExisting: false, tags: "", ownerId: "",
  groupMode: kind === "audience" ? "new" : "none", groupId: "", newGroupName: "", pipelineId: "", stageId: "",
});

/** Options the user may actually send: controls for missing permissions are dropped. */
export function toOptions(d: OptionsDraft, can: (p: Permission) => boolean): ImportOptions {
  const o: ImportOptions = { matchBy: d.matchBy };
  if (d.updateExisting && can("contacts.update")) o.updateExisting = true;
  const tags = d.tags.split(/[,;،]/).map((s) => s.trim()).filter(Boolean);
  if (tags.length) o.tags = tags;
  if (d.ownerId) o.ownerId = d.ownerId;
  if (d.groupMode === "existing" && d.groupId && can("audiences.update")) o.groupId = d.groupId;
  if (d.groupMode === "new" && d.newGroupName.trim() && can("audiences.create")) o.newGroupName = d.newGroupName.trim();
  if (d.pipelineId && can("tickets.create") && can("contacts.update")) {
    o.pipeline = { pipelineId: d.pipelineId, ...(d.stageId ? { stageId: d.stageId } : {}) };
  }
  return o;
}

interface Props {
  tx: Tx;
  lang: Lang;
  kind: ImportKind;
  upload: ImportUpload;
  mapping: Record<string, string>;
  onMapping: (m: Record<string, string>) => void;
  options: OptionsDraft;
  onOptions: (o: OptionsDraft) => void;
  customDefs: CustomFieldDef[];
  team: TeamMember[];
  pipelines: Pipeline[];
  groups: Segment[];
  can: (p: Permission) => boolean;
  error: string | null;
}

export function StepMap(p: Props) {
  const { tx, lang, kind, upload, mapping, options, can } = p;
  const targets = useMemo(() => targetsFor(p.customDefs), [p.customDefs]);
  const check = validateMapping(mapping);
  const set = (patch: Partial<OptionsDraft>) => p.onOptions({ ...options, ...patch });
  const noPerm = tx("You don't have permission to do this", "ليست لديك صلاحية للقيام بذلك");
  const canUpdate = can("contacts.update");
  const canPipeline = can("tickets.create") && can("contacts.update");
  const canExisting = can("audiences.update");
  const canNew = can("audiences.create");
  const pipeline = p.pipelines.find((x) => x.id === options.pipelineId);
  const sample = (i: number) => upload.sampleRows.map((r) => r[i]).find((v) => v && v.trim()) ?? "";
  const tooBigForPipeline = !!options.pipelineId && upload.totalRows > 500;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div>
        <div style={{ fontWeight: 600, fontSize: 13, marginBlockEnd: 2 }}>
          <bdi dir="auto">{upload.fileName}</bdi> · {upload.totalRows.toLocaleString()} {tx("rows", "صف")}
        </div>
        <div className="muted" style={{ fontSize: 12 }}>{tx("Choose what each column should be imported as.", "اختر كيف يُستورد كل عمود.")}</div>
      </div>

      <div style={{ display: "grid", gap: 6 }}>
        {upload.headers.map((h, i) => (
          <div key={h} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 10, alignItems: "center" }}>
            <div style={{ minWidth: 0 }}>
              <div dir="auto" style={{ fontSize: 13, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h}</div>
              <div dir="auto" className="muted" style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {sample(i) || tx("(empty)", "(فارغ)")}
              </div>
            </div>
            <select
              aria-label={h}
              value={mapping[h] ?? "ignore"}
              onChange={(e) => p.onMapping({ ...mapping, [h]: e.target.value })}
              style={FIELD}
            >
              {targets.map((t) => <option key={t.value} value={t.value}>{lang === "ar" ? t.ar : t.en}</option>)}
            </select>
          </div>
        ))}
      </div>
      {"error" in check && <div role="alert" style={ERROR_BOX}>{messageText(check.error, tx)}</div>}

      <fieldset style={{ border: "1px solid var(--line-soft)", borderRadius: 10, padding: 12, display: "grid", gap: 12, margin: 0 }}>
        <legend style={{ fontSize: 12, padding: "0 6px", color: "var(--ink-3)" }}>{tx("Options", "الخيارات")}</legend>

        <div>
          <label style={LABEL}>{tx("Match existing contacts by", "مطابقة الجهات الموجودة حسب")}</label>
          <select style={{ ...FIELD, width: "100%" }} value={options.matchBy} onChange={(e) => set({ matchBy: e.target.value as OptionsDraft["matchBy"] })}>
            <option value="phone_then_email">{tx("Phone, then email", "الهاتف ثم البريد")}</option>
            <option value="phone">{tx("Phone only", "الهاتف فقط")}</option>
            <option value="email">{tx("Email only", "البريد فقط")}</option>
          </select>
        </div>

        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }} title={canUpdate ? undefined : noPerm}>
          <input type="checkbox" disabled={!canUpdate} checked={options.updateExisting && canUpdate} onChange={(e) => set({ updateExisting: e.target.checked })} />
          <span>
            {tx("Update existing contacts", "تحديث الجهات الموجودة")}
            {!canUpdate && <span className="muted" style={{ fontSize: 11 }}> — {tx("requires permission to edit contacts", "تتطلب صلاحية تعديل جهات الاتصال")}</span>}
          </span>
        </label>

        <div>
          <label style={LABEL}>{tx("Add tags to every imported contact (comma-separated)", "إضافة وسوم لكل جهة مستوردة (مفصولة بفواصل)")}</label>
          <input dir="auto" style={{ ...FIELD, width: "100%" }} value={options.tags} onChange={(e) => set({ tags: e.target.value })} />
        </div>

        <div>
          <label style={LABEL}>{tx("Owner for new contacts", "المسؤول عن الجهات الجديدة")}</label>
          <select style={{ ...FIELD, width: "100%" }} value={options.ownerId} onChange={(e) => set({ ownerId: e.target.value })}>
            <option value="">{tx("No owner", "بدون مسؤول")}</option>
            {p.team.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </div>

        <div>
          <label style={LABEL}>
            {kind === "audience" ? tx("Audience group", "مجموعة الجمهور") : tx("Add to a group", "إضافة إلى مجموعة")}
          </label>
          <select
            style={{ ...FIELD, width: "100%" }}
            value={options.groupMode}
            onChange={(e) => set({ groupMode: e.target.value as OptionsDraft["groupMode"] })}
          >
            {kind !== "audience" && <option value="none">{tx("No group", "بدون مجموعة")}</option>}
            <option value="existing" disabled={!canExisting}>{tx("Existing group", "مجموعة موجودة")}{canExisting ? "" : ` (${tx("no permission", "لا صلاحية")})`}</option>
            <option value="new" disabled={!canNew}>{tx("New group", "مجموعة جديدة")}{canNew ? "" : ` (${tx("no permission", "لا صلاحية")})`}</option>
          </select>
          {!canExisting && !canNew && <div className="muted" style={{ fontSize: 11, marginBlockStart: 4 }}>{tx("Adding to groups requires audience permissions.", "الإضافة إلى المجموعات تتطلب صلاحيات الجمهور.")}</div>}
          {options.groupMode === "existing" && (
            <select style={{ ...FIELD, width: "100%", marginBlockStart: 6 }} value={options.groupId} onChange={(e) => set({ groupId: e.target.value })}>
              <option value="">{tx("Choose a group…", "اختر مجموعة…")}</option>
              {p.groups.map((g) => <option key={g.id} value={g.id}>{lang === "ar" && g.nameAr ? g.nameAr : g.name}</option>)}
            </select>
          )}
          {options.groupMode === "new" && (
            <input dir="auto" placeholder={tx("Group name", "اسم المجموعة")} style={{ ...FIELD, width: "100%", marginBlockStart: 6 }} value={options.newGroupName} onChange={(e) => set({ newGroupName: e.target.value })} />
          )}
        </div>

        {kind === "contacts" && (
          <div title={canPipeline ? undefined : noPerm}>
            <label style={LABEL}>{tx("Add to a pipeline (max 500 rows)", "إضافة إلى مسار (حتى 500 صف)")}</label>
            <select style={{ ...FIELD, width: "100%" }} disabled={!canPipeline} value={options.pipelineId} onChange={(e) => set({ pipelineId: e.target.value, stageId: "" })}>
              <option value="">{tx("Don't add", "عدم الإضافة")}</option>
              {p.pipelines.map((pl) => <option key={pl.id} value={pl.id}>{lang === "ar" && pl.nameAr ? pl.nameAr : pl.name}</option>)}
            </select>
            {!canPipeline && <div className="muted" style={{ fontSize: 11, marginBlockStart: 4 }}>{tx("Requires permission to create tickets and edit contacts.", "تتطلب صلاحية إنشاء التذاكر وتعديل جهات الاتصال.")}</div>}
            {pipeline && (
              <select style={{ ...FIELD, width: "100%", marginBlockStart: 6 }} value={options.stageId} onChange={(e) => set({ stageId: e.target.value })}>
                <option value="">{tx("First stage", "المرحلة الأولى")}</option>
                {pipeline.stages.map((s) => <option key={s.id} value={s.id}>{lang === "ar" && s.labelAr ? s.labelAr : s.label}</option>)}
              </select>
            )}
            {tooBigForPipeline && <div style={{ ...ERROR_BOX, marginBlockStart: 6 }}>{messageText("imports.pipeline_too_large", tx)}</div>}
          </div>
        )}
      </fieldset>
      {p.error && <div role="alert" style={ERROR_BOX}>{p.error}</div>}
    </div>
  );
}
