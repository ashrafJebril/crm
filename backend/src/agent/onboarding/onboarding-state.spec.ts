import { HttpException } from "@nestjs/common";
import { BUSINESS_NAME_MAX } from "../agent-constants";
import { assertDriver, cleanBusinessName, readState, transition, type OnboardingState } from "./onboarding-state";

const now = new Date("2026-11-17T10:00:00Z");
const fail = (fn: () => unknown): { status: number; key: string } => {
  try {
    fn();
  } catch (e) {
    const err = e as HttpException;
    return { status: err.getStatus(), key: (err.getResponse() as { message: string }).message };
  }
  throw new Error("expected an error");
};

describe("onboarding state", () => {
  it("onboarding state transitions", () => {
    // start → business → website → learn → try → live
    let s: OnboardingState = transition(null, "start", { userId: "u1", now });
    expect(s).toMatchObject({ status: "in_progress", step: "business", startedBy: "u1", businessName: null });
    expect(fail(() => transition(s, "step", { userId: "u1", now, step: "website" }))).toEqual({ status: 400, key: "onboarding.name_invalid" });
    s = transition(s, "step", { userId: "u1", now, step: "website", businessName: "  Salon   Noor " });
    expect(s).toMatchObject({ step: "website", businessName: "Salon Noor" });
    expect(fail(() => transition(s, "step", { userId: "u1", now, step: "learn" }))).toEqual({ status: 409, key: "onboarding.no_website" });
    s = { ...s, websiteSourceId: "src1", websiteUrl: "https://salon.example/" };
    s = transition(s, "step", { userId: "u1", now, step: "learn" });
    s = transition(s, "step", { userId: "u1", now, step: "try" });
    expect(fail(() => transition(s, "step", { userId: "u1", now, step: "launch" }))).toEqual({ status: 400, key: "onboarding.step_invalid" });

    // A second member gets 409 while it is in progress.
    for (const action of ["start", "skip", "step", "finish"] as const) {
      expect(fail(() => transition(s, action, { userId: "u2", now, step: "try" }))).toEqual({ status: 409, key: "onboarding.not_owner" });
    }
    expect(fail(() => assertDriver(s, "u2"))).toEqual({ status: 409, key: "onboarding.not_owner" });

    // Skip and resume keep the step; the resumer drives it.
    const skipped = transition(s, "skip", { userId: "u1", now });
    expect(skipped).toMatchObject({ status: "skipped", step: "try" });
    expect(transition(skipped, "skip", { userId: "u2", now })).toBe(skipped);
    const resumed = transition(skipped, "resume", { userId: "u2", now });
    expect(resumed).toMatchObject({ status: "in_progress", step: "try", startedBy: "u2" });
    expect(transition(skipped, "start", { userId: "u1", now })).toMatchObject({ status: "in_progress", step: "try", startedBy: "u1" });

    // finish → done, which is final.
    const done = transition(resumed, "finish", { userId: "u2", now });
    expect(done).toMatchObject({ status: "done", step: "live" });
    for (const action of ["start", "skip", "resume", "step", "finish"] as const) {
      expect(fail(() => transition(done, action, { userId: "u2", now, step: "business" }))).toEqual({ status: 409, key: "onboarding.done" });
    }
    expect(fail(() => assertDriver(done, "u2"))).toEqual({ status: 409, key: "onboarding.done" });
  });

  it("existing workspaces never see onboarding: null stays null until someone starts it", () => {
    expect(readState(null)).toBeNull();
    expect(readState({ status: "weird" })).toBeNull();
    expect(readState([])).toBeNull();
    expect(fail(() => transition(null, "resume", { userId: "u1", now }))).toEqual({ status: 400, key: "onboarding.step_invalid" });
    expect(fail(() => transition(null, "step", { userId: "u1", now, step: "website" }))).toEqual({ status: 400, key: "onboarding.step_invalid" });
    expect(fail(() => assertDriver(null, "u1"))).toEqual({ status: 400, key: "onboarding.step_invalid" });
  });

  it("start with a business name goes straight to the website step; starting again is idempotent for the starter", () => {
    const s = transition(null, "start", { userId: "u1", now, businessName: "Noor" });
    expect(s).toMatchObject({ step: "website", businessName: "Noor" });
    expect(transition(s, "start", { userId: "u1", now })).toBe(s);
  });

  it("business names are 1..120 characters on one line", () => {
    expect(cleanBusinessName(" a\nb ")).toBe("a b");
    for (const bad of ["", "   ", "x".repeat(BUSINESS_NAME_MAX + 1), 5, null]) {
      expect(fail(() => cleanBusinessName(bad))).toEqual({ status: 400, key: "onboarding.name_invalid" });
    }
  });
});
