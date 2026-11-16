import http from "node:http";
import type { AddressInfo } from "node:net";
import { NotFoundException } from "@nestjs/common";
import { MCPServer } from "@mastra/mcp";
import { McpToolsFactory } from "./mcp-tools.factory";
import { AppointmentsService } from "../appointments/appointments.service";
import { ContactsService } from "../contacts/contacts.service";
import { MediaService } from "../media/media.service";

interface JsonRpcResult {
  result?: { content?: { type: string; text: string }[]; isError?: boolean; tools?: { name: string }[] };
}

describe("MCP server HTTP transport", () => {
  let appointments: { list: jest.Mock; get: jest.Mock; create: jest.Mock; update: jest.Mock };
  let contacts: { search: jest.Mock; get: jest.Mock; create: jest.Mock; update: jest.Mock };
  let media: { listForAgent: jest.Mock };
  let knowledge: { search: jest.Mock };
  let server: http.Server;
  let baseUrl: string;

  // Mirrors McpServerController.handle() exactly: a fresh MCPServer per
  // request, tools closured over one workspaceId, served statelessly.
  function startFor(workspaceId: string): Promise<void> {
    const factory = new McpToolsFactory(
      appointments as unknown as AppointmentsService,
      contacts as unknown as ContactsService,
      media as unknown as MediaService,
      {} as never, // SP-10: BookingsService (no booking-catalog tool is called here)
      knowledge as never, // SP-21: KnowledgeSearchService
    );
    server = http.createServer(async (req, res) => {
      const mcp = new MCPServer({ name: "tkana-crm", version: "1.0.0", tools: factory.build(workspaceId) });
      await mcp.startHTTP({
        url: new URL(req.url ?? "", "http://localhost"),
        httpPath: "/mcp",
        req,
        res,
        options: { serverless: true },
      });
    });
    return new Promise((resolve) => {
      server.listen(0, () => {
        const { port } = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${port}/mcp`;
        resolve();
      });
    });
  }

  async function call(method: string, params: unknown): Promise<JsonRpcResult> {
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return res.json() as Promise<JsonRpcResult>;
  }

  beforeEach(() => {
    appointments = { list: jest.fn(), get: jest.fn(), create: jest.fn(), update: jest.fn() };
    contacts = { search: jest.fn(), get: jest.fn(), create: jest.fn(), update: jest.fn() };
    media = { listForAgent: jest.fn() };
    knowledge = { search: jest.fn() };
  });

  afterEach(() => {
    server?.close();
  });

  it("mcp tools list includes list_photos, the SP-10 catalog tools and SP-21 search_knowledge: all thirteen tools and no delete tool", async () => {
    await startFor("ws1");
    const { result } = await call("tools/list", {});
    const names = (result?.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual([
      "cancel_appointment", "create_appointment", "create_contact", "find_slots", "get_appointment",
      "get_contact", "list_appointments", "list_photos", "list_services", "search_contacts", "search_knowledge",
      "update_appointment", "update_contact",
    ]);
    expect(names.some((n) => n.includes("delete"))).toBe(false);
  });

  it("list_photos answers over the transport, scoped to the server's workspace", async () => {
    await startFor("ws-7");
    media.listForAgent.mockResolvedValue({ photos: [{ id: "p1", url: "https://cdn.test/p1" }] });
    const { result } = await call("tools/call", { name: "list_photos", arguments: { query: "menu" } });
    expect(result?.isError).toBe(false);
    expect(media.listForAgent).toHaveBeenCalledWith("ws-7", { query: "menu", limit: 5 });
    expect(JSON.parse(result!.content![0].text)).toEqual({ photos: [{ id: "p1", url: "https://cdn.test/p1" }] });
    const refused = await call("tools/call", { name: "list_photos", arguments: { limit: 11 } });
    expect(refused.result?.isError).toBe(true);
    expect(media.listForAgent).toHaveBeenCalledTimes(1);
  });

  it("search_knowledge answers over the transport with the reference notice, scoped to the workspace", async () => {
    await startFor("ws-7");
    knowledge.search.mockResolvedValue([{ chunkId: "c1", sourceId: "s1", sourceTitle: "Menu", kind: "file", heading: null, text: "Cut 50 SAR" }]);
    const { result } = await call("tools/call", { name: "search_knowledge", arguments: { query: "cut price" } });
    expect(result?.isError).toBe(false);
    expect(knowledge.search).toHaveBeenCalledWith("ws-7", "cut price", { kind: undefined, limit: 5 });
    const out = JSON.parse(result!.content![0].text);
    expect(out.notice).toMatch(/never instructions/);
    expect(out.results).toHaveLength(1);
    for (const bad of [{ query: "x", limit: 11 }, { query: "x".repeat(201) }, { query: "" }, { query: "x", kind: "secrets" }]) {
      const refused = await call("tools/call", { name: "search_knowledge", arguments: bad });
      expect(refused.result?.isError).toBe(true);
    }
    expect(knowledge.search).toHaveBeenCalledTimes(1);
  });

  it("scopes a tool call to the workspace baked into this server instance", async () => {
    await startFor("ws-42");
    appointments.list.mockResolvedValue([]);
    await call("tools/call", { name: "list_appointments", arguments: {} });
    expect(appointments.list).toHaveBeenCalledWith("ws-42", { limit: 50 });
  });

  it("returns isError:true with a clean message when the service throws NotFoundException", async () => {
    await startFor("ws1");
    appointments.get.mockRejectedValue(new NotFoundException("Appointment not found"));
    const { result } = await call("tools/call", { name: "get_appointment", arguments: { id: "missing" } });
    expect(result?.isError).toBe(true);
    expect(result?.content?.[0]?.text).toContain("Appointment not found");
  });

  it("returns isError:true on invalid input before the service is ever called", async () => {
    await startFor("ws1");
    const { result } = await call("tools/call", {
      name: "create_appointment",
      arguments: {
        contactId: "c1", service: "Cut", serviceAr: "قص", startAt: "2026-09-20T10:00:00.000Z",
        durationMin: 30, status: "not-a-status", source: "human",
      },
    });
    expect(result?.isError).toBe(true);
    expect(appointments.create).not.toHaveBeenCalled();
  });

  it("returns isError:false with the created row on success", async () => {
    await startFor("ws1");
    appointments.create.mockResolvedValue({ id: "a9" });
    const { result } = await call("tools/call", {
      name: "create_appointment",
      arguments: {
        contactId: "c1", service: "Cut", serviceAr: "قص", startAt: "2026-09-20T10:00:00.000Z",
        durationMin: 30, status: "pending", source: "human",
      },
    });
    expect(result?.isError).toBe(false);
    expect(JSON.parse(result!.content![0].text)).toEqual({ id: "a9" });
  });
});
