import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTweaks } from "@/tweaks/context";
import { makeTx, type Tx } from "@/lib/tx";
import { api, ApiError } from "@/api/client";
import { usePermissions, NO_PERMISSION_AR, NO_PERMISSION_EN } from "@/auth/usePermissions";
import { Badge } from "@/components/Badge";
import { SettingsCard, Field, inputStyle, StatusToast } from "./form";
import { StageListEditor } from "./pipelines/StageListEditor";
import { LostReasonsEditor } from "./pipelines/LostReasonsEditor";
import {
  DRAFT_ERROR_TEXT,
  draftFromPipeline,
  hasChanges,
  toPayload,
  validateDraft,
  type DraftPipelineInput,
  type PipelineDraft,
} from "./pipelines/draft";

interface PipelineListItem {
  id: string;
  key: string;
  name: string;
  nameAr: string;
  isDefault: boolean;
  kind?: string;
  archivedAt?: string | null;
  _count?: { tickets: number };
}

type PipelineFull = DraftPipelineInput;

const LIST_KEY = ["pipelines", "admin"] as const;

function errorText(e: unknown, tx: Tx): string {
  if (e instanceof ApiError) {
    const m = DRAFT_ERROR_TEXT[e.message];
    if (m) return tx(m[0], m[1]);
    if (e.status === 403) return tx(NO_PERMISSION_EN, NO_PERMISSION_AR);
    return e.message;
  }
  return tx("Request failed", "فشل الطلب");
}

