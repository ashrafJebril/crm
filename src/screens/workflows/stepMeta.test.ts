import { describe, expect, it } from "vitest";
import { makeTx } from "@/lib/tx";
import type { WorkflowStep, WorkflowStepGraph } from "@/lib/types";
import {
  countIssues,
  renderSample,
  splitTemplate,
  summarizeStep,
  summarizeTrigger,
  validateStep,
  validateTrigger,
  variablesFor,
} from "./stepMeta";

const tx = makeTx("en");
const ctx = { tx, variableLabel: (p: string) => (p === "trigger.contact.lifecycle" ? "Contact lifecycle" : p), stageLabel: (id: string) => (id === "s1" ? "Sales / Won" : undefined) };

describe("summarizeStep", () => {
  it("describes a condition with the field label", () => {
    const step: WorkflowStep = { id: "c", type: "condition", config: { field: "trigger.contact.lifecycle", operator: "equals", value: "lead" } };
    expect(summarizeStep(step, ctx)).toBe("Contact lifecycle equals “lead”");
  });

  it("keeps variable tokens in a message summary and truncates long text", () => {
    const step: WorkflowStep = { id: "m", type: "send_whatsapp", config: { message: "Hi {{trigger.contact.name}}, " + "x".repeat(200) } };
    const s = summarizeStep(step, ctx);
    expect(s.startsWith("Hi {{trigger.contact.name}}, ")).toBe(true);
    expect(s.endsWith("…")).toBe(true);
    expect(s.length).toBeLessThan(100);
  });

  it("collapses newlines in a message summary", () => {
    const step: WorkflowStep = { id: "m", type: "send_whatsapp", config: { message: "Hi\n\nthere" } };
    expect(summarizeStep(step, ctx)).toBe("Hi there");
  });

  it("describes delays with singular and plural units", () => {
    expect(summarizeStep({ id: "d", type: "delay", config: { amount: 1, unit: "hours" } }, ctx)).toBe("Wait 1 hour");
    expect(summarizeStep({ id: "d", type: "delay", config: { amount: 3, unit: "days" } }, ctx)).toBe("Wait 3 days");
  });

  it("describes CRM updates, resolving stage names", () => {
    expect(summarizeStep({ id: "u", type: "update_data", config: { operation: "add_tag", tag: "vip" } }, ctx)).toBe("Add tag “vip”");
    expect(summarizeStep({ id: "u", type: "update_data", config: { operation: "move_ticket_stage", stageId: "s1" } }, ctx)).toBe("Move ticket to Sales / Won");
    expect(summarizeStep({ id: "u", type: "update_data", config: { operation: "update_contact_field", field: "lifecycle", value: "customer" } }, ctx)).toBe("Set Lifecycle to “customer”");
  });

  it("returns a placeholder when nothing is configured yet", () => {
    expect(summarizeStep({ id: "a", type: "ask_agent", config: { prompt: "" } }, ctx)).toBe("Not set up yet");
  });
});

describe("validateStep", () => {
  it("matches the backend's strict activation rules", () => {
    expect(validateStep({ id: "m", type: "send_whatsapp", config: { message: "  " } }, tx)).toBe("Message is empty");
    expect(validateStep({ id: "c", type: "condition", config: { field: "", operator: "equals", value: "x" } }, tx)).toBe("Pick a field to check");
    expect(validateStep({ id: "c", type: "condition", config: { field: "a", operator: "equals", value: "" } }, tx)).toBe("Enter a value to compare");
    expect(validateStep({ id: "d", type: "delay", config: { amount: 0, unit: "hours" } }, tx)).toBe("Wait time must be more than 0");
    expect(validateStep({ id: "u", type: "update_data", config: { operation: "move_ticket_stage", stageId: "" } }, tx)).toBe("Pick a stage");
    expect(validateStep({ id: "m", type: "send_whatsapp", config: { message: "hi" } }, tx)).toBeNull();
  });

  it("flags a schedule trigger without a cron expression", () => {
    expect(validateTrigger("schedule", {}, tx)).toBe("Set when it runs");
    expect(validateTrigger("schedule", { cron: "0 9 * * *" }, tx)).toBeNull();
    expect(validateTrigger("contact_created", {}, tx)).toBeNull();
  });

  it("counts issues across reachable steps and the trigger", () => {
    const graph: WorkflowStepGraph = {
      entry: "a",
      steps: {
        a: { id: "a", type: "send_whatsapp", config: { message: "" }, next: "b" },
        b: { id: "b", type: "ask_agent", config: { prompt: "" } },
        orphan: { id: "orphan", type: "ask_agent", config: { prompt: "" } },
      },
    };
    expect(countIssues(graph, "schedule", {}, tx)).toBe(3);
  });
});

describe("summarizeTrigger", () => {
  it("describes schedule and stage triggers", () => {
    expect(summarizeTrigger("schedule", { cron: "0 9 * * *", timezone: "Asia/Amman" }, ctx)).toBe("0 9 * * * · Asia/Amman");
    expect(summarizeTrigger("ticket_stage_changed", { stageId: "s1" }, ctx)).toBe("Into Sales / Won");
    expect(summarizeTrigger("ticket_stage_changed", {}, ctx)).toBe("Any stage");
  });
});

describe("variables", () => {
  it("offers trigger variables plus answers from earlier AI steps", () => {
    const graph: WorkflowStepGraph = {
      entry: "ai",
      steps: {
        ai: { id: "ai", type: "ask_agent", config: { prompt: "?" }, next: "m" },
        m: { id: "m", type: "send_whatsapp", config: { message: "" } },
      },
    };
    const vars = variablesFor("contact_created", graph, "m", tx);
    expect(vars.map((v) => v.path)).toContain("trigger.contact.name");
    expect(vars.map((v) => v.path)).toContain("steps.ai.answer");
    expect(variablesFor("contact_created", graph, "ai", tx).map((v) => v.path)).not.toContain("steps.ai.answer");
  });

  it("splits a template into text and variable parts", () => {
    expect(splitTemplate("Hi {{ trigger.contact.name }}!")).toEqual([
      { kind: "text", text: "Hi " },
      { kind: "var", path: "trigger.contact.name" },
      { kind: "text", text: "!" },
    ]);
  });

  it("fills a preview with sample values", () => {
    expect(renderSample("Hi {{trigger.contact.name}} from {{unknown.path}}")).toBe("Hi Lina from [unknown.path]");
  });
});
