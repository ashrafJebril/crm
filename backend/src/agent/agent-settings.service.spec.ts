import { HttpException } from "@nestjs/common";
import { makeFakePrisma } from "../channels/test-prisma";
import { LAgentSetupService } from "../integrations/l-agent-setup.service";
import { AgentSettingsService } from "./agent-settings.service";
import { invalidateAgentGate } from "./agent-reply-gate";

const WS = "ws1";
const SCHEDULE = { sun: [{ from: "09:00", to: "17:00" }], mon: [{ from: "09:00", to: "17:00" }] };

/** The l platform: one agent, one live prompt; PUT replaces it. */
function fakeL(initial = "You are support.") {
  const state = { content: initial, puts: 0, fail: false };
  const client = {
    request: jest.fn(async (path: string, o?: { method?: string; body?: { content: string } }) => {
      if (state.fail) throw new Error("l is down");
      if (o?.method === "PUT") {
        state.puts++;
        state.content = o.body!.content;
        return undefined;
      }
      if (path.endsWith("/agents")) return [{ slug: "support", live_version: 1 }];
      if (path.endsWith("/prompts")) return [{ version: 1, content: state.content }];
      return undefined;
    }),
  };
  return { state, client };
}

/** The unscoped client LAgentSetupService uses for its prompt lock. */
function rawClient(linked: boolean) {
  const raw: Record<string, unknown> = {
    workspace: { findUnique: jest.fn(async () => ({ lWorkspaceId: linked ? "l-ws" : null })) },
    $executeRaw: jest.fn(async () => 0),
  };
  raw.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(raw));
  return raw;
}

function world(opts: { linked?: boolean; prompt?: string } = {}) {
  const linked = opts.linked ?? true;
  const prisma = makeFakePrisma({
    workspace: [{ id: WS, name: "Salon", slug: "salon", timezone: "Asia/Riyadh", lWorkspaceId: linked ? "l-ws" : null }],
    user: [{ id: "u1", name: "Owner Olga", email: "o@x" }],
    tag: [
      { id: "tag-vip", workspaceId: WS, name: "VIP", color: "red" },
      { id: "tag-new", workspaceId: WS, name: "New", color: "blue" },
      { id: "tag-foreign", workspaceId: "ws2", name: "VIP", color: "red" },
    ],
  });
  const l = fakeL(opts.prompt);
  const setup = new LAgentSetupService(
    { raw: rawClient(linked) } as never,
    l.client as never,
    { resolveSlug: jest.fn(async () => "support") } as never,
    {
      list: jest.fn(async () => ({ servers: [{ id: "srv", name: "kewy_crm" }] })),
      bind: jest.fn(async () => undefined),
      remove: jest.fn(),
      create: jest.fn(),
    } as never,
    { status: jest.fn(async () => ({ connected: true })), generate: jest.fn() } as never,
  );
  const svc = new AgentSettingsService(prisma as never, setup);
  jest.spyOn((svc as unknown as { log: { warn: () => void } }).log, "warn").mockImplementation(() => undefined);
  return { prisma, svc, l, setup };
}

async function expectError(p: Promise<unknown>, status: number, body: Record<string, unknown>) {
  try {
    await p;
    throw new Error("expected an error");
  } catch (e) {
    expect(e).toBeInstanceOf(HttpException);
    expect((e as HttpException).getStatus()).toBe(status);
    expect((e as HttpException).getResponse()).toMatchObject(body);
  }
}

