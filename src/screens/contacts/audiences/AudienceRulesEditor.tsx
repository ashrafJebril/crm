import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { api } from "@/api/client";
import { useWorkspaceTz } from "@/components/activities/activityApi";
import { IconPlus, IconX } from "@/icons";
import type { Tx } from "@/lib/tx";
import type {
  AudienceField,
  AudienceGroup,
  AudiencePreview,
  AudienceRule,
  AudienceRules,
  CustomFieldDef,
  Lang,
  RelTime,
  RelUnit,
  RuleIssue,
} from "@/lib/types";
import { LIFECYCLES, lifecycleLabel } from "../lifecycle";
import { normalizeDigits, parseFieldInput } from "../fieldValue";
import { audienceErrorText, errorRulePath } from "./audienceErrors";
import {
  AUDIENCE_CHANNELS,
  AUDIENCE_LIMITS,
  FIELD_DEFS,
  NEW_RULE_FIELDS,
  REL_UNITS,
  addGroup,
  addRule,
  canAddGroup,
  canAddRule,
  channelName,
  countConditions,
  countLabel,
  customOpsForType,
  emptyRule,
  fieldLabel,
  isGroup,
  isLegacyExpressible,
  isRuleComplete,
  issueText,
  issuesAt,
  opLabel,
  relTimeLabel,
  removeAt,
  replaceAt,
  samePath,
  setGroupOp,
  treeComplete,
  withOp,
  type Path,
} from "./rulesModel";
import { FIELD, segName, useRuleLookups } from "./ui";

const PREVIEW_DEBOUNCE_MS = 400;

/** A save or preview error placed on a rule (path) or on the whole tree (path null). */
export interface RuleError {
  path: Path | null;
  message: string;
}

interface Props {
  tx: Tx;
  lang: Lang;
  value: AudienceRules;
  onChange: (next: AudienceRules) => void;
  /** The audience being edited: excluded from the group picker and sent as `excludeId`. */
  excludeId?: string | null;
  /** An error from the last save, mapped to its rule. */
  saveError?: RuleError | null;
  /** Issues stored on the saved audience (shown until the preview answers). */
  savedIssues?: RuleIssue[];
}

