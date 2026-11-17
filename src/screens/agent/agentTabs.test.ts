import { describe, expect, it } from "vitest";
import { availableAgentTabs, pickAgentTab } from "./agentTabs";

const can = (...ps: string[]) => (p: string) => ps.includes(p);

describe("agent page tab selection", () => {
  it("waits for permissions instead of opening on Tools", () => {
    // While loading, can() denies everything: the old code picked "tools" here.
    expect(pickAgentTab({ loading: true, available: availableAgentTabs(can()) })).toBeNull();
    expect(pickAgentTab({ loading: false, available: availableAgentTabs(can("agent.view", "agent.update", "knowledge.view")) })).toBe("settings");
  });

  it("the first tab the member can open, in page order", () => {
    expect(availableAgentTabs(can("agent.view", "agent.update", "knowledge.view"))).toEqual(["settings", "try", "skills", "knowledge", "tools", "mcp"]);
    expect(pickAgentTab({ loading: false, available: availableAgentTabs(can("knowledge.view")) })).toBe("knowledge");
    expect(pickAgentTab({ loading: false, available: availableAgentTabs(can()) })).toBe("tools");
  });

  it("respects a tab given in the hash when the member can open it", () => {
    const all = availableAgentTabs(can("agent.view", "agent.update", "knowledge.view"));
    expect(pickAgentTab({ loading: false, available: all, requested: "knowledge" })).toBe("knowledge");
    expect(pickAgentTab({ loading: false, available: all, requested: "mcp" })).toBe("mcp");
    // Not allowed or unknown: the default.
    expect(pickAgentTab({ loading: false, available: availableAgentTabs(can("knowledge.view")), requested: "settings" })).toBe("knowledge");
    expect(pickAgentTab({ loading: false, available: all, requested: "nope" })).toBe("settings");
    // A tab the member clicked wins, unless it is no longer available.
    expect(pickAgentTab({ loading: false, available: all, requested: "knowledge", chosen: "tools" })).toBe("tools");
    expect(pickAgentTab({ loading: false, available: availableAgentTabs(can()), chosen: "try" })).toBe("tools");
  });
});
