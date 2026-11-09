import { isShortTitle, KNOWN_META_FAILURE_CODES, LAUNCH_UNCONFIRMED, metaFailureCode, missingValueCode, parseMissingValueCode, providerFailure, SKIP_CODES } from "./failure-codes";

describe("failure codes", () => {
  it("metaFailureCode namespaces integer codes only", () => {
    expect(metaFailureCode(131026)).toBe("meta:131026");
    expect(metaFailureCode("132015")).toBe("meta:132015");
    expect(metaFailureCode(368)).toBe("meta:368");
    for (const bad of [null, undefined, "", "abc", 1.5, "13 1", NaN, -1, {}]) expect(metaFailureCode(bad)).toBeNull();
  });

  it("providerFailure prefers the explanation, flattens it to one line and caps it at 300", () => {
    expect(providerFailure("Message failed", 131026, "Message undeliverable.\n  Check the number")).toEqual({
      failureCode: "meta:131026",
      failureReason: "Message undeliverable. Check the number",
    });
    expect(providerFailure("Boom", null, null)).toEqual({ failureCode: "provider:unknown", failureReason: "Boom" });
    expect(providerFailure(null, "x", undefined)).toEqual({ failureCode: "provider:unknown", failureReason: null });
    expect(providerFailure("y".repeat(500), 1, null).failureReason).toHaveLength(300);
  });

  it("isShortTitle: one line, at most 120 characters, no braces", () => {
    expect(isShortTitle("Message undeliverable")).toBe(true);
    expect(isShortTitle("a".repeat(120))).toBe(true);
    expect(isShortTitle("a".repeat(121))).toBe(false);
    expect(isShortTitle("two\nlines")).toBe(false);
    expect(isShortTitle('{"error":1}')).toBe(false);
    expect(isShortTitle("")).toBe(false);
    expect(isShortTitle(null)).toBe(false);
  });

  it("exports the skip codes and the Meta codes the UI has copy for", () => {
    expect(SKIP_CODES).toEqual({ opted_out: "skip:opted_out", no_phone: "skip:no_phone" });
    expect(KNOWN_META_FAILURE_CODES).toContain("meta:131026");
    expect(KNOWN_META_FAILURE_CODES).toContain("meta:132015");
    expect(KNOWN_META_FAILURE_CODES).toHaveLength(18);
  });
});

describe("SP-13 failure codes", () => {
  it("missingValueCode names the field, and parseMissingValueCode reads it back", () => {
    expect(missingValueCode("custom", "service_due")).toBe("skip:missing_value:custom.service_due");
    expect(missingValueCode("field", "email")).toBe("skip:missing_value:field.email");
    expect(parseMissingValueCode("skip:missing_value:custom.service_due")).toEqual({ source: "custom", key: "service_due" });
    expect(parseMissingValueCode("skip:missing_value:field.firstName")).toEqual({ source: "field", key: "firstName" });
    for (const bad of [null, "skip:opted_out", "skip:missing_value:other.x", "skip:missing_value:custom.", "launch:unconfirmed"]) {
      expect(parseMissingValueCode(bad)).toBeNull();
    }
    expect(LAUNCH_UNCONFIRMED).toBe("launch:unconfirmed");
  });
});
