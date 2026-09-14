import { describe, expect, it } from "vitest";
import { newAutomation } from "@/lib/automations";
import { loadAutomations, saveAutomations, storageKey } from "./store";

function fakeStorage(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    dump: () => Object.fromEntries(m),
  };
}

describe("store", () => {
  it("scopes the key by workspace and falls back to local", () => {
    expect(storageKey("ws1")).toBe("tkana.automations.ws1");
    expect(storageKey(null)).toBe("tkana.automations.local");
  });

  it("round-trips a list", () => {
    const s = fakeStorage();
    const a = newAutomation();
    a.name = "Test";
    expect(saveAutomations(s, "k", [a])).toBe(true);
    expect(loadAutomations(s, "k")).toEqual([a]);
  });

  it("returns empty on missing or corrupt data", () => {
    expect(loadAutomations(fakeStorage(), "k")).toEqual([]);
    expect(loadAutomations(fakeStorage({ k: "{not json" }), "k")).toEqual([]);
    expect(loadAutomations(fakeStorage({ k: '{"a":1}' }), "k")).toEqual([]);
  });

  it("filters out malformed entries in a stored array", () => {
    const a = newAutomation();
    const raw = JSON.stringify([a, null, { id: "x" }]);
    expect(loadAutomations(fakeStorage({ k: raw }), "k")).toEqual([a]);
  });

  it("swallows storage write errors", () => {
    const s = {
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(saveAutomations(s, "k", [])).toBe(false);
  });
});
