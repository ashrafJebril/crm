import { AiReplyService, AiReplyResult } from "./ai-reply.service";

describe("AiReplyService.parseStructuredOutput", () => {
  const svc = new AiReplyService({} as never, {} as never, {} as never);

  it("parses a valid reply payload", () => {
    const raw = JSON.stringify({
      action: "reply",
      reply: "Delivery: 1-2 business days.",
      confidence: 0.92,
      needsEscalation: false,
      escalationReason: null,
      usedKnowledge: true,
      missingInformation: null,
    });
    const out = svc.parseStructuredOutput(raw);
    expect(out.action).toBe("reply");
    expect(out.confidence).toBe(0.92);
    expect(out.reply).toBe("Delivery: 1-2 business days.");
  });

  it("parses an escalate payload", () => {
    const raw = JSON.stringify({
      action: "escalate",
      reply: null,
      confidence: 0.4,
      needsEscalation: true,
      escalationReason: "no KB match",
      usedKnowledge: false,
      missingInformation: "delivery policy missing",
    });
    const out = svc.parseStructuredOutput(raw);
    expect(out.action).toBe("escalate");
    expect(out.needsEscalation).toBe(true);
  });

  it("throws on invalid JSON", () => {
    expect(() => svc.parseStructuredOutput("not json")).toThrow();
  });

  it("throws when confidence out of range", () => {
    const raw = JSON.stringify({
      action: "reply",
      reply: "x",
      confidence: 1.5,
      needsEscalation: false,
      escalationReason: null,
      usedKnowledge: true,
      missingInformation: null,
    });
    expect(() => svc.parseStructuredOutput(raw)).toThrow(/confidence/);
  });

  it("throws on invalid action", () => {
    const raw = JSON.stringify({
      action: "panic",
      reply: null,
      confidence: 0.5,
      needsEscalation: false,
      escalationReason: null,
      usedKnowledge: false,
      missingInformation: null,
    });
    expect(() => svc.parseStructuredOutput(raw)).toThrow(/action/);
  });
});

describe("AiReplyService.shouldEscalate", () => {
  const svc = new AiReplyService({} as never, {} as never, {} as never);

  const base: AiReplyResult = {
    action: "reply",
    reply: "ok",
    confidence: 0.9,
    needsEscalation: false,
    escalationReason: null,
    usedKnowledge: true,
    missingInformation: null,
  };

  it("escalates when needsEscalation=true", () => {
    expect(svc.shouldEscalate({ ...base, needsEscalation: true }, 0.75)).toBe(true);
  });
  it("escalates when action=escalate", () => {
    expect(svc.shouldEscalate({ ...base, action: "escalate" }, 0.75)).toBe(true);
  });
  it("escalates when confidence below threshold", () => {
    expect(svc.shouldEscalate({ ...base, confidence: 0.6 }, 0.75)).toBe(true);
  });
  it("escalates when reply is empty", () => {
    expect(svc.shouldEscalate({ ...base, reply: "" }, 0.75)).toBe(true);
  });
  it("does not escalate on confident, non-empty reply", () => {
    expect(svc.shouldEscalate(base, 0.75)).toBe(false);
  });
});

describe("AiReplyService.buildSystemPrompt", () => {
  const svc = new AiReplyService({} as never, {} as never, {} as never);

  it("includes retrieved chunks as numbered KB items", () => {
    const prompt = svc.buildSystemPrompt([
      { chunkId: "c1", documentId: "d1", documentFilename: "faq.pdf", content: "Delivery: 1-2 days", similarity: 0.9 },
      { chunkId: "c2", documentId: "d1", documentFilename: "faq.pdf", content: "Refund: 30 days", similarity: 0.7 },
    ]);
    expect(prompt).toContain("[KB 1]");
    expect(prompt).toContain("Delivery: 1-2 days");
    expect(prompt).toContain("[KB 2]");
    expect(prompt).toContain("Refund: 30 days");
  });

  it("notes the empty-KB case", () => {
    const prompt = svc.buildSystemPrompt([]);
    expect(prompt.toLowerCase()).toContain("no knowledge");
  });
});
