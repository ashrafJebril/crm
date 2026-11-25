import { crmPromptSections } from "../../integrations/l-agent-setup.service";
import { composeSandboxSystem, localNow, PREVIEW_NOTICE, turnNote } from "./sandbox-prompt";

describe("sandbox prompt", () => {
  const base = { sections: crmPromptSections(), persona: "Your name is Salma.", guidelines: "Be brief.", guidelinesBlock: "guidelines" };

  it("uses the live l prompt when there is one, else the CRM sections", () => {
    const live = composeSandboxSystem({ ...base, live: "LIVE\n<!-- kewy-crm-persona:begin -->\nold persona\n<!-- kewy-crm-persona:end -->" });
    expect(live.startsWith("LIVE")).toBe(true);
    expect(live).not.toContain("old persona"); // the latest saved persona wins
    expect(live).toContain("<!-- kewy-crm-persona:begin -->\nYour name is Salma.\n<!-- kewy-crm-persona:end -->");
    expect(live).toContain("<!-- kewy-crm-guidelines:begin -->\nBe brief.\n<!-- kewy-crm-guidelines:end -->");
    expect(live.endsWith(PREVIEW_NOTICE)).toBe(true);

    const none = composeSandboxSystem({ ...base, live: null });
    for (const m of ["<!-- kewy-crm-tools -->", "<!-- kewy-crm-photos -->", "<!-- kewy-crm-booking-slots -->", "<!-- kewy-crm-knowledge -->"]) expect(none).toContain(m);
    expect(composeSandboxSystem({ ...base, live: "   " }).startsWith(crmPromptSections().slice(0, 20))).toBe(true);
    // Empty persona/guidelines: no blocks.
    expect(composeSandboxSystem({ ...base, live: null, persona: "", guidelines: "" })).not.toContain("kewy-crm-persona");
  });

  it("the preview notice says writes are simulated", () => {
    expect(PREVIEW_NOTICE).toMatch(/simulated/);
    expect(PREVIEW_NOTICE).toMatch(/NOT saved/);
  });

  it("the per-turn note carries local time and the gate decision", () => {
    const now = new Date("2026-11-22T07:00:00Z");
    expect(localNow(now, "Asia/Riyadh")).toContain("10:00");
    expect(turnNote({ now, tz: "Asia/Riyadh", gate: { wouldReply: true, reason: "ok" } })).toMatch(/would answer a real customer now\.$/);
    expect(turnNote({ now, tz: "Asia/Riyadh", gate: { wouldReply: false, reason: "outside_hours" } })).toContain("(it is outside the agent's working hours)");
    expect(localNow(now, "Not/AZone")).toBe(now.toISOString());
  });
});
