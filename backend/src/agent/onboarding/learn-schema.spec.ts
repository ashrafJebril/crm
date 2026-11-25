/* eslint-disable @typescript-eslint/no-explicit-any */
import { cleanLearnReply, cleanText, LEARN_JSON_SCHEMA, LearnReplySchema } from "./learn-schema";

describe("learn schema", () => {
  it("the structured-output schema is strict at every object and uses no unsupported constraints", () => {
    const walk = (s: any, path: string) => {
      if (!s || typeof s !== "object") return;
      if (s.type === "object") expect({ path, ap: s.additionalProperties }).toEqual({ path, ap: false });
      for (const bad of ["minimum", "maximum", "minLength", "maxLength", "maxItems", "pattern"]) expect({ path, bad, has: bad in s }).toEqual({ path, bad, has: false });
      for (const [k, v] of Object.entries(s)) walk(v, `${path}.${k}`);
    };
    walk(LEARN_JSON_SCHEMA, "$");
    expect(LEARN_JSON_SCHEMA.required).toEqual(["business", "faqs", "services"]);
    expect(Object.keys(LEARN_JSON_SCHEMA.properties.hours.properties)).toEqual(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
  });

  it("zod enforces types and drops unknown keys", () => {
    expect(LearnReplySchema.safeParse({ business: { name: "N" }, faqs: [], services: [] }).success).toBe(true);
    expect(LearnReplySchema.safeParse({ business: { name: 1 }, faqs: [], services: [] }).success).toBe(false);
    expect(LearnReplySchema.safeParse({ business: { name: "N" }, faqs: "none", services: [] }).success).toBe(false);
    const parsed = LearnReplySchema.parse({ business: { name: "N", evil: true }, faqs: [], services: [], setAgent: "always" });
    expect(parsed).not.toHaveProperty("setAgent");
    expect(parsed.business).not.toHaveProperty("evil");
  });

  it("cleaning dedupes FAQs, drops empties and keeps an empty card empty", () => {
    const card = cleanLearnReply(
      {
        business: { name: "  N  " },
        faqs: [
          { question: "Q?", answer: "A" },
          { question: "q?", answer: "dup" },
          { question: "Q2", answer: "   " },
        ],
        services: [{ name: "  " }],
      },
      [],
    );
    expect(card).toEqual({ business: { name: "N" }, faqs: [{ question: "Q?", answer: "A" }], services: [], sourcePages: [] });
    expect(cleanText("javascript:alert(1)", 50)).toBe("alert(1)");
  });
});
