// src/screens/workflows/WorkflowsPage.tsx
import { memo, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx, type Tx } from "@/lib/tx";
import { useFetch } from "@/api/useFetch";
import { PageHeader } from "@/components/PageHeader";
import { IconPlus } from "@/icons";
import type { Pipeline, Workflow, WorkflowStepGraph, WorkflowStepType } from "@/lib/types";
import { WorkflowBuilder, newStepId } from "./WorkflowBuilder";
import { orderedStepIds } from "./graph";
import { STEP_META, TRIGGER_META } from "./stepMeta";
import { StepIcon } from "./StepNode";
import { instantiateTemplate, WORKFLOW_TEMPLATES, type WorkflowDraft, type WorkflowTemplate } from "./templates";
import "./workflows.css";

const MAX_CHAIN_ICONS = 7;

type Open =
  | { kind: "existing"; id: string }
  | { kind: "blank" }
  | { kind: "template"; template: { draft: WorkflowDraft; needsStage: boolean } };

/** Trigger icon followed by one icon per step, in reading order. */
function StepChain({ graph, tx }: { graph: WorkflowStepGraph; tx: Tx }) {
  const order = orderedStepIds(graph);
  if (order.length === 0) return <span className="wf-hint">{tx("No steps yet", "لا توجد خطوات بعد")}</span>;
  return (
    <div className="wf-card-chain" aria-label={tx(`${order.length} steps`, `${order.length} خطوات`)}>
      {order.slice(0, MAX_CHAIN_ICONS).map((sid) => {
        const type: WorkflowStepType = graph.steps[sid].type;
        return (
          <span key={sid} title={tx(STEP_META[type].en, STEP_META[type].ar)}>
            <StepIcon type={type} />
          </span>
        );
      })}
      {order.length > MAX_CHAIN_ICONS && <span className="mono muted" style={{ fontSize: 11 }}>+{order.length - MAX_CHAIN_ICONS}</span>}
    </div>
  );
}

function TriggerLine({ type, tx }: { type: Workflow["triggerType"]; tx: Tx }) {
  const trigger = TRIGGER_META[type];
  return (
    <div className="wf-card-trigger">
      <StepIcon type="trigger" />
      <span>
        {tx("When", "عندما")}: <b style={{ color: "var(--ink-1)", fontWeight: 600 }}>{tx(trigger.en, trigger.ar)}</b>
      </span>
    </div>
  );
}

function WorkflowCard({ wf, onOpen, lang }: { wf: Workflow; onOpen: () => void; lang: "en" | "ar" }) {
  const tx = makeTx(lang);
  const graph = wf.steps ?? { entry: null, steps: {} };
  const count = orderedStepIds(graph).length;
  return (
    <button type="button" className="wf-card" onClick={onOpen}>
      <div className="wf-card-top">
        <h3>{wf.name || tx("Untitled workflow", "أتمتة بلا عنوان")}</h3>
        <span className={`badge ${wf.status === "active" ? "ok" : ""}`.trim()}>
          {wf.status === "active" ? tx("Active", "نشطة") : tx("Draft", "مسودة")}
        </span>
      </div>
      <TriggerLine type={wf.triggerType} tx={tx} />
      <StepChain graph={graph} tx={tx} />
      <div className="wf-card-foot">
        <span>{count === 1 ? tx("1 step", "خطوة واحدة") : tx(`${count} steps`, `${count} خطوات`)}</span>
        <span>
          {tx("Updated", "آخر تحديث")} {new Date(wf.updatedAt).toLocaleDateString(lang === "ar" ? "ar" : "en", { dateStyle: "medium" })}
        </span>
      </div>
    </button>
  );
}

