import { nameMatches, normalizeName } from "./names";

describe("normalizeName", () => {
  it("trims, collapses whitespace and lowercases Latin", () => {
    expect(normalizeName("  Hair   Cut \t ")).toBe("hair cut");
    expect(normalizeName("BEARD Trim")).toBe("beard trim");
    expect(normalizeName(null)).toBe("");
    expect(normalizeName(undefined)).toBe("");
  });

  it("unifies hamza forms of alef", () => {
    expect(normalizeName("أحمد")).toBe(normalizeName("احمد"));
    expect(normalizeName("إبراهيم")).toBe("ابراهيم");
    expect(normalizeName("آمنة")).toBe("امنه");
  });

  it("unifies alef maqsura and taa marbuta", () => {
    expect(normalizeName("مستشفى")).toBe("مستشفي");
    expect(normalizeName("قصة شعر")).toBe("قصه شعر");
  });

  it("strips tatweel and diacritics", () => {
    expect(normalizeName("قـــص")).toBe("قص");
    expect(normalizeName("حَلاقَة")).toBe("حلاقه");
    expect(normalizeName("مُحَمَّد")).toBe("محمد");
  });

  it("nameMatches searches both names", () => {
    expect(nameMatches("قصه", "Haircut", "قَصّة شعر")).toBe(true);
    expect(nameMatches("HAIR", "Haircut", "قصة")).toBe(true);
    expect(nameMatches("nail", "Haircut", "قصة")).toBe(false);
    expect(nameMatches("  ", "anything")).toBe(true);
    expect(nameMatches("x", null, undefined)).toBe(false);
  });
});
