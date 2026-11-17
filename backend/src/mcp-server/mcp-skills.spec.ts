import http from "node:http";
import type { AddressInfo } from "node:net";
import { MCPServer } from "@mastra/mcp";
import type { z } from "zod";
import { makeFakePrisma } from "../channels/test-prisma";
import { McpToolsFactory, OPEN_TICKETS_PER_CONTACT } from "./mcp-tools.factory";
import { AgentToolCallRecorder } from "../skills/agent-tool-call.recorder";
import { defaultEnabled, enabledFromStates, resolveSkillStates, type EnabledSkills } from "../skills/skill-state";

const WS = "ws1";
const BOOKING_TOOLS = ["list_appointments", "get_appointment", "create_appointment", "update_appointment", "cancel_appointment", "list_services", "find_slots"];

/** The enabled set for these rows (as SkillsService.enabledFor computes it). */
const enabledWith = (rows: Array<{ skillKey: string; status: string; config?: object }>): EnabledSkills =>
  enabledFromStates(resolveSkillStates(rows.map((r) => ({ installedVersion: 1, needsConfig: false, version: 0, config: {}, ...r }))));

function world() {
  const prisma: any = makeFakePrisma({
    contact: [
      { id: "c1", workspaceId: WS, name: "Ali", tags: "[]" },
      { id: "c2", workspaceId: WS, name: "Sara", tags: "[]" },
      { id: "cX", workspaceId: "ws2", name: "Other", tags: "[]" },
    ],
    pipeline: [
      { id: "pSup", workspaceId: WS, kind: "support", archivedAt: null, createdAt: new Date(1) },
      { id: "pDeals", workspaceId: WS, kind: "deals", archivedAt: null, createdAt: new Date(0) },
    ],
    ticketStage: [
      { id: "sOpen", workspaceId: WS, pipelineId: "pSup", label: "New", order: 0, isTerminal: false },
      { id: "sDone", workspaceId: WS, pipelineId: "pSup", label: "Resolved", order: 2, isTerminal: true },
    ],
    ticket: [],
    agentToolCall: [],
  } as never);
  let n = 0;
  const tickets = {
    createTicket: jest.fn(async (ws: string, dto: any) => {
      const row = { id: `t${++n}`, workspaceId: ws, number: n, pipelineId: dto.pipelineId, stageId: dto.stageId, contactId: dto.contactId, title: dto.title, priority: dto.priority ?? "normal", closedAt: null, createdAt: new Date(Date.now() + n), slaDueAt: null };
      prisma.db.ticket.push(row);
      return { ...row, stage: { label: "New" } };
    }),
  };
  const tags = { assign: jest.fn().mockResolvedValue({ changed: 1 }) };
  const appointments = { list: jest.fn(), get: jest.fn(), create: jest.fn().mockResolvedValue({ id: "a1" }), update: jest.fn() };
  const recorder = new AgentToolCallRecorder(prisma);
  const factory = new McpToolsFactory(appointments as never, {} as never, {} as never, {} as never, {} as never, tickets as never, tags as never, prisma, recorder);
  return { prisma, tickets, tags, appointments, factory };
}

const flush = () => new Promise((r) => setImmediate(r));

