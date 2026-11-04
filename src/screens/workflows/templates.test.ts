import { describe, expect, it } from "vitest";
import { makeTx } from "@/lib/tx";
import { orderedStepIds } from "./graph";
import { validateStep, validateTrigger } from "./stepMeta";
import { instantiateTemplate, WORKFLOW_TEMPLATES } from "./templates";

const tx = makeTx("en");
let n = 0;
const newId = () => `s${++n}`;

describe("workflow templates", () => {
  it("have unique ids", () => {
    const ids = WORKFLOW_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const tpl of WORKFLOW_TEMPLATES) {
    describe(tpl.id, () => {
      const { draft } = instantiateTemplate(tpl, { tx, newId, wonStageId: "stage_won" });

      it("installs as a connected graph with every step reachable", () => {
        expect(draft.graph.entry).not.toBeNull();
        expect(orderedStepIds(draft.graph).sort()).toEqual(Object.keys(draft.graph.steps).sort());
      });

      it(tpl.setup ? "only needs its WhatsApp template picked" : "is complete enough to activate right away", () => {
        const issues = Object.values(draft.graph.steps).map((step) => validateStep(step, tx)).filter(Boolean);
        expect(issues).toEqual(tpl.setup ? ["Pick an approved template"] : []);
        expect(validateTrigger(draft.triggerType, draft.triggerConfig, tx)).toBeNull();
      });

      it("gets fresh step ids, consistent with each step's id field", () => {
        for (const [id, step] of Object.entries(draft.graph.steps)) expect(step.id).toBe(id);
      });
    });
  }

  it("rewrites references to earlier steps when ids are regenerated", () => {
    const tpl = {
      ...WORKFLOW_TEMPLATES[0],
      steps: {
        entry: "ask",
        steps: {
          ask: { id: "ask", type: "ask_agent" as const, config: { prompt: "Summarise" }, next: "say" },
          say: { id: "say", type: "send_whatsapp" as const, config: { message: "AI says: {{steps.ask.answer}}" } },
        },
      },
    };
    const { draft } = instantiateTemplate(tpl, { tx, newId, wonStageId: null });
    const [askId, sayId] = orderedStepIds(draft.graph);
    expect(draft.graph.steps[askId].next).toBe(sayId);
    expect(draft.graph.steps[sayId].config).toEqual({ message: `AI says: {{steps.${askId}.answer}}` });
  });

  it("points the deal-won template at the workspace's Won stage", () => {
    const tpl = WORKFLOW_TEMPLATES.find((t) => t.triggerType === "ticket_stage_changed")!;
    const { draft, needsStage } = instantiateTemplate(tpl, { tx, newId, wonStageId: "stage_won" });
    expect(draft.triggerConfig).toEqual({ stageId: "stage_won" });
    expect(needsStage).toBe(false);
  });

  it("flags the deal-won template when no Won stage exists", () => {
    const tpl = WORKFLOW_TEMPLATES.find((t) => t.triggerType === "ticket_stage_changed")!;
    const { draft, needsStage } = instantiateTemplate(tpl, { tx, newId, wonStageId: null });
    expect(draft.triggerConfig).toEqual({});
    expect(needsStage).toBe(true);
  });

  it("opens setup templates on the step that needs attention", () => {
    for (const tpl of WORKFLOW_TEMPLATES.filter((t) => t.setup)) {
      const { draft, focusStepId, setupNote } = instantiateTemplate(tpl, { tx, newId, wonStageId: null });
      expect(draft.graph.steps[focusStepId!].type).toBe("send_whatsapp_template");
      expect(setupNote).toMatch(/\{\{1\}\}/);
    }
  });

  it("pre-fills the receipt template's variables from the sale", () => {
    const tpl = WORKFLOW_TEMPLATES.find((t) => t.triggerType === "sale_completed")!;
    const { draft } = instantiateTemplate(tpl, { tx, newId, wonStageId: null });
    const step = Object.values(draft.graph.steps).find((s) => s.type === "send_whatsapp_template")!;
    expect((step.config as { variables: string[] }).variables).toEqual([
      "{{trigger.contact.name}}",
      "{{trigger.sale.receiptNumber}}",
      "{{trigger.sale.itemsText}}",
      "{{trigger.sale.total}} {{trigger.sale.currency}}",
    ]);
  });

  it("writes customer-facing text in the chosen language", () => {
    const ar = makeTx("ar");
    const tpl = WORKFLOW_TEMPLATES.find((t) => t.id === "request-received")!;
    const { draft } = instantiateTemplate(tpl, { tx: ar, newId, wonStageId: null });
    const msg = Object.values(draft.graph.steps).find((s) => s.type === "send_whatsapp")!;
    expect((msg.config as { message: string }).message).toMatch(/[؀-ۿ]/);
    expect(draft.name).toMatch(/[؀-ۿ]/);
  });
});
