/* eslint-disable @typescript-eslint/no-explicit-any */
import { withAdvisoryLocks } from "../channels/test-prisma";
import { connect, oauthWorld } from "./__fixtures__/oauth-world";
import { ConnectorOAuthService } from "./connector-oauth.service";
import { proxyCtx, tool } from "./__fixtures__/connectors-world";
import { mintProxyToken } from "./connector-proxy-token";
import { sealJson } from "./connector-credentials";
import { UpstreamAuthError } from "./connector-upstream";

const MIN = 60_000;
const tokenOf = (row: any) => ConnectorOAuthService.storedToken(row);

async function proxyCall(w: any, conn: any, name: string) {
  const minted = await mintProxyToken();
  conn.proxyTokenPrefix = minted.prefix;
  conn.proxyTokenHash = minted.hash;
  const req: any = { headers: { authorization: `Bearer ${minted.token}` }, params: { connectorId: conn.id } };
  await w.guard.canActivate(proxyCtx(req));
  return w.rpc.handle(req.connector, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } });
}

describe("connector tokens", () => {
  it("refresh token rotation", async () => {
    const w = oauthWorld();
    w.upstream.tools = [{ name: "scheduled_events-get_event", description: "get", inputSchema: { type: "object" } }];
    const { connector: c } = await connect(w);
    expect(tokenOf(c)).toMatchObject({ access_token: "at_1", refresh_token: "rt_1" });
    const v0 = c.tokenVersion;
    // The token expires in 1 minute: a proxy call refreshes once first.
    w.clock.advance(59 * MIN);
    const tokenRequests = () => w.vendor.requests.filter((r) => r.url.endsWith("/token"));
    const before = tokenRequests().length;
    const res: any = await proxyCall(w, c, "scheduled_events-get_event");
    expect(res.result).toBeDefined();
    expect(tokenRequests().length - before).toBe(1);
    const refreshReq = tokenRequests().at(-1)!;
    expect(refreshReq.form).toMatchObject({ grant_type: "refresh_token", refresh_token: "rt_1" });
    expect(w.upstream.calls.at(-1)!.headers.authorization).toBe("Bearer at_2");
    // Both rotated values stored encrypted; version bumped, failures reset.
    expect(c.tokenEnc.startsWith("enc:v1:")).toBe(true);
    expect(c.tokenEnc).not.toMatch(/at_2|rt_2/);
    expect(tokenOf(c)).toMatchObject({ access_token: "at_2", refresh_token: "rt_2" });
    expect(c.tokenVersion).toBe(v0 + 1);
    expect(c.refreshFailures).toBe(0);
    // The next refresh: the old refresh token is never sent again; a vendor
    // answer without a refresh token keeps the previous one.
    w.vendor.tokenAnswers.push({ status: 200, body: { access_token: "at_3", expires_in: 3600 } });
    w.clock.advance(60 * MIN);
    await w.tokens.getAccessToken(c);
    expect(tokenRequests().at(-1)!.form.refresh_token).toBe("rt_2");
    expect(tokenRequests().filter((r) => r.form.grant_type === "refresh_token").map((r) => r.form.refresh_token)).toEqual(["rt_1", "rt_2"]);
    expect(tokenOf(c)).toMatchObject({ access_token: "at_3", refresh_token: "rt_2" });
  });

  it("concurrent refresh calls the vendor once", async () => {
    const w = oauthWorld();
    const { connector: c } = await connect(w);
    withAdvisoryLocks(w.prisma);
    w.clock.advance(59 * MIN);
    let open!: () => void;
    w.vendor.gate = new Promise<void>((r) => (open = r));
    const seen = { ...c };
    const both = Promise.all([w.tokens.getAccessToken(seen), w.tokens.getAccessToken({ ...seen })]);
    await new Promise((r) => setImmediate(r));
    open();
    const [a, b] = await both;
    expect(a).toBe("at_2");
    expect(b).toBe("at_2");
    expect(w.vendor.requests.filter((r) => r.form.grant_type === "refresh_token")).toHaveLength(1);
  });

  it("invalid_grant after a concurrent rotation is not a failure", async () => {
    const w = oauthWorld();
    const { connector: c } = await connect(w);
    w.clock.advance(59 * MIN);
    const seen = { ...c };
    // While our refresh is in flight, another machine rotated the token.
    w.vendor.tokenAnswers.push(() => {
      c.tokenEnc = sealJson({ access_token: "at_other", refresh_token: "rt_other" });
      c.tokenVersion += 1;
      c.tokenExpiresAt = new Date(w.clock.get().getTime() + 3600_000);
      return { status: 400, body: { error: "invalid_grant" } };
    });
    expect(await w.tokens.getAccessToken(seen)).toBe("at_other");
    expect(c.status).toBe("active");
    expect(w.notifications.notify).not.toHaveBeenCalled();
  });

  it("second consecutive refresh failure escalates", async () => {
    const w = oauthWorld();
    const { connector: c } = await connect(w);
    w.clock.advance(59 * MIN);
    w.vendor.tokenAnswers.push({ status: 500, body: {} }, { status: 503, body: {} });
    expect(await w.tokens.getAccessToken({ ...c })).toBe("at_1"); // still valid for a minute
    expect(c).toMatchObject({ refreshFailures: 1, status: "active" });
    expect(await w.tokens.getAccessToken({ ...c })).toBeNull();
    expect(c).toMatchObject({ status: "needs_reconnect", statusReason: "refresh_failed" });
    expect(w.notifications.notify).toHaveBeenCalledTimes(1);
  });

  it("expired token without refresh token escalates", async () => {
    const w = oauthWorld();
    w.vendor.tokenAnswers.push({ status: 200, body: { access_token: "at_only", expires_in: 600 } });
    const { connector: c } = await connect(w);
    expect(tokenOf(c)).toEqual(expect.not.objectContaining({ refresh_token: expect.anything() }));
    w.clock.advance(11 * MIN);
    expect(await w.tokens.getAccessToken({ ...c })).toBeNull();
    expect(c).toMatchObject({ status: "needs_reconnect", statusReason: "no_refresh_token" });
  });

  it("second upstream 401 after refresh escalates", async () => {
    const w = oauthWorld();
    const { connector: c } = await connect(w);
    c.tools = [tool("get", "read", "read")];
    const before = w.vendor.requests.filter((r) => r.form.grant_type === "refresh_token").length;
    w.upstream.fail = new UpstreamAuthError(401);
    const res: any = await proxyCall(w, c, "get");
    expect(res.error.message).toBe("connector needs reconnecting");
    // One forced refresh, one retry, then needs_reconnect.
    expect(w.vendor.requests.filter((r) => r.form.grant_type === "refresh_token").length - before).toBe(1);
    expect(w.upstream.calls.filter((x) => x.name === "get").map((x) => x.headers.authorization)).toEqual(["Bearer at_1", "Bearer at_2"]);
    expect(c).toMatchObject({ status: "needs_reconnect", statusReason: "upstream_unauthorized" });
    expect(w.notifications.notify).toHaveBeenCalledTimes(1);
    expect(w.db.connectorCall.at(-1)).toMatchObject({ outcome: "error", errorCode: "upstream_auth" });
  });

  it("refresh sweep picks only tokens expiring within two hours", async () => {
    const w = oauthWorld();
    const { connector: soon } = await connect(w);
    soon.tokenExpiresAt = new Date(w.clock.get().getTime() + 90 * MIN);
    const late = { ...soon, id: "late", tokenExpiresAt: new Date(w.clock.get().getTime() + 3 * 60 * MIN), proxyTokenPrefix: null };
    const other = { ...soon, id: "other_ws", workspaceId: "ws2", proxyTokenPrefix: null };
    const off = { ...soon, id: "off", status: "needs_reconnect", proxyTokenPrefix: null };
    w.db.connector.push(late, other, off);
    const refreshes = () => w.vendor.requests.filter((r) => r.form.grant_type === "refresh_token").length;
    expect(await w.scheduler.tick({ workspaceIds: ["ws1"] })).toBe(1);
    expect(refreshes()).toBe(1);
    expect(tokenOf(soon)).toMatchObject({ access_token: "at_2" });
    expect(tokenOf(late)).toMatchObject({ access_token: "at_1" });
    expect(tokenOf(other)).toMatchObject({ access_token: "at_1" });
    // Without the filter the other workspace's expiring token is refreshed too
    // (and ws1's new one-hour token, which is again inside the window).
    expect(await w.scheduler.tick()).toBe(2);
    expect(tokenOf(other)?.access_token).not.toBe("at_1");
    expect(tokenOf(off)).toMatchObject({ access_token: "at_1" });
  });
});