describe("MCP tools gated by skills (SP-22)", () => {
  describe("over the HTTP transport", () => {
    let server: http.Server;
    let baseUrl: string;
    const call = async (method: string, params: unknown) => {
      const res = await fetch(baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      return (await res.json()) as { result?: { tools?: { name: string }[]; isError?: boolean; content?: { text: string }[] }; error?: { message: string } };
    };
    afterEach(() => server?.close());

    it("disabled skill tools are not exposed over MCP", async () => {
      const w = world();
      // Mirrors McpServerController.handle(): a fresh server per request, enabled set from the ledger.
      const enabled = enabledWith([{ skillKey: "booking", status: "disabled" }]);
      server = http.createServer(async (req, res) => {
        const mcp = new MCPServer({ name: "tkana-crm", version: "1.0.0", tools: w.factory.build(WS, { enabled }) });
        await mcp.startHTTP({ url: new URL(req.url ?? "", "http://localhost"), httpPath: "/mcp", req, res, options: { serverless: true } });
      });
      await new Promise<void>((resolve) => server.listen(0, resolve));
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;

      const listed = (await call("tools/list", {})).result?.tools?.map((t) => t.name) ?? [];
      for (const t of BOOKING_TOOLS) expect({ t, listed: listed.includes(t) }).toEqual({ t, listed: false });
      expect(listed).toContain("search_contacts");
      expect(listed).toContain("search_knowledge");

      const res = await call("tools/call", {
        name: "create_appointment",
        arguments: { contactId: "c1", service: "Cut", serviceAr: "قص", startAt: "2026-11-22T10:00:00+03:00", durationMin: 30, status: "pending", source: "self-booking" },
      });
      expect(res.error ?? (res.result?.isError ? res.result : null)).toBeTruthy();
      expect(w.appointments.create).not.toHaveBeenCalled();
    });
  });

  it("uninstalled and needs_connector skills build no tools", () => {
    const w = world();
    expect(Object.keys(w.factory.build(WS, { enabled: defaultEnabled() }))).not.toContain("open_support_ticket");
    const tools = w.factory.build(WS, { enabled: enabledWith([{ skillKey: "support_tickets", status: "needs_connector" }, { skillKey: "lead_capture", status: "disabled" }]) });
    expect(Object.keys(tools)).not.toContain("open_support_ticket");
    expect(Object.keys(tools)).not.toContain("tag_contact");
    const on = w.factory.build(WS, { enabled: enabledWith([{ skillKey: "support_tickets", status: "enabled" }, { skillKey: "lead_capture", status: "needs_attention" }]) });
    expect(Object.keys(on)).toEqual(expect.arrayContaining(["open_support_ticket", "list_my_tickets", "tag_contact"]));
  });

  it("booking status follows skill config", async () => {
    const w = world();
    const input = { contactId: "c1", service: "Cut", serviceAr: "قص", startAt: "2026-11-22T10:00:00+03:00", durationMin: 30, status: "pending" as const, source: "self-booking" as const };
    const confirmed = w.factory.build(WS, { enabled: enabledWith([{ skillKey: "booking", status: "enabled", config: { newBookingStatus: "confirmed" } }]) });
    await confirmed.create_appointment.execute!(input as never, {} as never);
    expect(w.appointments.create).toHaveBeenLastCalledWith(WS, expect.objectContaining({ status: "confirmed" }));
    const pending = w.factory.build(WS); // defaults: pending
    await pending.create_appointment.execute!({ ...input, status: "confirmed" } as never, {} as never);
    expect(w.appointments.create).toHaveBeenLastCalledWith(WS, expect.objectContaining({ status: "pending" }));
  });

  it("agent cannot open an urgent ticket", async () => {
    const w = world();
    const tools = w.factory.build(WS, { enabled: enabledWith([{ skillKey: "support_tickets", status: "enabled", config: { defaultPriority: "high" } }]) });
    const schema = (tools.open_support_ticket as unknown as { inputSchema: z.ZodTypeAny }).inputSchema;
    expect(schema.safeParse({ contactId: "c1", title: "Broken", priority: "urgent" }).success).toBe(false);
    expect(schema.safeParse({ contactId: "c1", title: "Broken", priority: "low" }).success).toBe(true);
    const out = await tools.open_support_ticket.execute!({ contactId: "c1", title: "Broken", priority: "low" } as never, {} as never);
    expect(out).toEqual({ id: "t1", number: 1, stage: "New" });
    expect(w.tickets.createTicket).toHaveBeenCalledWith(WS, expect.objectContaining({ pipelineId: "pSup", stageId: "sOpen", contactId: "c1", priority: "high" }));
  });

  it("tag outside allowedTags is refused", async () => {
    const w = world();
    const tools = w.factory.build(WS, { enabled: enabledWith([{ skillKey: "lead_capture", status: "enabled", config: { allowedTags: ["VIP", "wholesale"] } }]) });
    await expect(tools.tag_contact.execute!({ contactId: "c1", tag: "spam" } as never, {} as never)).rejects.toThrow("skills.tag_not_allowed");
    expect(w.tags.assign).not.toHaveBeenCalled();
    expect(await tools.tag_contact.execute!({ contactId: "c1", tag: "vip" } as never, {} as never)).toEqual({ ok: true, contactId: "c1", tag: "VIP" });
    expect(w.tags.assign).toHaveBeenCalledWith(WS, { contactIds: ["c1"], add: ["VIP"] });
    // Another workspace's contact is not found.
    await expect(tools.tag_contact.execute!({ contactId: "cX", tag: "vip" } as never, {} as never)).rejects.toThrow("contacts.not_found");
  });

  it("open ticket limit per contact", async () => {
    const w = world();
    const tools = w.factory.build(WS, { enabled: enabledWith([{ skillKey: "support_tickets", status: "enabled" }]) });
    for (let i = 0; i < OPEN_TICKETS_PER_CONTACT; i++) {
      await tools.open_support_ticket.execute!({ contactId: "c1", title: `P${i}` } as never, {} as never);
    }
    await expect(tools.open_support_ticket.execute!({ contactId: "c1", title: "P4" } as never, {} as never)).rejects.toThrow("tickets.too_many_open");
    // Another contact is unaffected; a closed ticket frees a slot.
    await tools.open_support_ticket.execute!({ contactId: "c2", title: "Q" } as never, {} as never);
    w.prisma.db.ticket[0].closedAt = new Date();
    await expect(tools.open_support_ticket.execute!({ contactId: "c1", title: "P4" } as never, {} as never)).resolves.toMatchObject({ number: 5 });
    // No support pipeline → its own key.
    w.prisma.db.pipeline = w.prisma.db.pipeline.filter((p: any) => p.kind !== "support");
    await expect(tools.open_support_ticket.execute!({ contactId: "c2", title: "R" } as never, {} as never)).rejects.toThrow("tickets.no_support_pipeline");
  });

  it("list_my_tickets returns only that contact's tickets", async () => {
    const w = world();
    const tools = w.factory.build(WS, { enabled: enabledWith([{ skillKey: "support_tickets", status: "enabled" }]) });
    await tools.open_support_ticket.execute!({ contactId: "c1", title: "Mine" } as never, {} as never);
    await tools.open_support_ticket.execute!({ contactId: "c2", title: "Theirs" } as never, {} as never);
    w.prisma.db.ticket.push({ id: "tDeal", workspaceId: WS, number: 9, pipelineId: "pDeals", stageId: "x", contactId: "c1", title: "A deal", priority: "normal", closedAt: null, createdAt: new Date() });
    const out = (await tools.list_my_tickets.execute!({ contactId: "c1" } as never, {} as never)) as { tickets: Array<{ title: string }> };
    expect(out.tickets.map((t) => t.title)).toEqual(["Mine"]);
    expect(JSON.stringify(out)).not.toMatch(/Theirs|c2/);
    await expect(tools.list_my_tickets.execute!({ contactId: "cX" } as never, {} as never)).rejects.toThrow("contacts.not_found");
  });

  it("tool calls are recorded without arguments", async () => {
    const w = world();
    const tools = w.factory.build(WS, { enabled: enabledWith([{ skillKey: "lead_capture", status: "enabled", config: { allowedTags: ["vip"] } }]) });
    await tools.tag_contact.execute!({ contactId: "c1", tag: "vip" } as never, {} as never);
    await tools.tag_contact.execute!({ contactId: "c1", tag: "secret-tag-text" } as never, {} as never).catch(() => undefined);
    await flush();
    const rows = w.prisma.db.agentToolCall;
    expect(rows.map((r: any) => [r.workspaceId, r.tool, r.skillKey, r.outcome, r.errorCode])).toEqual([
      [WS, "tag_contact", "lead_capture", "ok", null],
      [WS, "tag_contact", "lead_capture", "error", "skills.tag_not_allowed"],
    ]);
    for (const r of rows) expect(typeof r.durationMs).toBe("number");
    expect(JSON.stringify(rows)).not.toMatch(/secret-tag-text|c1|vip/);
    // A recorder failure does not fail the tool.
    w.prisma.agentToolCall.create = jest.fn(() => Promise.reject(new Error("db down")));
    await expect(tools.tag_contact.execute!({ contactId: "c1", tag: "vip" } as never, {} as never)).resolves.toMatchObject({ ok: true });
    // The sandbox build is never recorded.
    const before = rows.length;
    const sandbox = w.factory.build(WS, { mode: "sandbox", enabled: enabledWith([{ skillKey: "lead_capture", status: "enabled", config: { allowedTags: ["vip"] } }]) });
    await sandbox.tag_contact.execute!({ contactId: "c1", tag: "vip" } as never, {} as never);
    await flush();
    expect(w.prisma.db.agentToolCall).toHaveLength(before);
  });
});

describe("SP-22 review I2: ticket cap under concurrency", () => {
  it("two concurrent calls with 2 open tickets create exactly one", async () => {
    const { withAdvisoryLocks } = await import("../channels/test-prisma");
    const w = world();
    const locks = withAdvisoryLocks(w.prisma);
    for (let i = 0; i < 2; i++) {
      w.prisma.db.ticket.push({ id: `old${i}`, workspaceId: WS, number: 100 + i, pipelineId: "pSup", stageId: "sOpen", contactId: "c1", title: "old", priority: "normal", closedAt: null, createdAt: new Date() });
    }
    // A slow create, so both callers would pass an unlocked count.
    const create = w.tickets.createTicket.getMockImplementation()!;
    w.tickets.createTicket.mockImplementation(async (ws: string, dto: unknown) => {
      await new Promise((r) => setTimeout(r, 20));
      return create(ws, dto);
    });
    const tools = w.factory.build(WS, { enabled: enabledWith([{ skillKey: "support_tickets", status: "enabled" }]) });
    const results = await Promise.allSettled([
      tools.open_support_ticket.execute!({ contactId: "c1", title: "A" } as never, {} as never),
      tools.open_support_ticket.execute!({ contactId: "c1", title: "B" } as never, {} as never),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(w.tickets.createTicket).toHaveBeenCalledTimes(1);
    expect(w.prisma.db.ticket.filter((t: { contactId: string; closedAt: unknown }) => t.contactId === "c1" && !t.closedAt)).toHaveLength(3);
    expect(locks.order).toEqual([expect.stringContaining("support-cap:ws1:c1"), expect.stringContaining("support-cap:ws1:c1")]);
  });
});
