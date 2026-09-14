import { describe, expect, it } from "vitest";
import {
  BASE_TOKENS,
  canSave,
  missingTokens,
  newAutomation,
  newStep,
  renderTemplate,
  templateTokens,
} from "./automations";

const values = {
  "contact.name": "Sara",
  "deal.title": "Laser package",
  "deal.value": "AED 2,400",
};

describe("renderTemplate", () => {
  it("substitutes named tokens", () => {
    expect(renderTemplate("Hi {{contact.name}}, re {{deal.title}}", values)).toBe(
      "Hi Sara, re Laser package",
    );
  });

  it("resolves numbered placeholders through variableMap", () => {
    const out = renderTemplate("Hi {{1}}, your {{2}} is ready", values, {
      "1": "contact.name",
      "2": "deal.title",
    });
    expect(out).toBe("Hi Sara, your Laser package is ready");
  });

  it("renders unmapped numbers as [missing]", () => {
    expect(renderTemplate("Hi {{1}} and {{2}}", values, { "1": "contact.name" })).toBe(
      "Hi Sara and [missing]",
    );
    expect(renderTemplate("Hi {{1}}", values)).toBe("Hi [missing]");
  });

  it("leaves unknown named tokens untouched", () => {
    expect(renderTemplate("Hi {{contact.email}}", values)).toBe("Hi {{contact.email}}");
  });
});

describe("templateTokens / missingTokens", () => {
  it("collects named tokens", () => {
    expect(templateTokens({ body: "{{contact.name}} {{deal.value}} {{contact.name}}" })).toEqual([
      "contact.name",
      "deal.value",
    ]);
  });

  it("collects tokens via variableMap for numbered templates", () => {
    expect(
      templateTokens({ body: "{{1}} {{2}}", variableMap: { "1": "contact.name", "2": "deal.title" } }),
    ).toEqual(["contact.name", "deal.title"]);
  });

  it("returns empty when the trigger supplies everything", () => {
    expect(missingTokens({ body: "Hi {{contact.name}}" }, BASE_TOKENS)).toEqual([]);
  });

  it("lists deal tokens for a contact-only trigger", () => {
    expect(missingTokens({ body: "{{contact.name}} {{deal.title}} {{deal.value}}" }, BASE_TOKENS)).toEqual([
      "deal.title",
      "deal.value",
    ]);
  });
});

describe("canSave / factories", () => {
  it("newAutomation starts empty and unsaveable", () => {
    const a = newAutomation();
    expect(a.trigger).toBeNull();
    expect(a.steps).toEqual([]);
    expect(a.enabled).toBe(true);
    expect(canSave(a)).toBe(false);
  });

  it("requires a trigger and one templated message step", () => {
    const a = newAutomation();
    a.trigger = { kind: "contact.created" };
    expect(canSave(a)).toBe(false);
    a.steps = [newStep("wait")];
    expect(canSave(a)).toBe(false);
    const wa = newStep("whatsapp");
    a.steps = [wa];
    expect(canSave(a)).toBe(false);
    if (wa.kind === "whatsapp") wa.templateId = "t1";
    expect(canSave(a)).toBe(true);
  });

  it("newStep defaults", () => {
    expect(newStep("wait")).toMatchObject({ kind: "wait", amount: 1, unit: "days" });
    expect(newStep("email")).toMatchObject({ kind: "email", templateId: null, subject: "" });
    expect(newStep("whatsapp").id).toBeTruthy();
  });
});
