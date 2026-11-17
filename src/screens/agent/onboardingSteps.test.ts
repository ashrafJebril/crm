import { describe, expect, it } from "vitest";
import type { OnboardingState } from "@/lib/types";
import { ONBOARDING_STEPS } from "./agentConstants";
import { nextStep, progress, setupView, showContinueCard, STEP_COPY, websiteReading } from "./onboardingSteps";

const state = (over: Partial<OnboardingState> = {}): OnboardingState => ({
  status: "in_progress",
  step: "business",
  businessName: null,
  websiteUrl: null,
  website: null,
  learned: null,
  hoursApplyEnablesWorkingHours: false,
  stuck: false,
  canManage: true,
  ...over,
});

describe("onboarding steps", () => {
  it("walks business → website → learn → try → live", () => {
    expect(nextStep("business")).toBe("website");
    expect(nextStep("learn")).toBe("try");
    expect(nextStep("live")).toBeNull();
    expect(progress("learn")).toEqual({ current: 3, total: 5 });
    for (const s of ONBOARDING_STEPS) {
      expect(STEP_COPY[s].label[1]).toMatch(/[؀-ۿ]/);
      expect(STEP_COPY[s].line[1]).toMatch(/[؀-ۿ]/);
    }
  });

  it("decides the page view and the Continue setup card", () => {
    expect(setupView(null)).toBe("start");
    expect(setupView(state({ status: "not_started" }))).toBe("start");
    expect(setupView(state())).toBe("steps");
    expect(setupView(state({ status: "skipped" }))).toBe("skipped");
    expect(setupView(state({ status: "done" }))).toBe("done");
    expect(setupView(state({ canManage: false }))).toBe("no_access");
    expect(showContinueCard(state({ status: "skipped" }))).toBe(true);
    expect(showContinueCard(state({ status: "skipped", canManage: false }))).toBe(false);
    expect(showContinueCard(state({ status: "not_started" }))).toBe(false); // existing workspaces never see it
    expect(showContinueCard(null)).toBe(false);
  });

  it("polls while the website is being read", () => {
    expect(websiteReading(state({ website: { sourceId: "s", status: "queued", pagesSynced: 0 } }))).toBe(true);
    expect(websiteReading(state({ website: { sourceId: "s", status: "ready", pagesSynced: 5 } }))).toBe(false);
    expect(websiteReading(state())).toBe(false);
  });
});
