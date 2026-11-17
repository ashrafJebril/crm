/* eslint-disable @typescript-eslint/no-explicit-any */
import { Logger } from "@nestjs/common";
import { connectorsWorld, NOW, seedConnector, tool, WS, WS2 } from "./__fixtures__/connectors-world";
import { ConnectorPresenceService } from "./connector-presence.service";
import { SafeFetchError } from "./safe-fetch";
import { CUSTOM_CONNECTORS_MAX } from "./connector-catalog";
import { applyRescan, storedTools } from "./connector-tools";
import { UpstreamAuthError } from "./connector-upstream";
import { mintProxyToken } from "./connector-proxy-token";
import { sealJson } from "./connector-credentials";

const fail = (p: Promise<unknown>) => p.then(() => null, (e: any) => ({ status: e.getStatus?.(), message: e.getResponse?.().message, body: e.getResponse?.() }));
const upstreamTools = [
  { name: "get_event", description: "Get", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
  { name: "cancel_event", description: "Cancel", inputSchema: { type: "object" } },
];

describe("custom connectors", () => {
  it("custom connector starts with every tool off", async () => {
    const w = connectorsWorld();
    w.upstream.tools = upstreamTools;
    const d = await w.service.createCustom(WS, "u1", { name: "Bookings", url: "https://mcp.example.com/mcp", headers: [{ name: "X-Api-Key", value: "sk_live_abcdef123456" }] });
    expect(d).toMatchObject({ provider: "custom", status: "active", serverHost: "mcp.example.com", toolCounts: { on: 0, total: 2 } });
    expect(d.tools.map((t) => [t.name, t.kind, t.access, t.exposed])).toEqual([
      ["get_event", "read", "off", false],
      ["cancel_event", "write", "off", false],
    ]);
    // The check went through the upstream client with the secret header, not trusted.
    expect(w.upstream.lists[0]).toEqual({ url: "https://mcp.example.com/mcp", headers: { "X-Api-Key": "sk_live_abcdef123456" }, trusted: false });
    // Stored encrypted, returned masked.
    const row = w.db.connector[0];
    expect(row.headersEnc.startsWith("enc:v1:")).toBe(true);
    expect(row.headersEnc).not.toContain("sk_live");
    expect(d.headers).toEqual([{ name: "X-Api-Key", value: "••••3456" }]);
    // Registered on l through our proxy, bound, and skills told.
    expect(w.lRequests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /workspaces/lws-1/mcp-servers",
      "PUT /workspaces/lws-1/agents/agent-1/mcp-servers/lsrv_1",
    ]);
    expect(w.lRequests[0].body.url).toMatch(/\/api\/mcp\/connectors\/.+$/);
    expect(w.lRequests[0].body.headers.Authorization).toMatch(/^Bearer cnp_[0-9a-f]{12}_/);
    expect(row).toMatchObject({ lServerId: "lsrv_1", agentBound: true });
    expect(row.proxyTokenHash).not.toContain("cnp_");
    expect(w.skills.onConnectorChanged).toHaveBeenCalledWith(WS, "custom");
  });

  it("custom connector url is ssrf-guarded at create", async () => {
    const w = connectorsWorld();
    for (const url of ["http://mcp.example.com", "https://127.0.0.1", "https://10.0.0.5", "https://169.254.169.254", "https://[::1]", "https://[fd00::1]", "https://[::ffff:10.0.0.1]", "https://100.64.0.1", "https://mcp.example.com:22/"]) {
      expect({ url, r: await fail(w.service.createCustom(WS, "u1", { name: "x", url })) }).toMatchObject({ url, r: { status: 400, message: "connectors.unsafe_url" } });
    }
    // A name that resolves to a private address is refused by the check itself.
    w.upstream.fail = new SafeFetchError("unsafe_url", "private_address");
    expect(await fail(w.service.createCustom(WS, "u1", { name: "x", url: "https://evil.example.com" }))).toMatchObject({ status: 400, message: "connectors.unsafe_url", body: { reason: "private_address" } });
    w.upstream.fail = new SafeFetchError("redirect", "http_302");
    expect(await fail(w.service.createCustom(WS, "u1", { name: "x", url: "https://moved.example.com" }))).toMatchObject({ status: 400, message: "connectors.check_failed", body: { reason: "http_302" } });
    expect(w.db.connector).toHaveLength(0);
  });

  it("custom connector limit", async () => {
    const w = connectorsWorld();
    w.upstream.tools = upstreamTools;
    for (let i = 0; i < CUSTOM_CONNECTORS_MAX; i++) await w.service.createCustom(WS, "u1", { name: `c${i}`, url: "https://mcp.example.com/mcp" });
    expect(await fail(w.service.createCustom(WS, "u1", { name: "c11", url: "https://mcp.example.com/mcp" }))).toMatchObject({ status: 409, message: "connectors.custom_limit" });
    // A disconnected one frees a slot.
    await w.service.disconnect(WS, w.db.connector[0].id);
    await expect(w.service.createCustom(WS, "u1", { name: "c11", url: "https://mcp.example.com/mcp" })).resolves.toBeDefined();
  });
});

