import { makeFakePrisma } from "../channels/test-prisma";
import { AgentReplyGate, agentReplyDecision, contactTagNames, invalidateAgentGate, type GateInput } from "./agent-reply-gate";

const SUN_THU_9_17 = {
  sun: [{ from: "09:00", to: "17:00" }],
  mon: [{ from: "09:00", to: "17:00" }],
  tue: [{ from: "09:00", to: "17:00" }],
  wed: [{ from: "09:00", to: "17:00" }],
  thu: [{ from: "09:00", to: "17:00" }],
};
const SUN_1000_RIYADH = new Date("2026-11-22T07:00:00Z"); // inside
const SUN_1800_RIYADH = new Date("2026-11-22T15:00:00Z"); // outside

const base = (over: Partial<GateInput> = {}): GateInput => ({
  stoppedAt: null,
  conversation: { aiEnabled: true, aiPausedAt: null },
  excluded: false,
  hoursMode: "always",
  schedule: SUN_THU_9_17,
  now: SUN_1000_RIYADH,
  tz: "Asia/Riyadh",
  ...over,
});

describe("agentReplyDecision", () => {
  it("kill-switch still overrides hours mode", () => {
    const stopped = new Date("2026-11-20T00:00:00Z");
    // within, inside the schedule, AI on, nothing excluded → still stopped.
    expect(agentReplyDecision(base({ stoppedAt: stopped, hoursMode: "within", now: SUN_1000_RIYADH }))).toEqual({ reply: false, reason: "stopped" });
    // outside, outside the schedule → still stopped.
    expect(agentReplyDecision(base({ stoppedAt: stopped, hoursMode: "outside", now: SUN_1800_RIYADH }))).toEqual({ reply: false, reason: "stopped" });
    // Clearing the stop → ok in both.
    expect(agentReplyDecision(base({ hoursMode: "within", now: SUN_1000_RIYADH }))).toEqual({ reply: true, reason: "ok" });
    expect(agentReplyDecision(base({ hoursMode: "outside", now: SUN_1800_RIYADH }))).toEqual({ reply: true, reason: "ok" });

    // The order is pinned: stopped beats conversation_off, paused, excluded and hours.
    const everythingNo = base({
      stoppedAt: stopped,
      conversation: { aiEnabled: false, aiPausedAt: new Date() },
      excluded: true,
      hoursMode: "within",
      now: SUN_1800_RIYADH,
    });
    expect(agentReplyDecision(everythingNo).reason).toBe("stopped");
    expect(agentReplyDecision({ ...everythingNo, stoppedAt: null }).reason).toBe("conversation_off");
    expect(agentReplyDecision({ ...everythingNo, stoppedAt: null, conversation: { aiEnabled: true, aiPausedAt: new Date() } }).reason).toBe("paused");
    expect(
      agentReplyDecision({ ...everythingNo, stoppedAt: null, conversation: { aiEnabled: true, aiPausedAt: null } }).reason,
    ).toBe("excluded");
    expect(
      agentReplyDecision({ ...everythingNo, stoppedAt: null, conversation: { aiEnabled: true, aiPausedAt: null }, excluded: false }).reason,
    ).toBe("outside_hours");
    // `outside` mode inside the schedule says why.
    expect(agentReplyDecision(base({ hoursMode: "outside", now: SUN_1000_RIYADH }))).toEqual({ reply: false, reason: "within_hours" });
  });

  it("with no conversation (the sandbox preview) the conversation step is skipped", () => {
    expect(agentReplyDecision(base({ conversation: null }))).toEqual({ reply: true, reason: "ok" });
    expect(agentReplyDecision(base({ conversation: null, excluded: true })).reason).toBe("excluded");
  });

  it("reads contact tags from the JSON string column and never throws", () => {
    expect(contactTagNames('["VIP","lead"]')).toEqual(["VIP", "lead"]);
    expect(contactTagNames("not json")).toEqual([]);
    expect(contactTagNames('{"a":1}')).toEqual([]);
    expect(contactTagNames(["x", 3])).toEqual(["x"]);
    expect(contactTagNames(null)).toEqual([]);
  });
});

const WS = "ws1";
function world(settings: Record<string, unknown> | null, contactTags: string[] = ["VIP"]) {
  const prisma = makeFakePrisma({
    workspace: [{ id: WS, name: "Salon", slug: "salon", timezone: "Asia/Riyadh" }],
    tag: [
      { id: "tag-vip", workspaceId: WS, name: "VIP", color: "red" },
      { id: "tag-other", workspaceId: "ws2", name: "VIP", color: "red" },
    ],
    contact: [{ id: "c1", workspaceId: WS, name: "Sara", tags: JSON.stringify(contactTags) }],
    conversation: [{ id: "cv1", workspaceId: WS, contactId: "c1", channel: "whatsapp", aiEnabled: true, aiPausedAt: null }],
    agentSettings: settings ? [{ id: "as1", workspaceId: WS, tone: [], hoursMode: "always", schedule: null, excludedTagIds: [], stoppedAt: null, version: 0, ...settings }] : [],
  });
  return { prisma, gate: new AgentReplyGate(prisma as never) };
}
const CTX = { conversationId: "cv1", contactId: "c1", now: SUN_1000_RIYADH };

