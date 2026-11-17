/* eslint-disable @typescript-eslint/no-explicit-any */
import { Readable } from "node:stream";
import { availability, catalogEntry, CONNECTOR_CATALOG, CONNECTOR_PROVIDERS, curatedUrl } from "./connector-catalog";
import { CONNECTOR_ERROR_KEYS, connectorError, connectorErrorStatus } from "./connector-errors";
import { applyPatch, initialTools, isExposed, kindOf, ToolPatchError } from "./connector-tools";
import { validateArgs } from "./connector-args";
import { mintProxyToken, proxyTokenMatches, proxyTokenPrefix } from "./connector-proxy-token";
import { HttpConnectorUpstream, UpstreamAuthError } from "./connector-upstream";
import { ConnectorCallPruneScheduler } from "./connector-call-prune.scheduler";
import { ConnectorCallRecorder } from "./connector-call.recorder";
import { makeFakePrisma } from "../channels/test-prisma";
import type { SafeFetchDeps, SafeRequest } from "./safe-fetch";

describe("connector catalog", () => {
  it("lists Calendly, HubSpot and custom; Pipedrive, Salla and Foodics are coming soon", () => {
    expect(CONNECTOR_CATALOG.map((e) => e.provider)).toEqual(["calendly", "hubspot", "pipedrive", "salla", "foodics", "custom"]);
    for (const p of CONNECTOR_PROVIDERS) expect(catalogEntry(p)).not.toBeNull();
    for (const p of ["pipedrive", "salla", "foodics"]) expect(availability(catalogEntry(p)!)).toEqual({ available: false, unavailableReason: "coming_soon" });
    expect(availability(catalogEntry("hubspot")!, {} as never)).toEqual({ available: false, unavailableReason: "not_configured" });
    expect(availability(catalogEntry("hubspot")!, { HUBSPOT_MCP_CLIENT_ID: "a", HUBSPOT_MCP_CLIENT_SECRET: "b" } as never)).toEqual({ available: true, unavailableReason: null });
    expect(curatedUrl(catalogEntry("calendly")!, {} as never)).toBe("https://mcp.calendly.com");
    expect(curatedUrl(catalogEntry("calendly")!, { CONNECTOR_CALENDLY_MCP_URL: "http://127.0.0.1:9/mcp", NODE_ENV: "production" } as never)).toBeNull();
    expect(curatedUrl(catalogEntry("calendly")!, { CONNECTOR_CALENDLY_MCP_URL: "http://127.0.0.1:9/mcp", NODE_ENV: "test" } as never)).toBe("http://127.0.0.1:9/mcp");
  });

  it("error keys carry their status", () => {
    for (const k of CONNECTOR_ERROR_KEYS) {
      expect(connectorError(k).getStatus()).toBe(connectorErrorStatus(k));
      expect((connectorError(k).getResponse() as any).message).toBe(k);
    }
  });
});

