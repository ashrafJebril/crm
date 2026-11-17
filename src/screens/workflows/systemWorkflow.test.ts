import { describe, expect, it } from "vitest";
import { makeTx } from "@/lib/tx";
import { MANAGED_BADGE, isSystemWorkflow, newWorkflowTrigger, stepGroup, stepLabel, triggerMeta, withoutNewParams } from "./systemWorkflow";

const ARABIC = /[؀-ۿ]/;

describe("system workflows are locked and custom automations prefill the trigger", () => {
  it("systemKey rows are system workflows", () => {
    expect(isSystemWorkflow({ systemKey: "lifecycle.booking_confirmed" })).toBe(true);
    expect(isSystemWorkflow({ systemKey: null })).toBe(false);
    expect(isSystemWorkflow({})).toBe(false);
    expect(makeTx("ar")(...MANAGED_BADGE)).toMatch(ARABIC);
  });

  it("reads new=1&trigger= for user triggers only", () => {
    expect(newWorkflowTrigger("#/workflows?new=1&trigger=appointment_confirmed")).toBe("appointment_confirmed");
    expect(newWorkflowTrigger("#/workflows?new=1&trigger=ticket_resolved")).toBe("ticket_resolved");
    expect(newWorkflowTrigger("#/workflows?new=1&trigger=appointment_reminder_due")).toBeNull();
    expect(newWorkflowTrigger("#/workflows?trigger=ticket_created")).toBeNull();
    expect(newWorkflowTrigger("#/workflows")).toBeNull();
    expect(withoutNewParams("#/workflows?new=1&trigger=ticket_created&x=1")).toBe("#/workflows?x=1");
    expect(withoutNewParams("#/workflows?new=1&trigger=ticket_created")).toBe("#/workflows");
  });

  it("labels every step type, including notify_staff", () => {
    expect(stepLabel("notify_staff")).toEqual(["Notify the team", "تنبيه الفريق"]);
    expect(stepLabel("send_whatsapp_template")[0]).toBeTruthy();
    expect(stepLabel("future_step")[0]).toBe("future step");
  });

  it("unknown step and trigger types fall back instead of crashing", () => {
    expect(stepGroup("notify_staff")).toBe("message");
    expect(stepGroup("delay")).toBe("logic");
    expect(triggerMeta("appointment_reminder_due").en).toBe("Booking reminder");
    expect(triggerMeta("some_future_trigger")).toEqual({ en: "some future trigger", ar: "some future trigger", descEn: "", descAr: "" });
  });
});
