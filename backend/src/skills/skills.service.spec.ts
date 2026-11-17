import { HttpException } from "@nestjs/common";
import { McpToolsFactory } from "../mcp-server/mcp-tools.factory";
import { makeSkillsWorld, withEntry, WS, WS2 } from "./__fixtures__/skills-world";
import { SKILL_CATALOG, type SkillEntry } from "./skill-catalog";
import { fencedNotes } from "./skill-config";

async function failure(p: Promise<unknown>) {
  const e = await p.then(
    () => {
      throw new Error("expected a failure");
    },
    (err: unknown) => err,
  );
  if (!(e instanceof HttpException)) throw e;
  return { status: e.getStatus(), body: e.getResponse() as Record<string, unknown> };
}

const toolNames = (w: ReturnType<typeof makeSkillsWorld>, enabled: Awaited<ReturnType<typeof w.skills.enabledFor>>) =>
  Object.keys(new McpToolsFactory({} as never, {} as never, {} as never, {} as never, {} as never).build(WS, { enabled })).sort();

const rowOf = (w: ReturnType<typeof makeSkillsWorld>, key: string) => w.db.skillInstall.find((r) => r.workspaceId === WS && r.skillKey === key);

describe("SkillsService (SP-22)", () => {
  it("install with missing connector stays disabled", async () => {
    const w = makeSkillsWorld({ prompt: "Owner text." });
    const dto = await w.skills.install(WS, "calendly_scheduling", {}, "u1");
    expect(dto).toMatchObject({ key: "calendly_scheduling", installed: true, status: "needs_connector", requiredConnector: { provider: "calendly", connected: false }, agents: [] });

    // No tools and no block.
    const enabled = await w.skills.enabledFor(WS);
    expect(enabled.has("calendly_scheduling")).toBe(false);
    await w.prompts.apply(WS);
    expect(w.l.state.content).not.toContain("kewy-skill:calendly_scheduling");

    // Enable refused while the connector is missing.
    expect(await failure(w.skills.patch(WS, "calendly_scheduling", { enabled: true, version: dto.rowVersion }))).toMatchObject({
      status: 409,
      body: { message: "skills.connector_required", provider: "calendly" },
    });

    // The connector connects (SP-23 calls onConnectorChanged): enabled, block applied.
    w.connected.add("calendly");
    await w.skills.onConnectorChanged(WS, "calendly");
    expect(rowOf(w, "calendly_scheduling").status).toBe("enabled");
    expect((await w.skills.enabledFor(WS)).has("calendly_scheduling")).toBe(true);
    expect(w.l.state.content).toContain("<!-- kewy-skill:calendly_scheduling:v1 -->");
    expect(w.l.state.content.startsWith("Owner text.")).toBe(true);

    // It goes away: back to needs_connector, block removed.
    w.connected.delete("calendly");
    await w.skills.onConnectorChanged(WS, "calendly");
    expect(rowOf(w, "calendly_scheduling").status).toBe("needs_connector");
    expect(w.l.state.content).not.toContain("kewy-skill:calendly_scheduling");
  });

  it("update preserves config", async () => {
    const v1 = SKILL_CATALOG;
    const w = makeSkillsWorld({ prompt: "Owner text.", catalog: v1 });
    const installed = await w.skills.install(WS, "lead_capture", { config: { qualificationNotes: "Budget over 5k", allowedTags: ["vip", "wholesale"] } }, "u1");
    expect(installed).toMatchObject({ status: "enabled", installedVersion: 1, updateAvailable: false });
    expect(w.l.state.content).toContain("Budget over 5k");

    // The catalog bumps lead_capture to v2: adds followUpHours (default 24), keeps both keys.
    const v2 = withEntry("lead_capture", (e): SkillEntry => ({
      ...e,
      version: 2,
      configFields: [...e.configFields, { key: "followUpHours", type: "number", labelEn: "Follow up after", labelAr: "المتابعة بعد", required: false, default: 24, min: 1, max: 168 }],
      prompt: (c) => `## Lead capture v2\nFollow up after ${String(c.followUpHours)} hours.\n\n${fencedNotes(String(c.qualificationNotes ?? ""))}`,
    }));
    const w2 = { ...w, skills: new (w.skills.constructor as never as new (...a: unknown[]) => typeof w.skills)(w.prisma, w.prompts, w.presence, v2) };
    const listed = (await w2.skills.list(WS)).skills.find((s) => s.key === "lead_capture")!;
    expect(listed).toMatchObject({ updateAvailable: true, installedVersion: 1, version: 2 });

    const { skill, dropped } = await w2.skills.update(WS, "lead_capture", { version: listed.rowVersion });
    expect(dropped).toEqual([]);
    expect(skill).toMatchObject({ installedVersion: 2, updateAvailable: false, status: "enabled" });
    expect(skill.config).toEqual({ qualificationNotes: "Budget over 5k", allowedTags: ["vip", "wholesale"], followUpHours: 24 });
    // Re-applied with v2's text, the same notes, the v2 marker. Owner text kept.
    expect(w.l.state.content).toContain("<!-- kewy-skill:lead_capture:v2 -->");
    expect(w.l.state.content).toContain("## Lead capture v2\nFollow up after 24 hours.");
    expect(w.l.state.content).toContain("Budget over 5k");
    expect(w.l.state.content).not.toContain("kewy-skill:lead_capture:v1");
    expect(w.l.state.content.startsWith("Owner text.")).toBe(true);
    expect(await failure(w2.skills.update(WS, "lead_capture", { version: skill.rowVersion }))).toMatchObject({ status: 409, body: { message: "skills.up_to_date" } });
  });

  it("update reports dropped keys", async () => {
    const w = makeSkillsWorld();
    await w.skills.install(WS, "lead_capture", { config: { qualificationNotes: "Notes", allowedTags: ["vip"] } }, null);
    const v3 = withEntry("lead_capture", (e) => ({ ...e, version: 3, configFields: e.configFields.filter((f) => f.key !== "qualificationNotes") }));
    const s3 = new (w.skills.constructor as never as new (...a: unknown[]) => typeof w.skills)(w.prisma, w.prompts, w.presence, v3);
    const { skill, dropped } = await s3.update(WS, "lead_capture", { version: rowOf(w, "lead_capture").version });
    expect(dropped).toEqual(["qualificationNotes"]);
    expect(skill.config).toEqual({ allowedTags: ["vip"] });
  });

  it("new required field without default needs config", async () => {
    const w = makeSkillsWorld();
    await w.skills.install(WS, "lead_capture", { config: { allowedTags: ["vip"] } }, null);
    const v2 = withEntry("lead_capture", (e) => ({
      ...e,
      version: 2,
      configFields: [...e.configFields, { key: "region", type: "text", labelEn: "Region", labelAr: "المنطقة", required: true, maxLength: 50 }],
    }));
    const s2 = new (w.skills.constructor as never as new (...a: unknown[]) => typeof w.skills)(w.prisma, w.prompts, w.presence, v2);
    const { skill } = await s2.update(WS, "lead_capture", { version: rowOf(w, "lead_capture").version });
    expect(skill).toMatchObject({ status: "disabled", needsConfig: true });
    expect(w.l.state.content).not.toContain("kewy-skill:lead_capture");
    expect(await failure(s2.patch(WS, "lead_capture", { enabled: true, version: skill.rowVersion }))).toMatchObject({
      status: 409,
      body: { message: "skills.config_required", fields: ["region"] },
    });
    // Saving the field and enabling works.
    const ok = await s2.patch(WS, "lead_capture", { enabled: true, config: { allowedTags: ["vip"], region: "Riyadh" }, version: skill.rowVersion });
    expect(ok).toMatchObject({ status: "enabled", needsConfig: false });
  });

  it("no rows means today's tools and prompt", async () => {
    const w = makeSkillsWorld({ prompt: "Owner text." });
    const enabled = await w.skills.enabledFor(WS);
    expect([...enabled.keys()]).toEqual(["booking", "customer_records", "photos"]);
    // Today's thirteen tools (the twelve pre-SP-21 ones plus SP-21's core search_knowledge).
    expect(toolNames(w, enabled)).toEqual([
      "cancel_appointment", "create_appointment", "create_contact", "find_slots", "get_appointment",
      "get_contact", "list_appointments", "list_photos", "list_services", "search_contacts", "search_knowledge",
      "update_appointment", "update_contact",
    ]);
    // The prompt carries today's three sections' text, delimited.
    await w.prompts.apply(WS);
    const { CRM_PROMPT_SECTION, CRM_PHOTOS_SECTION, CRM_BOOKING_SLOTS_SECTION } = await import("./skill-catalog");
    expect(w.l.state.content).toBe(
      [
        "Owner text.",
        `<!-- kewy-skill:booking:v1 -->\n${CRM_PROMPT_SECTION}\n\n${CRM_BOOKING_SLOTS_SECTION}\n<!-- /kewy-skill:booking -->`,
        `<!-- kewy-skill:photos:v1 -->\n${CRM_PHOTOS_SECTION}\n<!-- /kewy-skill:photos -->`,
      ].join("\n\n"),
    );
    expect(w.db.skillInstall).toHaveLength(0); // no backfill
  });

  it("skill routes are workspace-scoped", async () => {
    const w = makeSkillsWorld();
    // Workspace B disables booking; workspace A is untouched.
    await w.skills.patch(WS2, "booking", { enabled: false, version: 0 });
    expect(w.db.skillInstall.map((r) => [r.workspaceId, r.skillKey, r.status])).toEqual([[WS2, "booking", "disabled"]]);
    expect((await w.skills.enabledFor(WS)).has("booking")).toBe(true);
    expect((await w.skills.list(WS)).skills.find((s) => s.key === "booking")).toMatchObject({ status: "enabled", rowVersion: 0 });
    // A row of B planted with A's query shape is never returned for A.
    w.db.skillInstall.push({ id: "x", workspaceId: WS2, skillKey: "support_tickets", status: "enabled", installedVersion: 1, config: {}, needsConfig: false, version: 0 });
    expect((await w.skills.enabledFor(WS)).has("support_tickets")).toBe(false);
    expect(await failure(w.skills.install(WS, "nope", {}, null))).toMatchObject({ status: 404, body: { message: "skills.unknown" } });
    expect(await failure(w.skills.patch(WS, "nope", { version: 0 }))).toMatchObject({ status: 404 });
    expect(await failure(w.skills.uninstall(WS, "support_tickets"))).toMatchObject({ status: 404, body: { message: "skills.not_installed" } });
  });

  it("install rules: already installed, a disabled default reinstalls, no l link, invalid config", async () => {
    const w = makeSkillsWorld();
    expect(await failure(w.skills.install(WS, "booking", {}, null))).toMatchObject({ status: 409, body: { message: "skills.already_installed" } });
    await w.skills.uninstall(WS, "booking");
    expect(rowOf(w, "booking")).toMatchObject({ status: "disabled" });
    expect((await w.skills.install(WS, "booking", { config: { newBookingStatus: "confirmed" } }, "u1")).status).toBe("enabled");
    expect(rowOf(w, "booking").config).toEqual({ newBookingStatus: "confirmed" });

    expect(await failure(w.skills.install(WS, "support_tickets", { config: { defaultPriority: "urgent" } }, null))).toMatchObject({
      status: 400,
      body: { message: "skills.invalid_config", errors: [{ key: "defaultPriority", code: "not_an_option" }] },
    });
    const unlinked = makeSkillsWorld({ linked: false });
    expect(await failure(unlinked.skills.install(WS, "support_tickets", {}, null))).toMatchObject({ status: 409, body: { message: "skills.agent_not_connected" } });

    // Uninstall of a non-default skill deletes the row (config not kept).
    await w.skills.install(WS, "support_tickets", { config: { defaultPriority: "high" } }, null);
    await w.skills.uninstall(WS, "support_tickets");
    expect(rowOf(w, "support_tickets")).toBeUndefined();
  });

  it("stale version is 409 version_conflict with the current version", async () => {
    const w = makeSkillsWorld();
    const s = await w.skills.install(WS, "support_tickets", {}, null);
    await w.skills.patch(WS, "support_tickets", { enabled: false, version: s.rowVersion });
    expect(await failure(w.skills.patch(WS, "support_tickets", { enabled: true, version: s.rowVersion }))).toMatchObject({
      status: 409,
      body: { message: "skills.version_conflict", current: s.rowVersion + 1 },
    });
  });

  it("l failure marks needs attention and retry recovers", async () => {
    const w = makeSkillsWorld({ prompt: "Owner." });
    w.l.state.failNext = 1;
    const s = await w.skills.install(WS, "support_tickets", {}, null);
    expect(s).toMatchObject({ status: "needs_attention" });
    expect(s.lastError).toMatch(/HTTP 500/);
    expect(s.lastError).not.toContain("abc123"); // no secret
    expect(s.lastError!.length).toBeLessThanOrEqual(300);
    // Still wanted on: its tools stay.
    expect((await w.skills.enabledFor(WS)).has("support_tickets")).toBe(true);
    const r = await w.skills.retry(WS, "support_tickets");
    expect(r).toMatchObject({ status: "enabled", lastError: null });
    expect(w.l.state.content).toContain("<!-- kewy-skill:support_tickets:v1 -->");
  });

  it("list reports usage, agents and the agent link", async () => {
    const w = makeSkillsWorld();
    const now = Date.now();
    w.db.agentToolCall.push(
      { id: "a", workspaceId: WS, tool: "list_photos", skillKey: "photos", outcome: "ok", durationMs: 5, at: new Date(now - 2 * 86_400_000) },
      { id: "b", workspaceId: WS, tool: "list_photos", skillKey: "photos", outcome: "ok", durationMs: 5, at: new Date(now - 10 * 86_400_000) },
      { id: "c", workspaceId: WS2, tool: "list_photos", skillKey: "photos", outcome: "ok", durationMs: 5, at: new Date(now) },
    );
    w.db.agentSettings.push({ id: "s", workspaceId: WS, nameEn: "Salma", nameAr: "سلمى" });
    const res = await w.skills.list(WS);
    expect(res.agentConnected).toBe(true);
    const photos = res.skills.find((s) => s.key === "photos")!;
    expect(photos.usage).toEqual({ calls7d: 1, calls30d: 2, lastUsedAt: new Date(now - 2 * 86_400_000).toISOString() });
    expect(photos.agents).toEqual([{ slug: "agent-1", name: { en: "Salma", ar: "سلمى" } }]);
    expect(photos.tools).toEqual([{ name: "list_photos", kind: "read" }]);
    expect(res.skills.find((s) => s.key === "support_tickets")).toMatchObject({ installed: false, status: "not_installed", agents: [] });
    expect(res.skills.map((s) => s.key)).toEqual(SKILL_CATALOG.map((e) => e.key));
  });
});
