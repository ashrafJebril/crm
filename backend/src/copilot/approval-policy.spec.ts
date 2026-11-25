import { decideApproval, normalizeMode } from "./approval-policy";
import { APPROVAL_MODES, AUTO_APPLY_TOOLS } from "./copilot-constants";

const d = (mode: unknown, tool: string, risk: "low" | "medium" | "high", tainted = false) => decideApproval({ mode, tool, risk, tainted });

describe("approval policy", () => {
  it("write tool never executes without approval in Manual mode", () => {
    for (const tool of ["create_activity", "move_ticket_stage", "save_attachment_to_knowledge"]) {
      for (const risk of ["low", "medium", "high"] as const) {
        expect(d("manual", tool, risk)).toEqual({ apply: false, reason: "manual" });
      }
    }
  });

  it("approval policy order (manual, high risk, tainted, auto allow-list, agent_decides low only)", () => {
    expect(d("manual", "create_activity", "low", true).reason).toBe("manual");
    expect(d("auto", "move_ticket_stage", "high", true).reason).toBe("high_risk");
    expect(d("auto", "create_activity", "low", true).reason).toBe("tainted");
    expect(d("auto", "create_activity", "low")).toEqual({ apply: true, reason: "auto_allowed" });
    expect(d("auto", "move_ticket_stage", "medium")).toEqual({ apply: true, reason: "auto_allowed" });
    expect(d("agent_decides", "create_activity", "low")).toEqual({ apply: true, reason: "agent_decides_low" });
    expect(d("agent_decides", "move_ticket_stage", "medium")).toEqual({ apply: false, reason: "not_allowed" });
  });

  it("auto never widens beyond the allow-list", () => {
    expect([...AUTO_APPLY_TOOLS].sort()).toEqual(["create_activity", "move_ticket_stage"]);
    for (const tool of ["save_attachment_to_knowledge", "draft_reply", "delete_everything", ""]) {
      for (const risk of ["low", "medium"] as const) {
        expect({ tool, risk, r: d("auto", tool, risk) }).toEqual({ tool, risk, r: { apply: false, reason: "not_allowed" } });
      }
    }
    // An unknown or forged mode is manual.
    for (const mode of ["AUTO", "yolo", undefined, null, 1, { auto: true }]) {
      expect(normalizeMode(mode)).toBe("manual");
      expect(d(mode, "create_activity", "low").apply).toBe(false);
    }
    expect([...APPROVAL_MODES].map(normalizeMode)).toEqual([...APPROVAL_MODES]);
  });

  it("tainted session confirms in every mode", () => {
    for (const mode of APPROVAL_MODES) {
      for (const tool of AUTO_APPLY_TOOLS) expect({ mode, tool, apply: d(mode, tool, "low", true).apply }).toEqual({ mode, tool, apply: false });
    }
  });

  it("terminal stage move confirms in every mode", () => {
    for (const mode of APPROVAL_MODES) expect({ mode, apply: d(mode, "move_ticket_stage", "high").apply }).toEqual({ mode, apply: false });
    // Knowledge saves are high risk too.
    for (const mode of APPROVAL_MODES) expect(d(mode, "save_attachment_to_knowledge", "high").apply).toBe(false);
  });
});
