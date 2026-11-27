import { describe, expect, it } from "vitest";
import { parseToolJson } from "./toolJson";

const empty = { headers: "", body_template: "", param_descriptions: "" };

describe("parseToolJson", () => {
  it("leaves empty boxes out", () => {
    expect(parseToolJson({ ...empty, headers: "  " })).toEqual({ ok: true });
  });

  it("reads all three boxes", () => {
    expect(
      parseToolJson({
        headers: '{"x-crm-secret": "s"}',
        body_template: '{"branches": "{branches}", "nested": {"a": ["{b}"]}, "n": 1}',
        param_descriptions: '{"branches": "How many branches"}',
      }),
    ).toEqual({
      ok: true,
      headers: { "x-crm-secret": "s" },
      body_template: { branches: "{branches}", nested: { a: ["{b}"] }, n: 1 },
      param_descriptions: { branches: "How many branches" },
    });
  });

  it("names the box that is wrong", () => {
    expect(parseToolJson({ ...empty, headers: "{bad" })).toEqual({ ok: false, field: "headers" });
    expect(parseToolJson({ ...empty, headers: '{"n": 1}' })).toEqual({ ok: false, field: "headers" });
    expect(parseToolJson({ ...empty, body_template: "[1]" })).toEqual({ ok: false, field: "body_template" });
    expect(parseToolJson({ ...empty, param_descriptions: '"x"' })).toEqual({ ok: false, field: "param_descriptions" });
  });
});
