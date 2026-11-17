/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from "node:crypto";
import { Logger } from "@nestjs/common";
import { connect, oauthWorld, startConnect } from "./__fixtures__/oauth-world";
import { WS2 } from "./__fixtures__/connectors-world";
import { connectorStateSecret, CONNECTOR_STATE_AUDIENCE, newNonce, signConnectorState } from "./connector-oauth-state";
import { ConnectorOAuthService, pkcePair } from "./connector-oauth.service";
import { callbackPage } from "./oauth-callback-page";
import { connectorRedirectUri } from "./connector-oauth-config";

const fail = (p: Promise<unknown>) => p.then(() => null, (e: any) => ({ status: e.getStatus?.(), message: e.getResponse?.().message }));
const nothingStored = (c: any) => {
  expect(c.tokenEnc).toBeNull();
  expect(c.status).not.toBe("active");
};

describe("connector oauth", () => {
  it("oauth state is signed single-use and expires", async () => {
    const w = oauthWorld();
    const s = await startConnect(w);
    const c = s.connector;
    const outcome = (state: string) => w.oauth.callback({ code: "code_1", state });
    // A forged signature.
    const [h, p] = s.state.split(".");
    expect(await outcome(`${h}.${p}.AAAA`)).toMatchObject({ connected: false, reason: "invalid_state" });
    // Another audience (a session-like token signed with the same derived key).
    const other = w.jwt.sign({ workspaceId: "ws1", userId: "u_owner", connectorId: c.id, nonce: newNonce(), purpose: "connector_oauth" }, { secret: connectorStateSecret(), audience: "sessions", expiresIn: 600 });
    expect(await outcome(other)).toMatchObject({ reason: "invalid_state" });
    // Signed with the session secret (not the derived key).
    const session = w.jwt.sign({ workspaceId: "ws1", userId: "u_owner", connectorId: c.id, nonce: newNonce(), purpose: "connector_oauth" }, { secret: process.env.JWT_SECRET!, audience: CONNECTOR_STATE_AUDIENCE, expiresIn: 600 });
    expect(await outcome(session)).toMatchObject({ reason: "invalid_state" });
    // Expired.
    const expired = signConnectorState(w.jwt, { workspaceId: "ws1", userId: "u_owner", connectorId: c.id, nonce: newNonce() }, -10);
    expect(await outcome(expired)).toMatchObject({ reason: "invalid_state" });
    // Another workspace's connector id.
    const foreign = signConnectorState(w.jwt, { workspaceId: WS2, userId: "u_owner", connectorId: c.id, nonce: newNonce() });
    expect(await outcome(foreign)).toMatchObject({ reason: "invalid_state" });
    nothingStored(c);
    // The real state works once; the replay is refused.
    expect(await outcome(s.state)).toEqual({ connected: true, connectorId: c.id, reason: null });
    const tokenBefore = c.tokenEnc;
    expect(await outcome(s.state)).toMatchObject({ connected: false, reason: "invalid_state" });
    expect(c.tokenEnc).toBe(tokenBefore);
  });

  it("callback rechecks permission", async () => {
    let allowed = true;
    const w = oauthWorld({ canConnect: () => allowed });
    const s = await startConnect(w);
    allowed = false; // the role changed between start and callback
    expect(await w.oauth.callback({ code: "code_1", state: s.state })).toMatchObject({ connected: false, reason: "forbidden" });
    expect(w.perms.invalidate).toHaveBeenCalledWith("ws1", "u_owner");
    nothingStored(s.connector);
    expect(s.connector.oauthPendingEnc).toBeNull();
    expect(w.vendor.requests.some((r) => r.url.endsWith("/token"))).toBe(false);
  });

  it("pkce verifier is required", async () => {
    const w = oauthWorld();
    // Missing pending verifier.
    const s1 = await startConnect(w);
    s1.connector.oauthPendingEnc = null;
    expect(await w.oauth.callback({ code: "c", state: s1.state })).toMatchObject({ reason: "invalid_state" });
    // Expired pending verifier.
    const s2 = await startConnect(w);
    w.clock.advance(11 * 60_000);
    expect(await w.oauth.callback({ code: "c", state: s2.state })).toMatchObject({ reason: "invalid_state" });
    nothingStored(s2.connector);
    // The token request carries the verifier matching the S256 challenge and the exact redirect URI.
    w.clock.advance(-11 * 60_000);
    const s3 = await startConnect(w);
    expect(s3.url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(s3.url.searchParams.get("redirect_uri")).toBe(connectorRedirectUri());
    await w.oauth.callback({ code: "the_code", state: s3.state });
    const tokenReq = w.vendor.requests.find((r) => r.url.endsWith("/token"))!;
    expect(tokenReq.form).toMatchObject({ grant_type: "authorization_code", code: "the_code", redirect_uri: connectorRedirectUri() });
    expect(createHash("sha256").update(tokenReq.form.code_verifier).digest("base64url")).toBe(s3.challenge);
    // A cancelled consent stores nothing.
    const s4 = await startConnect(w);
    expect(await w.oauth.callback({ error: "access_denied", state: s4.state })).toMatchObject({ reason: "cancelled" });
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });

  it("discovery and dcr register once", async () => {
    const w = oauthWorld();
    await connect(w);
    const c = w.db.connector.find((r: any) => r.provider === "calendly");
    expect(c.oauthMeta).toMatchObject({ token_endpoint: "https://auth.calendly.test/token" });
    expect(c.oauthClientEnc.startsWith("enc:v1:")).toBe(true);
    await startConnect(w);
    expect(w.vendor.registrations).toBe(1);
    const reg = w.vendor.requests.find((r) => r.url.endsWith("/register"))!;
    expect(reg.json).toMatchObject({ redirect_uris: [connectorRedirectUri()], token_endpoint_auth_method: "none" });
    // HubSpot: the env app, no DCR; no env → provider_unavailable.
    const env = { id: process.env.HUBSPOT_MCP_CLIENT_ID, secret: process.env.HUBSPOT_MCP_CLIENT_SECRET };
    delete process.env.HUBSPOT_MCP_CLIENT_ID;
    delete process.env.HUBSPOT_MCP_CLIENT_SECRET;
    try {
      expect(await fail(w.oauth.start("ws1", "u_owner", "hubspot"))).toMatchObject({ status: 400, message: "connectors.provider_unavailable" });
      process.env.HUBSPOT_MCP_CLIENT_ID = "hs_client";
      process.env.HUBSPOT_MCP_CLIENT_SECRET = "hs_secret_value";
      const s = await startConnect(w, "hubspot");
      expect(s.url.origin).toBe("https://auth.hubspot.test");
      expect(s.url.searchParams.get("client_id")).toBe("hs_client");
      expect(w.vendor.registrations).toBe(1);
      await w.oauth.callback({ code: "c", state: s.state });
      const tokenReq = w.vendor.requests.filter((r) => r.url === "https://auth.hubspot.test/token").at(-1)!;
      expect(tokenReq.headers.authorization).toBe(`Basic ${Buffer.from("hs_client:hs_secret_value").toString("base64")}`);
      expect(w.db.connector.find((r: any) => r.provider === "hubspot").oauthClientEnc).toBeNull();
    } finally {
      process.env.HUBSPOT_MCP_CLIENT_ID = env.id;
      process.env.HUBSPOT_MCP_CLIENT_SECRET = env.secret;
      if (env.id === undefined) delete process.env.HUBSPOT_MCP_CLIENT_ID;
      if (env.secret === undefined) delete process.env.HUBSPOT_MCP_CLIENT_SECRET;
    }
    // Coming-soon and custom providers are not OAuth.
    for (const p of ["pipedrive", "custom", "nope"]) expect(await fail(w.oauth.start("ws1", "u_owner", p))).toMatchObject({ message: "connectors.provider_unavailable" });
  });

  it("encryption is required in production", async () => {
    const w = oauthWorld();
    const key = process.env.TOKEN_ENC_KEY;
    const nodeEnv = process.env.NODE_ENV;
    delete process.env.TOKEN_ENC_KEY;
    process.env.NODE_ENV = "production";
    try {
      expect(await fail(w.oauth.start("ws1", "u_owner", "calendly"))).toMatchObject({ status: 400, message: "connectors.encryption_unavailable" });
      expect(w.db.connector).toHaveLength(0);
      expect(w.vendor.requests).toHaveLength(0);
    } finally {
      process.env.TOKEN_ENC_KEY = key;
      process.env.NODE_ENV = nodeEnv;
    }
  });

  it("callback page posts only to the frontend origin", () => {
    const page = callbackPage({ connected: true, connectorId: "conn_1", reason: null }, "https://app.example.com", "https://app.example.com/#/agent?tab=connectors&connected=1");
    const nonce = /script-src 'nonce-([^']+)'/.exec(page.headers["Content-Security-Policy"])![1];
    expect(page.html).toContain(`<script nonce="${nonce}">`);
    expect(page.html).toContain('postMessage(m,o)');
    expect(page.html).toContain('"https://app.example.com"');
    expect(page.html).not.toContain('"*"');
    expect(page.headers).toMatchObject({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    expect(page.headers["Content-Security-Policy"]).toContain("default-src 'none'");
    expect((page.html.match(/<script/g) ?? []).length).toBe(1);
    expect(page.html).not.toMatch(/access_token|refresh_token|code=|state=/);
  });

  it("tokens, codes and verifiers are never logged or returned", async () => {
    const w = oauthWorld();
    const lines: string[] = [];
    const spies = (["log", "warn", "error", "debug", "verbose"] as const).flatMap((m) => [
      jest.spyOn(Logger.prototype, m).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" "))),
      jest.spyOn(Logger, m).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" "))),
    ]);
    try {
      const s = await startConnect(w);
      w.vendor.tokenAnswers.push({ status: 400, body: { error: "invalid_grant", error_description: "secret_code_xyz bad" } });
      await w.oauth.callback({ code: "secret_code_xyz", state: s.state });
      const { connector } = await connect(w);
      w.clock.advance(59 * 60_000);
      w.vendor.tokenAnswers.push({ status: 500, body: {} }, { status: 500, body: {} });
      await w.tokens.getAccessToken({ ...connector });
      await w.tokens.getAccessToken({ ...connector });
      const detail = JSON.stringify(await w.service.detail("ws1", connector.id));
      expect(detail).not.toMatch(/at_\d|rt_\d|code_verifier|oauthClientEnc|tokenEnc/);
      const verifier = w.vendor.requests.find((r) => r.form.code_verifier)!.form.code_verifier;
      const log = lines.join("\n");
      for (const secret of ["secret_code_xyz", verifier, "at_1", "rt_1", "dcr_client_1"]) expect({ secret, logged: log.includes(secret) }).toEqual({ secret, logged: false });
      expect(ConnectorOAuthService.storedToken(connector)).toMatchObject({ access_token: expect.any(String) });
    } finally {
      for (const sp of spies) sp.mockRestore();
    }
  });
});
