import { describe, expect, it } from "vitest";
import backendNames from "../../../backend/src/bookings/names.ts?raw";
import mineSrc from "./catalogSearch.ts?raw";
import { matchesSearch, normalizeName } from "./catalogSearch";

describe("catalog search normalization mirrors the backend", () => {
  it("same rules as backend/src/bookings/names.ts", () => {
    // The normalization chains are the same source text.
    const chain = (src: string) => /\.normalize\("NFC"\)[\s\S]*?\.trim\(\);/.exec(src)?.[0].replace(/\s+/g, "");
    expect(chain(backendNames)).toBeTruthy();
    expect(chain(mineSrc)).toBe(chain(backendNames));
    expect(mineSrc).toContain(/const ARABIC_DIACRITICS = (.*);/.exec(backendNames)![1]);
    for (const [a, b] of [
      ["أحمد", "احمد"],
      ["قصة شعر", "قصه شعر"],
      ["مستشفى", "مستشفي"],
      ["حَلاقَة", "حلاقه"],
      ["  Hair   Cut ", "hair cut"],
      ["قـــص", "قص"],
    ]) {
      expect(normalizeName(a)).toBe(normalizeName(b));
    }
  });

  it("matches either name, Arabic and Latin", () => {
    expect(matchesSearch("قصه", "Haircut", "قَصّة شعر")).toBe(true);
    expect(matchesSearch("HAIR", "Haircut", null)).toBe(true);
    expect(matchesSearch("nail", "Haircut", "قصة")).toBe(false);
    expect(matchesSearch("", "x")).toBe(true);
  });
});
