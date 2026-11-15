import { describe, expect, it } from "vitest";
import { setHashParam } from "@/lib/hashState";
import { templatesTabFromHash, templatesTabFromParam, templatesTabParam } from "./templatesTab";

describe("templatesTabFromHash", () => {
  it("opens the tab named in the hash, else the library", () => {
    expect(templatesTabFromHash("#/templates?tab=gallery")).toBe("gallery");
    expect(templatesTabFromHash("#/templates?tab=quick")).toBe("quick");
    expect(templatesTabFromHash("#/templates")).toBe("library");
    expect(templatesTabFromHash("#/templates?tab=nope")).toBe("library");
    expect(templatesTabFromHash("")).toBe("library");
    expect(templatesTabFromParam(null)).toBe("library");
  });

  it("writes the tab back to the hash, and the library clears it (round trip)", () => {
    const from = "#/templates?tab=gallery";
    const toLibrary = setHashParam(from, "tab", templatesTabParam("library"));
    expect(toLibrary).not.toContain("tab=");
    expect(templatesTabFromHash(toLibrary)).toBe("library");
    for (const tab of ["quick", "gallery"] as const) {
      const next = setHashParam("#/templates", "tab", templatesTabParam(tab));
      expect(next).toContain(`tab=${tab}`);
      expect(templatesTabFromHash(next)).toBe(tab);
    }
  });
});
