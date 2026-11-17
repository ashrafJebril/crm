import { useState } from "react";
import type { Tx } from "@/lib/tx";
import type { Workflow } from "@/lib/types";
import { IconChev } from "@/icons";
import { orderedStepIds } from "./graph";
import { ExecutionsTab } from "./ExecutionsTab";
import { AUTOMATIC_MESSAGES_HREF, MANAGED_BADGE, stepLabel, triggerMeta } from "./systemWorkflow";

/**
 * SP-24: a system workflow opened from the list. Read-only: no Save, toggle
 * or Test (the generic routes answer 409 `workflows.system_locked`); its
 * runs stay visible. Changes happen in Settings → Automatic messages.
 */
export function LockedWorkflow({ wf, tx, lang, onClose }: { wf: Workflow; tx: Tx; lang: "en" | "ar"; onClose: () => void }) {
  const [tab, setTab] = useState<"overview" | "runs">("overview");
  const trigger = triggerMeta(wf.triggerType);
  const graph = wf.steps ?? { entry: null, steps: {} };
  return (
    <div className="wf-builder">
      <div className="wf-head">
        <button type="button" className="btn icon ghost" onClick={onClose} aria-label={tx("Back to workflows", "العودة إلى الأتمتة")}>
          <span className="flip-rtl" style={{ display: "inline-flex" }}>
            <span style={{ display: "inline-flex", transform: "rotate(180deg)" }}>
              <IconChev w={16} />
            </span>
          </span>
        </button>
        <div className="wf-name">
          <strong style={{ fontSize: 15 }}>{wf.name}</strong>
          <span className={`badge ${wf.status === "active" ? "ok" : ""}`.trim()}>
            {wf.status === "active" ? tx("On", "مفعّلة") : tx("Off", "متوقفة")}
          </span>
          <span className="badge accent">{tx(MANAGED_BADGE[0], MANAGED_BADGE[1])}</span>
        </div>
        <div className="wf-tabs" role="tablist" aria-label={tx("View", "العرض")}>
          <button type="button" role="tab" className="wf-tab" aria-selected={tab === "overview"} onClick={() => setTab("overview")}>
            {tx("Overview", "نظرة عامة")}
          </button>
          <button type="button" role="tab" className="wf-tab" aria-selected={tab === "runs"} onClick={() => setTab("runs")}>
            {tx("Runs", "التشغيلات")}
          </button>
        </div>
      </div>

      <div className="wf-note" role="note">
        <span style={{ flex: 1 }}>
          {tx(
            "This workflow sends an automatic message. Turn it on or off, change who gets it and edit its text in Automatic messages.",
            "هذه الأتمتة ترسل رسالة تلقائية. فعّلها أو أوقفها وغيّر مستلميها وعدّل نصها من الرسائل التلقائية.",
          )}
        </span>
        <a className="btn sm" href={AUTOMATIC_MESSAGES_HREF} style={{ textDecoration: "none" }}>
          {tx("Open Automatic messages", "افتح الرسائل التلقائية")}
        </a>
      </div>

      {tab === "overview" ? (
        <div style={{ padding: 24, display: "grid", gap: 12, maxInlineSize: 640 }}>
          <div>
            <div className="wf-label">{tx("When this happens", "عندما يحدث هذا")}</div>
            <div style={{ fontSize: 14 }}>{tx(trigger.en, trigger.ar)}</div>
            <p className="wf-hint">{tx(trigger.descEn, trigger.descAr)}</p>
          </div>
          <div>
            <div className="wf-label">{tx("Steps", "الخطوات")}</div>
            <ol style={{ margin: 0, paddingInlineStart: 18, fontSize: 13.5 }}>
              {orderedStepIds(graph).map((sid) => {
                const l = stepLabel(graph.steps[sid].type);
                return <li key={sid}>{tx(l[0], l[1])}</li>;
              })}
            </ol>
          </div>
        </div>
      ) : (
        <ExecutionsTab workflowId={wf.id} tx={tx} lang={lang} />
      )}
    </div>
  );
}
