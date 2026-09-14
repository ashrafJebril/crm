import { describe, expect, it } from "vitest";
import { missingTokens, newAutomation, newStep } from "@/lib/automations";
import {
  MOCK_TEMPLATES,
  RECIPES,
  TRIGGERS,
  stepLabel,
  suggestName,
  summarize,
  suppliedTokens,
  templateById,
} from "./catalog";

const ctx = { stageLabel: (id: string) => (id === "won" ? "Won" : undefined) };

describe("catalog shape", () => {
  it("has exactly six triggers with bilingual labels", () => {
    expect(TRIGGERS).toHaveLength(6);
    for (const t of TRIGGERS) {
      expect(t.en.length).toBeGreaterThan(0);
      expect(t.ar.length).toBeGreaterThan(0);
      expect(t.defaults.kind).toBe(t.kind);
    }
  });

  it("every mock template is compatible with at least one trigger", () => {
    for (const tpl of MOCK_TEMPLATES) {
      const ok = TRIGGERS.some((t) => missingTokens(tpl, t.supplies).length === 0);
      expect(ok, tpl.id).toBe(true);
    }
  });

  it("deal templates are incompatible with the contact trigger", () => {
    const tpl = templateById("wa_deal_won_en")!;
    expect(missingTokens(tpl, suppliedTokens({ kind: "contact.created" }))).toContain("deal.title");
    expect(missingTokens(tpl, suppliedTokens({ kind: "deal.stage_changed", pipelineId: "p", stageId: "won" }))).toEqual([]);
  });
});

describe("summarize / suggestName", () => {
  const a = newAutomation();
  a.trigger = { kind: "deal.stage_changed", pipelineId: "p", stageId: "won" };
  const wa = newStep("whatsapp");
  if (wa.kind === "whatsapp") wa.templateId = "wa_deal_won_en";
  const wait = newStep("wait");
  if (wait.kind === "wait") {
    wait.amount = 2;
    wait.unit = "days";
  }
  const em = newStep("email");
  if (em.kind === "email") em.templateId = "em_onboarding_en";
  a.steps = [wa, wait, em];

  it("produces the English sentence", () => {
    expect(summarize(a, "en", ctx)).toBe(
      "When a deal moves to Won → WhatsApp: Deal won thank-you → wait 2 days → Email: Onboarding",
    );
  });

  it("produces the Arabic sentence", () => {
    const s = summarize(a, "ar", ctx);
    expect(s).toContain("عندما تنتقل صفقة إلى Won");
    expect(s).toContain("واتساب: Deal won thank-you");
    expect(s).toContain("انتظر 2 يوم");
  });

  it("suggests a name from trigger and first action", () => {
    expect(suggestName(a, "en", ctx)).toBe("Deal moves to Won → WhatsApp");
    const empty = newAutomation();
    expect(suggestName(empty, "en", ctx)).toBe("New automation");
  });

  it("stepLabel handles wait units", () => {
    expect(stepLabel({ id: "x", kind: "wait", amount: 1, unit: "hours" }, "en")).toBe("wait 1 hour");
    expect(stepLabel({ id: "x", kind: "wait", amount: 3, unit: "hours" }, "en")).toBe("wait 3 hours");
  });
});

describe("recipes", () => {
  it("builds three saveable-shaped automations", () => {
    expect(RECIPES).toHaveLength(3);
    const won = RECIPES.find((r) => r.id === "deal_won")!.build({
      wonStageRef: { pipelineId: "p", stageId: "won" },
    });
    expect(won.trigger).toEqual({ kind: "deal.stage_changed", pipelineId: "p", stageId: "won" });
    expect(won.steps.map((s) => s.kind)).toEqual(["whatsapp", "wait", "email"]);
    const noStage = RECIPES.find((r) => r.id === "deal_won")!.build({ wonStageRef: null });
    expect(noStage.trigger).toEqual({ kind: "deal.stage_changed", pipelineId: "", stageId: "" });
  });
});
