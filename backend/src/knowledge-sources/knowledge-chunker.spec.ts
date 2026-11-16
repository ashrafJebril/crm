import { chunkRows, chunkText } from "./knowledge-chunker";
import { CHUNK_MAX_CHARS } from "./knowledge-constants";

describe("knowledge chunker", () => {
  it("splits on headings, then paragraphs, carrying the heading", () => {
    const text = [
      "Intro paragraph that is long enough to keep around.",
      "",
      "# Opening hours",
      "We open every day from nine to nine, Friday from four.",
      "",
      "## Parking",
      "Free parking for customers is behind the building.",
      "",
      "short",
    ].join("\n");
    expect(chunkText(text)).toEqual([
      { heading: null, text: "Intro paragraph that is long enough to keep around." },
      { heading: "Opening hours", text: "We open every day from nine to nine, Friday from four." },
      { heading: "Parking", text: "Free parking for customers is behind the building.\n\nshort" },
    ]);
  });

  it("keeps every chunk within the cap, splitting on sentences, and drops tiny chunks", () => {
    const sentence = "This sentence is about forty characters. ";
    const text = `# Big\n${sentence.repeat(100)}\n\n# Tiny\nok`;
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
      expect(c.heading).toBe("Big");
    }
    // An unbreakable run is hard-cut.
    const run = chunkText("x".repeat(3000));
    expect(run.map((c) => c.text.length)).toEqual([1200, 1200, 600]);
    // Arabic sentences split on the Arabic question mark too.
    expect(chunkText(`${"هل لديكم مواقف للسيارات؟ ".repeat(80)}`).every((c) => c.text.length <= CHUNK_MAX_CHARS)).toBe(true);
  });

  it("one chunk per sheet row, header: value, empty cells skipped, row numbers kept", () => {
    expect(chunkRows("Prices", ["name", "price", "note"], [["Cut", "50", ""], ["", "", ""], ["Color", "120", "long"]], [2, 3, 4])).toEqual([
      { heading: "Prices", text: "name: Cut; price: 50", rowRef: 2 },
      { heading: "Prices", text: "name: Color; price: 120; note: long", rowRef: 4 },
    ]);
  });
});
