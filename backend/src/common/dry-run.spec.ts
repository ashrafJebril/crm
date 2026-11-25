import { isDryRun } from "./dry-run";

describe("isDryRun", () => {
  it("is true only for the exact value 1", () => {
    expect(isDryRun("1")).toBe(true);
    expect(isDryRun(undefined)).toBe(false);
    expect(isDryRun("0")).toBe(false);
    expect(isDryRun("true")).toBe(false);
    expect(isDryRun("")).toBe(false);
  });

  it("is true when any of the dry-run headers says 1", () => {
    expect(isDryRun(undefined, "1")).toBe(true);
    expect(isDryRun("0", undefined)).toBe(false);
  });

  it("reads a repeated header", () => {
    expect(isDryRun(["0", "1"])).toBe(true);
  });
});
