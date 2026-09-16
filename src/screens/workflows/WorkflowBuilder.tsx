import { useEffect, useState, type ReactNode } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx, type Tx } from "@/lib/tx";
import { useFetch, useMutation } from "@/api/useFetch";
import { api } from "@/api/client";
import type { Workflow, WorkflowStep, WorkflowStepGraph, WorkflowStepType, WorkflowTriggerType } from "@/lib/types";
import { StepCard } from "./StepCard";
import { AddStepButton } from "./AddStepButton";
import { ConditionConfigForm, AiConditionConfigForm, DelayConfigForm, UpdateDataConfigForm } from "./config/StepConfigForms";
import { TriggerConfigFields } from "./config/TriggerConfigFields";
import { SendWhatsappConfigForm, AskAgentConfigForm } from "./config/MessageConfigForms";
import { ExecutionsTab } from "./ExecutionsTab";
import { TestWorkflowModal } from "./TestWorkflowModal";

const TRIGGER_OPTIONS: Array<{ value: WorkflowTriggerType; en: string; ar: string }> = [
  { value: "contact_created", en: "New contact", ar: "جهة اتصال جديدة" },
  { value: "message_received", en: "Message received", ar: "رسالة واردة" },
  { value: "ticket_created", en: "Ticket created", ar: "تذكرة جديدة" },
  { value: "ticket_stage_changed", en: "Ticket stage changed", ar: "تغيّر مرحلة التذكرة" },
  { value: "schedule", en: "Schedule", ar: "جدولة" },
  { value: "webhook", en: "Webhook", ar: "ويبهوك" },
];

const EMPTY_GRAPH: WorkflowStepGraph = { entry: null, steps: {} };

function defaultConfigFor(type: WorkflowStepType): WorkflowStep["config"] {
  switch (type) {
    case "condition":
      return { field: "", operator: "equals", value: "" };
    case "ai_condition":
      return { prompt: "" };
    case "send_whatsapp":
      return { message: "" };
    case "ask_agent":
      return { prompt: "" };
    case "update_data":
      return { operation: "add_tag", tag: "" };
    case "delay":
      return { amount: 1, unit: "hours" };
  }
}

function createStep(type: WorkflowStepType): WorkflowStep {
  const id = `step_${Math.random().toString(36).slice(2, 10)}`;
  return { id, type, config: defaultConfigFor(type) } as WorkflowStep;
}

interface BranchInfo {
  conditionId: string;
  branch: "then" | "else";
}

interface RenderCtx {
  graph: WorkflowStepGraph;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAddAfter: (parentId: string, type: WorkflowStepType) => void;
  onAddBranch: (conditionId: string, branch: "then" | "else", type: WorkflowStepType) => void;
  onRemoveTail: (id: string, parentId: string | null, branchInfo?: BranchInfo) => void;
  tx: Tx;
}

function renderChain(
  startId: string | null | undefined,
  ctx: RenderCtx,
  visited: Set<string>,
  parentId: string | null,
  branchInfo: BranchInfo | undefined,
  depth: number,
): ReactNode {
  const nodes: ReactNode[] = [];
  let id = startId ?? null;
  let prevId = parentId;
  let prevBranchInfo = branchInfo;

  while (id) {
    if (visited.has(id)) break;
    visited.add(id);
    const step = ctx.graph.steps[id];
    if (!step) break;

    const isBranch = step.type === "condition" || step.type === "ai_condition";
    const isTail = isBranch ? !step.thenNext && !step.elseNext : !step.next;
    const removeParentId = prevId;
    const removeBranchInfo = prevId ? undefined : prevBranchInfo;

    nodes.push(
      <div key={step.id} style={{ marginTop: 8 }}>
        <StepCard
          step={step}
          selected={ctx.selectedId === step.id}
          onSelect={() => ctx.onSelect(step.id)}
          onRemove={isTail ? () => ctx.onRemoveTail(step.id, removeParentId, removeBranchInfo) : undefined}
          tx={ctx.tx}
        />
        {!isBranch && isTail && <AddStepButton onAdd={(type) => ctx.onAddAfter(step.id, type)} tx={ctx.tx} />}
        {isBranch && (
          <div style={{ display: "flex", gap: 16, marginTop: 8, marginInlineStart: 16 }}>
            <div style={{ flex: 1, borderInlineStart: "2px solid var(--line)", paddingInlineStart: 12 }}>
              <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
                THEN
              </div>
              {renderChain(step.thenNext, ctx, visited, null, { conditionId: step.id, branch: "then" }, depth + 1)}
              {!step.thenNext && (
                <AddStepButton onAdd={(type) => ctx.onAddBranch(step.id, "then", type)} tx={ctx.tx} />
              )}
            </div>
            <div style={{ flex: 1, borderInlineStart: "2px solid var(--line)", paddingInlineStart: 12 }}>
              <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
                ELSE
              </div>
              {renderChain(step.elseNext, ctx, visited, null, { conditionId: step.id, branch: "else" }, depth + 1)}
              {!step.elseNext && (
                <AddStepButton onAdd={(type) => ctx.onAddBranch(step.id, "else", type)} tx={ctx.tx} />
              )}
            </div>
          </div>
        )}
      </div>,
    );

    if (isBranch) return nodes; // branch point ends the main chain — v1 rule, see Global Constraints
    prevId = step.id;
    prevBranchInfo = undefined;
    id = step.next ?? null;
  }
  return nodes;
}