describe("AgentSettingsService", () => {
  beforeEach(() => invalidateAgentGate());

  it("first read creates the row with today's defaults", async () => {
    const { svc, prisma } = world({ linked: false });
    const dto = await svc.get(WS);
    expect(dto).toEqual({
      nameEn: null,
      nameAr: null,
      greeting: null,
      greetingAr: null,
      tone: [],
      hoursMode: "always",
      schedule: null,
      excludedTags: [],
      droppedTagIds: [],
      stopped: null,
      timezone: "Asia/Riyadh",
      publishState: "none",
      linked: false,
      version: 0,
    });
    expect(prisma.db.agentSettings).toHaveLength(1);
    await svc.get(WS);
    expect(prisma.db.agentSettings).toHaveLength(1);
  });

  it("settings validation", async () => {
    const { svc } = world({ linked: false });
    // Name required once identity is set (both names empty after the merge).
    await expectError(svc.update(WS, { identity: { greeting: "Hi" }, version: 0 }), 400, { message: "agent.name_required" });
    await expectError(svc.update(WS, { identity: { nameEn: "   ", nameAr: "" }, version: 0 }), 400, { message: "agent.name_required" });
    // Tones from the list only (sarcastic is not on it).
    await expectError(svc.update(WS, { identity: { nameEn: "Sam", tone: ["friendly", "sarcastic"] }, version: 0 }), 400, {
      message: "agent.tone_invalid",
    });
    // Schedule errors per day, from SP-10's validator.
    await expectError(
      svc.update(WS, { hours: { mode: "within", schedule: { mon: [{ from: "18:00", to: "09:00" }] } }, version: 0 }),
      422,
      { message: "agent.hours_invalid", day: "mon", reason: "from_not_before_to" },
    );
    await expectError(svc.update(WS, { hours: { mode: "within", schedule: { funday: [] } }, version: 0 }), 422, {
      message: "agent.hours_invalid",
      day: "funday",
      reason: "unknown_day",
    });
    // An empty schedule for within/outside → 422 hours_empty (also with none stored).
    await expectError(svc.update(WS, { hours: { mode: "outside", schedule: {} }, version: 0 }), 422, { message: "agent.hours_empty" });
    await expectError(svc.update(WS, { hours: { mode: "within" }, version: 0 }), 422, { message: "agent.hours_empty" });
    // Unknown tag (including another workspace's) → 400.
    await expectError(svc.update(WS, { audience: { excludedTagIds: ["tag-vip", "nope"] }, version: 0 }), 400, { message: "agent.tag_unknown" });
    await expectError(svc.update(WS, { audience: { excludedTagIds: ["tag-foreign"] }, version: 0 }), 400, { message: "agent.tag_unknown" });
    // Nothing above was written.
    expect((await svc.get(WS)).version).toBe(0);

    // A valid save bumps the version; a stale version → 409 {current}.
    const saved = await svc.update(WS, {
      identity: { nameEn: " Salma ", tone: ["professional", "friendly", "friendly"] },
      hours: { mode: "within", schedule: SCHEDULE },
      audience: { excludedTagIds: ["tag-vip", "tag-vip"] },
      version: 0,
    });
    expect(saved).toMatchObject({
      nameEn: "Salma",
      tone: ["friendly", "professional"],
      hoursMode: "within",
      schedule: SCHEDULE,
      excludedTags: [{ id: "tag-vip", name: "VIP" }],
      version: 1,
    });
    await expectError(svc.update(WS, { identity: { nameEn: "X" }, version: 0 }), 409, { message: "agent.version_conflict", current: 1 });

    // `always` keeps the stored schedule; `within` then works without resending it.
    const always = await svc.update(WS, { hours: { mode: "always" }, version: 1 });
    expect(always).toMatchObject({ hoursMode: "always", schedule: SCHEDULE, version: 2 });
    const back = await svc.update(WS, { hours: { mode: "outside" }, version: 2 });
    expect(back).toMatchObject({ hoursMode: "outside", schedule: SCHEDULE });
    // Clearing the audience is allowed.
    expect((await svc.update(WS, { audience: { excludedTagIds: [] }, version: 3 })).excludedTags).toEqual([]);
  });

  it("a deleted excluded tag is dropped on the next read and reported once", async () => {
    const { svc, prisma } = world({ linked: false });
    await svc.update(WS, { audience: { excludedTagIds: ["tag-vip", "tag-new"] }, version: 0 });
    prisma.db.tag = prisma.db.tag.filter((t: { id: string }) => t.id !== "tag-new");
    const read = await svc.get(WS);
    expect(read.excludedTags).toEqual([{ id: "tag-vip", name: "VIP" }]);
    expect(read.droppedTagIds).toEqual(["tag-new"]);
    expect(read.version).toBe(1); // a cleanup, not an owner's edit
    expect((await svc.get(WS)).droppedTagIds).toEqual([]);
    // A renamed tag shows its current name.
    prisma.db.tag.find((t: { id: string }) => t.id === "tag-vip").name = "Gold";
    expect((await svc.get(WS)).excludedTags).toEqual([{ id: "tag-vip", name: "Gold" }]);
  });

  it("persona block published after save and never fails the save", async () => {
    const { svc, l, prisma } = world({ prompt: "You are support." });
    const saved = await svc.update(WS, { identity: { nameEn: "Salma", nameAr: "سلمى", tone: ["friendly"] }, version: 0 });
    // The save returns before publishing (it runs in the background).
    expect(saved.publishState).toBe("pending");
    expect(saved.linked).toBe(true);
    await svc.whenPublished(WS);
    expect((await svc.get(WS)).publishState).toBe("published");
    // One prompt PUT carrying the block (and the missing CRM sections, once).
    expect(l.state.puts).toBe(1);
    expect(l.state.content).toContain("<!-- kewy-crm-persona:begin -->");
    expect(l.state.content).toContain('Your name is "Salma"');
    expect(l.state.content).toContain("<!-- kewy-crm-tools -->");

    // A save that does not change the persona writes nothing more.
    await svc.update(WS, { hours: { mode: "always" }, version: 1 });
    await svc.whenPublished(WS);
    expect(l.state.puts).toBe(1);

    // l failing: the save still commits, publishState says "failed".
    l.state.fail = true;
    const failed = await svc.update(WS, { identity: { nameEn: "Noor" }, version: 2 });
    expect(failed).toMatchObject({ nameEn: "Noor", version: 3, publishState: "pending" });
    await svc.whenPublished(WS);
    expect((await svc.get(WS)).publishState).toBe("failed");
    expect(prisma.db.agentSettings[0].nameEn).toBe("Noor");

    // The next save retries and publishes.
    l.state.fail = false;
    await svc.update(WS, { identity: { greeting: "Hello" }, version: 3 });
    await svc.whenPublished(WS);
    expect((await svc.get(WS)).publishState).toBe("published");
    expect(l.state.content).toContain('Your name is "Noor"');
    expect(l.state.content.split("<!-- kewy-crm-persona:begin -->")).toHaveLength(2);
  });

  it("a slow agent platform never holds up the save, and a stale run never overwrites a newer save's state", async () => {
    const { svc, l } = world({ prompt: "You are support." });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inner = l.client.request.getMockImplementation()!;
    l.client.request.mockImplementation(async (path: string, o?: { method?: string; body?: { content: string } }) => {
      await gate;
      return inner(path, o);
    });
    const first = await svc.update(WS, { identity: { nameEn: "Salma" }, version: 0 });
    expect(first.publishState).toBe("pending"); // returned while l is still blocked
    const second = await svc.update(WS, { identity: { nameEn: "Noor" }, version: 1 });
    expect(second).toMatchObject({ nameEn: "Noor", publishState: "pending", version: 2 });
    release();
    await svc.whenPublished(WS);
    // The first run (version 1) could not mark the row published under version 2; the second run did.
    expect((await svc.get(WS)).publishState).toBe("published");
    expect(l.state.content).toContain('Your name is "Noor"');
    expect(l.state.content).not.toContain('Your name is "Salma"');
  });

  it("an unlinked workspace saves without publishing (publishState none)", async () => {
    const { svc, l } = world({ linked: false });
    const saved = await svc.update(WS, { identity: { nameEn: "Salma" }, version: 0 });
    expect(saved.publishState).toBe("none");
    expect(l.client.request).not.toHaveBeenCalled();
    expect(await svc.resync(WS)).toEqual({ mcpServer: "not_linked", prompt: "not_linked", persona: "not_linked" });
  });

  it("resync appends missing CRM sections once and publishes the persona", async () => {
    const { svc, l } = world({ prompt: "Custom intro." });
    await svc.update(WS, { identity: { nameEn: "Salma" }, version: 0 });
    await svc.whenPublished(WS);
    l.state.content = "Custom intro."; // the agent's prompt was reset upstream
    expect(await svc.resync(WS)).toEqual({ mcpServer: "already-present", prompt: "updated", persona: "updated" });
    expect(l.state.content.startsWith("Custom intro.")).toBe(true);
    for (const m of ["<!-- kewy-crm-tools -->", "<!-- kewy-crm-knowledge -->", "<!-- kewy-crm-persona:begin -->"]) {
      expect(l.state.content.split(m)).toHaveLength(2);
    }
    expect(await svc.resync(WS)).toEqual({ mcpServer: "already-present", prompt: "already-present", persona: "already-present" });
    // A resync failure is reported (the owner pressed the button) and recorded.
    l.state.fail = true;
    await expect(svc.resync(WS)).rejects.toMatchObject({ status: 502, response: { statusCode: 502, message: "agent.resync_failed" } });
    expect((await svc.get(WS)).publishState).toBe("failed");
  });

  it("shows who stopped the agent", async () => {
    const { svc, prisma } = world({ linked: false });
    await svc.get(WS);
    Object.assign(prisma.db.agentSettings[0], { stoppedAt: new Date("2026-11-16T10:00:00Z"), stoppedReason: "Holiday", stoppedById: "u1" });
    expect((await svc.get(WS)).stopped).toEqual({ at: "2026-11-16T10:00:00.000Z", reason: "Holiday", by: { id: "u1", name: "Owner Olga" } });
  });
});
