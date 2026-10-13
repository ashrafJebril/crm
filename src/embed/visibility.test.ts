import { describe, expect, it } from "vitest";
import { getEmbedVisible, setEmbedVisible, shouldAutoSelect } from "./visibility";

describe("shouldAutoSelect", () => {
  it("only when visible, no active, and conversations exist", () => {
    expect(shouldAutoSelect(true, null, [{}])).toBe(true);
    expect(shouldAutoSelect(false, null, [{}])).toBe(false);
    expect(shouldAutoSelect(true, "a", [{}])).toBe(false);
    expect(shouldAutoSelect(true, null, [])).toBe(false);
  });
});
describe("visibility store", () => {
  it("defaults visible and toggles", () => {
    expect(getEmbedVisible()).toBe(true);
    setEmbedVisible(false);
    expect(getEmbedVisible()).toBe(false);
    setEmbedVisible(true);
    expect(getEmbedVisible()).toBe(true);
  });
});
