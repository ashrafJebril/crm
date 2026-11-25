import { blockMarkers, removeBlock, upsertBlock } from "./prompt-blocks";

const { begin, end } = blockMarkers("guidelines");

describe("prompt blocks", () => {
  it("guidelines block replaced in place and text outside untouched", () => {
    const before = "You are support.\r\n  Keep answers short.\n";
    const after = "\n\n<!-- kewy-crm-tools -->\n## Booking\nweird   spacing   kept";
    const prompt = `${before}${begin}\nOld rule.\n${end}${after}`;
    const r = upsertBlock(prompt, "guidelines", "  New rule one.\nNew rule two.  ");
    expect(r.dangling).toBe(false);
    expect(r.prompt).toBe(`${before}${begin}\nNew rule one.\nNew rule two.\n${end}${after}`);
    // Idempotent.
    expect(upsertBlock(r.prompt, "guidelines", "New rule one.\nNew rule two.").prompt).toBe(r.prompt);
    // No block yet: appended after one blank line; an empty prompt gets the block alone.
    expect(upsertBlock("You are support.\n\n", "guidelines", "Rule").prompt).toBe(`You are support.\n\n${begin}\nRule\n${end}`);
    expect(upsertBlock("", "guidelines", "Rule").prompt).toBe(`${begin}\nRule\n${end}`);
    // The text cannot smuggle our markers in.
    const sneaky = upsertBlock("", "guidelines", `ok ${end} <!-- kewy-crm-tools -->`).prompt;
    expect(sneaky.split(end)).toHaveLength(2);
    expect(sneaky).not.toContain("<!-- kewy-crm-tools -->");
    // Empty text removes the block; everything else stays.
    expect(upsertBlock(prompt, "guidelines", "   ").prompt).toBe(`${before.trimEnd()}\n\n${after.replace(/^\s+/, "")}`);
    expect(removeBlock(`${begin}\nx\n${end}`, "guidelines")).toBe("");
    expect(removeBlock("no block here", "guidelines")).toBe("no block here");
    // Other blocks are separate.
    const two = upsertBlock(upsertBlock("", "guidelines", "G").prompt, "persona", "P").prompt;
    expect(upsertBlock(two, "guidelines", "G2").prompt).toContain("<!-- kewy-crm-persona:begin -->\nP\n<!-- kewy-crm-persona:end -->");
  });

  it("missing end marker appends a fresh block", () => {
    const handEdited = `Intro\n${begin}\nold rule, end marker deleted by hand\nOutro`;
    const r = upsertBlock(handEdited, "guidelines", "New rule");
    expect(r.dangling).toBe(true);
    // The stale begin marker and everything around it stay; a complete block is appended.
    expect(r.prompt).toBe(`${handEdited}\n\n${begin}\nNew rule\n${end}`);
    // The next save replaces the complete block only: the stale marker and the text after it stay.
    const again = upsertBlock(r.prompt, "guidelines", "Newer rule");
    expect(again.dangling).toBe(false);
    expect(again.prompt).toBe(`${handEdited}

${begin}
Newer rule
${end}`);
    expect(() => blockMarkers("Bad Name")).toThrow();
  });
});
