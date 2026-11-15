import { useState } from "react";
import { api } from "@/api/client";
import { Modal } from "@/components/Modal";
import { useToast } from "@/components/Toast";
import { NO_PERMISSION_AR, NO_PERMISSION_EN } from "@/auth/usePermissions";
import type { Tx } from "@/lib/tx";
import type { AudienceRefAudience, AudienceRefCampaign, AudienceRules, Lang, RuleIssue, Segment } from "@/lib/types";
import { AudienceRulesEditor, type RuleError } from "./AudienceRulesEditor";
import { audienceErrorText, campaignEditState, errorRulePath, isForbidden, liveCampaignWarning, versionConflict } from "./audienceErrors";
import { AUDIENCE_LIMITS, emptyTree, legacyToTree, treeComplete } from "./rulesModel";
import { FIELD, RuleText, segName } from "./ui";

const HUES = ["0", "30", "60", "90", "120", "150", "180", "210", "240", "270", "300", "330"];

interface Props {
  tx: Tx;
  lang: Lang;
  /** "smart" edits rules; "manual" is a hand-picked group (name and colour only). */
  mode: "smart" | "manual";
  /** The audience being edited; omitted to create one. */
  initial?: Segment | null;
  /** Smart audiences whose rules use this one (GET /segments/:id references.audiences), review m1. */
  dependents?: AudienceRefAudience[];
  /** Campaigns that use this audience (GET /segments/:id references.campaigns), final review I1. */
  campaigns?: AudienceRefCampaign[];
  onClose: () => void;
  onSaved: (row: Segment) => void;
}

const treeOf = (s: Segment | null | undefined): AudienceRules => (s?.rules ? s.rules : s ? legacyToTree(s.filter) : emptyTree());

