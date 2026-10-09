import { describe, expect, it } from "vitest";
import { newStep, type Step } from "@/lib/automations";
import {
  delayLabel,
  emptyMessages,
  messagesFromSteps,
  messagesReady,
  stepsFromMessages,
} from "./wizard";

const wait = (amount: number, unit: "hours" | "days"): Step => {
  const s = newStep("wait");
  if (s.kind === "wait") {
    s.amount = amount;
    s.unit = unit;
  }
  return s;
};
const wa = (templateId: string): Step => {
  const s = newStep("whatsapp");
  if (s.kind === "whatsapp") s.templateId = templateId;
  return s;
};
const em = (templateId: string, subject = ""): Step => {
  const s = newStep("email");
  if (s.kind === "email") {
    s.templateId = templateId;
    s.subject = subject;
  }
  return s;
};

describe("messagesFromSteps", () => {
  it("reads the deal-won recipe shape", () => {
    const m = messagesFromSteps([wa("wa1"), wait(2, "days"), em("em1", "Hi")]);
    expect(m.whatsapp).toMatchObject({ on: true, templateId: "wa1", delay: { amount: 0 } });
    expect(m.email).toMatchObject({ on: true, templateId: "em1", subject: "Hi", delay: { amount: 2, unit: "days" } });
  });

  it("assigns a leading wait to the first message", () => {
    const m = messagesFromSteps([wait(1, "hours"), wa("wa1")]);
    expect(m.whatsapp.delay).toEqual({ amount: 1, unit: "hours" });
    expect(m.email.on).toBe(false);
  });

  it("ignores duplicate channels and trailing waits", () => {
    const m = messagesFromSteps([wa("first"), wa("second"), wait(3, "days")]);
    expect(m.whatsapp.templateId).toBe("first");
    expect(m.email.on).toBe(false);
  });
});

describe("stepsFromMessages", () => {
  it("emits [whatsapp, wait, email] with no leading wait when immediate", () => {
    const m = emptyMessages();
    m.whatsapp = { on: true, templateId: "wa1", delay: { amount: 0, unit: "hours" }, subject: "" };
    m.email = { on: true, templateId: "em1", delay: { amount: 2, unit: "days" }, subject: "S" };
    const steps = stepsFromMessages(m);
    expect(steps.map((s) => s.kind)).toEqual(["whatsapp", "wait", "email"]);
    expect(steps[1]).toMatchObject({ amount: 2, unit: "days" });
    expect(steps[2]).toMatchObject({ templateId: "em1", subject: "S" });
  });

  it("skips channels that are off", () => {
    const m = emptyMessages();
    m.email = { on: true, templateId: "em1", delay: { amount: 1, unit: "days" }, subject: "" };
    expect(stepsFromMessages(m).map((s) => s.kind)).toEqual(["wait", "email"]);
  });

  it("round-trips and keeps existing ids", () => {
    const prev = [wa("wa1"), wait(2, "days"), em("em1", "Hi")];
    const again = stepsFromMessages(messagesFromSteps(prev), prev);
    expect(again.map((s) => s.id)).toEqual(prev.map((s) => s.id));
    expect(again).toEqual(prev);
  });
});

describe("helpers", () => {
  it("messagesReady needs an on channel with a template", () => {
    const m = emptyMessages();
    expect(messagesReady(m)).toBe(false);
    m.whatsapp.on = true;
    expect(messagesReady(m)).toBe(false);
    m.whatsapp.templateId = "x";
    expect(messagesReady(m)).toBe(true);
  });

  it("delayLabel in both languages", () => {
    expect(delayLabel({ amount: 0, unit: "hours" }, "en")).toBe("Immediately");
    expect(delayLabel({ amount: 1, unit: "hours" }, "en")).toBe("After 1 hour");
    expect(delayLabel({ amount: 2, unit: "days" }, "en")).toBe("After 2 days");
    expect(delayLabel({ amount: 0, unit: "hours" }, "ar")).toBe("فوراً");
    expect(delayLabel({ amount: 2, unit: "days" }, "ar")).toBe("بعد 2 يوم");
  });
});
