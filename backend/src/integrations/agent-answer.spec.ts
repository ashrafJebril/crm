import { AGENT_ANSWER_MAX, validateAgentAnswer } from "./agent-answer";

describe("validateAgentAnswer (SP-22)", () => {
  it("refuses empty, whitespace and non-string answers", () => {
    for (const answer of ["", "   \n\t ", null, undefined, 42, { text: "x" }, ["x"]]) {
      expect({ answer, out: validateAgentAnswer({ answer }) }).toEqual({ answer, out: null });
    }
    expect(validateAgentAnswer({ answer: "\u0000\u0007" })).toBeNull();
  });

  it("strips control characters, keeps newlines, trims", () => {
    expect(validateAgentAnswer({ answer: "  Hi\u0000 there‮!\r\nBye\t.  " })).toEqual({ text: "Hi there!\nBye\t." });
  });

  it("cuts a long answer at a sentence boundary with an ellipsis", () => {
    const sentence = "This is one sentence of the answer. ";
    const long = sentence.repeat(Math.ceil(10_000 / sentence.length));
    const out = validateAgentAnswer({ answer: long })!;
    expect(out.text.length).toBeLessThanOrEqual(AGENT_ANSWER_MAX);
    expect(out.text.endsWith("answer.…")).toBe(true);
    // No sentence boundary: cut at a space.
    const words = "word ".repeat(3000);
    const w = validateAgentAnswer({ answer: words })!;
    expect(w.text.length).toBeLessThanOrEqual(AGENT_ANSWER_MAX);
    expect(w.text.endsWith("word…")).toBe(true);
  });

  it("passes only an https image url on", () => {
    expect(validateAgentAnswer({ answer: "ok", image_url: "https://cdn.test/p.jpg" })).toEqual({ text: "ok", imageUrl: "https://cdn.test/p.jpg" });
    for (const image_url of ["http://cdn.test/p.jpg", "javascript:alert(1)", 5, ""]) {
      expect(validateAgentAnswer({ answer: "ok", image_url })).toEqual({ text: "ok" });
    }
  });
});