/** Create or edit an audience: name, Arabic name, colour and (smart) the rule editor. */
export function AudienceSheet({ tx, lang, mode, initial, dependents = [], campaigns, onClose, onSaved }: Props) {
  const { toast } = useToast();
  const [name, setName] = useState(initial?.name ?? "");
  const [nameAr, setNameAr] = useState(initial?.nameAr ?? "");
  const [color, setColor] = useState(initial?.color ?? "210");
  const [rules, setRules] = useState<AudienceRules>(() => treeOf(initial));
  const [version, setVersion] = useState<number | undefined>(initial?.version);
  const [savedIssues, setSavedIssues] = useState<RuleIssue[] | undefined>(initial?.issues);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RuleError | null>(null);
  const [conflict, setConflict] = useState<Segment | null>(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const smart = mode === "smart";
  const editing = !!initial;
  const camp = campaignEditState(campaigns);
  // Scheduled, launching or running campaigns read this audience when they run: name them (I1).
  const liveWarnings = smart && camp.live.length > 0 && (
    <ul style={{ margin: 0, paddingInlineStart: 18, display: "grid", gap: 2 }}>
      {camp.live.map((c) => (
        <li key={c.id}><RuleText parts={liveCampaignWarning(c, tx)} /></li>
      ))}
    </ul>
  );
  const ready = !!name.trim() && (!smart || treeComplete(rules));
  const title = editing
    ? smart ? tx("Edit smart audience", "تعديل الجمهور الذكي") : tx("Edit group", "تعديل المجموعة")
    : smart ? tx("New smart audience", "جمهور ذكي جديد") : tx("New group", "مجموعة جديدة");

  const save = async (allowEmpty = false) => {
    if (!ready || busy) return;
    // An empty root matches the whole workspace (Task 1 review, deviation 8): confirm first.
    if (smart && rules.rules.length === 0 && !allowEmpty) {
      setConfirmEmpty(true);
      return;
    }
    setConfirmEmpty(false);
    setBusy(true);
    setError(null);
    const base = { name: name.trim(), nameAr: nameAr.trim(), color, ...(smart ? { rules } : {}) };
    try {
      const row = editing
        ? await api.patch<Segment>(`/segments/${initial!.id}`, { ...base, ...(version !== undefined ? { version } : {}) })
        : await api.post<Segment>("/segments", { ...base, nameAr: base.nameAr || undefined, origin: smart ? "crm" : "manual" });
      onSaved(row);
    } catch (e) {
      const current = versionConflict(e);
      if (current) {
        setConflict(current);
      } else if (isForbidden(e)) {
        toast(tx(NO_PERMISSION_EN, NO_PERMISSION_AR), "error");
      } else {
        setError({ path: smart ? errorRulePath(e, rules) : null, message: audienceErrorText(e, tx) });
      }
    } finally {
      setBusy(false);
    }
  };

  const loadTheirs = () => {
    if (!conflict) return;
    setName(conflict.name);
    setNameAr(conflict.nameAr ?? "");
    setColor(conflict.color ?? color);
    setRules(treeOf(conflict));
    setSavedIssues(conflict.issues);
    setVersion(conflict.version);
    setConflict(null);
    setError(null);
  };
  const keepMine = () => {
    if (!conflict) return;
    setVersion(conflict.version);
    setConflict(null);
  };

  return (
    <Modal onClose={busy ? () => {} : onClose} width={smart ? 820 : 440} label={title} panelStyle={{ maxHeight: "88vh", overflowY: "auto" }}>
      <div dir={lang === "ar" ? "rtl" : "ltr"} style={{ display: "grid", gap: 14 }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>{title}</h3>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8 }}>
          <label style={{ display: "grid", gap: 4, fontSize: 11, color: "var(--ink-3)" }}>
            {tx("Name", "الاسم")}
            <input autoFocus dir="auto" maxLength={64} value={name} onChange={(e) => setName(e.target.value)} style={{ ...FIELD, height: 34 }} />
          </label>
          <label style={{ display: "grid", gap: 4, fontSize: 11, color: "var(--ink-3)" }}>
            {tx("Arabic name (optional)", "الاسم بالعربية (اختياري)")}
            <input dir="rtl" maxLength={64} value={nameAr} onChange={(e) => setNameAr(e.target.value)} style={{ ...FIELD, height: 34 }} />
          </label>
        </div>
        <div role="radiogroup" aria-label={tx("Colour", "اللون")} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {HUES.map((h) => (
            <button
              key={h}
              type="button"
              role="radio"
              aria-checked={color === h}
              aria-label={tx(`Colour ${h}`, `اللون ${h}`)}
              onClick={() => setColor(h)}
              style={{
                width: 22, height: 22, borderRadius: "50%", cursor: "pointer", background: `hsl(${h} 70% 45%)`,
                border: color === h ? "2px solid var(--ink)" : "2px solid transparent",
              }}
            />
          ))}
        </div>

        {smart && dependents.length > 0 && (
          <div role="note" style={{ padding: 10, borderRadius: 10, fontSize: 12.5, lineHeight: 1.5, background: "color-mix(in oklab, var(--warn) 12%, var(--bg-2))", border: "1px solid var(--warn)" }}>
            {tx("Other audiences use this one: ", "تستخدم جماهير أخرى هذا الجمهور: ")}
            {dependents.map((d, i) => (
              <span key={d.id}>
                {i > 0 ? tx(", ", "، ") : ""}
                <bdi dir="auto" style={{ fontWeight: 600 }}>{segName(d, lang)}</bdi>
              </span>
            ))}
            {". "}
            {tx(
              `They change with it. If this audience gets a broken condition, or its chain of audiences grows past ${AUDIENCE_LIMITS.maxReferenceDepth}, they match nobody until it is fixed.`,
              `تتغير معه. إذا أصبح في هذا الجمهور شرط معطّل، أو تجاوزت سلسلة الجماهير ${AUDIENCE_LIMITS.maxReferenceDepth}، فلن تطابق أحدًا حتى يُصلَح.`,
            )}
          </div>
        )}

        {smart && (camp.live.length > 0 || camp.drafts.length > 0) && (
          <div
            role="note"
            style={{
              padding: 10, borderRadius: 10, fontSize: 12.5, lineHeight: 1.5, display: "grid", gap: 4,
              background: camp.live.length ? "color-mix(in oklab, var(--warn) 12%, var(--bg-2))" : "var(--bg-2)",
              border: camp.live.length ? "1px solid var(--warn)" : "1px solid var(--line-soft)",
            }}
          >
            {liveWarnings}
            {camp.drafts.length > 0 && (
              <span className="muted">
                {tx("Draft campaigns that use it: ", "حملات مسودة تستخدمه: ")}
                {camp.drafts.map((c, i) => (
                  <span key={c.id}>
                    {i > 0 ? tx(", ", "، ") : ""}
                    <bdi dir="auto">{c.name}</bdi>
                  </span>
                ))}
              </span>
            )}
          </div>
        )}

        {smart && (
          <AudienceRulesEditor
            tx={tx}
            lang={lang}
            value={rules}
            onChange={(r) => {
              setRules(r);
              setConfirmEmpty(false);
              if (error?.path) setError(null);
            }}
            excludeId={initial?.id ?? null}
            saveError={error}
            savedIssues={savedIssues}
          />
        )}
        {!smart && error && <div role="alert" style={{ fontSize: 12, color: "var(--bad)" }}>{error.message}</div>}

        {conflict && (
          <div role="alert" style={{ padding: 10, borderRadius: 10, display: "grid", gap: 8, background: "color-mix(in oklab, var(--bad) 10%, var(--bg-2))", border: "1px solid var(--bad)" }}>
            <strong style={{ fontSize: 13 }}>{tx("Someone else changed this audience", "عدّل شخص آخر هذا الجمهور")}</strong>
            <span style={{ fontSize: 12.5 }}>
              {tx("Load their version to start from it, or keep yours and save over theirs.", "حمّل نسختهم لتبدأ منها، أو احتفظ بنسختك واحفظها فوق نسختهم.")}
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" className="btn sm" onClick={loadTheirs}>{tx("Load their version", "حمّل نسختهم")}</button>
              <button type="button" className="btn ghost sm" onClick={keepMine}>{tx("Keep mine", "احتفظ بنسختي")}</button>
            </div>
          </div>
        )}

        {confirmEmpty && (
          <div role="alert" style={{ padding: 10, borderRadius: 10, display: "grid", gap: 8, background: "color-mix(in oklab, var(--warn) 12%, var(--bg-2))", border: "1px solid var(--warn)" }}>
            <span style={{ fontSize: 12.5 }}>
              {tx(
                "This audience has no conditions, so it includes every contact in the workspace, including everyone added later. Save it anyway?",
                "لا شروط في هذا الجمهور، لذا يضم كل جهات الاتصال في مساحة العمل، ومن يُضاف لاحقًا. هل تحفظه رغم ذلك؟",
              )}
            </span>
            {liveWarnings}
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" className="btn sm" onClick={() => void save(true)}>{tx("Save for everyone", "احفظه للجميع")}</button>
              <button type="button" className="btn ghost sm" onClick={() => setConfirmEmpty(false)}>{tx("Add conditions", "أضف شروطًا")}</button>
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>{tx("Cancel", "إلغاء")}</button>
          <button type="button" className="btn primary" disabled={!ready || busy || !!conflict} onClick={() => void save()}>
            {busy ? tx("Saving…", "جارٍ الحفظ…") : editing ? tx("Save", "حفظ") : smart ? tx("Create audience", "إنشاء الجمهور") : tx("Create group", "إنشاء المجموعة")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
