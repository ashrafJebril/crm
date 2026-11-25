/* eslint-disable @typescript-eslint/no-explicit-any */
import { connect, oauthWorld } from "./__fixtures__/oauth-world";
import { proxyCtx, tool, WS } from "./__fixtures__/connectors-world";
import { mintProxyToken } from "./connector-proxy-token";
import { CONNECTOR_NEEDS_RECONNECT_TITLE } from "./connector-attention.service";

describe("connector attention", () => {
  it("connector auth failure → connector_needs_attention", async () => {
    const w = oauthWorld();
    const { connector: c } = await connect(w);
    c.tools = [tool("get", "read", "read")];
    w.skills.onConnectorChanged.mockClear();
    w.clock.advance(59 * 60_000);
    w.vendor.tokenAnswers.push({ status: 400, body: { error: "invalid_grant" } });
    expect(await w.tokens.getAccessToken({ ...c })).toBeNull();
    // invalid_grant on a fresh re-read (no concurrent rotation) → needs_reconnect with the reason.
    expect(c).toMatchObject({ status: "needs_reconnect", statusReason: "invalid_grant" });
    expect(w.notifications.notify).toHaveBeenCalledTimes(1);
    const [ws, ids, n] = w.notifications.notify.mock.calls[0] as any[];
    expect(ws).toBe(WS);
    // Members holding connectors.manage (owner and admin; not the viewer).
    expect(w.perms.membersWith).toHaveBeenCalledWith(WS, "connectors.manage");
    expect(ids).toEqual(["u_owner", "u_admin"]);
    expect(n).toMatchObject({ type: "connector_needs_attention", title: CONNECTOR_NEEDS_RECONNECT_TITLE });
    expect(JSON.parse(n.body)).toMatchObject({ provider: "calendly", name: "Calendly", reason: "invalid_grant" });
    expect(n.body).not.toMatch(/at_|rt_/);
    expect(w.skills.onConnectorChanged).toHaveBeenCalledWith(WS, "calendly");
    // The proxy now lists nothing.
    const minted = await mintProxyToken();
    c.proxyTokenPrefix = minted.prefix;
    c.proxyTokenHash = minted.hash;
    const req: any = { headers: { authorization: `Bearer ${minted.token}` }, params: { connectorId: c.id } };
    await w.guard.canActivate(proxyCtx(req));
    expect(((await w.rpc.handle(req.connector, { jsonrpc: "2.0", id: 1, method: "tools/list" })) as any).result.tools).toEqual([]);
    // A second failure while already needs_reconnect: no second notification.
    expect(await w.attention.markNeedsReconnect(c, "refresh_failed")).toBe(false);
    expect(w.notifications.notify).toHaveBeenCalledTimes(1);
  });

  it("reconnect restores tool switches", async () => {
    const w = oauthWorld();
    w.upstream.tools = [
      { name: "scheduled_events-get_event", description: "get", inputSchema: { type: "object" } },
      { name: "invitees-create_invitee", description: "book", inputSchema: { type: "object" } },
    ];
    const first = await connect(w);
    const c = first.connector;
    const lServerId = c.lServerId;
    expect(lServerId).toBe("lsrv_1");
    // The owner switched the write tool on.
    c.tools = c.tools.map((t: any) => (t.name === "invitees-create_invitee" ? { ...t, access: "write" } : t));
    const switches = c.tools.map((t: any) => [t.name, t.access]);
    await w.attention.markNeedsReconnect(c, "invalid_grant");
    expect(c.status).toBe("needs_reconnect");
    const again = await connect(w);
    expect(again.connector.id).toBe(c.id);
    expect(again.outcome).toEqual({ connected: true, connectorId: c.id, reason: null });
    expect(c).toMatchObject({ status: "active", statusReason: null, lServerId });
    expect(c.tools.map((t: any) => [t.name, t.access])).toEqual(switches);
    // One l server only.
    expect(w.lRequests.filter((r) => r.method === "POST" && /\/mcp-servers$/.test(r.path))).toHaveLength(1);
  });
});
