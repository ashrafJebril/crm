import { describe, expect, it } from "vitest";
import { mappingComplete, placeholderCount, renderCampaignPreview } from "./campaignVars";

describe("campaign template variables", () => {
  it("counts placeholders", () => {
    expect(placeholderCount("Hi {{1}}, {{2}} off")).toBe(2);
    expect(placeholderCount(null)).toBe(0);
  });

  it("previews the message with sample values", () => {
    expect(
      renderCampaignPreview("Hi {{1}}, {{2}} off. Call {{3}}", [
        { field: "name" },
        { field: "custom", customValue: "20%" },
        { field: "phone" },
      ]),
    ).toBe("Hi Lina, 20% off. Call +962 79 123 4567");
  });

  it("leaves unmapped placeholders visible", () => {
    expect(renderCampaignPreview("Hi {{1}} {{2}}", [{ field: "name" }])).toBe("Hi Lina {{2}}");
  });

  it("is complete only when every placeholder has a value", () => {
    expect(mappingComplete([{ field: "name" }, { field: "custom", customValue: "x" }], 2)).toBe(true);
    expect(mappingComplete([{ field: "name" }], 2)).toBe(false);
    expect(mappingComplete([{ field: "name" }, { field: "custom", customValue: "  " }], 2)).toBe(false);
    expect(mappingComplete([], 0)).toBe(true);
  });
});
