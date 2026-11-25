/* eslint-disable @typescript-eslint/no-explicit-any */
import { ForbiddenException, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { connectorsWorld, proxyCtx, seedConnector, tool, WS2, type World } from "./__fixtures__/connectors-world";
import { VENDOR_TEXT_NOTICE } from "./connector-proxy.rpc";
import { PROXY_ARGS_MAX_BYTES, UPSTREAM_RESPONSE_MAX_BYTES } from "./connector-catalog";
import { capContent } from "./connector-upstream";
import { mintProxyToken } from "./connector-proxy-token";

const rpc = (method: string, params?: unknown, id: number | null = 1) => ({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, ...(params ? { params } : {}) });

/** The connector as the guard hands it to the RPC handler (re-read each request). */
async function asAgent(w: World, connId: string, token: string, body: unknown) {
  const req: any = { headers: { authorization: `Bearer ${token}` }, params: { connectorId: connId } };
  await w.guard.canActivate(proxyCtx(req));
  return w.rpc.handle(req.connector, body);
}

async function withToken(w: World, conn: any) {
  const minted = await mintProxyToken();
  conn.proxyTokenPrefix = minted.prefix;
  conn.proxyTokenHash = minted.hash;
  return minted.token;
}

const names = (res: any) => res.result.tools.map((t: any) => t.name).sort();

describe("connector proxy", () => {
  it("tool switched off is not exposed to agent", async () => {
    const w = connectorsWorld();
    const conn = seedConnector(w, {
      tools: [
        tool("get_event", "read", "read"),
        tool("list_events", "read", "off"),
        tool("cancel_event", "write", "off"),
        tool("create_invitee", "write", "write"),
      ],
    });
    const token = await withToken(w, conn);
    expect(names(await asAgent(w, conn.id, token, rpc("tools/list")))).toEqual(["create_invitee", "get_event"]);

    for (const name of ["list_events", "cancel_event"]) {
      const res: any = await asAgent(w, conn.id, token, rpc("tools/call", { name, arguments: {} }));
      expect(res.error).toMatchObject({ message: "tool not available" });
    }
    expect(w.upstream.calls).toHaveLength(0);
    expect(w.db.connectorCall.map((c: any) => [c.tool, c.outcome])).toEqual([
      ["list_events", "refused"],
      ["cancel_event", "refused"],
    ]);

    // A write tool switched to "read" is still not exposed; to "write" it is.
    conn.tools = conn.tools.map((t: any) => (t.name === "cancel_event" ? { ...t, access: "read" } : t));
    expect(names(await asAgent(w, conn.id, token, rpc("tools/list")))).toEqual(["create_invitee", "get_event"]);
    conn.tools = conn.tools.map((t: any) => (t.name === "cancel_event" ? { ...t, access: "write" } : t));
    expect(names(await asAgent(w, conn.id, token, rpc("tools/list")))).toEqual(["cancel_event", "create_invitee", "get_event"]);

    // A removed tool is never exposed, whatever its switch.
    conn.tools = conn.tools.map((t: any) => (t.name === "get_event" ? { ...t, removedAt: "2026-11-01T00:00:00.000Z" } : t));
    expect(names(await asAgent(w, conn.id, token, rpc("tools/list")))).toEqual(["cancel_event", "create_invitee"]);
    const removed: any = await asAgent(w, conn.id, token, rpc("tools/call", { name: "get_event", arguments: {} }));
    expect(removed.error).toMatchObject({ message: "tool not available" });

    // An exposed call reaches the vendor once, wrapped as untrusted data, and is logged without arguments.
    const ok: any = await asAgent(w, conn.id, token, rpc("tools/call", { name: "create_invitee", arguments: { email: "a@b.co" } }));
    expect(ok.result.content[0]).toEqual({ type: "text", text: VENDOR_TEXT_NOTICE });
    expect(ok.result.content[1]).toEqual({ type: "text", text: "ok" });
    expect(w.upstream.calls.map((c) => c.name)).toEqual(["create_invitee"]);
    const last = w.db.connectorCall[w.db.connectorCall.length - 1];
    expect(last).toMatchObject({ tool: "create_invitee", kind: "write", outcome: "ok" });
    expect(JSON.stringify(w.db.connectorCall)).not.toContain("a@b.co");
  });

  it("proxy token is bound to its connector", async () => {
    const w = connectorsWorld();
    const a = seedConnector(w, { tools: [tool("t", "read", "read")] });
    const b = seedConnector(w, { tools: [tool("t", "read", "read")] });
    const tokenA = await withToken(w, a);
    await withToken(w, b);
    await expect(asAgent(w, b.id, tokenA, rpc("tools/list"))).rejects.toBeInstanceOf(NotFoundException);
    // Another workspace's connector id with A's token: the same 404.
    const foreign = seedConnector(w, { workspaceId: WS2 });
    await expect(asAgent(w, foreign.id, tokenA, rpc("tools/list"))).rejects.toBeInstanceOf(NotFoundException);
    // A forged secret with A's prefix.
    const forged = tokenA.replace(/_[^_]+$/, `_${"A".repeat(43)}`);
    await expect(asAgent(w, a.id, forged, rpc("tools/list"))).rejects.toBeInstanceOf(NotFoundException);
    // Revoked (disconnect clears the prefix and hash).
    a.proxyTokenPrefix = null;
    a.proxyTokenHash = null;
    await expect(asAgent(w, a.id, tokenA, rpc("tools/list"))).rejects.toBeInstanceOf(NotFoundException);
    // No bearer.
    await expect(w.guard.canActivate(proxyCtx({ headers: {}, params: { connectorId: b.id } }))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("inactive connector lists no tools", async () => {
    const w = connectorsWorld();
    const conn = seedConnector(w, { tools: [tool("t", "read", "read")] });
    const token = await withToken(w, conn);
    for (const status of ["needs_reconnect", "pending"]) {
      conn.status = status;
      expect((await asAgent(w, conn.id, token, rpc("tools/list")) as any).result.tools).toEqual([]);
      const call: any = await asAgent(w, conn.id, token, rpc("tools/call", { name: "t", arguments: {} }));
      expect(call.error).toMatchObject({ message: "tool not available" });
    }
    conn.status = "disconnected";
    await expect(asAgent(w, conn.id, token, rpc("tools/list"))).rejects.toBeInstanceOf(NotFoundException);
    expect(w.upstream.calls).toHaveLength(0);
  });

  it("payment lock closes the proxy", async () => {
    const w = connectorsWorld();
    const conn = seedConnector(w, { tools: [tool("t", "read", "read")] });
    const token = await withToken(w, conn);
    w.paymentLock.isLocked.mockResolvedValueOnce(true);
    await expect(asAgent(w, conn.id, token, rpc("tools/list"))).rejects.toBeInstanceOf(ForbiddenException);
    w.paymentLock.isLocked.mockRejectedValueOnce(new Error("db down"));
    await expect(asAgent(w, conn.id, token, rpc("tools/list"))).rejects.toThrow("db down");
  });

  it("invalid tool arguments are refused before upstream", async () => {
    const w = connectorsWorld();
    const schema = {
      type: "object",
      properties: { email: { type: "string", maxLength: 50 }, count: { type: "integer", minimum: 1 }, kind: { enum: ["a", "b"] } },
      required: ["email"],
      additionalProperties: false,
    };
    const conn = seedConnector(w, { tools: [tool("book", "write", "write", { inputSchema: schema })] });
    const token = await withToken(w, conn);
    for (const args of [{}, { email: 5 }, { email: "a@b.co", extra: 1 }, "not an object", [1], { email: "a@b.co", count: 0 }, { email: "a@b.co", kind: "c" }]) {
      const res: any = await asAgent(w, conn.id, token, rpc("tools/call", { name: "book", arguments: args }));
      expect({ args, error: res.error?.message }).toEqual({ args, error: "invalid arguments" });
    }
    expect(w.upstream.calls).toHaveLength(0);
    expect(w.db.connectorCall.every((c: any) => c.outcome === "refused" && c.errorCode === "invalid_arguments")).toBe(true);
    const ok: any = await asAgent(w, conn.id, token, rpc("tools/call", { name: "book", arguments: { email: "a@b.co", count: 2, kind: "a" } }));
    expect(ok.result).toBeDefined();
  });

  it("oversized arguments and responses are capped", async () => {
    const w = connectorsWorld();
    const conn = seedConnector(w, { tools: [tool("big", "read", "read")] });
    const token = await withToken(w, conn);
    const res: any = await asAgent(w, conn.id, token, rpc("tools/call", { name: "big", arguments: { s: "x".repeat(PROXY_ARGS_MAX_BYTES) } }));
    expect(res.error?.message).toBe("invalid arguments");
    expect(w.db.connectorCall[0]).toMatchObject({ outcome: "refused", errorCode: "args_too_large" });
    expect(w.upstream.calls).toHaveLength(0);
    // Responses: the content is cut to 1 MB with a note.
    const capped = capContent([{ type: "text", text: "y".repeat(UPSTREAM_RESPONSE_MAX_BYTES + 10) }]);
    expect(capped.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(capped.content))).toBeLessThanOrEqual(UPSTREAM_RESPONSE_MAX_BYTES + 200);
    expect(JSON.stringify(capped.content)).toContain("larger than 1 MB");
    w.upstream.result = { ...capped, isError: false };
    const big: any = await asAgent(w, conn.id, token, rpc("tools/call", { name: "big", arguments: {} }));
    expect(big.result.content.at(-1).text).toContain("larger than 1 MB");
    expect(w.db.connectorCall.at(-1)).toMatchObject({ outcome: "ok", errorCode: "truncated" });
  });

  it("speaks the minimal MCP server protocol", async () => {
    const w = connectorsWorld();
    const conn = seedConnector(w, { tools: [tool("t", "read", "read")] });
    const token = await withToken(w, conn);
    expect(await asAgent(w, conn.id, token, rpc("initialize", { protocolVersion: "2025-06-18" }))).toMatchObject({ result: { capabilities: { tools: {} } } });
    expect(await asAgent(w, conn.id, token, rpc("notifications/initialized", undefined, null))).toBeNull();
    expect(await asAgent(w, conn.id, token, rpc("ping"))).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect(await asAgent(w, conn.id, token, rpc("resources/list"))).toMatchObject({ error: { code: -32601 } });
    // Dry run (SP-20 sandbox): write tools refused.
    conn.tools = [tool("w", "write", "write")];
    const req: any = { headers: { authorization: `Bearer ${token}` }, params: { connectorId: conn.id } };
    await w.guard.canActivate(proxyCtx(req));
    const dry: any = await w.rpc.handle(req.connector, rpc("tools/call", { name: "w", arguments: {} }), { dryRun: true });
    expect(dry.error).toBeDefined();
    expect(w.db.connectorCall.at(-1)).toMatchObject({ outcome: "refused", errorCode: "dry_run" });
  });
});
