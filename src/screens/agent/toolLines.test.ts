import { describe, expect, it } from "vitest";
import { makeTx } from "@/lib/tx";
import { SANDBOX_READ_TOOLS } from "./agentConstants";
import { TOOL_LABELS, toolLabel, toolLines } from "./toolLines";

const en = makeTx("en");
const ar = makeTx("ar");

describe("tool lines", () => {
  it("collapses consecutive repeats to ×n and marks simulated writes Not saved", () => {
    const lines = toolLines(
      [
        { name: "search_knowledge", simulated: false },
        { name: "search_knowledge", simulated: false },
        { name: "search_knowledge", simulated: false },
        { name: "create_appointment", simulated: true },
        { name: "search_knowledge", simulated: false },
        { name: "get_contact", simulated: false, error: true },
      ],
      en,
    );
    expect(lines.map((l) => [l.label, l.times, l.badge, l.error])).toEqual([
      ["Searched your knowledge", "×3", "", false],
      ["Would book an appointment", "", "Not saved", false],
      ["Searched your knowledge", "", "", false],
      ["Opened a customer", "", "", true],
    ]);
    expect(toolLines([{ name: "create_contact", simulated: true }], ar)[0]).toMatchObject({ label: "سيضيف عميلًا", badge: "لم يُحفظ" });
  });

  it("labels every known tool in both languages; an unknown id shows as itself", () => {
    for (const id of [...SANDBOX_READ_TOOLS, "create_appointment", "update_appointment", "cancel_appointment", "create_contact", "update_contact"]) {
      expect(TOOL_LABELS[id]).toBeDefined();
      expect(toolLabel(id, ar)).toMatch(/[؀-ۿ]/);
    }
    expect(toolLabel("brand_new_tool", en)).toBe("brand_new_tool");
  });
});
