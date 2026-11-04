import {
  buildRecipients,
  campaignStatusFor,
  estimateMetaCost,
  normalizePhone,
  templatePlaceholderCount,
} from "./campaign-audience";

describe("normalizePhone", () => {
  it.each([
    ["962790000001", "+962790000001"],
    ["+962 79 000 0001", "+962790000001"],
    ["00962-79-000-0001", "+962790000001"],
    ["(+971) 50 123 4567", "+971501234567"],
  ])("turns %s into %s", (raw, out) => {
    expect(normalizePhone(raw)).toBe(out);
  });

  it.each([[null], [""], ["0790000001"], ["12345"], ["abc"], ["+1234567890123456"]])(
    "rejects %s (no country code, too short or too long)",
    (raw) => {
      expect(normalizePhone(raw as string | null)).toBeNull();
    },
  );
});

describe("buildRecipients", () => {
  it("keeps reachable contacts, skips opted-out, phoneless and duplicate numbers", () => {
    const { recipients, skipped } = buildRecipients([
      { name: "Lina", phone: "962790000001", lifecycle: "lead" },
      { name: "Omar", phone: "+962 79 000 0001", lifecycle: "customer" }, // same number as Lina
      { name: "Sara", phone: null, lifecycle: "lead" },
      { name: "Karim", phone: "0790000003", lifecycle: "lead" },
      { name: "Gone", phone: "962790000004", lifecycle: "churned" },
      { name: "", phone: "971501234567", lifecycle: "lead" },
    ]);
    expect(recipients).toEqual([
      { name: "Lina", phone: "+962790000001" },
      { name: "Customer", phone: "+971501234567" },
    ]);
    expect(skipped).toEqual({ noPhone: 2, optedOut: 1, duplicate: 1 });
  });
});

describe("estimateMetaCost", () => {
  it("prices each number at its country's marketing rate", () => {
    const est = estimateMetaCost(["+962790000001", "+962790000002", "+966501234567", "+447911123456"]);
    expect(est.usd).toBeCloseTo(0.0392 * 2 + 0.0576, 6);
    expect(est.unpriced).toBe(1);
  });
});

describe("campaignStatusFor", () => {
  it.each([
    ["draft", "draft"],
    ["scheduled", "scheduled"],
    ["sending", "running"],
    ["completed", "completed"],
    ["failed", "failed"],
    ["cancelled", "cancelled"],
    ["something-new", "running"],
  ])("maps Zernio %s to %s", (z, c) => {
    expect(campaignStatusFor(z)).toBe(c);
  });
});

describe("templatePlaceholderCount", () => {
  it("counts the highest numbered placeholder", () => {
    expect(templatePlaceholderCount("Hi {{1}}, {{2}} off until {{ 3 }}")).toBe(3);
    expect(templatePlaceholderCount("No variables")).toBe(0);
    expect(templatePlaceholderCount(null)).toBe(0);
  });
});