describe("tool rules", () => {
  it("kind: readOnlyHint, then the catalog override, else write", () => {
    expect(kindOf({ name: "x", annotations: { readOnlyHint: true } }, "custom")).toBe("read");
    expect(kindOf({ name: "x", annotations: { readOnlyHint: false } }, "custom")).toBe("write");
    expect(kindOf({ name: "scheduled_events-get_event" }, "calendly")).toBe("read");
    expect(kindOf({ name: "invitees-create_invitee", annotations: { readOnlyHint: true } }, "calendly")).toBe("read");
    expect(kindOf({ name: "unknown" }, "calendly")).toBe("write");
  });

  it("exposure and first-scan defaults", () => {
    expect(isExposed({ kind: "read", access: "read", removedAt: null })).toBe(true);
    expect(isExposed({ kind: "write", access: "read", removedAt: null })).toBe(false);
    expect(isExposed({ kind: "write", access: "write", removedAt: null })).toBe(true);
    expect(isExposed({ kind: "read", access: "off", removedAt: null })).toBe(false);
    expect(isExposed({ kind: "read", access: "write", removedAt: "x" })).toBe(false);
    const cal = initialTools([{ name: "scheduled_events-get_event" }, { name: "scheduled_events-list_events" }, { name: "invitees-create_invitee" }], "calendly");
    expect(cal.map((t) => [t.name, t.kind, t.access])).toEqual([
      ["scheduled_events-get_event", "read", "read"],
      ["scheduled_events-list_events", "read", "off"],
      ["invitees-create_invitee", "write", "off"],
    ]);
    expect(initialTools([{ name: "a", annotations: { readOnlyHint: true } }], "custom")[0].access).toBe("off");
  });

  it("applyPatch keeps the manage rule for write tools", () => {
    const tools = initialTools([{ name: "w" }, { name: "r", annotations: { readOnlyHint: true } }], "custom");
    expect(() => applyPatch(tools, [{ name: "w", access: "write" }], false)).toThrow(ToolPatchError);
    expect(applyPatch(tools, [{ name: "w", access: "write" }], true).find((t) => t.name === "w")!.access).toBe("write");
    // A write tool set to "read" (not exposed) needs no manage.
    expect(applyPatch(tools, [{ name: "w", access: "read" }], false).find((t) => t.name === "w")!.access).toBe("read");
  });
});

describe("argument validator", () => {
  it("checks the JSON Schema subset", () => {
    const s = {
      properties: {
        name: { type: "string", minLength: 1, maxLength: 3 },
        n: { type: "number", minimum: 0, maximum: 10 },
        tags: { type: "array", items: { type: "string" } },
        nested: { type: "object", properties: { a: { type: "integer" } }, required: ["a"], additionalProperties: false },
      },
      required: ["name"],
    };
    expect(validateArgs({ name: "ab", n: 5, tags: ["x"], nested: { a: 1 } }, s)).toEqual({ ok: true });
    const errs = (v: unknown) => (validateArgs(v, s) as any).errors?.map((e: any) => `${e.path}:${e.code}`);
    expect(errs({})).toEqual(["name:required"]);
    expect(errs({ name: "" })).toEqual(["name:too_short"]);
    expect(errs({ name: "abcd" })).toEqual(["name:too_long"]);
    expect(errs({ name: "a", n: 11 })).toEqual(["n:too_big"]);
    expect(errs({ name: "a", tags: [1] })).toEqual(["tags[0]:wrong_type"]);
    expect(errs({ name: "a", nested: { a: 1.5 } })).toEqual(["nested.a:wrong_type"]);
    expect(errs({ name: "a", nested: { a: 1, b: 2 } })).toEqual(["nested.b:unexpected"]);
    expect(errs(null)).toEqual([":not_object"]);
    // Unknown keywords are ignored.
    expect(validateArgs({ x: "a" }, { properties: { x: { type: "string", pattern: "^z" } } })).toEqual({ ok: true });
  });
});