describe("tool switches and re-scan", () => {
  it("write tool needs write access", async () => {
    const w = connectorsWorld();
    const c = seedConnector(w, { tools: [tool("get_event", "read", "off"), tool("cancel_event", "write", "off")] });
    // Reads with connectors.update only: fine.
    let d = await w.service.patchTools(WS, c.id, { version: 0, tools: [{ name: "get_event", access: "read" }] }, false);
    expect(d.tools.find((t) => t.name === "get_event")).toMatchObject({ access: "read", exposed: true });
    expect(await fail(w.service.patchTools(WS, c.id, { version: d.version, tools: [{ name: "cancel_event", access: "write" }] }, false))).toMatchObject({
      status: 403,
      message: "connectors.write_access_requires_manage",
    });
    d = await w.service.patchTools(WS, c.id, { version: d.version, tools: [{ name: "cancel_event", access: "write" }] }, true);
    expect(d.tools.find((t) => t.name === "cancel_event")).toMatchObject({ access: "write", exposed: true });
    // Switching it off again needs no manage.
    d = await w.service.patchTools(WS, c.id, { version: d.version, tools: [{ name: "cancel_event", access: "off" }] }, false);
    expect(d.tools.find((t) => t.name === "cancel_event")).toMatchObject({ access: "off", exposed: false });
    // Stale version, unknown tool, removed tool, disconnected connector.
    expect(await fail(w.service.patchTools(WS, c.id, { version: 0, tools: [{ name: "get_event", access: "off" }] }, true))).toMatchObject({ status: 409, message: "connectors.version_conflict" });
    expect(await fail(w.service.patchTools(WS, c.id, { version: d.version, tools: [{ name: "nope", access: "off" }] }, true))).toMatchObject({ status: 400, message: "connectors.invalid_tools" });
    c.tools = [...c.tools.slice(0, 1), { ...c.tools[1], removedAt: NOW.toISOString() }];
    expect(await fail(w.service.patchTools(WS, c.id, { version: d.version, tools: [{ name: "cancel_event", access: "read" }] }, true))).toMatchObject({ status: 400, message: "connectors.tool_removed" });
    c.status = "disconnected";
    expect(await fail(w.service.patchTools(WS, c.id, { version: d.version, tools: [{ name: "get_event", access: "off" }] }, true))).toMatchObject({ status: 409, message: "connectors.disconnected" });
  });

  it("rescan flags removed tools and switches off changed write tools", async () => {
    // Table cases of the pure rule.
    const old = [
      tool("keep_read", "read", "read"),
      tool("changed_read", "read", "read", { inputSchema: { type: "object", properties: { a: { type: "string" } } } }),
      tool("changed_write", "write", "write", { inputSchema: { type: "object" } }),
      tool("same_write", "write", "write"),
      tool("gone", "read", "read"),
      tool("back", "read", "read", { removedAt: "2026-11-01T00:00:00.000Z" }),
    ];
    const r = applyRescan(
      old,
      [
        { name: "keep_read", description: "keep_read description", inputSchema: old[0].inputSchema, annotations: { readOnlyHint: true } },
        { name: "changed_read", description: "changed_read description", inputSchema: { type: "object", properties: { b: { type: "number" } } }, annotations: { readOnlyHint: true } },
        { name: "changed_write", description: "changed_write description", inputSchema: { type: "object", required: ["x"] } },
        { name: "same_write", description: "same_write description", inputSchema: old[3].inputSchema },
        { name: "back", description: "back description", inputSchema: old[5].inputSchema, annotations: { readOnlyHint: true } },
        { name: "brand_new", description: "new", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
      ],
      "custom",
      NOW,
    );
    expect(r.added).toEqual(["brand_new"]);
    expect(r.removed).toEqual(["gone"]);
    expect(r.changed.sort()).toEqual(["changed_read", "changed_write"]);
    const by = Object.fromEntries(r.tools.map((t) => [t.name, t]));
    expect(by.brand_new.access).toBe("off");
    expect(by.changed_read.access).toBe("read"); // a read tool keeps its switch
    expect(by.changed_write.access).toBe("off"); // ruling 6
    expect(by.same_write.access).toBe("write");
    expect(by.gone.removedAt).toBe(NOW.toISOString());
    expect(by.back).toMatchObject({ removedAt: null, access: "read" });

    // Through the service: optimistic version.
    const w = connectorsWorld();
    const c = seedConnector(w, { tools: [tool("get_event", "read", "read"), tool("old_tool", "read", "read")], version: 3 });
    w.upstream.tools = upstreamTools;
    const res = await w.service.rescan(WS, c.id);
    expect(res).toMatchObject({ added: ["cancel_event"], removed: ["old_tool"] });
    expect(res.detail.version).toBe(4);
    expect(res.detail.tools.find((t) => t.name === "old_tool")).toMatchObject({ removed: true, exposed: false });
    w.upstream.fail = new UpstreamAuthError(401);
    expect(await fail(w.service.rescan(WS, c.id))).toMatchObject({ status: 409, message: "connectors.needs_reconnect" });
    c.status = "needs_reconnect";
    expect(await fail(w.service.rescan(WS, c.id))).toMatchObject({ status: 409, message: "connectors.needs_reconnect" });
  });
});

describe("activity, agent switch, disconnect", () => {
  it("activity lists the last calls without arguments", async () => {
    const w = connectorsWorld();
    const c = seedConnector(w);
    const at = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000);
    for (let i = 0; i < 25; i++) {
      w.db.connectorCall.push({ id: `cc${i}`, workspaceId: WS, connectorId: c.id, tool: i % 2 ? "a" : "b", kind: "read", outcome: i % 3 === 0 ? "refused" : "ok", errorCode: null, durationMs: 5, source: "agent", at: at(i % 10) });
    }
    w.db.connectorCall.push({ id: "old", workspaceId: WS, connectorId: c.id, tool: "a", kind: "read", outcome: "ok", errorCode: null, durationMs: 5, source: "agent", at: at(40) });
    const a = await w.service.activity(WS, c.id);
    expect(a.calls).toHaveLength(20);
    expect(a.calls.every((x) => x.at >= at(30))).toBe(true);
    expect(Object.keys(a.calls[0]).sort()).toEqual(["at", "errorCode", "kind", "outcome", "source", "tool"]);
    const week = w.db.connectorCall.filter((x: any) => x.at >= at(7));
    const expectA = week.filter((x: any) => x.tool === "a");
    expect(a.counts7d.find((x) => x.tool === "a")).toEqual({
      tool: "a",
      ok: expectA.filter((x: any) => x.outcome === "ok").length,
      error: 0,
      refused: expectA.filter((x: any) => x.outcome === "refused").length,
    });
  });

  it("agent switch binds and unbinds the l server", async () => {
    const w = connectorsWorld();
    const c = seedConnector(w);
    await w.service.setAgent(WS, c.id, true);
    expect(c).toMatchObject({ lServerId: "lsrv_1", agentBound: true });
    await w.service.setAgent(WS, c.id, false);
    await w.service.setAgent(WS, c.id, true);
    expect(w.lRequests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /workspaces/lws-1/mcp-servers",
      "PUT /workspaces/lws-1/agents/agent-1/mcp-servers/lsrv_1",
      "DELETE /workspaces/lws-1/agents/agent-1/mcp-servers/lsrv_1",
      "PUT /workspaces/lws-1/agents/agent-1/mcp-servers/lsrv_1",
    ]);
    // A workspace without an l link: 409 agent_not_connected.
    const w2 = connectorsWorld({ lLinked: false });
    const c2 = seedConnector(w2);
    expect(await fail(w2.service.setAgent(WS, c2.id, true))).toMatchObject({ status: 409, message: "connectors.agent_not_connected" });
  });

  it("disconnect wipes tokens, revokes the proxy token and removes the l server, keeping switches", async () => {
    const w = connectorsWorld();
    const minted = await mintProxyToken();
    const c = seedConnector(w, {
      provider: "calendly",
      authKind: "oauth",
      tokenEnc: sealJson({ access_token: "at_secret", refresh_token: "rt_secret" }),
      tokenExpiresAt: NOW,
      lServerId: "lsrv_9",
      agentBound: true,
      proxyTokenPrefix: minted.prefix,
      proxyTokenHash: minted.hash,
      tools: [tool("get_event", "read", "read")],
    });
    w.db.connectorCall.push({ id: "h", workspaceId: WS, connectorId: c.id, tool: "get_event", kind: "read", outcome: "ok", errorCode: null, durationMs: 1, source: "agent", at: NOW });
    await expect(w.service.disconnect(WS, c.id)).resolves.toEqual({ ok: true });
    expect(c).toMatchObject({ status: "disconnected", tokenEnc: null, tokenExpiresAt: null, lServerId: null, agentBound: false, proxyTokenPrefix: null, proxyTokenHash: null });
    expect(storedTools(c.tools)).toEqual([expect.objectContaining({ name: "get_event", access: "read" })]);
    expect(w.db.connectorCall).toHaveLength(1);
    expect(w.lRequests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "DELETE /workspaces/lws-1/agents/agent-1/mcp-servers/lsrv_9",
      "DELETE /workspaces/lws-1/mcp-servers/lsrv_9",
    ]);
    expect(w.skills.onConnectorChanged).toHaveBeenCalledWith(WS, "calendly");
    expect(await fail(w.service.disconnect(WS, c.id))).toMatchObject({ status: 404, message: "connectors.not_found" });
    // l failures are best effort: the token is revoked anyway.
    const w2 = connectorsWorld();
    const c2 = seedConnector(w2, { lServerId: "lsrv_7", agentBound: true, proxyTokenPrefix: "abcdefabcdef", proxyTokenHash: "h" });
    w2.lClient.request.mockRejectedValue(new Error("l down"));
    await w2.service.disconnect(WS, c2.id);
    expect(c2).toMatchObject({ status: "disconnected", proxyTokenPrefix: null, proxyTokenHash: null });
  });

  it("foreign connector id is 404 everywhere", async () => {
    const w = connectorsWorld();
    const foreign = seedConnector(w, { workspaceId: WS2, tools: [tool("t", "read", "off")] });
    const nf = { status: 404, message: "connectors.not_found" };
    expect(await fail(w.service.detail(WS, foreign.id))).toMatchObject(nf);
    expect(await fail(w.service.activity(WS, foreign.id))).toMatchObject(nf);
    expect(await fail(w.service.patchTools(WS, foreign.id, { version: 0, tools: [{ name: "t", access: "read" }] }, true))).toMatchObject(nf);
    expect(await fail(w.service.rescan(WS, foreign.id))).toMatchObject(nf);
    expect(await fail(w.service.setAgent(WS, foreign.id, true))).toMatchObject(nf);
    expect(await fail(w.service.disconnect(WS, foreign.id))).toMatchObject(nf);
    expect(await fail(w.service.detail(WS, "nope"))).toMatchObject(nf);
    expect(foreign.status).toBe("active");
  });
});

