import { describe, expect, it } from "vitest";
import { makeTx } from "@/lib/tx";
import {
  FIELD_SOURCES,
  VAR_VALUE_MAX,
  defaultVarMap,
  fieldLabelOf,
  legacyToVarMap,
  normalizeVarMap,
  placeholderCount,
  previewValues,
  renderTemplate,
  sampleSegments,
  slotLabel,
  templateUnsupported,
  varMapComplete,
  varMapIssue,
  varMapReasonText,
} from "./varMap";
import type { VarMap } from "@/lib/types";

const en = makeTx("en");
const ar = makeTx("ar");
const ARABIC = /[؀-ۿ]/;
const defs = new Map([["city", { label: "City", labelAr: "المدينة" }]]);

describe("varMap", () => {
  it("varMap resolves preview from sample contact with fallback", () => {
    const map: VarMap = {
      "1": { source: "field", key: "firstName", fallback: "there" },
      "2": { source: "custom", key: "city", fallback: "your city" },
      "3": { source: "static", value: "20%" },
      "4": { source: "field", key: "email" },
    };
    const r = previewValues(map, { firstName: "  ", email: "a@b.co" }, { city: "Amman" });
    expect(r.values).toEqual(["there", "Amman", "20%", "a@b.co"]);
    expect(r.usedFallback).toEqual([1]);
    expect(renderTemplate("Hi {{1}} in {{2}}: {{3}} off ({{4}})", r.values)).toBe("Hi there in Amman: 20% off (a@b.co)");
    // No value and no fallback: the slot stays visible as {{n}} (the backend skips that recipient).
    const miss = previewValues({ "1": { source: "field", key: "email" } }, {}, {});
    expect(miss.values).toEqual([""]);
    expect(miss.missing).toEqual({ slot: 1, source: "field", key: "email" });
    expect(renderTemplate("Mail {{1}}", miss.values)).toBe("Mail {{1}}");
  });

  it("legacy variables convert to varMap", () => {
    expect(
      legacyToVarMap([{ field: "name" }, { field: "phone" }, { field: "custom", customValue: " 20% " }]),
    ).toEqual({
      "1": { source: "field", key: "name" },
      "2": { source: "field", key: "phone" },
      "3": { source: "static", value: "20%" },
    });
    // `company` has no contact column: the backend refuses it, so it does not convert.
    expect(legacyToVarMap([{ field: "company" } as never])).toBeNull();
    expect(legacyToVarMap([{ field: "custom", customValue: "  " }])).toBeNull();
    expect(legacyToVarMap([])).toEqual({});
  });

  it("validates like the backend: missing, extra, bad key, unknown custom field, empty and too long", () => {
    const keys = new Set(["city"]);
    expect(varMapIssue(defaultVarMap(2), 2, keys)).toBeNull();
    expect(varMapIssue({ "1": { source: "field", key: "name" } }, 2, keys)).toEqual({ slot: "2", reason: "missing_slot" });
    expect(varMapIssue(defaultVarMap(3), 2, keys)).toEqual({ slot: "3", reason: "extra_slot" });
    expect(varMapIssue({ "1": { source: "field", key: "company" as never } }, 1, keys)).toEqual({ slot: "1", reason: "bad_key" });
    expect(varMapIssue({ "1": { source: "custom", key: "Bad Key!" } }, 1, keys)).toEqual({ slot: "1", reason: "bad_key" });
    expect(varMapIssue({ "1": { source: "custom", key: "region" } }, 1, keys)).toEqual({ slot: "1", reason: "unknown_custom_field" });
    // Without the custom-field list (no contacts.view) the key is left to the backend.
    expect(varMapIssue({ "1": { source: "custom", key: "region" } }, 1, null)).toBeNull();
    expect(varMapIssue({ "1": { source: "static", value: "   " } }, 1, keys)).toEqual({ slot: "1", reason: "empty_value" });
    expect(varMapIssue({ "1": { source: "static", value: "x".repeat(VAR_VALUE_MAX + 1) } }, 1, keys)).toEqual({
      slot: "1",
      reason: "too_long",
    });
    expect(varMapIssue({ "1": { source: "field", key: "name", fallback: "y".repeat(VAR_VALUE_MAX + 1) } }, 1, keys)).toEqual({
      slot: "1",
      reason: "too_long",
    });
    expect(varMapIssue({ "1": { source: "nope" } as never }, 1, keys)).toEqual({ slot: "1", reason: "bad_source" });
    expect(varMapComplete(defaultVarMap(0), 0)).toBe(true);
    expect(varMapComplete({ "1": { source: "static", value: "" } }, 1)).toBe(false);
    for (const reason of ["missing_slot", "extra_slot", "bad_source", "bad_key", "unknown_custom_field", "empty_value", "too_long"]) {
      expect(varMapReasonText(reason, "2", en), reason).toContain("{{2}}");
      expect(varMapReasonText(reason, "2", ar), reason).toMatch(ARABIC);
    }
  });

  it("normalizes before saving: trims, drops empty fallbacks and keeps numeric order", () => {
    expect(
      normalizeVarMap({
        "2": { source: "static", value: " x " },
        "1": { source: "field", key: "name", fallback: "  " },
        "3": { source: "custom", key: "city", fallback: " there " },
      }),
    ).toEqual({
      "1": { source: "field", key: "name" },
      "2": { source: "static", value: "x" },
      "3": { source: "custom", key: "city", fallback: "there" },
    });
  });

  it("labels slots and fields in both languages", () => {
    expect(FIELD_SOURCES.map((f) => f.key)).toEqual(["name", "firstName", "lastName", "phone", "email"]);
    for (const f of FIELD_SOURCES) expect(f.labelAr).toMatch(ARABIC);
    expect(slotLabel({ source: "field", key: "firstName" }, en, defs)).toBe("First name");
    expect(slotLabel({ source: "custom", key: "city" }, ar, defs)).toBe("المدينة");
    expect(slotLabel({ source: "static", value: "20%" }, en, defs)).toBe("20%");
    expect(fieldLabelOf("custom", "gone", defs)).toEqual({ label: "gone", labelAr: "gone", known: false });
    expect(placeholderCount("Hi {{1}}, {{ 2 }}")).toBe(2);
  });

  it("marks templates campaigns can't send yet (text-header variables, dynamic URL buttons)", () => {
    expect(templateUnsupported({ headerType: "TEXT", headerContent: "Hi {{1}}", buttons: null })).toBe(true);
    expect(templateUnsupported({ headerType: "text", headerContent: "Hello", buttons: null })).toBe(false);
    expect(
      templateUnsupported({ headerType: null, buttons: JSON.stringify([{ type: "URL", text: "Go", url: "https://x.co/{{1}}" }]) }),
    ).toBe(true);
    expect(templateUnsupported({ headerType: "image", buttons: JSON.stringify([{ type: "URL", text: "Go", url: "https://x.co" }]) })).toBe(false);
  });

  it("cuts a sample into text and filled slots, marking fallbacks and missing values", () => {
    expect(sampleSegments("Hi {{1}}, {{2}} off {{3}}", ["there", "20%", ""], [1])).toEqual([
      { text: "Hi " },
      { text: "there", slot: 1, fallback: true },
      { text: ", " },
      { text: "20%", slot: 2, fallback: false },
      { text: " off " },
      { text: "{{3}}", slot: 3, missing: true },
    ]);
    expect(sampleSegments("No vars", [], [])).toEqual([{ text: "No vars" }]);
  });
});
