import { useCallback, useEffect, useMemo, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { useFetch, useMutation } from "@/api/useFetch";
import { api } from "@/api/client";
import { Modal } from "@/components/Modal";
import { useToast } from "@/components/Toast";
import { IconAlert, IconChev, IconPlay } from "@/icons";
import type {
  Workflow,
  WorkflowRun,
  WorkflowStep,
  WorkflowStepGraph,
  WorkflowStepType,
} from "@/lib/types";
import { duplicateStep, insertStep, orderedStepIds, pruneUnreachable, removalImpact, removeStep, type InsertPoint } from "./graph";
import { countIssues, validateStep, validateTrigger, variablesFor } from "./stepMeta";
import { FlowCanvas, TRIGGER_NODE_ID } from "./FlowCanvas";
import { StepInspector } from "./StepInspector";
import { useStageOptions } from "./config/StepConfigForms";
import { ExecutionsTab } from "./ExecutionsTab";
import type { WorkflowDraft } from "./templates";
import { TestWorkflowModal } from "./TestWorkflowModal";
import "./workflows.css";

const EMPTY_GRAPH: WorkflowStepGraph = { entry: null, steps: {} };
const ZOOM_STEPS = [0.6, 0.75, 0.9, 1, 1.1, 1.25];

export const newStepId = () => `step_${Math.random().toString(36).slice(2, 10)}`;

function defaultConfigFor(type: WorkflowStepType): WorkflowStep["config"] {
  switch (type) {
    case "condition":
      return { field: "", operator: "equals", value: "" };
    case "ai_condition":
      return { prompt: "" };
    case "send_whatsapp":
      return { message: "" };
    case "send_whatsapp_template":
      return { name: "", language: "", variables: [] };
    case "ask_agent":
      return { prompt: "" };
    case "update_data":
      return { operation: "add_tag", tag: "" };
    case "delay":
      return { amount: 1, unit: "hours" };
  }
}

type Draft = WorkflowDraft;

const snapshot = (d: Draft) => JSON.stringify(d);
const BLANK: Draft = { name: "", triggerType: "contact_created", triggerConfig: {}, graph: EMPTY_GRAPH };

export function WorkflowBuilder({
  workflowId,
  template,
  onClose,
}: {
  workflowId: string | null;
  /** Unsaved starting point when installing a template. */
  template?: { draft: WorkflowDraft; needsStage: boolean; setupNote?: string | null; focusStepId?: string | null };
  onClose: () => void;
}) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const { toast } = useToast();

  const wfQ = useFetch<Workflow>(workflowId ? `/workflows/${workflowId}` : null);

  const [id, setId] = useState<string | null>(workflowId);
  // A template starts as an unsaved draft, so "Unsaved changes" shows until the first save.
  const [draft, setDraft] = useState<Draft>(template?.draft ?? BLANK);
  const [saved, setSaved] = useState<string>(snapshot(BLANK));
  const [status, setStatus] = useState<Workflow["status"]>("draft");
  const [webhookSecret, setWebhookSecret] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(
    template?.focusStepId ?? (workflowId ? null : TRIGGER_NODE_ID),
  );
  const [setupNote, setSetupNote] = useState<string | null>(template?.setupNote ?? null);
  const [error, setError] = useState<string | null>(
    template?.needsStage
      ? tx(
          "Pick the stage that should start this workflow. Your pipeline has no Won stage to preselect.",
          "اختر المرحلة التي تبدأ هذه الأتمتة. لا توجد مرحلة «تم الفوز» في مسارك لاختيارها تلقائيًا.",
        )
      : null,
  );
  const [tab, setTab] = useState<"builder" | "runs">("builder");
  const [showTest, setShowTest] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; dropped: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!wfQ.data) return;
    const loaded: Draft = {
      name: wfQ.data.name,
      triggerType: wfQ.data.triggerType,
      triggerConfig: wfQ.data.triggerConfig ?? {},
      graph: wfQ.data.steps ?? EMPTY_GRAPH,
    };
    setId(wfQ.data.id);
    setDraft(loaded);
    setSaved(snapshot(loaded));
    setStatus(wfQ.data.status);
    setWebhookSecret(wfQ.data.webhookSecret);
  }, [wfQ.data]);

  const runsQ = useFetch<WorkflowRun[]>(id ? `/workflows/${id}/runs` : null);
  const runCount = runsQ.data?.length ?? 0;

  const stageOptions = useStageOptions();
  const { name, triggerType, triggerConfig, graph } = draft;
  const dirty = snapshot(draft) !== saved;

  // Warn before a full page unload drops unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [dirty]);

  const order = useMemo(() => orderedStepIds(graph), [graph]);

  // A deal-won template installed without a Won stage would fire on every stage change.
  const stageIssue =
    template?.needsStage && triggerType === "ticket_stage_changed" && !triggerConfig.stageId
      ? tx("Pick the stage that starts this workflow", "اختر المرحلة التي تبدأ هذه الأتمتة")
      : null;

  const issues = useMemo(() => {
    const map: Record<string, string | null> = {
      [TRIGGER_NODE_ID]: validateTrigger(triggerType, triggerConfig, tx) ?? stageIssue,
    };
    for (const sid of order) map[sid] = validateStep(graph.steps[sid], tx);
    return map;
    // tx only changes with the language.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, order, triggerType, triggerConfig, stageIssue, t.lang]);
  const issueCount = countIssues(graph, triggerType, triggerConfig, tx) + (stageIssue ? 1 : 0);

  const labelByPath = useMemo(() => {
    const map = new Map<string, string>();
    for (const v of variablesFor(triggerType, graph, null, tx)) map.set(v.path, v.label);
    order.forEach((sid, i) => {
      if (graph.steps[sid].type === "ask_agent") map.set(`steps.${sid}.answer`, tx(`AI answer (step ${i + 1})`, `إجابة الذكاء (الخطوة ${i + 1})`));
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggerType, graph, order, t.lang]);
  const stageLabel = useCallback((sid: string) => stageOptions.find((s) => s.id === sid)?.label, [stageOptions]);
  const summaryCtx = useMemo(
    () => ({ tx, variableLabel: (p: string) => labelByPath.get(p) ?? p, stageLabel }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [labelByPath, stageLabel, t.lang],
  );

  const setGraph = (fn: (g: WorkflowStepGraph) => WorkflowStepGraph) => setDraft((d) => ({ ...d, graph: fn(d.graph) }));

  type SavePayload = Omit<Draft, "graph"> & { steps: WorkflowStepGraph };
  const createMut = useMutation<SavePayload, Workflow>((input) => api.post("/workflows", input));
  const updateMut = useMutation<SavePayload & { id: string }, Workflow>(({ id: wid, ...input }) => api.patch(`/workflows/${wid}`, input));
  const activateMut = useMutation<string, Workflow>((wid) => api.post(`/workflows/${wid}/activate`));
  const deactivateMut = useMutation<string, Workflow>((wid) => api.post(`/workflows/${wid}/deactivate`));

  /** Saves the draft; returns the workflow id, or null when saving failed. */
  async function save(opts: { quiet?: boolean } = {}): Promise<string | null> {
    setError(null);
    // The server rejects a delay without a positive wait even on a draft save.
    const badDelay = order.find((sid) => {
      const s = graph.steps[sid];
      return s.type === "delay" && !(Number.isFinite(s.config.amount) && s.config.amount > 0);
    });
    if (badDelay) {
      setSelectedId(badDelay);
      setTab("builder");
      setError(tx("Set a wait time above 0 on the Delay step before saving.", "حدّد مدة انتظار أكبر من 0 في خطوة التأخير قبل الحفظ."));
      return null;
    }
    const finalName = name.trim() || tx("Untitled workflow", "أتمتة بلا عنوان");
    const next: Draft = { ...draft, name: finalName, graph: pruneUnreachable(graph) };
    const payload: SavePayload = { name: next.name, triggerType: next.triggerType, triggerConfig: next.triggerConfig, steps: next.graph };
    setBusy(true);
    try {
      const res = id ? await updateMut.mutate({ ...payload, id }) : await createMut.mutate(payload);
      setId(res.id);
      setStatus(res.status);
      setWebhookSecret(res.webhookSecret);
      setDraft(next);
      setSaved(snapshot(next));
      if (!opts.quiet) toast(tx("Workflow saved", "تم حفظ الأتمتة"), "success");
      return res.id;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function onActivate() {
    const wid = dirty || !id ? await save({ quiet: true }) : id;
    if (!wid) return;
    setBusy(true);
    try {
      setStatus((await activateMut.mutate(wid)).status);
      toast(tx("Workflow is live", "الأتمتة تعمل الآن"), "success");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function onDeactivate() {
    if (!id) return;
    setBusy(true);
    try {
      setStatus((await deactivateMut.mutate(id)).status);
      toast(tx("Workflow paused", "تم إيقاف الأتمتة"), "info");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function onTest() {
    const wid = dirty || !id ? await save({ quiet: true }) : id;
    if (wid) setShowTest(true);
  }

  function onInsert(at: InsertPoint, type: WorkflowStepType) {
    const step = { id: newStepId(), type, config: defaultConfigFor(type) } as WorkflowStep;
    setGraph((g) => insertStep(g, at, step));
    setSelectedId(step.id);
  }

  function requestDelete(sid: string) {
    const dropped = removalImpact(graph, sid).length;
    if (dropped > 0) setPendingDelete({ id: sid, dropped });
    else doDelete(sid);
  }

  function doDelete(sid: string) {
    setGraph((g) => removeStep(g, sid).graph);
    setSelectedId(null);
    setPendingDelete(null);
  }

  function onDuplicate(sid: string) {
    const copyId = newStepId();
    setGraph((g) => duplicateStep(g, sid, copyId));
    setSelectedId(copyId);
  }

  function back() {
    if (dirty) setConfirmLeave(true);
    else onClose();
  }

  function jumpToFirstIssue() {
    setTab("builder");
    if (issues[TRIGGER_NODE_ID]) return setSelectedId(TRIGGER_NODE_ID);
    const first = order.find((sid) => issues[sid]);
    if (first) setSelectedId(first);
  }

  const activateBlocked = issueCount > 0 || !graph.entry;
  const activateTitle = !graph.entry
    ? tx("Add at least one step first", "أضف خطوة واحدة على الأقل أولاً")
    : issueCount > 0
      ? tx("Fix the highlighted steps first", "أصلح الخطوات المميزة أولاً")
      : undefined;

  if (workflowId && wfQ.loading && !wfQ.data) {
    return <div className="wf-builder muted" style={{ padding: 32 }}>{tx("Loading…", "جارٍ التحميل…")}</div>;
  }

  return (
    <div className="wf-builder">
      <div className="wf-head">
        <button type="button" className="btn icon ghost" onClick={back} aria-label={tx("Back to workflows", "العودة إلى الأتمتة")}>
          {/* Chevron points forward; rotate for "back", then mirror for RTL. */}
          <span className="flip-rtl" style={{ display: "inline-flex" }}>
            <span style={{ display: "inline-flex", transform: "rotate(180deg)" }}>
              <IconChev w={16} />
            </span>
          </span>
        </button>
        <div className="wf-name">
          <input
            value={name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            placeholder={tx("Name this workflow", "سمِّ هذه الأتمتة")}
            aria-label={tx("Workflow name", "اسم الأتمتة")}
          />
          <span className={`badge ${status === "active" ? "ok" : ""}`.trim()}>
            {status === "active" ? tx("Active", "نشطة") : tx("Draft", "مسودة")}
          </span>
          {dirty && <span className="wf-unsaved">{tx("Unsaved changes", "تغييرات غير محفوظة")}</span>}
        </div>
        <div className="wf-tabs" role="tablist" aria-label={tx("View", "العرض")}>
          <button type="button" role="tab" className="wf-tab" aria-selected={tab === "builder"} onClick={() => setTab("builder")}>
            {tx("Builder", "الإنشاء")}
          </button>
          <button
            type="button"
            role="tab"
            className="wf-tab"
            aria-selected={tab === "runs"}
            disabled={!id}
            title={id ? undefined : tx("Save the workflow to see its runs", "احفظ الأتمتة لرؤية تشغيلاتها")}
            onClick={() => setTab("runs")}
          >
            {tx("Runs", "التشغيلات")}
            {id && runCount > 0 && <span className="mono"> · {runCount >= 50 ? "50+" : runCount}</span>}
          </button>
        </div>
        <div className="wf-head-actions">
          {issueCount > 0 && (
            <button type="button" className="wf-issues" onClick={jumpToFirstIssue}>
              <IconAlert w={12} />
              {issueCount === 1
                ? tx("1 step needs attention", "خطوة واحدة تحتاج إلى انتباه")
                : tx(`${issueCount} steps need attention`, `${issueCount} خطوات تحتاج إلى انتباه`)}
            </button>
          )}
          <button type="button" className="btn" onClick={onTest} disabled={busy || !graph.entry}>
            <IconPlay w={12} />
            {tx("Test", "اختبار")}
          </button>
          <button type="button" className="btn" onClick={() => save()} disabled={busy}>
            {tx("Save", "حفظ")}
          </button>
          {status === "active" ? (
            <button type="button" className="btn" onClick={onDeactivate} disabled={busy}>
              {tx("Pause", "إيقاف")}
            </button>
          ) : (
            <button
              type="button"
              className="btn primary"
              onClick={onActivate}
              disabled={busy || activateBlocked}
              title={activateTitle}
            >
              {tx("Activate", "تفعيل")}
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="wf-error" role="alert">
          <IconAlert w={14} />
          <span style={{ flex: 1 }}>{error}</span>
          <button type="button" className="btn icon ghost sm" onClick={() => setError(null)} aria-label={tx("Dismiss", "إغلاق")}>
            ✕
          </button>
        </div>
      )}

      {setupNote && (
        <div className="wf-note" role="note">
          <IconAlert w={14} />
          <span style={{ flex: 1 }}>{setupNote}</span>
          <button type="button" className="btn icon ghost sm" onClick={() => setSetupNote(null)} aria-label={tx("Dismiss", "إغلاق")}>
            ✕
          </button>
        </div>
      )}

      {tab === "builder" || !id ? (
        <div className="wf-body">
          <div
            className="wf-canvas"
            onKeyDown={(e) => {
              if (e.key === "Escape" && !(e.target as HTMLElement).closest(".wf-picker")) setSelectedId(null);
            }}
          >
            <div className="wf-zoom">
              <div className="wf-tabs" aria-label={tx("Zoom", "التكبير")}>
                <button
                  type="button"
                  className="wf-tab"
                  aria-label={tx("Zoom out", "تصغير")}
                  disabled={zoom <= ZOOM_STEPS[0]}
                  onClick={() => setZoom((z) => ZOOM_STEPS[Math.max(0, ZOOM_STEPS.indexOf(z) - 1)])}
                >
                  −
                </button>
                <button type="button" className="wf-tab mono" aria-label={tx("Reset zoom", "إعادة التكبير")} onClick={() => setZoom(1)}>
                  {Math.round(zoom * 100)}%
                </button>
                <button
                  type="button"
                  className="wf-tab"
                  aria-label={tx("Zoom in", "تكبير")}
                  disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]}
                  onClick={() => setZoom((z) => ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, ZOOM_STEPS.indexOf(z) + 1)])}
                >
                  +
                </button>
              </div>
            </div>
            <FlowCanvas
              graph={graph}
              triggerType={triggerType}
              triggerConfig={triggerConfig}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onInsert={onInsert}
              issues={issues}
              ctx={summaryCtx}
              zoom={zoom}
              tx={tx}
            />
          </div>
          <StepInspector
            selectedId={selectedId}
            graph={graph}
            order={order}
            issues={issues}
            triggerType={triggerType}
            triggerConfig={triggerConfig}
            onTriggerType={(tt) => setDraft((d) => ({ ...d, triggerType: tt, triggerConfig: {} }))}
            onTriggerConfig={(c) => setDraft((d) => ({ ...d, triggerConfig: c }))}
            onStepConfig={(sid, config) =>
              setGraph((g) => ({ ...g, steps: { ...g.steps, [sid]: { ...g.steps[sid], config } as WorkflowStep } }))
            }
            onDelete={requestDelete}
            onDuplicate={onDuplicate}
            onClose={() => setSelectedId(null)}
            variablesFor={(sid) => variablesFor(triggerType, graph, sid, tx)}
            stageOptions={stageOptions}
            workflowId={id}
            webhookSecret={webhookSecret}
            tx={tx}
          />
        </div>
      ) : (
        <ExecutionsTab workflowId={id} tx={tx} lang={t.lang} />
      )}

      {showTest && id && (
        <TestWorkflowModal
          workflowId={id}
          triggerType={triggerType}
          onClose={() => {
            setShowTest(false);
            runsQ.refetch();
          }}
          tx={tx}
        />
      )}

      {confirmLeave && (
        <Modal onClose={() => setConfirmLeave(false)} label={tx("Unsaved changes", "تغييرات غير محفوظة")}>
          <h3 style={{ marginTop: 0 }}>{tx("Leave without saving?", "المغادرة دون حفظ؟")}</h3>
          <p className="muted" style={{ fontSize: 13 }}>
            {tx("Your changes to this workflow will be lost.", "ستفقد تغييراتك على هذه الأتمتة.")}
          </p>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
            <button type="button" className="btn ghost" onClick={onClose}>
              {tx("Discard changes", "تجاهل التغييرات")}
            </button>
            <button type="button" className="btn" onClick={() => setConfirmLeave(false)}>
              {tx("Keep editing", "متابعة التحرير")}
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={async () => {
                if (await save()) onClose();
                else setConfirmLeave(false);
              }}
            >
              {tx("Save and leave", "حفظ ومغادرة")}
            </button>
          </div>
        </Modal>
      )}

      {pendingDelete && (
        <Modal onClose={() => setPendingDelete(null)} label={tx("Delete condition", "حذف الشرط")}>
          <h3 style={{ marginTop: 0 }}>{tx("Delete this condition?", "حذف هذا الشرط؟")}</h3>
          <p className="muted" style={{ fontSize: 13 }}>
            {pendingDelete.dropped === 1
              ? tx(
                  "Steps on the Yes lane move up to take its place. The 1 step on the No lane will be deleted.",
                  "ستنتقل خطوات مسار نعم لتأخذ مكانه. وستُحذف الخطوة الموجودة في مسار لا.",
                )
              : tx(
                  `Steps on the Yes lane move up to take its place. The ${pendingDelete.dropped} steps on the No lane will be deleted.`,
                  `ستنتقل خطوات مسار نعم لتأخذ مكانه. وستُحذف ${pendingDelete.dropped} خطوات من مسار لا.`,
                )}
          </p>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
            <button type="button" className="btn" onClick={() => setPendingDelete(null)}>
              {tx("Cancel", "إلغاء")}
            </button>
            <button type="button" className="btn primary" onClick={() => doDelete(pendingDelete.id)}>
              {tx("Delete", "حذف")}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
