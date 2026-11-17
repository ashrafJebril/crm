/* eslint-disable @typescript-eslint/no-explicit-any */
import { HttpException } from "@nestjs/common";
import Anthropic from "@anthropic-ai/sdk";
import { FALLBACK_BETA } from "../../ai/claude.service";
import { SANDBOX_MAX_TURNS, SANDBOX_MESSAGE_MAX, SANDBOX_RATE } from "../agent-constants";
import { PREVIEW_NOTICE } from "./sandbox-prompt";
import { PREVIEW_REFUSAL_REPLY } from "./sandbox-text";
import { SIMULATED_NOTE } from "./sandbox-tools";
import { counts, MEMBER, sandboxWorld, toolUse, withKey, WS } from "./sandbox-test-world";
import { keepLastTurns, sourcesFrom } from "./sandbox.service";

async function expectKey(p: Promise<unknown>, status: number, key: string, extra: Record<string, unknown> = {}) {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(HttpException);
  expect((e as HttpException).getStatus()).toBe(status);
  expect((e as HttpException).getResponse()).toMatchObject({ message: key, ...extra });
}

const ALL_TOOLS_TURN = {
  stop_reason: "tool_use",
  content: [
    { type: "text", text: "Let me check." },
    toolUse("t1", "search_contacts", { query: "Sara" }),
    toolUse("t2", "create_contact", { name: "New Person", phone: "+966500000777", industry: "retail", lifecycle: "lead", source: "chat" }),
    toolUse("t3", "create_appointment", {
      contactId: "c1",
      service: "Cut",
      startAt: "2026-11-22T10:00:00+03:00",
      durationMin: 30,
      status: "pending",
      source: "self-booking",
    }),
    toolUse("t4", "update_contact", { id: "c1", name: "Sara B" }),
    toolUse("t5", "find_slots", { serviceId: "s1", date: "2026-11-22" }),
    toolUse("t6", "list_photos", { query: "menu" }),
    toolUse("t7", "search_knowledge", { query: "opening hours" }),
  ],
};