describe("proxy tokens", () => {
  it("mint, prefix and constant bcrypt check", async () => {
    const t = await mintProxyToken();
    expect(t.token).toMatch(/^cnp_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
    expect(proxyTokenPrefix(t.token)).toBe(t.prefix);
    expect(t.hash).not.toContain(t.token);
    expect(await proxyTokenMatches(t.token, t.hash)).toBe(true);
    expect(await proxyTokenMatches(`${t.token}x`, t.hash)).toBe(false);
    expect(await proxyTokenMatches(t.token, null)).toBe(false);
    expect(proxyTokenPrefix("mcp_abc_def")).toBeNull();
  });
});

describe("HTTP upstream client (MCP streamable HTTP over safe-fetch)", () => {
  function server(handler: (body: any, headers: Record<string, string>) => { status?: number; type?: string; body: string; session?: string }) {
    const calls: SafeRequest[] = [];
    const deps: SafeFetchDeps = {
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      async request(req) {
        calls.push(req);
        const out = handler(JSON.parse(req.body ?? "{}"), req.headers);
        return {
          status: out.status ?? 200,
          headers: { "content-type": out.type ?? "application/json", ...(out.session ? { "mcp-session-id": out.session } : {}) },
          body: Readable.from([Buffer.from(out.body)]),
          abort: () => undefined,
        };
      },
    };
    return { deps, calls };
  }

  it("initializes, lists raw tools (SSE answer) and calls with the session and credentials", async () => {
    const s = server((b, h) => {
      if (b.method === "initialize") return { body: JSON.stringify({ jsonrpc: "2.0", id: b.id, result: { serverInfo: { name: "vendor" } } }), session: "sess-1" };
      if (b.method === "notifications/initialized") return { status: 202, body: "" };
      expect(h["mcp-session-id"]).toBe("sess-1");
      if (b.method === "tools/list")
        return {
          type: "text/event-stream",
          body: `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: b.id, result: { tools: [{ name: "get", description: "d", inputSchema: { type: "object", required: ["id"] }, annotations: { readOnlyHint: true } }] } })}\n\n`,
        };
      return { body: JSON.stringify({ jsonrpc: "2.0", id: b.id, result: { content: [{ type: "text", text: `called ${b.params.name}` }] } }) };
    });
    const up = new HttpConnectorUpstream();
    up.deps = s.deps;
    const target = { url: "https://mcp.example.com/mcp", headers: { authorization: "Bearer at" }, trusted: false };
    expect(await up.initialize(target)).toEqual({ serverName: "vendor" });
    expect(await up.listTools(target)).toEqual([
      { name: "get", title: undefined, description: "d", inputSchema: { type: "object", required: ["id"] }, annotations: { readOnlyHint: true } },
    ]);
    expect(await up.callTool(target, "get", { id: "1" })).toEqual({ content: [{ type: "text", text: "called get" }], isError: false, truncated: false });
    expect(s.calls.every((c) => c.headers.authorization === "Bearer at" && c.pinned?.address === "93.184.216.34")).toBe(true);
  });

  it("a 401 is an auth error", async () => {
    const s = server(() => ({ status: 401, body: "" }));
    const up = new HttpConnectorUpstream();
    up.deps = s.deps;
    await expect(up.listTools({ url: "https://mcp.example.com/mcp", headers: {}, trusted: false })).rejects.toBeInstanceOf(UpstreamAuthError);
  });
});

describe("call log", () => {
  it("records without arguments and prunes after 90 days", async () => {
    const prisma: any = makeFakePrisma({ connectorCall: [] } as never);
    const rec = new ConnectorCallRecorder(prisma);
    await rec.record({ workspaceId: "w", connectorId: "c", tool: "t", kind: "read", outcome: "ok", durationMs: 3.4 });
    expect(Object.keys(prisma.db.connectorCall[0]).sort()).toEqual(
      ["at", "connectorId", "createdAt", "durationMs", "errorCode", "id", "kind", "outcome", "source", "tool", "updatedAt", "workspaceId"].sort(),
    );
    prisma.db.connectorCall.push({ id: "old", workspaceId: "w", connectorId: "c", tool: "t", at: new Date(Date.now() - 91 * 86_400_000) });
    prisma.db.connectorCall.push({ id: "old2", workspaceId: "other", connectorId: "c", tool: "t", at: new Date(Date.now() - 91 * 86_400_000) });
    const prune = new ConnectorCallPruneScheduler(prisma);
    expect(await prune.sweep({ workspaceIds: ["w"] })).toBe(1);
    expect(await prune.sweep()).toBe(1);
    expect(prisma.db.connectorCall.map((c: any) => c.id)).toHaveLength(1);
    // The recorder never throws.
    prisma.connectorCall.create = jest.fn(async () => {
      throw new Error("db");
    });
    await expect(rec.record({ workspaceId: "w", connectorId: "c", tool: "t", kind: "read", outcome: "ok", durationMs: 1 })).resolves.toBeUndefined();
  });
});