export function WorkflowBuilder({ workflowId, onClose }: { workflowId: string | null; onClose: () => void }) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const isNew = workflowId === null;

  const wfQ = useFetch<Workflow>(isNew ? null : `/workflows/${workflowId}`);

  const [id, setId] = useState<string | null>(workflowId);
  const [name, setName] = useState("");
  const [triggerType, setTriggerType] = useState<WorkflowTriggerType>("contact_created");
  const [triggerConfig, setTriggerConfig] = useState<Record<string, unknown>>({});
  const [status, setStatus] = useState<Workflow["status"]>("draft");
  const [graph, setGraph] = useState<WorkflowStepGraph>(EMPTY_GRAPH);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"builder" | "executions">("builder");
  const [showTest, setShowTest] = useState(false);

  useEffect(() => {
    if (wfQ.data) {
      setId(wfQ.data.id);
      setName(wfQ.data.name);
      setTriggerType(wfQ.data.triggerType);
      setTriggerConfig(wfQ.data.triggerConfig ?? {});
      setStatus(wfQ.data.status);
      setGraph(wfQ.data.steps);
    }
  }, [wfQ.data]);

  type SavePayload = {
    name: string;
    triggerType: WorkflowTriggerType;
    triggerConfig: Record<string, unknown>;
    steps: WorkflowStepGraph;
  };
  const createMut = useMutation<SavePayload, Workflow>((input) => api.post("/workflows", input));
  const updateMut = useMutation<SavePayload, Workflow>((input) => api.patch(`/workflows/${id}`, input));
  const activateMut = useMutation<void, Workflow>(() => api.post(`/workflows/${id}/activate`));
  const deactivateMut = useMutation<void, Workflow>(() => api.post(`/workflows/${id}/deactivate`));

  async function onSave() {
    setError(null);
    try {
      const payload: SavePayload = { name, triggerType, triggerConfig, steps: graph };
      const saved = id ? await updateMut.mutate(payload) : await createMut.mutate(payload);
      setId(saved.id);
      setStatus(saved.status);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function onActivate() {
    setError(null);
    try {
      setStatus((await activateMut.mutate()).status);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function onDeactivate() {
    setError(null);
    try {
      setStatus((await deactivateMut.mutate()).status);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function addStepAtEntry(type: WorkflowStepType) {
    const step = createStep(type);
    setGraph((g) => ({ entry: step.id, steps: { ...g.steps, [step.id]: step } }));
    setSelectedId(step.id);
  }

  function addStepAfter(parentId: string, type: WorkflowStepType) {
    const step = createStep(type);
    setGraph((g) => {
      const parent = g.steps[parentId];
      if (!parent || parent.next) return g;
      return { ...g, steps: { ...g.steps, [parentId]: { ...parent, next: step.id }, [step.id]: step } };
    });
    setSelectedId(step.id);
  }

  function addBranchStep(conditionId: string, branch: "then" | "else", type: WorkflowStepType) {
    const step = createStep(type);
    setGraph((g) => {
      const cond = g.steps[conditionId];
      if (!cond || (cond.type !== "condition" && cond.type !== "ai_condition")) return g;
      const key = branch === "then" ? "thenNext" : "elseNext";
      if (cond[key]) return g;
      return { ...g, steps: { ...g.steps, [conditionId]: { ...cond, [key]: step.id }, [step.id]: step } };
    });
    setSelectedId(step.id);
  }

  function removeTailStep(stepId: string, parentId: string | null, branchInfo?: BranchInfo) {
    setGraph((g) => {
      const step = g.steps[stepId];
      if (!step) return g;
      const isBranchStep = step.type === "condition" || step.type === "ai_condition";
      const hasChildren = isBranchStep ? Boolean(step.thenNext) || Boolean(step.elseNext) : Boolean(step.next);
      if (hasChildren) return g;
      const rest = { ...g.steps };
      delete rest[stepId];
      if (parentId) {
        const parent = rest[parentId];
        return { ...g, steps: { ...rest, [parentId]: { ...parent, next: undefined } } };
      }
      if (branchInfo) {
        const cond = rest[branchInfo.conditionId];
        const key = branchInfo.branch === "then" ? "thenNext" : "elseNext";
        return { ...g, steps: { ...rest, [branchInfo.conditionId]: { ...cond, [key]: undefined } } };
      }
      return { entry: null, steps: rest };
    });
    setSelectedId(null);
  }

  function updateStepConfig(stepId: string, config: WorkflowStep["config"]) {
    setGraph((g) => ({
      ...g,
      steps: { ...g.steps, [stepId]: { ...g.steps[stepId], config } as WorkflowStep },
    }));
  }

  const selectedStep = selectedId ? graph.steps[selectedId] : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "16px 32px",
          borderBottom: "1px solid var(--line-soft)",
        }}
      >
        <button type="button" onClick={onClose}>
          {tx("← Back", "→ رجوع")}
        </button>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={tx("Workflow name", "اسم الأتمتة")}
          style={{ flex: 1, fontSize: 16, fontWeight: 600, background: "transparent", border: "none", outline: "none" }}
        />
        <span className="muted" style={{ fontSize: 12 }}>
          {status === "active" ? tx("Active", "نشطة") : tx("Draft", "مسودة")}
        </span>
        <button type="button" onClick={onSave}>
          {tx("Save", "حفظ")}
        </button>
        {id && status === "draft" && (
          <button type="button" onClick={onActivate}>
            {tx("Activate", "تفعيل")}
          </button>
        )}
        {id && status === "active" && (
          <button type="button" onClick={onDeactivate}>
            {tx("Deactivate", "إيقاف")}
          </button>
        )}
        {id && (
          <button type="button" onClick={() => setShowTest(true)}>
            {tx("Test", "اختبار")}
          </button>
        )}
        {id && (
          <div style={{ display: "flex", gap: 4 }}>
            <button
              type="button"
              onClick={() => setTab("builder")}
              style={{ fontWeight: tab === "builder" ? 700 : 400 }}
            >
              {tx("Builder", "الإنشاء")}
            </button>
            <button
              type="button"
              onClick={() => setTab("executions")}
              style={{ fontWeight: tab === "executions" ? 700 : 400 }}
            >
              {tx("Executions", "التشغيلات")}
            </button>
          </div>
        )}
      </div>

      {error && <div style={{ color: "var(--bad)", padding: "8px 32px" }}>{error}</div>}

      {tab === "builder" ? (
        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          <div style={{ width: "45%", overflowY: "auto", padding: 24, borderInlineEnd: "1px solid var(--line-soft)" }}>
            <div style={{ marginBottom: 12 }}>
              <label className="muted" style={{ fontSize: 12 }}>
                {tx("Trigger", "المُشغّل")}
              </label>
              <select
                value={triggerType}
                onChange={(e) => setTriggerType(e.target.value as WorkflowTriggerType)}
                style={{ display: "block", width: "100%", marginTop: 4 }}
              >
                {TRIGGER_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {t.lang === "ar" ? o.ar : o.en}
                  </option>
                ))}
              </select>
            </div>
            <TriggerConfigFields
              triggerType={triggerType}
              triggerConfig={triggerConfig}
              onChange={setTriggerConfig}
              tx={tx}
            />

            {graph.entry ? (
              renderChain(
                graph.entry,
                {
                  graph,
                  selectedId,
                  onSelect: setSelectedId,
                  onAddAfter: addStepAfter,
                  onAddBranch: addBranchStep,
                  onRemoveTail: removeTailStep,
                  tx,
                },
                new Set(),
                null,
                undefined,
                0,
              )
            ) : (
              <AddStepButton onAdd={addStepAtEntry} tx={tx} />
            )}
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: 24 }}>
            {selectedStep ? (
              <div>
                <div style={{ fontWeight: 600, marginBottom: 12 }}>{selectedStep.type}</div>
                {selectedStep.type === "condition" && (
                  <ConditionConfigForm
                    config={selectedStep.config}
                    onChange={(c) => updateStepConfig(selectedStep.id, c)}
                    tx={tx}
                  />
                )}
                {selectedStep.type === "ai_condition" && (
                  <AiConditionConfigForm
                    config={selectedStep.config}
                    onChange={(c) => updateStepConfig(selectedStep.id, c)}
                    tx={tx}
                  />
                )}
                {selectedStep.type === "delay" && (
                  <DelayConfigForm
                    config={selectedStep.config}
                    onChange={(c) => updateStepConfig(selectedStep.id, c)}
                    tx={tx}
                  />
                )}
                {selectedStep.type === "update_data" && (
                  <UpdateDataConfigForm
                    config={selectedStep.config}
                    onChange={(c) => updateStepConfig(selectedStep.id, c)}
                    tx={tx}
                  />
                )}
                {selectedStep.type === "send_whatsapp" && (
                  <SendWhatsappConfigForm
                    config={selectedStep.config}
                    onChange={(c) => updateStepConfig(selectedStep.id, c)}
                    triggerType={triggerType}
                    tx={tx}
                  />
                )}
                {selectedStep.type === "ask_agent" && (
                  <AskAgentConfigForm
                    config={selectedStep.config}
                    onChange={(c) => updateStepConfig(selectedStep.id, c)}
                    triggerType={triggerType}
                    tx={tx}
                  />
                )}
              </div>
            ) : (
              <div className="muted">{tx("Select a step to configure it.", "اختر خطوة لتعديلها.")}</div>
            )}
          </div>
        </div>
      ) : (
        id && <ExecutionsTab workflowId={id} tx={tx} lang={t.lang} />
      )}

      {showTest && id && (
        <TestWorkflowModal workflowId={id} onClose={() => setShowTest(false)} tx={tx} />
      )}
    </div>
  );
}
