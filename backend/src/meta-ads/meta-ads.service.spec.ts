import { Logger } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Prisma } from "@prisma/client";
import { ADS_TOKEN, fakeGraph, insightRow, isolateEnv, marketingHandlers, META_ADS_ENV } from "../channels/whatsapp/test-graph";
import { decryptSecret, encryptSecret } from "../common/token-crypto";
import { resetMetaAdsTokenWarning } from "./meta-ads-token";
import { oauthStateSecret } from "./meta-ads.service";
import { caught, ENC_KEY, PROOF, seedActive, T0, world } from "./test-meta-ads";

const redirectParams = (r: { redirect: string }) => new URLSearchParams(r.redirect.split("#/ads?")[1]);

describe("Meta Ads connect", () => {
  let restore: () => void;
  let logs: jest.SpyInstance[];
  beforeEach(() => {
    restore = isolateEnv({ ...META_ADS_ENV, TOKEN_ENC_KEY: ENC_KEY });
    process.env.NODE_ENV = "test";
    resetMetaAdsTokenWarning();
    logs = (["log", "warn", "error", "debug", "verbose"] as const).map((m) => jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined));
  });
  afterEach(() => {
    restore();
    jest.restoreAllMocks();
  });
  const logged = () => JSON.stringify(logs.flatMap((s) => s.mock.calls));

  it("token stored encrypted (token-crypto.ts)", async () => {
    const w = world({
      graph: fakeGraph([[/\/act_111\/insights/, { body: { data: [insightRow("6001", "2026-11-09", "3.50", { ad_name: "Spring" })] } }], ...marketingHandlers()]),
    });
    const errors: unknown[] = [];

    // Callback: the pending token is encrypted with TOKEN_ENC_KEY.
    const { url } = w.svc.start("wsA", "u_owner");
    expect(url).not.toContain(ADS_TOKEN);
    const out = await w.svc.callback({ code: "CODE-1", state: w.stateOf(url) });
    expect(redirectParams(out).get("metaAds")).toBe("choose");
    const pending = w.conn().pendingTokenEnc as string;
    expect(pending.startsWith("enc:v1:")).toBe(true);
    expect(pending).not.toBe(ADS_TOKEN);
    expect(decryptSecret(pending)).toBe(ADS_TOKEN);
    expect(w.conn().tokenEnc).toBeNull();

    // Save promotes it to tokenEnc, still encrypted.
    const dto = await w.svc.save("wsA", "u_owner", { adAccountId: "act_111", pageId: "900" });
    expect(dto.status).toBe("active");
    expect(dto.connectedBy).toEqual({ id: "u_owner", name: "Olivia Owner" });
    expect(w.conn().tokenEnc).toBe(pending);
    expect(w.conn().pendingTokenEnc).toBeNull();
    expect(decryptSecret(w.conn().tokenEnc)).toBe(ADS_TOKEN);

    // Errors thrown along the way carry no token.
    errors.push(await caught(w.svc.save("wsA", "u_owner", { adAccountId: "act_111" })));
    errors.push(await caught(w.svc.candidates("wsA")));

    // The check and the sync read it through decryptSecret and send Bearer + appsecret_proof.
    w.graph.calls.length = 0;
    await w.svc.check("wsA", T0);
    errors.push(await caught(w.svc.check("wsA", new Date(T0.getTime() + 1000))));
    await w.scheduler.sweep(T0);
    const tokenCalls = w.graph.calls.filter((c) => !c.url.includes("/oauth/"));
    expect(tokenCalls.map((c) => new URL(c.url).pathname)).toEqual(
      expect.arrayContaining(["/v23.0/me", "/v23.0/act_111", "/v23.0/act_111/insights"]),
    );
    for (const c of tokenCalls) {
      expect(c.headers.Authorization).toBe(`Bearer ${ADS_TOKEN}`);
      expect(new URL(c.url).searchParams.get("appsecret_proof")).toBe(PROOF());
    }
    expect(w.prisma.db.adSpendDaily).toHaveLength(1);

    // The raw row, the DTO, every error and every log line hold neither the token nor the proof.
    const views = [
      JSON.stringify(w.prisma.db.metaAdsConnection),
      JSON.stringify(await w.svc.connection("wsA", true)),
      JSON.stringify(await w.svc.connection("wsA", false)),
      JSON.stringify(errors),
      logged(),
    ];
    for (const v of views) {
      expect(v).not.toContain(ADS_TOKEN);
      expect(v).not.toContain(PROOF());
    }
    const dtoText = JSON.stringify(await w.svc.connection("wsA", true));
    expect(dtoText).not.toContain("enc:v1:");
    expect(dtoText).not.toMatch(/tokenEnc|pendingTokenEnc/);
  });

  it("production without TOKEN_ENC_KEY refuses to store a meta ads token", async () => {
    restore();
    restore = isolateEnv({ ...META_ADS_ENV });
    process.env.NODE_ENV = "production";
    const w = world();
    const start = await caught(Promise.resolve().then(() => w.svc.start("wsA", "u_owner")));
    expect(start).toEqual({ status: 400, body: { statusCode: 400, message: "meta_ads.encryption_unavailable" } });
    // A state minted earlier (e.g. before the key was removed) still cannot store anything.
    const state = w.signState({});
    const out = await w.svc.callback({ code: "CODE-1", state });
    expect(Object.fromEntries(redirectParams(out))).toEqual({ tab: "connection", metaAds: "error", code: "encryption_unavailable" });
    expect(w.prisma.db.metaAdsConnection).toHaveLength(0);
    expect(w.graph.calls).toHaveLength(0);
    expect((await w.svc.connection("wsA", true)).config).toEqual({ ready: false, missing: ["TOKEN_ENC_KEY"] });
    expect((await w.svc.connection("wsA", false)).config).toEqual({ ready: false });
  });

  it("in dev without TOKEN_ENC_KEY it stores plaintext with one warning that has no token", async () => {
    restore();
    restore = isolateEnv({ ...META_ADS_ENV });
    process.env.NODE_ENV = "development";
    const w = world();
    for (let i = 0; i < 2; i++) {
      const out = await w.svc.callback({ code: `CODE-${i}`, state: w.stateOf(w.svc.start("wsA", "u_owner").url) });
      expect(redirectParams(out).get("metaAds")).toBe("choose");
    }
    expect(w.conn().pendingTokenEnc).toBe(ADS_TOKEN);
    const warns = (logs[1].mock.calls as unknown[][]).filter((c) => String(c[0]).includes("TOKEN_ENC_KEY"));
    expect(warns).toHaveLength(1);
    expect(logged()).not.toContain(ADS_TOKEN);
  });

  it("start needs the app settings: 400 meta_ads.not_configured {missing}", async () => {
    restore();
    restore = isolateEnv({ TOKEN_ENC_KEY: ENC_KEY, META_ADS_APP_ID: "1" });
    const w = world();
    const e = await caught(Promise.resolve().then(() => w.svc.start("wsA", "u_owner")));
    expect(e).toEqual({ status: 400, body: { statusCode: 400, message: "meta_ads.not_configured", missing: ["META_ADS_APP_SECRET", "META_ADS_LOGIN_CONFIG_ID"] } });
  });

  it("start builds the Login for Business dialog URL", () => {
    process.env.BACKEND_PUBLIC_URL = "https://api.example.com";
    try {
      const w = world();
      const url = new URL(w.svc.start("wsA", "u_owner").url);
      expect(url.origin + url.pathname).toBe("https://www.facebook.com/v23.0/dialog/oauth");
      expect(url.searchParams.get("client_id")).toBe(META_ADS_ENV.META_ADS_APP_ID);
      expect(url.searchParams.get("config_id")).toBe(META_ADS_ENV.META_ADS_LOGIN_CONFIG_ID);
      expect(url.searchParams.get("response_type")).toBe("code");
      expect(url.searchParams.get("redirect_uri")).toBe("https://api.example.com/api/meta-ads/oauth/callback");
      expect(url.toString()).not.toContain(META_ADS_ENV.META_ADS_APP_SECRET);
      const st = w.jwt.verify(url.searchParams.get("state")!, { secret: oauthStateSecret(), audience: "meta-ads-oauth" });
      expect(st).toMatchObject({ workspaceId: "wsA", userId: "u_owner", purpose: "meta_ads_oauth" });
    } finally {
      delete process.env.BACKEND_PUBLIC_URL;
    }
  });

  describe("oauth state is bound to workspace, user and purpose", () => {
    const expectRefused = async (w: ReturnType<typeof world>, state: string, code: string) => {
      const out = await w.svc.callback({ code: "CODE-1", state });
      expect(Object.fromEntries(redirectParams(out))).toEqual({ tab: "connection", metaAds: "error", code });
      expect(w.prisma.db.metaAdsConnection).toHaveLength(0);
      expect(w.graph.calls).toHaveLength(0);
    };

    it("an expired state is refused", async () => {
      const w = world();
      const state = w.signState({}, -5);
      await expectRefused(w, state, "invalid_state");
    });

    it("a wrong purpose is refused", async () => {
      const w = world();
      await expectRefused(w, w.signState({ purpose: "fb_oauth" }), "invalid_state");
    });

    it("a state signed with another secret is refused", async () => {
      const w = world();
      const forged = new JwtService({ secret: "another-secret-0123456789-0123456789" }).sign(
        { workspaceId: "wsA", userId: "u_owner", nonce: "n", purpose: "meta_ads_oauth" },
        { expiresIn: "10m" },
      );
      await expectRefused(w, forged, "invalid_state");
      await expectRefused(w, "", "invalid_state");
    });

    it("the state is signed apart from sessions: a session-secret token is no state, and a state is no session", async () => {
      const w = world();
      // Right payload, signed with the session secret (as AuthModule signs logins): refused.
      const sessionSigned = w.jwt.sign({ workspaceId: "wsA", userId: "u_owner", nonce: "n", purpose: "meta_ads_oauth" }, { expiresIn: "10m" });
      await expectRefused(w, sessionSigned, "invalid_state");
      // A real state does not verify as a session token.
      const state = w.stateOf(w.svc.start("wsA", "u_owner").url);
      expect(() => w.jwt.verify(state)).toThrow();
    });

    it("the oauth state is single-use", async () => {
      const w = world();
      const state = w.stateOf(w.svc.start("wsA", "u_owner").url);
      expect(redirectParams(await w.svc.callback({ code: "CODE-1", state })).get("metaAds")).toBe("choose");
      const first = w.conn().pendingTokenEnc;
      w.graph.calls.length = 0;
      // A replay with another code stores nothing and calls nothing.
      const replay = await w.svc.callback({ code: "CODE-OTHER", state });
      expect(Object.fromEntries(redirectParams(replay))).toEqual({ tab: "connection", metaAds: "error", code: "invalid_state" });
      expect(w.graph.calls).toHaveLength(0);
      expect(w.conn().pendingTokenEnc).toBe(first);
      // A cancelled callback uses its state up too.
      const cancelled = w.stateOf(w.svc.start("wsA", "u_owner").url);
      await w.svc.callback({ state: cancelled, error: "access_denied" });
      expect(redirectParams(await w.svc.callback({ code: "CODE-2", state: cancelled })).get("code")).toBe("invalid_state");
    });

    it("oauth callback refuses a state whose user lost connectors.manage", async () => {
      const w = world();
      const state = w.stateOf(w.svc.start("wsA", "u_admin").url);
      // The guard cached the admin's role at start; the admin is then demoted.
      await w.perm.effective("wsA", "u_admin");
      w.prisma.db.workspaceMember.find((m: { userId: string }) => m.userId === "u_admin").role = "agent";
      await expectRefused(w, state, "forbidden");
      // A state for a user who is not a member of that workspace is refused too.
      await expectRefused(w, w.stateOf(w.svc.start("wsA", "u_ownerB").url), "forbidden");
    });

    it("a user cancelling at Meta is an error key, never Meta's text", async () => {
      const w = world();
      const out = await w.svc.callback({ state: w.stateOf(w.svc.start("wsA", "u_owner").url), error: "access_denied" });
      expect(Object.fromEntries(redirectParams(out))).toEqual({ tab: "connection", metaAds: "error", code: "cancelled" });
    });

    it("a valid state sets pendingTokenEnc and leaves the active tokenEnc untouched", async () => {
      const w = world();
      const active = seedActive(w);
      const before = active.tokenEnc;
      const out = await w.svc.callback({ code: "CODE-2", state: w.stateOf(w.svc.start("wsA", "u_lead").url) });
      expect(redirectParams(out).get("metaAds")).toBe("choose");
      expect(w.conn().tokenEnc).toBe(before);
      expect(w.conn().status).toBe("active");
      expect(decryptSecret(w.conn().pendingTokenEnc)).toBe(ADS_TOKEN);
      expect((await w.svc.connection("wsA", true)).hasPendingLogin).toBe(true);
    });

    it("a failed code exchange redirects with a key and stores nothing", async () => {
      const w = world({ graph: fakeGraph([["/oauth/access_token", { status: 400, body: { error: { code: 100, message: `bad ${ADS_TOKEN}` } } }]]) });
      const out = await w.svc.callback({ code: "CODE-3", state: w.stateOf(w.svc.start("wsA", "u_owner").url) });
      expect(Object.fromEntries(redirectParams(out))).toEqual({ tab: "connection", metaAds: "error", code: "exchange_failed" });
      expect(w.prisma.db.metaAdsConnection).toHaveLength(0);
      expect(out.redirect).not.toContain("bad");
    });
  });

  describe("save checks assets against a fresh candidates read", () => {
    const connectPending = async (w: ReturnType<typeof world>) => {
      await w.svc.callback({ code: "CODE-1", state: w.stateOf(w.svc.start("wsA", "u_owner").url) });
    };

    it("candidates lists the ad accounts and Pages the pending token reaches", async () => {
      const w = world();
      await connectPending(w);
      expect(await w.svc.candidates("wsA")).toEqual({
        adAccounts: [
          { id: "act_111", name: "Main account", currency: "USD", timezone: "Asia/Riyadh", accountStatus: 1 },
          { id: "act_222", name: "Second account", currency: "EUR", timezone: "UTC", accountStatus: 1 },
        ],
        pages: [{ id: "900", name: "Shop page" }],
        scopes: ["ads_read", "business_management", "pages_show_list"],
      });
    });

    it("an adAccountId or pageId not in the read is 400 meta_ads.unknown_asset {ids}", async () => {
      const w = world();
      await connectPending(w);
      expect(await caught(w.svc.save("wsA", "u_owner", { adAccountId: "act_999" }))).toEqual({
        status: 400,
        body: { statusCode: 400, message: "meta_ads.unknown_asset", ids: ["act_999"] },
      });
      expect(await caught(w.svc.save("wsA", "u_owner", { adAccountId: "act_111", pageId: "901" }))).toEqual({
        status: 400,
        body: { statusCode: 400, message: "meta_ads.unknown_asset", ids: ["901"] },
      });
      expect((await caught(w.svc.save("wsA", "u_owner", { adAccountId: "../x" }))).body.message).toBe("meta_ads.unknown_asset");
      expect(w.conn().tokenEnc).toBeNull();
      expect(w.conn().pendingTokenEnc).not.toBeNull();
    });

    it("a pending token replaced between read and promote is 409 meta_ads.connection_changed", async () => {
      const w = world();
      await connectPending(w);
      w.graph.prepend([
        "/me/adaccounts",
        () => {
          // Another login lands while this save reads the candidates.
          w.conn().pendingTokenEnc = encryptSecret("EAAB-other-login");
          return { body: { data: [{ id: "act_111", name: "Main account", currency: "USD", timezone_name: "UTC" }] } };
        },
      ]);
      expect(await caught(w.svc.save("wsA", "u_owner", { adAccountId: "act_111" }))).toEqual({
        status: 409,
        body: { statusCode: 409, message: "meta_ads.connection_changed" },
      });
      expect(w.conn().tokenEnc).toBeNull();
      expect(w.conn().status).toBe("pending");
    });

    it("no pending token is 409 meta_ads.not_exchanged", async () => {
      const w = world();
      expect(await caught(w.svc.save("wsA", "u_owner", { adAccountId: "act_111" }))).toEqual({
        status: 409,
        body: { statusCode: 409, message: "meta_ads.not_exchanged" },
      });
      expect((await caught(w.svc.candidates("wsA"))).body.message).toBe("meta_ads.not_exchanged");
    });

    it("a login without ads_read is 400 meta_ads.no_ads_permission", async () => {
      const w = world({ graph: fakeGraph(marketingHandlers({ scopes: ["business_management"] })) });
      await connectPending(w);
      expect(await caught(w.svc.save("wsA", "u_owner", { adAccountId: "act_111" }))).toEqual({
        status: 400,
        body: { statusCode: 400, message: "meta_ads.no_ads_permission" },
      });
      expect(w.conn().tokenEnc).toBeNull();
    });

    it("a token Meta refuses during the read is 409 meta_ads.reconnect {token}", async () => {
      const w = world();
      await connectPending(w);
      w.graph.prepend(["/me/permissions", { status: 400, body: { error: { code: 190, message: "expired" } } }]);
      expect(await caught(w.svc.candidates("wsA"))).toEqual({
        status: 409,
        body: { statusCode: 409, message: "meta_ads.reconnect", token: "pending" },
      });
    });

    it("an expired pending login is 400 meta_ads.login_expired", async () => {
      const w = world();
      await connectPending(w);
      w.conn().pendingExpiresAt = new Date(Date.now() - 1000);
      expect((await caught(w.svc.save("wsA", "u_owner", { adAccountId: "act_111" }))).body.message).toBe("meta_ads.login_expired");
    });

    it("candidates are paged by cursor (up to 1000), so account 150 can be chosen", async () => {
      const page = (k: number) => ({
        body: {
          data: Array.from({ length: 100 }, (_, i) => ({ id: `act_${k * 100 + i + 1}`, name: `A${k * 100 + i + 1}`, currency: "USD", timezone_name: "UTC" })),
          paging: { cursors: { after: `C${k + 1}` }, next: `https://graph.facebook.com/next?access_token=SECRET&after=C${k + 1}` },
        },
      });
      const w = world({
        graph: fakeGraph([
          [/\/me\/adaccounts.*after=C1(&|$)/, page(1)],
          [/\/me\/adaccounts.*after=C2(&|$)/, { body: { data: [{ id: "act_201", name: "Last", currency: "USD" }] } }],
          ["/me/adaccounts", page(0)],
          ...marketingHandlers(),
        ]),
      });
      await connectPending(w);
      expect((await w.svc.candidates("wsA")).adAccounts).toHaveLength(201);
      const dto = await w.svc.save("wsA", "u_owner", { adAccountId: "act_150" });
      expect(dto).toMatchObject({ status: "active", adAccountId: "act_150", adAccountName: "A150" });
    });

    it("a valid save activates the chosen account and Page and schedules the first sync", async () => {
      const w = world();
      await connectPending(w);
      const dto = await w.svc.save("wsA", "u_owner", { adAccountId: "act_111", pageId: "900" });
      expect(dto).toMatchObject({
        status: "active",
        adAccountId: "act_111",
        adAccountName: "Main account",
        currency: "USD",
        timezone: "Asia/Riyadh",
        pageId: "900",
        pageName: "Shop page",
        hasPendingLogin: false,
        spendBackfilled: false,
        config: { ready: true },
      });
      expect(w.conn().syncAttemptedAt).toBeNull();
      expect(w.conn().scopes).toBe("ads_read,business_management,pages_show_list");
    });
  });

  describe("the choose step expires 1 hour after the exchange", () => {
    const HOUR = 3_600_000;

    it("even when Meta reports no expiry (a system-user token)", async () => {
      const w = world();
      let now = T0.getTime();
      w.svc.clock = () => new Date(now);
      await w.svc.callback({ code: "CODE-1", state: w.stateOf(w.svc.start("wsA", "u_owner").url) });
      expect(w.conn().pendingExpiresAt).toEqual(new Date(T0.getTime() + HOUR));
      expect((await w.svc.connection("wsA", true)).hasPendingLogin).toBe(true);

      now += HOUR + 60_000;
      expect((await w.svc.connection("wsA", true)).hasPendingLogin).toBe(false);
      expect(await caught(w.svc.candidates("wsA"))).toEqual({ status: 400, body: { statusCode: 400, message: "meta_ads.login_expired" } });
      // The expired pending token is cleared on read; nothing is left to promote.
      expect(w.conn()).toMatchObject({ pendingTokenEnc: null, pendingExpiresAt: null });
      expect((await caught(w.svc.save("wsA", "u_owner", { adAccountId: "act_111" }))).body.message).toBe("meta_ads.not_exchanged");
    });

    it("save keeps the token's own expiry from Meta (60-day user token, or none)", async () => {
      const exp = Math.floor((T0.getTime() + 60 * 24 * HOUR) / 1000);
      const w = world({ graph: fakeGraph([["/debug_token", { body: { data: { is_valid: true, expires_at: exp } } }], ...marketingHandlers()]) });
      let now = T0.getTime();
      w.svc.clock = () => new Date(now);
      await w.svc.callback({ code: "CODE-1", state: w.stateOf(w.svc.start("wsA", "u_owner").url) });
      now += 30 * 60_000;
      const dto = await w.svc.save("wsA", "u_owner", { adAccountId: "act_111" });
      expect(dto.tokenExpiresAt).toEqual(new Date(exp * 1000));
      // The app secret goes to Graph only, never to a log or the row.
      const dbg = w.graph.called("/debug_token")[0];
      expect(new URL(dbg.url).searchParams.get("input_token")).toBe(ADS_TOKEN);
      expect(JSON.stringify(w.prisma.db.metaAdsConnection)).not.toContain(META_ADS_ENV.META_ADS_APP_SECRET);

      const sys = world();
      await sys.svc.callback({ code: "CODE-1", state: sys.stateOf(sys.svc.start("wsA", "u_owner").url) });
      expect((await sys.svc.save("wsA", "u_owner", { adAccountId: "act_111" })).tokenExpiresAt).toBeNull();
    });
  });

  it("check is rate-limited per workspace and survives restart", async () => {
    const w = world();
    seedActive(w);
    const dto = await w.svc.check("wsA", T0);
    expect(dto.status).toBe("active");
    expect(w.graph.calls).toHaveLength(2);

    // 30 s later, from a fresh service instance (a restart or another machine).
    const w2 = world({ prisma: w.prisma });
    const e = await caught(w2.svc.check("wsA", new Date(T0.getTime() + 30_000)));
    expect(e).toEqual({
      status: 429,
      body: { statusCode: 429, message: "meta_ads.check_cooldown", retryAfter: 30, nextAt: new Date(T0.getTime() + 60_000).toISOString() },
    });
    expect(w2.graph.calls).toHaveLength(0);

    await w2.svc.check("wsA", new Date(T0.getTime() + 61_000));
    expect(w2.graph.calls).toHaveLength(2);
    // Another workspace has its own cooldown (and no connection: 409).
    expect((await caught(w.svc.check("wsB", T0))).body.message).toBe("meta_ads.not_connected");
  });

  it("check with a refused token parks the connection and notifies once", async () => {
    const w = world({ graph: fakeGraph([["/me?", { status: 400, body: { error: { code: 190 } } }], ...marketingHandlers()]) });
    seedActive(w);
    const dto = await w.svc.check("wsA", T0);
    expect(dto).toMatchObject({ status: "needs_reconnect", statusReason: "token_refused" });
    expect(w.notify).toHaveBeenCalledTimes(1);
    // A second refusal finds it already parked: no further notification.
    const again = await w.svc.check("wsA", new Date(T0.getTime() + 61_000));
    expect(again.status).toBe("needs_reconnect");
    expect(w.notify).toHaveBeenCalledTimes(1);
  });

  it("check of other Graph failures is 502 meta_ads.meta_refused {graphCode}", async () => {
    const w = world({ graph: fakeGraph([["/me?", { status: 400, body: { error: { code: 17 } } }], ...marketingHandlers()]) });
    seedActive(w);
    expect(await caught(w.svc.check("wsA", T0))).toEqual({ status: 502, body: { statusCode: 502, message: "meta_ads.meta_refused", graphCode: 17 } });
    expect(w.conn().status).toBe("active");
  });

  it("disconnect wipes tokens and keeps history", async () => {
    const w = world();
    // Synced (backfilled and last synced at T0): the spend before disconnect is known.
    seedActive(w, { pendingTokenEnc: encryptSecret("EAAB-pending"), spendBackfilledAt: T0, lastSyncedAt: T0 });
    w.prisma.db.adSource.push({ id: "ad1", workspaceId: "wsA", sourceType: "ad", sourceId: "6001", adAccountId: "act_111", lastReferredAt: T0 });
    w.prisma.db.adReferral.push({ id: "r1", workspaceId: "wsA", adSourceId: "ad1", conversationId: "cv1", contactId: "c1", messageId: "m1", provider: "meta", referredAt: new Date("2026-11-08T10:00:00.000Z") });
    w.prisma.db.adSpendDaily.push({
      id: "s1",
      workspaceId: "wsA",
      adSourceId: "ad1",
      adAccountId: "act_111",
      date: new Date("2026-11-09T00:00:00.000Z"),
      spend: new Prisma.Decimal("12.5"),
      currency: "USD",
      syncedAt: T0,
    });
    const before = await w.metrics.overview("wsA", { from: "2026-11-01", to: "2026-11-10" }, T0);
    expect(before.ads[0]).toMatchObject({ started: 1, spend: { amount: 12.5, currency: "USD" }, costPerConversation: 12.5 });

    for (let i = 0; i < 2; i++) {
      const dto = await w.svc.disconnect("wsA");
      expect(dto.status).toBe("disconnected");
      expect(w.conn()).toMatchObject({ tokenEnc: null, pendingTokenEnc: null, status: "disconnected" });
      expect(w.prisma.db.adSpendDaily).toHaveLength(1);
    }
    expect(w.graph.calls).toHaveLength(0);
    const after = await w.metrics.overview("wsA", { from: "2026-11-01", to: "2026-11-10" }, T0);
    expect(after.ads[0]).toMatchObject({ started: 1, spend: null, costPerConversation: null });
    expect(after.totals.byCurrency).toEqual([]);
    // A workspace that never connected: disconnect is a no-op.
    expect((await w.svc.disconnect("wsB")).status).toBe("not_connected");
  });
});
