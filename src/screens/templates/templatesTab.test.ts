import { describe, expect, it } from "vitest";
import { templatesTabFromHash } from "./templatesTab";

describe("templatesTabFromHash", () => {
  it("opens the tab named in the hash, else the library", () => {
    expect(templatesTabFromHash("#/templates?tab=gallery")).toBe("gallery");
    expect(templatesTabFromHash("#/templates?tab=quick")).toBe("quick");
    expect(templatesTabFromHash("#/templates")).toBe("library");
    expect(templatesTabFromHash("#/templates?tab=nope")).toBe("library");
    expect(templatesTabFromHash("")).toBe("library");
  });
});