describe("SandboxService", () => {
  afterEach(() => jest.restoreAllMocks());

  it("sandbox creates no contacts/conversations/tickets", async () => {
    const w = sandboxWorld({ replies: [ALL_TOOLS_TURN, { content: [{ type: "text", text: "Booked for you! (Not saved: preview)" }] }] });
    const before = counts(w.prisma);
    const out = await withKey(() => w.sandbox.send(WS, MEMBER, "Book me a haircut tomorrow at 10, I'm Sara"));
    const after = counts(w.prisma);

    // Only AgentSandboxThread changed.
    const changed = Object.keys({ ...before, ...after }).filter((k) => (before[k] ?? 0) !== (after[k] ?? 0));
    expect(changed).toEqual(["agentSandboxThread"]);
    for (const t of ["contact", "conversation", "message", "ticket", "appointment", "activity", "notification", "media"]) {
      expect({ t, n: after[t] }).toEqual({ t, n: before[t] });
    }
    expect(w.prisma.db.contact.find((c: any) => c.id === "c1").name).toBe("Sara"); // update_contact did nothing
    // No write service was ever called; the reads were.
    for (const fn of [w.contacts.create, w.contacts.update, w.appointments.create, w.appointments.update]) expect(fn).not.toHaveBeenCalled();
    expect(w.contacts.search).toHaveBeenCalledWith(WS, "Sara");
    expect(w.bookings.availability).toHaveBeenCalledWith(WS, expect.objectContaining({ serviceId: "s1" }));
    expect(w.media.listForAgent).toHaveBeenCalled();
    expect(w.knowledge.search).toHaveBeenCalled();

    // The reply marks writes simulated and reads real.
    expect(out.toolCalls.map((c) => [c.name, c.simulated])).toEqual([
      ["search_contacts", false],
      ["create_contact", true],
      ["create_appointment", true],
      ["update_contact", true],
      ["find_slots", false],
      ["list_photos", false],
      ["search_knowledge", false],
    ]);
    expect(out.toolCalls.every((c) => !c.error)).toBe(true);
    expect(out.toolCalls[1].args).toEqual({ name: "New Person", phone: "+966500000777", industry: "retail", lifecycle: "lead", source: "chat" });
    expect(out.reply).toBe("Booked for you! (Not saved: preview)");
    expect(out.turnCount).toBe(1);

    // Parallel tool results went back in ONE user message; simulated ones carry the mock.
    const second = w.ai.calls[1];
    const results = second.messages[second.messages.length - 1];
    expect(results.role).toBe("user");
    expect(results.content).toHaveLength(7);
    const mock = JSON.parse(results.content.find((r: any) => r.tool_use_id === "t2").content);
    expect(mock).toEqual({ simulated: true, ok: true, tool: "create_contact", note: SIMULATED_NOTE, args: { name: "New Person", phone: "+966500000777", industry: "retail", lifecycle: "lead", source: "chat" } });

    // No outside party was touched: no realtime, no workflow event, no l / Zernio / kewy-ai call.
    for (const fn of [w.realtime.emitToWorkspace, w.events.emit, w.lClient.request, w.zernioClient.sendMessage, w.zernioClient.sendTemplateMessage, w.kewyBridge.notifyInbound]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it("unknown tool is simulated", async () => {
    // A tool added to the factory later, not on SANDBOX_READ_TOOLS: mocked, its service never runs.
    const w = sandboxWorld({ replies: [{ stop_reason: "tool_use", content: [toolUse("t1", "delete_everything", {})] }, { content: [{ type: "text", text: "ok" }] }] });
    const danger = jest.fn();
    const build = w.factory.build.bind(w.factory);
    jest.spyOn(w.factory, "build").mockImplementation((ws: string, opts?: any) => {
      // The live build of a future factory: the new tool is just another tool.
      const live = build(ws) as any;
      live.delete_everything = { id: "delete_everything", description: "Deletes everything (says it is read-only)", inputSchema: undefined, execute: danger };
      return opts?.mode === "sandbox" ? (require("./sandbox-tools").sandboxTools(live) as any) : live;
    });
    const out = await withKey(() => w.sandbox.send(WS, MEMBER, "Clean up"));
    expect(danger).not.toHaveBeenCalled();
    expect(out.toolCalls).toEqual([{ name: "delete_everything", simulated: true, args: {} }]);
    // And the tool was offered with a strict, empty schema.
    expect(w.ai.calls[0].tools.find((t: any) => t.name === "delete_everything")).toMatchObject({ strict: true, input_schema: { type: "object", additionalProperties: false } });
  });

  it("sandbox never calls a channel or the agent platform", async () => {
    // Linked workspace: the live prompt is read with GETs only, once per minute.
    const w = sandboxWorld({ linked: true, replies: [ALL_TOOLS_TURN, { content: [{ type: "text", text: "done" }] }] });
    await withKey(() => w.sandbox.send(WS, MEMBER, "hi"));
    await withKey(() => w.sandbox.send(WS, MEMBER, "again"));
    const calls = w.lClient.request.mock.calls as [string, { method?: string }?][];
    expect(calls.map(([p]) => p)).toEqual(["/workspaces/l-ws/agents", "/workspaces/l-ws/agents/support/prompts"]); // cached for the second turn
    expect(calls.every(([, o]) => !o?.method || o.method === "GET")).toBe(true);
    // The live prompt is the base of the system prompt, then the persona, guidelines and the preview notice.
    const system = w.ai.calls[0].system[0].text as string;
    expect(system.startsWith("LIVE PROMPT")).toBe(true);
    expect(system).toContain("<!-- kewy-crm-persona:begin -->");
    expect(system).toContain("Always greet warmly.");
    expect(system.endsWith(PREVIEW_NOTICE)).toBe(true);
    for (const fn of [w.zernioClient.sendMessage, w.kewyBridge.notifyInbound, w.realtime.emitToWorkspace, w.events.emit]) expect(fn).not.toHaveBeenCalled();
    expect(w.prisma.db.message).toHaveLength(1);
  });

  it("sandbox sources come from search_knowledge results", async () => {
    const w = sandboxWorld({
      replies: [{ stop_reason: "tool_use", content: [toolUse("t1", "search_knowledge", { query: "hours" }), toolUse("t2", "search_knowledge", { query: "parking" })] }, { content: [{ type: "text", text: "We open at 9." }] }],
    });
    const out = await withKey(() => w.sandbox.send(WS, MEMBER, "When do you open?"));
    // All of them (the "3 then +N" rule is the frontend's), deduped by source, http(s) URLs only.
    expect(out.sources).toEqual([
      { sourceId: "src-web", title: "salon.example", url: "https://salon.example/hours" },
      { sourceId: "src-faq", title: "Do you take cards?" },
      { sourceId: "src-bad", title: "Bad link" },
    ]);
    const into = new Map();
    sourcesFrom({ results: [{ sourceId: "x", sourceTitle: "X", url: "data:text/html,hi" }] }, into);
    expect([...into.values()]).toEqual([{ sourceId: "x", title: "X" }]);
  });

  it("sandbox request shape", async () => {
    const prev = process.env.AGENT_SANDBOX_MODEL;
    delete process.env.AGENT_SANDBOX_MODEL;
    try {
      const w = sandboxWorld({ replies: [ALL_TOOLS_TURN, { content: [{ type: "text", text: "ok" }] }] });
      await withKey(() => w.sandbox.send(WS, MEMBER, "hi"));
      const p = w.ai.calls[0];
      expect(p.model).toBe("claude-opus-5-5");
      expect(p.max_tokens).toBe(16000);
      expect(p.output_config).toEqual({ effort: "medium" });
      expect(p).not.toHaveProperty("temperature");
      expect(p).not.toHaveProperty("thinking"); // adaptive by default; `disabled` is a 400 on this model
      expect(p.tool_choice).toEqual({ type: "auto" });
      expect(p.betas).toEqual([FALLBACK_BETA]);
      expect(p.fallbacks).toBe("default");
      // Stable prefix with cache breakpoints: the system block and the last tool.
      expect(p.system).toEqual([{ type: "text", text: expect.any(String), cache_control: { type: "ephemeral" } }]);
      expect(p.tools[p.tools.length - 1].cache_control).toEqual({ type: "ephemeral" });
      expect(p.tools.map((t: any) => t.name)).toEqual([...p.tools.map((t: any) => t.name)].sort());
      // Strict schemas with additionalProperties: false at every object level, no unsupported constraints.
      const walk = (s: any, path: string) => {
        if (s && typeof s === "object") {
          if (s.type === "object") expect({ path, ap: s.additionalProperties }).toEqual({ path, ap: false });
          for (const bad of ["minimum", "maximum", "minLength", "maxLength", "default"]) expect({ path, bad, has: bad in s }).toEqual({ path, bad, has: false });
          for (const [k, v] of Object.entries(s)) if (k !== "enum") walk(v, `${path}.${k}`);
        }
      };
      for (const t of p.tools) {
        expect(t.strict).toBe(true);
        walk(t.input_schema, t.name);
      }
      // The per-turn note is a mid-conversation system message right after the owner's message.
      expect(p.messages.slice(-2).map((m: any) => m.role)).toEqual(["user", "system"]);
      expect(p.messages[p.messages.length - 1].content).toMatch(/It is now .* \(Asia\/Riyadh\)\. With the current settings, the live agent would answer/);
      // The second call replays the first call's content unchanged (append-only), then the tool results.
      const q = w.ai.calls[1];
      expect(q.system).toEqual(p.system);
      expect(q.tools).toEqual(p.tools);
      expect(q.messages.slice(0, p.messages.length)).toEqual(p.messages);
      expect(q.messages[p.messages.length]).toEqual({ role: "assistant", content: ALL_TOOLS_TURN.content });

      // The next turn appends to the stored transcript (byte-identical prefix).
      await withKey(() => w.sandbox.send(WS, MEMBER, "and tomorrow?"));
      const r = w.ai.calls[2];
      expect(r.messages.slice(0, q.messages.length + 1)).toEqual([...q.messages, { role: "assistant", content: [{ type: "text", text: "ok" }] }]);
    } finally {
      if (prev !== undefined) process.env.AGENT_SANDBOX_MODEL = prev;
    }
  });

  it("refusal and max_tokens handled", async () => {
    const refused = sandboxWorld({ replies: [{ stop_reason: "refusal", content: [{ type: "text", text: "partial" }] }] });
    const out = await withKey(() => refused.sandbox.send(WS, MEMBER, "something"));
    expect(out.reply).toBe(PREVIEW_REFUSAL_REPLY);

    const cut = sandboxWorld({ replies: [{ stop_reason: "max_tokens", content: [{ type: "text", text: "half an ans" }] }] });
    await expectKey(withKey(() => cut.sandbox.send(WS, MEMBER, "long")), 502, "agent.ai_failed");
    // A failed turn stores nothing.
    expect(cut.prisma.db.agentSandboxThread).toHaveLength(0);

    // An endless tool loop stops at SANDBOX_MAX_ITERATIONS calls: ai_failed.
    const loop = sandboxWorld({ replies: [{ stop_reason: "tool_use", content: [toolUse("t", "list_services", {})] }] });
    await expectKey(withKey(() => loop.sandbox.send(WS, MEMBER, "loop")), 502, "agent.ai_failed");
    expect(loop.ai.calls).toHaveLength(6);

    // Typed SDK errors: auth → 503 ai_unavailable; others → 502 ai_failed. No key → 503 before any call.
    const auth = sandboxWorld({ replies: [() => { throw new Anthropic.AuthenticationError(401, {}, "bad key", new Headers()); }] });
    jest.spyOn((auth.ai.claude as any).log, "warn").mockImplementation(() => undefined);
    await expectKey(withKey(() => auth.sandbox.send(WS, MEMBER, "x")), 503, "agent.ai_unavailable");
    const nokey = sandboxWorld();
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await expectKey(nokey.sandbox.send(WS, MEMBER, "x"), 503, "agent.ai_unavailable");
    } finally {
      if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
    }
    expect(nokey.ai.calls).toHaveLength(0);
  });

  it("tool input failing its schema returns is_error", async () => {
    const w = sandboxWorld({
      replies: [
        {
          stop_reason: "tool_use",
          content: [
            toolUse("t1", "find_slots", { serviceId: "s1", date: "tomorrow" }),
            toolUse("t2", "list_appointments", { limit: 5000 }),
            toolUse("t3", "no_such_tool", {}),
            toolUse("t4", "get_contact", { id: "c-foreign" }),
          ],
        },
        { content: [{ type: "text", text: "sorry" }] },
      ],
    });
    const out = await withKey(() => w.sandbox.send(WS, MEMBER, "x"));
    const results = w.ai.calls[1].messages[w.ai.calls[1].messages.length - 1].content;
    expect(results.map((r: any) => [r.tool_use_id, r.is_error === true])).toEqual([
      ["t1", true],
      ["t2", true],
      ["t3", true],
      ["t4", true], // another workspace's contact: not found
    ]);
    expect(results[0].content).toMatch(/^Invalid input\. date: /);
    expect(results[2].content).toBe("Unknown tool: no_such_tool");
    expect(w.bookings.availability).not.toHaveBeenCalled();
    expect(w.appointments.list).not.toHaveBeenCalled();
    expect(w.contacts.get).toHaveBeenCalledWith(WS, "c-foreign");
    expect(out.toolCalls.every((c) => c.error)).toBe(true);
  });

  it("sandbox rate, size and turn caps", async () => {
    const w = sandboxWorld();
    await expectKey(withKey(() => w.sandbox.send(WS, MEMBER, "x".repeat(SANDBOX_MESSAGE_MAX + 1))), 400, "agent.message_invalid");
    await expectKey(withKey(() => w.sandbox.send(WS, MEMBER, "   ")), 400, "agent.message_invalid");
    await withKey(() => w.sandbox.send(WS, MEMBER, "x".repeat(SANDBOX_MESSAGE_MAX)));

    for (let i = 1; i < SANDBOX_RATE.turns; i++) await withKey(() => w.sandbox.send(WS, MEMBER, `turn ${i}`));
    const e = await withKey(() => w.sandbox.send(WS, MEMBER, "one too many")).catch((err) => err);
    expect((e as HttpException).getStatus()).toBe(429);
    expect((e as HttpException).getResponse()).toMatchObject({ message: "agent.sandbox_rate", retryAfterSeconds: expect.any(Number) });
    expect(((e as HttpException).getResponse() as any).retryAfterSeconds).toBeGreaterThan(0);
    // Another member has their own budget.
    await withKey(() => w.sandbox.send(WS, "u2", "hello"));

    // 41st turn: the oldest turn is dropped from the thread.
    const turns = Array.from({ length: SANDBOX_MAX_TURNS }, (_, i) => [
      { role: "owner" as const, text: `q${i}`, at: "" },
      { role: "agent" as const, text: `a${i}`, at: "" },
    ]).flat();
    const kept = keepLastTurns([...turns, { role: "owner", text: "q40", at: "" }, { role: "agent", text: "a40", at: "" }], SANDBOX_MAX_TURNS);
    expect(kept.filter((t) => t.role === "owner")).toHaveLength(SANDBOX_MAX_TURNS);
    expect(kept[0].text).toBe("q1");
    expect(kept[kept.length - 1].text).toBe("a40");
  });

  it("a full thread starts a fresh model transcript with a recap; the display keeps 40 turns", async () => {
    const w = sandboxWorld();
    const display = Array.from({ length: SANDBOX_MAX_TURNS }, (_, i) => [
      { role: "owner", text: `q${i}`, at: "2026-11-16T00:00:00.000Z" },
      { role: "agent", text: `a${i}`, at: "2026-11-16T00:00:00.000Z" },
    ]).flat();
    w.prisma.db.agentSandboxThread.push({
      id: "th1",
      workspaceId: WS,
      userId: MEMBER,
      messages: display,
      transcript: { key: "whatever", turns: SANDBOX_MAX_TURNS, messages: [{ role: "user", content: "old" }] },
      expiresAt: new Date(Date.now() + 60_000),
    });
    const out = await withKey(() => w.sandbox.send(WS, MEMBER, "q40"));
    expect(out.turnCount).toBe(SANDBOX_MAX_TURNS);
    const msgs = w.prisma.db.agentSandboxThread[0].messages;
    expect(msgs[0].text).toBe("q1");
    // No earlier turn (or thinking) replayed: one user message carrying a recap, then the note.
    const p = w.ai.calls[0];
    expect(p.messages.map((m: any) => m.role)).toEqual(["user", "system"]);
    expect(p.messages[0].content[0].text).toMatch(/^Earlier in this preview chat/);
    expect(p.messages[0].content[1].text).toBe("q40");
  });

  it("the thread is the member's own; reset deletes it; an expired thread reads empty", async () => {
    const w = sandboxWorld();
    await withKey(() => w.sandbox.send(WS, MEMBER, "hi"));
    expect((await w.sandbox.get(WS, MEMBER)).turnCount).toBe(1);
    expect(await w.sandbox.get(WS, "u2")).toEqual({ messages: [], turnCount: 0, expiresAt: null });
    expect(await w.sandbox.get("ws2", MEMBER)).toEqual({ messages: [], turnCount: 0, expiresAt: null });
    expect(await w.sandbox.get(WS, MEMBER, new Date(Date.now() + 25 * 60 * 60 * 1000))).toEqual({ messages: [], turnCount: 0, expiresAt: null });
    await w.sandbox.reset(WS, MEMBER);
    expect(w.prisma.db.agentSandboxThread).toHaveLength(0);
  });

  it("the gate decision is shown, and the preview answers anyway", async () => {
    const w = sandboxWorld();
    w.prisma.db.agentSettings[0].stoppedAt = new Date();
    const out = await withKey(() => w.sandbox.send(WS, MEMBER, "hi"));
    expect(out.gate).toEqual({ wouldReply: false, reason: "stopped" });
    expect(out.reply).toBe("Hello!");
    expect(w.ai.calls[0].messages[w.ai.calls[0].messages.length - 1].content).toContain("would NOT answer a real customer now (the agent is stopped)");
  });
});