export function PipelinesTab() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const { can, loading } = usePermissions();
  const canView = can("pipelines.view");
  const canManage = can("pipelines.manage");
  const qc = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState({ name: "", nameAr: "", kind: "deals" });

  const list = useQuery<PipelineListItem[]>({
    queryKey: LIST_KEY,
    queryFn: ({ signal }) => api.get<PipelineListItem[]>("/pipelines?includeArchived=1", signal),
    enabled: canView,
  });

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(id);
  }, [toast]);

  if (loading) return null;
  if (!canView) {
    return (
      <SettingsCard title={tx("Pipelines", "مسارات المبيعات")}>
        <div className="muted" style={{ fontSize: 13 }}>
          {tx(NO_PERMISSION_EN, NO_PERMISSION_AR)}
        </div>
      </SettingsCard>
    );
  }

  const refresh = () => qc.invalidateQueries({ queryKey: ["pipelines"] });

  if (editingId) {
    return (
      <PipelineEditor
        key={editingId}
        id={editingId}
        canManage={canManage}
        tx={tx}
        onBack={() => setEditingId(null)}
        onSaved={() => {
          void refresh();
          setToast(tx("Pipeline saved", "تم حفظ المسار"));
        }}
      />
    );
  }

  const create = async () => {
    setBusy(true);
    try {
      const p = await api.post<PipelineListItem>("/pipelines", {
        name: creating.name.trim(),
        nameAr: creating.nameAr.trim(),
        kind: creating.kind,
      });
      setCreating({ name: "", nameAr: "", kind: "deals" });
      await refresh();
      setEditingId(p.id);
    } catch (e) {
      setToast(errorText(e, tx));
    } finally {
      setBusy(false);
    }
  };

  const toggleArchive = async (p: PipelineListItem) => {
    const archiving = !p.archivedAt;
    if (
      archiving &&
      !window.confirm(
        tx(
          `Archive "${p.name}"? It disappears from the board picker and no new tickets can be added. Existing tickets stay readable.`,
          `أرشفة "${p.nameAr}"؟ سيختفي من قائمة اللوحة ولا يمكن إضافة تذاكر جديدة. تبقى التذاكر الحالية قابلة للقراءة.`,
        ),
      )
    )
      return;
    setBusy(true);
    try {
      await api.post(`/pipelines/${p.id}/${archiving ? "archive" : "unarchive"}`, {});
      await refresh();
      setToast(archiving ? tx("Pipeline archived", "تمت أرشفة المسار") : tx("Pipeline restored", "تمت استعادة المسار"));
    } catch (e) {
      setToast(errorText(e, tx));
    } finally {
      setBusy(false);
    }
  };

  const items = list.data ?? [];
  return (
    <div>
      <SettingsCard
        title={tx("Pipelines", "مسارات المبيعات")}
        description={tx(
          "Stages, lost reasons and rules for each pipeline.",
          "المراحل وأسباب الخسارة وقواعد كل مسار.",
        )}
      >
        {list.isPending ? <div className="muted">{tx("Loading…", "جارٍ التحميل…")}</div> : null}
        {list.isError ? <div style={{ color: "var(--bad, #ef4444)" }}>{errorText(list.error, tx)}</div> : null}
        {items.map((p) => {
          const archived = !!p.archivedAt;
          const protectedPipe = p.isDefault || p.kind === "support";
          return (
            <div
              key={p.id}
              style={{
                display: "flex",
                gap: 10,
                alignItems: "center",
                flexWrap: "wrap",
                padding: "8px 10px",
                border: "1px solid var(--line-soft)",
                borderRadius: 10,
                opacity: archived ? 0.7 : 1,
              }}
            >
              <div style={{ flex: "1 1 160px", minWidth: 0 }}>
                <div dir="auto" style={{ fontWeight: 600, fontSize: 13 }}>
                  {tx(p.name, p.nameAr)}
                </div>
                <div className="muted" style={{ fontSize: 11 }}>
                  {tx(`${p._count?.tickets ?? 0} ticket(s)`, `${p._count?.tickets ?? 0} تذكرة`)}
                </div>
              </div>
              {p.isDefault ? <Badge kind="accent">{tx("Default", "افتراضي")}</Badge> : null}
              {p.kind === "support" ? <Badge kind="info">{tx("Support", "الدعم")}</Badge> : null}
              {archived ? <Badge>{tx("Archived", "مؤرشف")}</Badge> : null}
              <button type="button" className="btn" onClick={() => setEditingId(p.id)}>
                {canManage ? tx("Edit", "تعديل") : tx("View", "عرض")}
              </button>
              {canManage ? (
                <button
                  type="button"
                  className="btn ghost"
                  disabled={busy || (!archived && protectedPipe)}
                  title={
                    !archived && protectedPipe
                      ? tx("The default and support pipelines cannot be archived", "لا يمكن أرشفة المسار الافتراضي ومسار الدعم")
                      : undefined
                  }
                  onClick={() => void toggleArchive(p)}
                >
                  {archived ? tx("Unarchive", "استعادة") : tx("Archive", "أرشفة")}
                </button>
              ) : null}
            </div>
          );
        })}
      </SettingsCard>

      {canManage ? (
        <SettingsCard
          title={tx("New pipeline", "مسار جديد")}
          description={tx(
            "Starts with New, In progress, Won and Lost stages and default lost reasons.",
            "يبدأ بمراحل جديد وقيد التنفيذ وفوز وخسارة وأسباب خسارة افتراضية.",
          )}
          footer={
            <button
              type="button"
              className="btn primary"
              disabled={busy || !creating.name.trim() || !creating.nameAr.trim()}
              onClick={() => void create()}
            >
              {tx("Create pipeline", "إنشاء المسار")}
            </button>
          }
        >
          <Field label={tx("Name (English)", "الاسم (إنجليزي)")}>
            <input
              dir="auto"
              style={inputStyle}
              value={creating.name}
              maxLength={60}
              onChange={(e) => setCreating({ ...creating, name: e.target.value })}
            />
          </Field>
          <Field label={tx("Name (Arabic)", "الاسم (عربي)")}>
            <input
              dir="rtl"
              style={inputStyle}
              value={creating.nameAr}
              maxLength={60}
              onChange={(e) => setCreating({ ...creating, nameAr: e.target.value })}
            />
          </Field>
          <Field label={tx("Kind", "النوع")}>
            <select
              style={inputStyle}
              value={creating.kind}
              onChange={(e) => setCreating({ ...creating, kind: e.target.value })}
            >
              <option value="deals">{tx("Deals", "صفقات")}</option>
              <option value="support">{tx("Support", "دعم")}</option>
            </select>
          </Field>
        </SettingsCard>
      ) : null}
      <StatusToast message={toast} />
    </div>
  );
}