describe("AgentReplyGate", () => {
  beforeEach(() => invalidateAgentGate());

  it("no settings row keeps today's behaviour: always on, nothing excluded, not stopped", async () => {
    const { gate } = world(null);
    expect(await gate.decide(WS, CTX)).toEqual({ reply: true, reason: "ok" });
  });

  it("excluded tag blocks auto-reply but not human send", async () => {
    // A contact tagged VIP, the VIP catalog id excluded → excluded.
    const { prisma, gate } = world({ excludedTagIds: ["tag-vip"] });
    expect(await gate.decide(WS, CTX)).toEqual({ reply: false, reason: "excluded" });

    // A renamed tag still excludes (id-based): the catalog and the contact are renamed together.
    prisma.db.tag.find((t: { id: string }) => t.id === "tag-vip").name = "Gold";
    prisma.db.contact[0].tags = JSON.stringify(["Gold"]);
    invalidateAgentGate(WS);
    expect(await gate.decide(WS, CTX)).toEqual({ reply: false, reason: "excluded" });

    // A deleted tag stops excluding.
    prisma.db.tag = prisma.db.tag.filter((t: { id: string }) => t.id !== "tag-vip");
    invalidateAgentGate(WS);
    expect(await gate.decide(WS, CTX)).toEqual({ reply: true, reason: "ok" });
  });

  it("another workspace's tag of the same name never excludes", async () => {
    const { gate } = world({ excludedTagIds: ["tag-other"] });
    expect(await gate.decide(WS, CTX)).toEqual({ reply: true, reason: "ok" });
  });

  it("the stop on the row overrides hours mode; clearing it replies", async () => {
    const { prisma, gate } = world({ stoppedAt: new Date(), hoursMode: "within", schedule: SUN_THU_9_17 });
    expect(await gate.decide(WS, CTX)).toEqual({ reply: false, reason: "stopped" });
    prisma.db.agentSettings[0].stoppedAt = null;
    invalidateAgentGate(WS);
    expect(await gate.decide(WS, CTX)).toEqual({ reply: true, reason: "ok" });
    expect(await gate.decide(WS, { ...CTX, now: SUN_1800_RIYADH })).toEqual({ reply: false, reason: "outside_hours" });
  });

  it("uses the workspace timezone", async () => {
    const { prisma, gate } = world({ hoursMode: "within", schedule: SUN_THU_9_17 });
    expect((await gate.decide(WS, CTX)).reply).toBe(true); // Riyadh Sun 10:00
    prisma.db.workspace[0].timezone = "America/New_York";
    invalidateAgentGate(WS);
    expect(await gate.decide(WS, CTX)).toEqual({ reply: false, reason: "outside_hours" }); // NY Sun 02:00
  });

  it("caches hours, tags and timezone for 30 s per workspace; the stop is read on every decision", async () => {
    const { prisma, gate } = world({});
    const reads = () =>
      (prisma.agentSettings.findUnique.mock.calls as [{ select: Record<string, boolean> }][]).map(([a]) => Object.keys(a.select).sort().join(","));
    await gate.decide(WS, CTX);
    await gate.decide(WS, CTX);
    expect(reads()).toEqual(["stoppedAt", "excludedTagIds,hoursMode,schedule", "stoppedAt"]);
    expect(prisma.workspace.findUnique).toHaveBeenCalledTimes(1);
    invalidateAgentGate(WS);
    await gate.decide(WS, CTX);
    expect(reads()).toEqual(["stoppedAt", "excludedTagIds,hoursMode,schedule", "stoppedAt", "stoppedAt", "excludedTagIds,hoursMode,schedule"]);
  });

  it("a cached settings entry does not mask a stop written by another process", async () => {
    const { prisma, gate } = world({ hoursMode: "always" });
    expect(await gate.decide(WS, CTX)).toEqual({ reply: true, reason: "ok" }); // settings now cached
    // Another instance writes the stop: nothing clears this process's cache.
    prisma.db.agentSettings[0].stoppedAt = new Date();
    expect(await gate.decide(WS, CTX)).toEqual({ reply: false, reason: "stopped" });
    // And clearing it elsewhere applies at once too.
    prisma.db.agentSettings[0].stoppedAt = null;
    expect(await gate.decide(WS, CTX)).toEqual({ reply: true, reason: "ok" });
  });

  it("a failing stop read fails closed even with settings cached", async () => {
    const { prisma, gate } = world({});
    await gate.decide(WS, CTX);
    prisma.agentSettings.findUnique.mockImplementation(() => Promise.reject(new Error("db down")));
    jest.spyOn((gate as unknown as { log: { warn: () => void } }).log, "warn").mockImplementation(() => undefined);
    expect(await gate.allows(WS, { conversationId: "cv1", contactId: "c1" }, "zernio_bridge")).toBe(false);
  });

  it("a conversation of another workspace is never answered", async () => {
    const { prisma, gate } = world({});
    prisma.db.conversation[0].workspaceId = "ws2";
    expect(await gate.decide(WS, CTX)).toEqual({ reply: false, reason: "conversation_off" });
  });

  it("gate error sends no reply: allows() fails closed with one warn", async () => {
    const { prisma, gate } = world({});
    prisma.agentSettings.findUnique.mockImplementation(() => Promise.reject(new Error("db down")));
    const warn = jest.spyOn((gate as unknown as { log: { warn: (m: string) => void } }).log, "warn").mockImplementation(() => undefined);
    expect(await gate.allows(WS, { conversationId: "cv1", contactId: "c1" }, "l_auto_reply")).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("no reply sent");
  });
});
