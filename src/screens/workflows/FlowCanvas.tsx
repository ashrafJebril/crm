import { useState, type ReactNode } from "react";
import type { Tx } from "@/lib/tx";
import type { WorkflowStepGraph, WorkflowStepType, WorkflowTriggerType } from "@/lib/types";
import { IconPlus } from "@/icons";
import { isBranchStep, type InsertPoint } from "./graph";
import { STEP_META, TRIGGER_META, summarizeStep, summarizeTrigger, type SummaryCtx } from "./stepMeta";
import { StepNode, stepKindLabel } from "./StepNode";
import { StepPicker } from "./StepPicker";

export const TRIGGER_NODE_ID = "__trigger__";

const slotKey = (at: InsertPoint) =>
  at.kind === "entry" ? "entry" : at.kind === "after" ? `after:${at.stepId}` : `${at.branch}:${at.conditionId}`;

interface Props {
  graph: WorkflowStepGraph;
  triggerType: WorkflowTriggerType;
  triggerConfig: Record<string, unknown>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onInsert: (at: InsertPoint, type: WorkflowStepType) => void;
  issues: Record<string, string | null>;
  ctx: SummaryCtx;
  zoom: number;
  tx: Tx;
}

export function FlowCanvas({ graph, triggerType, triggerConfig, selectedId, onSelect, onInsert, issues, ctx, zoom, tx }: Props) {
  const [openSlot, setOpenSlot] = useState<string | null>(null);

  function pick(at: InsertPoint, type: WorkflowStepType) {
    setOpenSlot(null);
    onInsert(at, type);
  }

  function slot(at: InsertPoint, variant: "plus" | "end", label?: string): ReactNode {
    const key = slotKey(at);
    const open = openSlot === key;
    const toggle = () => setOpenSlot(open ? null : key);
    return (
      <div className="wf-slot" key={`slot-${key}`}>
        <div className="wf-edge" />
        <div className="wf-slot-anchor">
          {variant === "plus" ? (
            <button
              type="button"
              className="wf-plus"
              aria-haspopup="menu"
              aria-expanded={open}
              aria-label={tx("Add a step here", "أضف خطوة هنا")}
              title={tx("Add a step here", "أضف خطوة هنا")}
              onClick={toggle}
            >
              <IconPlus w={12} stroke={2} />
            </button>
          ) : (
            <button type="button" className="wf-end-add" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
              <IconPlus w={12} stroke={2} />
              {label ?? tx("Add step", "إضافة خطوة")}
            </button>
          )}
          {open && <StepPicker onPick={(type) => pick(at, type)} onClose={() => setOpenSlot(null)} tx={tx} />}
        </div>
        <div className="wf-edge" style={variant === "end" ? { height: 14 } : undefined} />
        {variant === "end" && <span className="wf-end-cap">{tx("End", "النهاية")}</span>}
      </div>
    );
  }

  /** Renders a chain from `startId` until it ends or forks. */
  function chain(startId: string | undefined, visited: Set<string>): ReactNode[] {
    const nodes: ReactNode[] = [];
    let id = startId;
    while (id && !visited.has(id) && graph.steps[id]) {
      visited.add(id);
      const step = graph.steps[id];
      const meta = STEP_META[step.type];
      nodes.push(
        <StepNode
          key={step.id}
          type={step.type}
          kind={stepKindLabel(step.type, tx)}
          title={tx(meta.en, meta.ar)}
          summary={summarizeStep(step, ctx)}
          issue={issues[step.id] ?? null}
          selected={selectedId === step.id}
          onSelect={() => onSelect(step.id)}
          variableLabel={ctx.variableLabel}
        />,
      );

      if (isBranchStep(step)) {
        const lane = (branch: "then" | "else", start: string | undefined) => (
          <div className="wf-lane" key={branch}>
            <span className={`wf-lane-label ${branch === "then" ? "yes" : "no"}`}>
              {branch === "then" ? tx("Yes", "نعم") : tx("No", "لا")}
            </span>
            {start
              ? [slot({ kind: "branch", conditionId: step.id, branch }, "plus"), ...chain(start, visited)]
              : slot({ kind: "branch", conditionId: step.id, branch }, "end")}
          </div>
        );
        nodes.push(
          <div className="wf-edge" key={`${step.id}-stem`} style={{ height: 18 }} />,
          <div className="wf-lanes" key={`${step.id}-lanes`}>
            {lane("then", step.thenNext)}
            {lane("else", step.elseNext)}
          </div>,
        );
        return nodes;
      }

      nodes.push(slot({ kind: "after", stepId: step.id }, step.next ? "plus" : "end"));
      id = step.next;
    }
    return nodes;
  }

  const trigger = TRIGGER_META[triggerType];

  return (
    <div className="wf-flow" style={{ zoom }}>
      <StepNode
        type="trigger"
        kind={tx("When", "عندما")}
        title={tx(trigger.en, trigger.ar)}
        summary={summarizeTrigger(triggerType, triggerConfig, ctx)}
        issue={issues[TRIGGER_NODE_ID] ?? null}
        selected={selectedId === TRIGGER_NODE_ID}
        onSelect={() => onSelect(TRIGGER_NODE_ID)}
        variableLabel={ctx.variableLabel}
      />
      {graph.entry
        ? [slot({ kind: "entry" }, "plus"), ...chain(graph.entry, new Set())]
        : slot({ kind: "entry" }, "end", tx("Add the first step", "أضف الخطوة الأولى"))}
    </div>
  );
}
