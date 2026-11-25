import { describe, expect, it } from "vitest";
import { DEFAULT_CATALOG_PARAMS, parseCatalogParams, withCatalogParams } from "./catalogParams";

describe("catalog tab and search round-trip through the hash", () => {
  it("defaults when absent or unknown", () => {
    expect(parseCatalogParams("#/calendar")).toEqual(DEFAULT_CATALOG_PARAMS);
    expect(parseCatalogParams("#/calendar?tab=rooms&layout=grid&archived=yes")).toEqual(DEFAULT_CATALOG_PARAMS);
  });

  it("round-trips tab, Arabic search, layout and archived; defaults stay out of the URL", () => {
    let h = "#/calendar";
    h = withCatalogParams(h, { tab: "staff" });
    expect(h).toBe("#/calendar?tab=staff");
    h = withCatalogParams(h, { q: "سارة", layout: "table", archived: true });
    expect(parseCatalogParams(h)).toEqual({ tab: "staff", q: "سارة", layout: "table", archived: true });
    h = withCatalogParams(h, { layout: "cards", archived: false, q: "  " });
    expect(h).toBe("#/calendar?tab=staff");
    h = withCatalogParams(h, { tab: "schedule" });
    expect(h).toBe("#/calendar");
  });

  it("switching tabs clears the search; other params (Task 5's view/date) are kept", () => {
    const h = withCatalogParams("#/calendar?view=board&date=2026-11-17&tab=services&q=cut", { tab: "staff" });
    expect(parseCatalogParams(h)).toMatchObject({ tab: "staff", q: "" });
    expect(h).toContain("view=board");
    expect(h).toContain("date=2026-11-17");
    expect(parseCatalogParams(withCatalogParams(h, { tab: "services", q: "beard" })).q).toBe("beard");
  });

  it("caps the search length", () => {
    expect(parseCatalogParams(withCatalogParams("#/calendar", { q: "x".repeat(300) })).q).toHaveLength(100);
  });
});