describe("presence, status and secrets", () => {
  it("presence answers only for active connectors", async () => {
    const w = connectorsWorld();
    const presence = new ConnectorPresenceService(w.prisma);
    expect(await presence.isConnected(WS, "calendly")).toBe(false);
    const c = seedConnector(w, { provider: "calendly", authKind: "oauth", tokenEnc: null });
    expect(await presence.isConnected(WS, "calendly")).toBe(false); // no usable token
    c.tokenEnc = sealJson({ access_token: "x" });
    expect(await presence.isConnected(WS, "calendly")).toBe(true);
    expect(await presence.isConnected(WS2, "calendly")).toBe(false);
    for (const status of ["needs_reconnect", "pending", "disconnected"]) {
      c.status = status;
      expect({ status, connected: await presence.isConnected(WS, "calendly") }).toEqual({ status, connected: false });
    }
    seedConnector(w, { provider: "custom" });
    expect(await presence.isConnected(WS, "custom")).toBe(true);
  });

  it("status changes notify skills", async () => {
    const w = connectorsWorld();
    const c = seedConnector(w, { provider: "calendly", authKind: "oauth", status: "pending" });
    expect(await w.service.setStatus(c, "active", null)).toBe(true);
    expect(await w.service.setStatus(c, "needs_reconnect", "invalid_grant", ["active"])).toBe(true);
    // A lost compare-and-set notifies nothing.
    expect(await w.service.setStatus(c, "needs_reconnect", "invalid_grant", ["active"])).toBe(false);
    await w.service.disconnect(WS, c.id);
    expect(w.skills.onConnectorChanged.mock.calls).toEqual([
      [WS, "calendly"],
      [WS, "calendly"],
      [WS, "calendly"],
    ]);
    expect(c).toMatchObject({ status: "disconnected" });
  });

  it("tokens are never returned or logged", async () => {
    const w = connectorsWorld();
    const lines: string[] = [];
    const spies = (["log", "warn", "error", "debug", "verbose"] as const).flatMap((m) => [
      jest.spyOn(Logger.prototype, m).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" "))),
      jest.spyOn(Logger, m).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" "))),
    ]);
    const secrets = ["at_secret_value", "rt_secret_value", "hdr_secret_value"];
    try {
      const oauth = seedConnector(w, {
        provider: "calendly",
        authKind: "oauth",
        tokenEnc: sealJson({ access_token: secrets[0], refresh_token: secrets[1] }),
        tools: [tool("get_event", "read", "read")],
      });
      w.upstream.tools = upstreamTools;
      const custom = await w.service.createCustom(WS, "u1", { name: "x", url: "https://mcp.example.com/mcp?key=q", headers: [{ name: "Authorization", value: `Bearer ${secrets[2]}` }] });
      const all = JSON.stringify([await w.service.list(WS), await w.service.detail(WS, oauth.id), custom, await w.service.activity(WS, oauth.id)]);
      for (const s of secrets) expect(all).not.toContain(s);
      expect(all).not.toMatch(/cnp_|tokenEnc|headersEnc|proxyTokenHash|access_token|refresh_token/);
      expect(all).not.toContain("key=q"); // host only
      // Failing paths log without secrets.
      w.upstream.fail = new Error(`boom ${secrets[2]}`);
      await w.service.createCustom(WS, "u1", { name: "y", url: "https://mcp.example.com/mcp", headers: [{ name: "X-K", value: secrets[2] }] }).catch(() => null);
      w.lClient.request.mockRejectedValue(new Error("l down"));
      await w.service.disconnect(WS, oauth.id);
      const log = lines.join("\n");
      for (const s of secrets) expect(log).not.toContain(s);
      expect(log).not.toMatch(/cnp_[0-9a-f]{12}_|access_token|refresh_token/);
      expect(JSON.stringify(w.lRequests.map((r) => r.body?.headers ?? null))).toContain("Bearer cnp_"); // only l holds it
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});