/** Nested AND/OR rule editor (depth 3, 30 conditions) with a live, debounced preview. */
export function AudienceRulesEditor({ tx, lang, value, onChange, excludeId, saveError, savedIssues }: Props) {
  const lk = useRuleLookups();
  const tz = useWorkspaceTz();
  const total = countConditions(value);
  const complete = treeComplete(value);

  // ── live preview: debounced, stale answers dropped ──
  const [preview, setPreview] = useState<AudiencePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<RuleError | null>(null);
  const seq = useRef(0);
  const body = useMemo(() => JSON.stringify({ rules: value, ...(excludeId ? { excludeId } : {}) }), [value, excludeId]);
  useEffect(() => {
    const my = ++seq.current;
    if (!complete) {
      setPreviewing(false);
      return;
    }
    setPreviewing(true);
    const t = window.setTimeout(() => {
      api
        .post<AudiencePreview>("/segments/preview", JSON.parse(body))
        .then((r) => {
          if (my !== seq.current) return;
          setPreview(r);
          setPreviewError(null);
        })
        .catch((e) => {
          if (my !== seq.current) return;
          setPreview(null);
          setPreviewError({ path: errorRulePath(e, value), message: audienceErrorText(e, tx) });
        })
        .finally(() => {
          if (my === seq.current) setPreviewing(false);
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
    // `value` is captured through `body`; tx only words the error.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, complete]);

  const issues = preview?.issues ?? savedIssues ?? [];
  const highlight = saveError ?? previewError;
  const ctx: Ctx = { tx, lang, tz, lk, root: value, onChange, excludeId: excludeId ?? null, issues, highlight };

  const rootLabel = (op: "and" | "or") =>
    op === "and" ? tx("Match all of the following", "تطابق جميع الشروط التالية") : tx("Match any of the following", "تطابق أيًّا من الشروط التالية");

  return (
    // data-legacy-expressible: developer tools only (can pre-SP-16 code still read this audience exactly?).
    <div style={{ display: "grid", gap: 12 }} data-legacy-expressible={String(isLegacyExpressible(value))}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <select
          aria-label={tx("How conditions combine", "طريقة جمع الشروط")}
          value={value.op}
          onChange={(e) => onChange(setGroupOp(value, [], e.target.value as "and" | "or"))}
          style={{ ...FIELD, fontWeight: 600 }}
        >
          <option value="and">{rootLabel("and")}</option>
          <option value="or">{rootLabel("or")}</option>
        </select>
        <span className="mono muted" style={{ fontSize: 11 }}>
          {tx(`${total} of ${AUDIENCE_LIMITS.maxConditions} conditions`, `${total} من ${AUDIENCE_LIMITS.maxConditions} شرطًا`)}
        </span>
      </div>

      <GroupBody ctx={ctx} group={value} path={[]} />

      {highlight && highlight.path === null && (
        <div role="alert" style={{ fontSize: 12, color: "var(--bad)" }}>{highlight.message}</div>
      )}

      <PreviewPanel tx={tx} preview={preview} loading={previewing} complete={complete} empty={value.rules.length === 0} />
    </div>
  );
}

interface Ctx {
  tx: Tx;
  lang: Lang;
  tz: string;
  lk: ReturnType<typeof useRuleLookups>;
  root: AudienceRules;
  onChange: (next: AudienceRules) => void;
  excludeId: string | null;
  issues: RuleIssue[];
  highlight: RuleError | null;
}

function GroupBody({ ctx, group, path }: { ctx: Ctx; group: AudienceGroup; path: Path }) {
  const { tx, root, onChange } = ctx;
  const ruleOk = canAddRule(root, path);
  const groupOk = canAddGroup(root, path);
  const atMax = countConditions(root) >= AUDIENCE_LIMITS.maxConditions;
  const groupReason = path.length + 2 > AUDIENCE_LIMITS.maxDepth
    ? tx(`Groups can be nested at most ${AUDIENCE_LIMITS.maxDepth} levels deep`, `يمكن تداخل المجموعات حتى ${AUDIENCE_LIMITS.maxDepth} مستويات فقط`)
    : undefined;
  const ruleReason = atMax
    ? tx(`An audience can have at most ${AUDIENCE_LIMITS.maxConditions} conditions`, `الحد ${AUDIENCE_LIMITS.maxConditions} شرطًا للجمهور الواحد`)
    : undefined;
  const joiner = group.op === "and" ? tx("and", "و") : tx("or", "أو");

  return (
    <div style={{ display: "grid", gap: 8 }}>
      {group.rules.length === 0 && (
        <div className="muted" style={{ fontSize: 12.5 }}>
          {tx("No conditions yet: this audience matches every contact.", "لا شروط بعد: هذا الجمهور يطابق كل جهات الاتصال.")}
        </div>
      )}
      {group.rules.map((n, i) => {
        const p = [...path, i];
        return (
          <div key={i} style={{ display: "grid", gap: 6 }}>
            {i > 0 && <span className="mono muted" style={{ fontSize: 10.5, textTransform: "uppercase" }}>{joiner}</span>}
            {isGroup(n) ? <NestedGroup ctx={ctx} group={n} path={p} /> : <RuleRow ctx={ctx} rule={n} path={p} />}
          </div>
        );
      })}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button type="button" className="btn ghost sm" disabled={!ruleOk} title={ruleReason} onClick={() => onChange(addRule(root, path))}>
          <IconPlus w={12} /> {tx("Add condition", "إضافة شرط")}
        </button>
        {groupReason === undefined && (
          <button type="button" className="btn ghost sm" disabled={!groupOk} title={ruleReason} onClick={() => onChange(addGroup(root, path))}>
            <IconPlus w={12} /> {tx("Add group", "إضافة مجموعة")}
          </button>
        )}
        {ruleReason && <span className="muted" style={{ fontSize: 11.5 }}>{ruleReason}</span>}
      </div>
    </div>
  );
}

function NestedGroup({ ctx, group, path }: { ctx: Ctx; group: AudienceGroup; path: Path }) {
  const { tx, root, onChange } = ctx;
  return (
    <div style={{ border: "1px dashed var(--line)", borderRadius: 10, padding: 10, display: "grid", gap: 8, background: "var(--bg-2)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <select
          aria-label={tx("How this group combines", "طريقة جمع هذه المجموعة")}
          value={group.op}
          onChange={(e) => onChange(setGroupOp(root, path, e.target.value as "and" | "or"))}
          style={FIELD}
        >
          <option value="and">{tx("All of", "جميع")}</option>
          <option value="or">{tx("Any of", "أيٌّ من")}</option>
        </select>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn ghost icon sm" aria-label={tx("Remove group", "حذف المجموعة")} onClick={() => onChange(removeAt(root, path))}>
          <IconX w={12} />
        </button>
      </div>
      <GroupBody ctx={ctx} group={group} path={path} />
    </div>
  );
}

const ROW: CSSProperties = { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" };

function RuleRow({ ctx, rule, path }: { ctx: Ctx; rule: AudienceRule; path: Path }) {
  const { tx, root, onChange, issues, highlight } = ctx;
  const ruleIssues = issuesAt(issues, path);
  const err = highlight && highlight.path && samePath(highlight.path, path) ? highlight.message : null;
  const incomplete = !isRuleComplete(rule);
  // Editing a rule clears its "missing" mark: the user chose a replacement (ruling 6 "Fix").
  const set = (next: AudienceRule) => {
    const { missing: _m, ...rest } = next as AudienceRule & { missing?: true };
    onChange(replaceAt(root, path, rest as AudienceRule));
  };
  const fields = NEW_RULE_FIELDS.includes(rule.field) ? NEW_RULE_FIELDS : [rule.field, ...NEW_RULE_FIELDS];
  const def = rule.field === "custom_field" ? ctx.lk.defRows.find((d) => d.id === rule.defId) : undefined;
  const ops = rule.field === "custom_field" && def ? customOpsForType(def.type) : FIELD_DEFS[rule.field].ops;
  const bad = ruleIssues.length > 0 || !!err;

  return (
    <div
      style={{
        display: "grid", gap: 6, padding: 8, borderRadius: 8,
        border: `1px solid ${bad ? "var(--warn)" : "var(--line-soft)"}`, background: "var(--bg-1)",
      }}
    >
      <div style={ROW}>
        <select aria-label={tx("Condition", "الشرط")} value={rule.field} onChange={(e) => set(emptyRule(e.target.value as AudienceField))} style={FIELD}>
          {fields.map((f) => (
            <option key={f} value={f}>{fieldLabel(f, tx)}</option>
          ))}
        </select>
        <select aria-label={tx("Operator", "العملية")} value={rule.op} onChange={(e) => set(withOp(rule, e.target.value))} style={FIELD}>
          {ops.map((o) => (
            <option key={o} value={o}>{opLabel(rule.field, o, tx, def?.type)}</option>
          ))}
        </select>
        <ValueInput ctx={ctx} rule={rule} set={set} def={def} />
        <span style={{ flex: 1 }} />
        <button type="button" className="btn ghost icon sm" aria-label={tx("Remove condition", "حذف الشرط")} onClick={() => onChange(removeAt(root, path))}>
          <IconX w={12} />
        </button>
      </div>
      {incomplete && !err && <div className="muted" style={{ fontSize: 11.5 }}>{tx("Fill in this condition.", "أكمل هذا الشرط.")}</div>}
      {ruleIssues.map((iss, i) => (
        <div key={i} role="note" style={{ fontSize: 12, color: "var(--warn)" }}>
          {issueText(iss, tx)} {tx("Fix it by choosing a replacement, or remove the condition.", "أصلحه باختيار بديل، أو احذف الشرط.")}
        </div>
      ))}
      {err && <div role="alert" style={{ fontSize: 12, color: "var(--bad)" }}>{err}</div>}
    </div>
  );
}

function RelInput({ tx, value, onChange }: { tx: Tx; value: RelTime; onChange: (v: RelTime) => void }) {
  return (
    <>
      <input
        type="number"
        min={1}
        max={1000}
        step={1}
        aria-label={tx("Amount", "المقدار")}
        value={Number.isFinite(value.amount) ? value.amount : ""}
        onChange={(e) => onChange({ ...value, amount: e.target.value === "" ? NaN : Math.trunc(Number(e.target.value)) })}
        style={{ ...FIELD, width: 80 }}
      />
      <select aria-label={tx("Unit", "الوحدة")} value={value.unit} onChange={(e) => onChange({ ...value, unit: e.target.value as RelUnit })} style={FIELD}>
        {REL_UNITS.map((u) => (
          <option key={u} value={u}>{relTimeLabel({ amount: 10, unit: u }, tx).replace(/^[\d٠-٩,٬]+\s*/, "")}</option>
        ))}
      </select>
    </>
  );
}

const splitList = (s: string): string[] => s.split(/[,،]/).map((x) => x.trim()).filter(Boolean);

function ValueInput({ ctx, rule, set, def }: { ctx: Ctx; rule: AudienceRule; set: (r: AudienceRule) => void; def?: CustomFieldDef }) {
  const { tx, lang, lk, tz, excludeId } = ctx;
  switch (rule.field) {
    case "tag": {
      const names = lk.tags.map((t) => t.name);
      if (rule.tag && !names.includes(rule.tag)) names.unshift(rule.tag);
      return (
        <select dir="auto" aria-label={tx("Tag", "الوسم")} value={rule.tag} onChange={(e) => set({ ...rule, tag: e.target.value })} style={FIELD}>
          <option value="">{tx("Choose a tag…", "اختر وسمًا…")}</option>
          {names.map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
      );
    }
    case "lifecycle": {
      const opts = [...LIFECYCLES, ...rule.values.filter((v) => !LIFECYCLES.includes(v.toLowerCase()))];
      return (
        <span style={{ display: "inline-flex", gap: 8, flexWrap: "wrap" }} role="group" aria-label={tx("Lifecycle", "مرحلة العميل")}>
          {opts.map((l) => {
            const on = rule.values.some((v) => v.toLowerCase() === l.toLowerCase());
            return (
              <label key={l} style={{ display: "inline-flex", gap: 4, alignItems: "center", fontSize: 12.5 }}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() =>
                    set({ ...rule, values: on ? rule.values.filter((v) => v.toLowerCase() !== l.toLowerCase()) : [...rule.values, l] })
                  }
                />
                <bdi>{lifecycleLabel(tx, l)}</bdi>
              </label>
            );
          })}
        </span>
      );
    }
    case "last_active":
      return <RelInput tx={tx} value={rule.value} onChange={(value) => set({ ...rule, value })} />;
    case "created":
      if ("value" in rule) return <RelInput tx={tx} value={rule.value} onChange={(value) => set({ ...rule, value })} />;
      return (
        <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 12 }}>
          <input type="date" dir="ltr" aria-label={tx("Date", "التاريخ")} value={rule.date} onChange={(e) => set({ ...rule, date: e.target.value })} style={FIELD} />
          <span className="muted">
            {tx("workspace time", "بتوقيت مساحة العمل")} (<bdi dir="ltr">{tz}</bdi>)
          </span>
        </label>
      );
    case "channel": {
      const opts = AUDIENCE_CHANNELS.includes(rule.channel) ? AUDIENCE_CHANNELS : [rule.channel, ...AUDIENCE_CHANNELS];
      return (
        <select aria-label={tx("Channel", "القناة")} value={rule.channel} onChange={(e) => set({ ...rule, channel: e.target.value })} style={FIELD}>
          {opts.map((c) => (
            <option key={c} value={c}>{channelName(c, tx).text}</option>
          ))}
        </select>
      );
    }
    case "group": {
      const rows = lk.segmentRows.filter((s) => s.id !== excludeId);
      const known = rows.some((s) => s.id === rule.segmentId);
      return (
        <select dir="auto" aria-label={tx("Group or audience", "مجموعة أو جمهور")} value={rule.segmentId} onChange={(e) => set({ ...rule, segmentId: e.target.value })} style={FIELD}>
          <option value="">{tx("Choose a group or audience…", "اختر مجموعة أو جمهورًا…")}</option>
          {rule.segmentId && !known && <option value={rule.segmentId}>{tx("(deleted group)", "(مجموعة محذوفة)")}</option>}
          {rows.map((s) => (
            <option key={s.id} value={s.id}>
              {segName(s, lang)}{s.origin === "crm" ? ` · ${tx("Smart", "ذكي")}` : ""}
            </option>
          ))}
        </select>
      );
    }
    case "pipeline_stage": {
      const live = lk.pipelineRows.filter((p) => !p.archivedAt || p.id === rule.pipelineId);
      const p = lk.pipelineRows.find((x) => x.id === rule.pipelineId);
      return (
        <>
          <select dir="auto" aria-label={tx("Pipeline", "المسار")} value={rule.pipelineId} onChange={(e) => set({ field: "pipeline_stage", op: rule.op, pipelineId: e.target.value })} style={FIELD}>
            <option value="">{tx("Choose a pipeline…", "اختر مسارًا…")}</option>
            {rule.pipelineId && !p && <option value={rule.pipelineId}>{tx("(deleted pipeline)", "(مسار محذوف)")}</option>}
            {live.map((x) => (
              <option key={x.id} value={x.id}>{lang === "ar" && x.nameAr ? x.nameAr : x.name}</option>
            ))}
          </select>
          {rule.pipelineId && (
            <select
              dir="auto"
              aria-label={tx("Stage", "المرحلة")}
              value={rule.stageId ?? ""}
              onChange={(e) => set(e.target.value ? { ...rule, stageId: e.target.value } : { field: "pipeline_stage", op: rule.op, pipelineId: rule.pipelineId })}
              style={FIELD}
            >
              <option value="">{tx("Any stage (open cards)", "أي مرحلة (بطاقات مفتوحة)")}</option>
              {rule.stageId && !p?.stages.some((s) => s.id === rule.stageId) && <option value={rule.stageId}>{tx("(removed stage)", "(مرحلة محذوفة)")}</option>}
              {(p?.stages ?? []).map((s) => (
                <option key={s.id} value={s.id}>{lang === "ar" && s.labelAr ? s.labelAr : s.label}</option>
              ))}
            </select>
          )}
        </>
      );
    }
    case "custom_field": {
      const defs = lk.defRows.filter((d) => !d.archivedAt || d.id === rule.defId);
      const needsValue = rule.op !== "set" && rule.op !== "unset";
      const raw = rule.value ?? "";
      const parsed = def && needsValue && raw !== "" && def.type !== "boolean" ? parseFieldInput(def.type, raw, def.options) : null;
      return (
        <>
          <select
            dir="auto"
            aria-label={tx("Field", "الحقل")}
            value={rule.defId}
            onChange={(e) => {
              const d = lk.defRows.find((x) => x.id === e.target.value);
              const op = customOpsForType(d?.type)[0] as "eq";
              set({ field: "custom_field", op, defId: e.target.value, value: d?.type === "boolean" ? "true" : "" });
            }}
            style={FIELD}
          >
            <option value="">{tx("Choose a field…", "اختر حقلًا…")}</option>
            {rule.defId && !def && <option value={rule.defId}>{tx("(deleted field)", "(حقل محذوف)")}</option>}
            {defs.map((d) => (
              <option key={d.id} value={d.id}>{lang === "ar" && d.labelAr ? d.labelAr : d.label}</option>
            ))}
          </select>
          {def && needsValue &&
            (def.type === "select" ? (
              <select dir="auto" aria-label={tx("Value", "القيمة")} value={raw} onChange={(e) => set({ ...rule, value: e.target.value })} style={FIELD}>
                <option value="">{tx("Choose…", "اختر…")}</option>
                {(def.options ?? []).map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
            ) : def.type === "boolean" ? (
              <select aria-label={tx("Value", "القيمة")} value={raw || "true"} onChange={(e) => set({ ...rule, value: e.target.value })} style={FIELD}>
                <option value="true">{tx("Yes", "نعم")}</option>
                <option value="false">{tx("No", "لا")}</option>
              </select>
            ) : (
              <input
                dir={def.type === "text" ? "auto" : "ltr"}
                aria-label={tx("Value", "القيمة")}
                type={def.type === "date" ? "date" : "text"}
                inputMode={def.type === "number" ? "decimal" : undefined}
                value={raw}
                onChange={(e) => set({ ...rule, value: def.type === "number" ? normalizeDigits(e.target.value) : e.target.value })}
                style={{ ...FIELD, width: 150 }}
              />
            ))}
          {parsed && !parsed.ok && <span style={{ fontSize: 11.5, color: "var(--bad)" }}>{tx(parsed.error.en, parsed.error.ar)}</span>}
        </>
      );
    }
    case "campaign": {
      const launched = lk.campaignRows.filter((c) => c.status !== "draft" && c.status !== "scheduled");
      const known = launched.some((c) => c.id === rule.campaignId);
      return (
        <select dir="auto" aria-label={tx("Campaign", "الحملة")} value={rule.campaignId} onChange={(e) => set({ ...rule, campaignId: e.target.value })} style={FIELD}>
          <option value="">{tx("Choose a campaign…", "اختر حملة…")}</option>
          {rule.campaignId && !known && (
            <option value={rule.campaignId}>{lk.campaignRows.find((c) => c.id === rule.campaignId)?.name ?? tx("(deleted campaign)", "(حملة محذوفة)")}</option>
          )}
          {launched.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      );
    }
    case "industry":
    case "source":
      return (
        <input
          dir="auto"
          aria-label={fieldLabel(rule.field, tx)}
          placeholder={tx("Values, separated by commas", "قيم مفصولة بفواصل")}
          key={rule.values.join("")}
          defaultValue={rule.values.join(", ")}
          onBlur={(e) => set({ ...rule, values: splitList(e.target.value).slice(0, AUDIENCE_LIMITS.maxValues) })}
          style={{ ...FIELD, width: 200 }}
        />
      );
    case "name":
      return <input dir="auto" aria-label={tx("Name contains", "الاسم يحتوي على")} value={rule.value} onChange={(e) => set({ ...rule, value: e.target.value })} style={{ ...FIELD, width: 160 }} />;
    case "stage_key":
      return (
        <input
          dir="ltr"
          aria-label={fieldLabel(rule.field, tx)}
          key={rule.keys.join("")}
          defaultValue={rule.keys.join(", ")}
          onBlur={(e) => set({ ...rule, keys: splitList(e.target.value).slice(0, 20) })}
          style={{ ...FIELD, width: 200 }}
        />
      );
    default:
      return null;
  }
}

function PreviewPanel({ tx, preview, loading, complete, empty }: { tx: Tx; preview: AudiencePreview | null; loading: boolean; complete: boolean; empty: boolean }) {
  const label = preview ? countLabel(preview.count, preview.timedOut, tx) : null;
  return (
    <div aria-live="polite" style={{ padding: "10px 12px", borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line-soft)", display: "grid", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
        <span style={{ color: "var(--ink-2)" }}>{tx("Matches", "يطابق")}</span>
        <strong className="mono" style={{ color: "var(--accent)" }}>
          {!complete ? "—" : label ? <bdi title={label.title}>{label.text}</bdi> : tx("Counting…", "جارٍ العدّ…")}
        </strong>
        {label?.state === "known" && <span className="muted" style={{ fontSize: 12 }}>{tx("contacts", "جهة اتصال")}</span>}
        {loading && preview && <span className="muted" style={{ fontSize: 11 }}>{tx("Updating…", "جارٍ التحديث…")}</span>}
      </div>
      {!complete && (
        <div className="muted" style={{ fontSize: 12 }}>{tx("Finish the conditions to see who matches.", "أكمل الشروط لترى من يطابقها.")}</div>
      )}
      {complete && empty && (
        <div style={{ fontSize: 12, color: "var(--warn)" }}>{tx("With no conditions, this audience is every contact in the workspace.", "بلا شروط، يضم هذا الجمهور كل جهات الاتصال في مساحة العمل.")}</div>
      )}
      {complete && preview && preview.sample.length > 0 && (
        <div style={{ fontSize: 12, color: "var(--ink-2)" }}>
          {tx("For example: ", "مثلًا: ")}
          {preview.sample.map((s, i) => (
            <span key={s.id}>
              {i > 0 ? tx(", ", "، ") : ""}
              <bdi dir="auto">{s.name || s.phone || "—"}</bdi>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
