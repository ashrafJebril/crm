/* eslint-disable @typescript-eslint/no-explicit-any */
import { connect, oauthWorld } from "./__fixtures__/oauth-world";
import { NonceStore } from "./connector-oauth-state";
import { frontendConnectorsUrl, frontendOrigin } from "./connector-oauth-config";
import { ConnectorsController } from "./connectors.controller";

describe("connector oauth: disconnect, nonces, config, controller", () => {
  it("disconnect revokes at the vendor (best effort) and wipes the tokens", async () => {
    const w = oauthWorld();
    const { connector: c } = await connect(w);
    await w.service.disconnect("ws1", c.id);
    const revokes = w.vendor.requests.filter((r) => r.url.endsWith("/revoke"));
    expect(revokes.map((r) => [r.form.token_type_hint, r.form.token])).toEqual([
      ["refresh_token", "rt_1"],
      ["access_token", "at_1"],
    ]);
    expect(c).toMatchObject({ status: "disconnected", tokenEnc: null });
    // A vendor that fails the revoke never blocks the disconnect.
    const w2 = oauthWorld();
    const { connector: c2 } = await connect(w2);
    w2.vendor.request = async () => {
      throw new Error("vendor down");
    };
    await expect(w2.service.disconnect("ws1", c2.id)).resolves.toEqual({ ok: true });
    expect(c2.status).toBe("disconnected");
  });

  it("nonces are single use and expire", () => {
    let now = 0;
    const store = new NonceStore(() => now);
    expect(store.use("a", 1000)).toBe(true);
    expect(store.use("a", 1000)).toBe(false);
    now = 10 * 60_000 + 1;
    expect(store.use("b", now + 1000)).toBe(true);
  });

  it("frontend origin and hand-off URL come from config", () => {
    expect(frontendOrigin({ FRONTEND_PUBLIC_URL: "https://app.example.com/some/path" })).toBe("https://app.example.com");
    expect(frontendConnectorsUrl({ connected: "1" }, { FRONTEND_PUBLIC_URL: "https://app.example.com" })).toBe("https://app.example.com/#/agent?tab=connectors&connected=1");
  });

  it("the callback route always answers the hand-off page with the security headers", async () => {
    const w = oauthWorld();
    const ctrl = new ConnectorsController(w.service, w.perms, w.oauth);
    const res: any = { headers: {} as Record<string, string>, body: "", code: 0 };
    res.status = (c: number) => ((res.code = c), res);
    res.set = (h: Record<string, string>) => (Object.assign(res.headers, h), res);
    res.send = (b: string) => ((res.body = b), res);
    await ctrl.oauthCallback("code", "not-a-state", undefined, res);
    expect(res.code).toBe(200);
    expect(res.headers).toMatchObject({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    expect(res.body).toContain("invalid_state");
    expect(res.body).not.toContain("not-a-state");
  });
});
