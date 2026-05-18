import { splitIntoChunks, estimateTokens } from "./chunker";

describe("chunker.splitIntoChunks", () => {
  it("returns the original text as one chunk when below max size", () => {
    const text = "Short paragraph.";
    const chunks = splitIntoChunks(text, { maxChars: 1000, overlapChars: 100 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe("Short paragraph.");
  });

  it("splits long text on paragraph boundaries first", () => {
    const text = "A".repeat(500) + "\n\n" + "B".repeat(500) + "\n\n" + "C".repeat(500);
    const chunks = splitIntoChunks(text, { maxChars: 600, overlapChars: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(750);
  });

  it("includes overlap between consecutive chunks", () => {
    const text = "word ".repeat(400); // ~2000 chars
    const chunks = splitIntoChunks(text, { maxChars: 500, overlapChars: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    const tail = chunks[0].slice(-50);
    expect(chunks[1].startsWith(tail.slice(0, 30))).toBe(true);
  });

  it("handles Arabic text with Arabic punctuation", () => {
    const ar = "كيف حالك؟\n\nأنا بخير، شكراً لك.\n\nما هي ساعات العمل؟";
    const chunks = splitIntoChunks(ar, { maxChars: 100, overlapChars: 20 });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join(" ")).toContain("ساعات");
  });

  it("never returns an empty chunk", () => {
    const text = "\n\n\n\nhello\n\n\n\n";
    const chunks = splitIntoChunks(text, { maxChars: 100, overlapChars: 10 });
    for (const c of chunks) expect(c.trim().length).toBeGreaterThan(0);
  });
});

describe("chunker.estimateTokens", () => {
  it("estimates a sensible token count for English", () => {
    const t = estimateTokens("hello world this is a test sentence");
    expect(t).toBeGreaterThan(5);
    expect(t).toBeLessThan(20);
  });
});