// ── editor ──────────────────────────────────────────────────────────────

interface Conflict {
  current: PipelineFull;
  /** The user's unsaved draft at the time of the conflict, kept for comparison. */
  local: PipelineDraft;
}

function PipelineEditor({
  id,
  canManage,
  tx,
  onBack,
  onSaved,
}: {
  id: string;
  canManage: boolean;
  tx: Tx;
  onBack: () => void;
  onSaved: () => void;
}) {
  const [original, setOriginal] = useState<PipelineDraft | null>(null);
  const [draft, setDraft] = useState<PipelineDraft | null>(null);
  const [meta, setMeta] = useState<{ kind?: string; isDefault?: boolean; archived: boolean } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [keptCopy, setKeptCopy] = useState<PipelineDraft | null>(null);
  const [showErrors, setShowErrors] = useState(false);

  const adopt = (p: PipelineFull) => {
    const d = draftFromPipeline(p);
    setOriginal(d);
    setDraft(d);
    setMeta({ kind: p.kind, isDefault: p.isDefault, archived: !!p.archivedAt });
  };

  useEffect(() => {
    let live = true;
    api
      .get<PipelineFull>(`/pipelines/${id}`)
      .then((p) => live && adopt(p))
      .catch((e) => live && setLoadError(errorText(e, tx)));
    return () => {
      live = false;
    };
  }, [id]);

  const errors = useMemo(() => (draft ? validateDraft(draft) : []), [draft]);
  const dirty = !!draft && !!original && hasChanges(draft, original);
  const readOnly = !canManage || !!meta?.archived;

  if (loadError) {
    return (
      <SettingsCard title={tx("Pipeline", "المسار")}>
        <div style={{ color: "var(--bad, #ef4444)" }}>{loadError}</div>
        <button type="button" className="btn" onClick={onBack}>
          {tx("Back", "رجوع")}
        </button>
      </SettingsCard>
    );
  }
  if (!draft || !original || !meta) return <div className="muted">{tx("Loading…", "جارٍ التحميل…")}</div>;

  const save = async () => {
    if (errors.length > 0) {
      setShowErrors(true);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await api.put<PipelineFull>(`/pipelines/${id}/draft`, toPayload(draft));
      adopt(saved);
      setShowErrors(false);
      onSaved();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const current = (e.body as { current?: PipelineFull } | undefined)?.current;
        if (current) {
          setConflict({ current, local: draft });
          return;
        }
      }
      setSaveError(errorText(e, tx));
    } finally {
      setSaving(false);
    }
  };

  const reload = () => {
    if (!conflict) return;
    setKeptCopy(conflict.local);
    adopt(conflict.current);
    setConflict(null);
    setSaveError(null);
  };

  const unique = [...new Set(errors.map((e) => e.key))];
  const set = (patch: Partial<PipelineDraft>) => setDraft({ ...draft, ...patch });

  return (
    <div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn ghost"
          onClick={() => {
            if (!dirty || window.confirm(tx("Discard unsaved changes?", "تجاهل التغييرات غير المحفوظة؟"))) onBack();
          }}
        >
          {t_back(tx)}
        </button>
        <h3 dir="auto" style={{ margin: 0, fontSize: 15 }}>
          {tx(original.name, original.nameAr)}
        </h3>
        {meta.archived ? <Badge>{tx("Archived", "مؤرشف")}</Badge> : null}
        {!canManage ? <Badge>{tx("Read only", "للقراءة فقط")}</Badge> : null}
      </div>

      {conflict ? (
        <div
          role="alert"
          style={{
            padding: 12,
            marginBottom: 14,
            borderRadius: 10,
            border: "1px solid var(--warn, #f59e0b)",
            background: "color-mix(in srgb, var(--warn, #f59e0b) 10%, var(--bg-1))",
            display: "flex",
            gap: 10,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <span style={{ flex: "1 1 240px", fontSize: 13 }}>
            {tx(
              "Someone else changed this pipeline — reload to see their changes",
              "قام شخص آخر بتعديل هذا المسار — أعد التحميل لرؤية تغييراته",
            )}
          </span>
          <button type="button" className="btn primary" onClick={reload}>
            {tx("Reload", "إعادة التحميل")}
          </button>
        </div>
      ) : null}

      {keptCopy ? <KeptCopy copy={keptCopy} tx={tx} onDismiss={() => setKeptCopy(null)} /> : null}

      <SettingsCard title={tx("Details", "التفاصيل")}>
        <Field label={tx("Name (English)", "الاسم (إنجليزي)")}>
          <input
            dir="auto"
            style={inputStyle}
            value={draft.name}
            disabled={readOnly}
            maxLength={60}
            onChange={(e) => set({ name: e.target.value })}
          />
        </Field>
        <Field label={tx("Name (Arabic)", "الاسم (عربي)")}>
          <input
            dir="rtl"
            style={inputStyle}
            value={draft.nameAr}
            disabled={readOnly}
            maxLength={60}
            onChange={(e) => set({ nameAr: e.target.value })}
          />
        </Field>
        <Field label={tx("Kind", "النوع")} hint={tx("Set when the pipeline is created.", "يُحدد عند إنشاء المسار.")}>
          <input
            style={inputStyle}
            disabled
            value={meta.kind === "support" ? tx("Support", "دعم") : tx("Deals", "صفقات")}
          />
        </Field>
      </SettingsCard>

      <SettingsCard
        title={tx("Stages", "المراحل")}
        description={tx(
          "Keep one Won stage, at most one Lost stage and at least one open stage. Order is left to right on the board.",
          "أبقِ مرحلة فوز واحدة ومرحلة خسارة واحدة كحد أقصى ومرحلة مفتوحة واحدة على الأقل. الترتيب من اليسار إلى اليمين في اللوحة.",
        )}
      >
        <StageListEditor draft={draft} original={original} onChange={setDraft} readOnly={readOnly} errors={errors} tx={tx} />
      </SettingsCard>

      <SettingsCard
        title={tx("Lost reasons", "أسباب الخسارة")}
        description={tx(
          "Shown when a card moves to the Lost stage. Reasons already used are archived, not deleted.",
          "تظهر عند نقل بطاقة إلى مرحلة الخسارة. الأسباب المستخدمة تُؤرشف ولا تُحذف.",
        )}
      >
        <LostReasonsEditor draft={draft} onChange={setDraft} readOnly={readOnly} errors={errors} tx={tx} />
      </SettingsCard>

      <SettingsCard title={tx("Rules", "القواعد")}>
        <Field
          label={tx("Stale after (days)", "الركود بعد (أيام)")}
          hint={tx(
            "Cards that stay in one stage longer than this turn amber. Leave empty to turn off.",
            "تتحول البطاقات التي تبقى في مرحلة أطول من ذلك إلى اللون الكهرماني. اتركه فارغاً للإيقاف.",
          )}
        >
          <input
            type="number"
            min={1}
            max={365}
            style={{ ...inputStyle, maxWidth: 140 }}
            value={draft.staleDays ?? ""}
            disabled={readOnly}
            onChange={(e) => set({ staleDays: e.target.value === "" ? null : Number(e.target.value) })}
          />
        </Field>
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
          <input
            type="checkbox"
            checked={draft.agentCanMove}
            disabled={readOnly}
            onChange={(e) => set({ agentCanMove: e.target.checked })}
          />
          {tx("Agents can move cards between stages", "يمكن للوكلاء نقل البطاقات بين المراحل")}
        </label>
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
          <input
            type="checkbox"
            checked={draft.assignsConversations}
            disabled={readOnly}
            onChange={(e) => set({ assignsConversations: e.target.checked })}
          />
          {tx("Assigns conversations to the card owner", "يسند المحادثات إلى مالك البطاقة")}
        </label>
      </SettingsCard>

      {showErrors && unique.length > 0 ? (
        <div role="alert" style={{ color: "var(--bad, #ef4444)", fontSize: 12.5, marginBottom: 12, display: "grid", gap: 2 }}>
          {unique.map((k) => {
            const m = DRAFT_ERROR_TEXT[k];
            return <div key={k}>{m ? tx(m[0], m[1]) : k}</div>;
          })}
        </div>
      ) : null}
      {saveError ? (
        <div role="alert" style={{ color: "var(--bad, #ef4444)", fontSize: 12.5, marginBottom: 12 }}>
          {saveError}
        </div>
      ) : null}

      {!readOnly ? (
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginBottom: 24 }}>
          <button type="button" className="btn ghost" disabled={!dirty || saving} onClick={() => setDraft(original)}>
            {tx("Discard changes", "تجاهل التغييرات")}
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!dirty || saving || !!conflict}
            onClick={() => void save()}
          >
            {saving ? tx("Saving…", "جارٍ الحفظ…") : tx("Save pipeline", "حفظ المسار")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

const t_back = (tx: Tx) => `← ${tx("Pipelines", "المسارات")}`;

function KeptCopy({ copy, tx, onDismiss }: { copy: PipelineDraft; tx: Tx; onDismiss: () => void }) {
  return (
    <details
      open
      style={{ marginBottom: 14, padding: 10, border: "1px solid var(--line-soft)", borderRadius: 10, fontSize: 12.5 }}
    >
      <summary style={{ cursor: "pointer", fontWeight: 600 }}>
        {tx("Your unsaved changes (kept for comparison)", "تغييراتك غير المحفوظة (محفوظة للمقارنة)")}
      </summary>
      <div style={{ display: "grid", gap: 4, marginTop: 8 }}>
        <div dir="auto">
          {tx("Name", "الاسم")}: {copy.name} / {copy.nameAr}
        </div>
        <div>
          {tx("Stale days", "أيام الركود")}: {copy.staleDays ?? "—"} · {tx("Agents can move", "الوكلاء ينقلون")}:{" "}
          {copy.agentCanMove ? tx("yes", "نعم") : tx("no", "لا")} · {tx("Assigns conversations", "يسند المحادثات")}:{" "}
          {copy.assignsConversations ? tx("yes", "نعم") : tx("no", "لا")}
        </div>
        <div dir="auto">
          {tx("Stages", "المراحل")}:{" "}
          {copy.stages.map((s) => tx(s.label, s.labelAr || s.label) + (s.isWon ? " ✓" : s.isTerminal ? " ✗" : "")).join(" → ")}
        </div>
        {copy.removed.length > 0 ? (
          <div dir="auto">
            {tx("Removed", "المحذوفة")}: {copy.removed.map((r) => tx(r.label, r.labelAr || r.label)).join(", ")}
          </div>
        ) : null}
        <div dir="auto">
          {tx("Lost reasons", "أسباب الخسارة")}: {copy.lostReasons.map((r) => tx(r.label, r.labelAr || r.label)).join(", ")}
        </div>
        <div>
          <button type="button" className="btn ghost sm" onClick={onDismiss}>
            {tx("Dismiss", "إخفاء")}
          </button>
        </div>
      </div>
    </details>
  );
}