function TemplateCard({ tpl, onUse, tx }: { tpl: WorkflowTemplate; onUse: () => void; tx: Tx }) {
  const graph = typeof tpl.steps === "function" ? tpl.steps(tx) : tpl.steps;
  return (
    <button type="button" className="wf-card wf-template" onClick={onUse}>
      <div className="wf-card-top">
        <h3>{tx(tpl.name[0], tpl.name[1])}</h3>
        <span className="badge accent">{tx("Template", "قالب")}</span>
      </div>
      <p className="wf-template-desc">{tx(tpl.description[0], tpl.description[1])}</p>
      <TriggerLine type={tpl.triggerType} tx={tx} />
      <StepChain graph={graph} tx={tx} />
      <div className="wf-card-foot">
        <span>{tx("Opens as a draft you can edit", "يُفتح كمسودة قابلة للتعديل")}</span>
        <span className="wf-template-use">{tx("Use template →", "استخدم القالب ←")}</span>
      </div>
    </button>
  );
}

function WorkflowsPageImpl() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const { data, loading, refetch } = useFetch<Workflow[]>("/workflows");
  const pipelinesQ = useFetch<Pipeline[]>("/pipelines");
  const workflows = data ?? [];
  const [open, setOpen] = useState<Open | null>(null);

  if (open !== null) {
    return (
      <WorkflowBuilder
        workflowId={open.kind === "existing" ? open.id : null}
        template={open.kind === "template" ? open.template : undefined}
        onClose={() => {
          setOpen(null);
          refetch();
        }}
      />
    );
  }

  const installTemplate = (tpl: WorkflowTemplate) => {
    const wonStageId = (pipelinesQ.data ?? []).flatMap((p) => p.stages).find((s) => s.isWon)?.id ?? null;
    setOpen({ kind: "template", template: instantiateTemplate(tpl, { tx, newId: newStepId, wonStageId }) });
  };

  const hasWorkflows = workflows.length > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <PageHeader
        title={tx("Workflows", "الأتمتة")}
        subtitle={tx(
          "Automate what happens when a contact, message, or ticket event occurs.",
          "أتمتة ما يحدث عند وقوع حدث متعلق بجهة اتصال أو رسالة أو تذكرة.",
        )}
        actions={
          <button type="button" className="btn primary" onClick={() => setOpen({ kind: "blank" })}>
            <IconPlus w={14} />
            {tx("New workflow", "أتمتة جديدة")}
          </button>
        }
      />

      <div style={{ flex: 1, overflowY: "auto", padding: "0 32px 32px", display: "grid", gap: 28, alignContent: "start" }}>
        {loading && !hasWorkflows ? (
          <div className="muted">{tx("Loading…", "جارٍ التحميل…")}</div>
        ) : (
          hasWorkflows && (
            <section>
              <h2 className="wf-section-title">{tx("Your workflows", "أتمتتك")}</h2>
              <div className="wf-list">
                {workflows.map((wf) => (
                  <WorkflowCard key={wf.id} wf={wf} lang={t.lang} onOpen={() => setOpen({ kind: "existing", id: wf.id })} />
                ))}
              </div>
            </section>
          )
        )}

        <section>
          <h2 className="wf-section-title">
            {hasWorkflows ? tx("Templates", "القوالب") : tx("Start with a template or build your own", "ابدأ بقالب أو أنشئ أتمتتك")}
          </h2>
          <p className="wf-section-sub">
            {tx(
              "Templates open as drafts. Review the messages, save, then activate.",
              "تُفتح القوالب كمسودات. راجع الرسائل واحفظ ثم فعّل.",
            )}
          </p>
          <div className="wf-list">
            <button type="button" className="wf-card wf-blank" onClick={() => setOpen({ kind: "blank" })}>
              <span className="wf-ico lg wf-tone-trigger" aria-hidden="true">
                <IconPlus w={18} />
              </span>
              <h3>{tx("Blank workflow", "أتمتة فارغة")}</h3>
              <p className="wf-template-desc">
                {tx("Pick a trigger and add your own steps.", "اختر مُشغّلاً وأضف خطواتك بنفسك.")}
              </p>
            </button>
            {WORKFLOW_TEMPLATES.map((tpl) => (
              <TemplateCard key={tpl.id} tpl={tpl} tx={tx} onUse={() => installTemplate(tpl)} />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

const WorkflowsPage = memo(WorkflowsPageImpl);
export default WorkflowsPage;
