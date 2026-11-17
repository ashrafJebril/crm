/* eslint-disable @typescript-eslint/no-explicit-any */
import { Readable } from "node:stream";
import { oauthWorld, startConnect } from "./__fixtures__/oauth-world";
import { callbackPage } from "./oauth-callback-page";
import { ConnectorOAuthHttp, OAuthHttpError } from "./connector-oauth-http";
import type { SafeFetchDeps } from "./safe-fetch";

function metaServer(meta: Record<string, unknown>): SafeFetchDeps {
  return {
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    async request(req) {
      const body = req.url.pathname.startsWith("/.well-known/oauth-protected-resource")
        ? { authorization_servers: ["https://auth.example.com"] }
        : { issuer: "https://auth.example.com", code_challenge_methods_supported: ["S256"], ...meta };
      return { status: 200, headers: { "content-type": "application/json" }, body: Readable.from([Buffer.from(JSON.stringify(body))]), abort: () => undefined };
    },
  };
}

describe("SP-23 OAuth review fixes", () => {
  it("the callback page escapes < inside its inline script", () => {
    const evil = "https://app.example.com/#/x?</script><script>alert(1)</script>";
    const page = callbackPage({ connected: false, connectorId: "c1", reason: "cancelled" }, "https://app.example.com", evil);
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(page.html)![1];
    expect(script).not.toContain("<");
    expect(script).toContain("\\u003c/script>");
    // Exactly one script element: nothing broke out of it.
    expect((page.html.match(/<script/g) ?? []).length).toBe(1);
  });

  it("discovery refuses non-https or private authorization and token endpoints", async () => {
    const http = new ConnectorOAuthHttp();
    const good = { authorization_endpoint: "https://auth.example.com/authorize", token_endpoint: "https://auth.example.com/token" };
    for (const bad of [
      { authorization_endpoint: "javascript:alert(1)" },
      { authorization_endpoint: "http://auth.example.com/authorize" },
      { token_endpoint: "http://auth.example.com/token" },
      { token_endpoint: "https://10.0.0.1/token" },
      { authorization_endpoint: "data:text/html,hi" },
      { revocation_endpoint: "file:///etc/passwd" },
      { registration_endpoint: "https://169.254.169.254/register" },
    ]) {
      http.deps = metaServer({ ...good, ...bad });
      const err = await http.discover("https://mcp.example.com/mcp", false).catch((e) => e);
      expect({ bad, kind: err instanceof OAuthHttpError ? err.kind : String(err) }).toEqual({ bad, kind: "unsafe_url" });
    }
    http.deps = metaServer(good);
    await expect(http.discover("https://mcp.example.com/mcp", false)).resolves.toMatchObject(good);
  });

  it("a duplicate callback that loses the race reports connected when the connector is now active", async () => {
    const w = oauthWorld();
    const s = await startConnect(w);
    let release!: () => void;
    w.vendor.gate = new Promise<void>((r) => (release = r));
    // Two loads of the same callback URL at the same time.
    const first = w.oauth.callback({ code: "code_1", state: s.state });
    const second = w.oauth.callback({ code: "code_1", state: s.state });
    await new Promise((r) => setImmediate(r));
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual({ connected: true, connectorId: s.connector.id, reason: null });
    expect(b).toEqual({ connected: true, connectorId: s.connector.id, reason: null });
    expect(w.vendor.requests.filter((r) => r.form.grant_type === "authorization_code")).toHaveLength(1);
    // A duplicate whose connect failed still reports the failure.
    const w2 = oauthWorld();
    const s2 = await startConnect(w2);
    w2.vendor.tokenAnswers.push({ status: 400, body: { error: "invalid_grant" } });
    expect(await w2.oauth.callback({ code: "bad", state: s2.state })).toMatchObject({ connected: false, reason: "exchange_failed" });
    expect(await w2.oauth.callback({ code: "bad", state: s2.state })).toMatchObject({ connected: false, reason: "invalid_state" });
  });
});
