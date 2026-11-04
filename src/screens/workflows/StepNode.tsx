import type { ReactNode } from "react";
import type { Tx } from "@/lib/tx";
import type { WorkflowStepType } from "@/lib/types";
import { IconAlert, IconBolt, IconClock, IconRoute, IconSend, IconSparkles, IconTag, IconTemplate } from "@/icons";
import { GROUP_LABEL, STEP_META, splitTemplate, type StepGroup } from "./stepMeta";

const TYPE_ICON: Record<WorkflowStepType, (p: { w?: number }) => ReactNode> = {
  send_whatsapp: IconSend,
  send_whatsapp_template: IconTemplate,
  ask_agent: IconSparkles,
  condition: IconRoute,
  ai_condition: IconRoute,
  delay: IconClock,
  update_data: IconTag,
};

export function StepIcon({ type, size }: { type: WorkflowStepType | "trigger"; size?: "lg" }) {
  const tone: StepGroup | "trigger" = type === "trigger" ? "trigger" : STEP_META[type].group;
  const Icon = type === "trigger" ? IconBolt : TYPE_ICON[type];
  return (
    <span className={`wf-ico wf-tone-${tone}${size ? ` ${size}` : ""}`} aria-hidden="true">
      <Icon w={size === "lg" ? 18 : 16} />
    </span>
  );
}

/** Renders a template, turning {{variable}} tokens into chips. */
export function TemplateText({ text, variableLabel }: { text: string; variableLabel: (path: string) => string }) {
  return (
    <>
      {splitTemplate(text).map((part, i) =>
        part.kind === "text" ? (
          <span key={i}>{part.text}</span>
        ) : (
          <span key={i} className="wf-var">
            {variableLabel(part.path)}
          </span>
        ),
      )}
    </>
  );
}

export function stepKindLabel(type: WorkflowStepType, tx: Tx): string {
  const group = GROUP_LABEL[STEP_META[type].group];
  const isBranch = type === "condition" || type === "ai_condition";
  return isBranch ? `${tx(group[0], group[1])} · ${tx("Branch", "تفرّع")}` : tx(group[0], group[1]);
}

export function StepNode({
  type,
  kind,
  title,
  summary,
  issue,
  selected,
  onSelect,
  variableLabel,
}: {
  type: WorkflowStepType | "trigger";
  kind: string;
  title: string;
  summary: string;
  issue: string | null;
  selected: boolean;
  onSelect: () => void;
  variableLabel: (path: string) => string;
}) {
  return (
    <button
      type="button"
      className={`wf-node${type === "trigger" ? " is-trigger" : ""}${issue ? " is-invalid" : ""}`}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <StepIcon type={type} />
      <span style={{ minWidth: 0 }}>
        <span className="wf-kind">{kind}</span>
        <span className="wf-title">{title}</span>
        <span className="wf-sum" dir="auto">
          <TemplateText text={summary} variableLabel={variableLabel} />
        </span>
        {issue && (
          <span className="wf-warn">
            <IconAlert w={12} />
            {issue}
          </span>
        )}
      </span>
    </button>
  );
}
