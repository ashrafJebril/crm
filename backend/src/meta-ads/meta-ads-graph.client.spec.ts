import { Logger } from "@nestjs/common";
import { createHmac } from "node:crypto";
import { ADS_TOKEN, fakeGraph, insightRow, isolateEnv, marketingHandlers, META_ADS_ENV } from "../channels/whatsapp/test-graph";
import { appSecretProof, classifyGraphError, MetaAdsGraphClient, MetaAdsGraphError } from "./meta-ads-graph.client";

describe("classifyGraphError", () => {
  const table: Array<[number | null, number | null, number, string]> = [
    [190, null, 400, "token"],
    [190, 463, 400, "token"],
    [102, null, 400, "token"],
    [463, null, 400, "token"],
    [467, null, 400, "token"],
    [4, null, 400, "rate_limit"],
    [17, null, 400, "rate_limit"],
    [32, null, 400, "rate_limit"],
    [613, null, 400, "rate_limit"],
    [80000, null, 400, "rate_limit"],
    [80004, null, 400, "rate_limit"],
    [80014, null, 400, "rate_limit"],
    [null, null, 429, "rate_limit"],
    [10, null, 403, "refused"],
    [200, null, 403, "refused"],
    [272, null, 400, "refused"],
    [299, null, 400, "refused"],
    [100, 33, 400, "refused"],
    [100, null, 400, "permanent"],
    [80015, null, 400, "permanent"],
    [null, null, 0, "transient"],
    [null, null, 503, "transient"],
    [1, null, 500, "transient"],
    [2, null, 400, "transient"],
    [null, null, 404, "permanent"],
  ];
  it.each(table)("code %p subcode %p status %p → %s", (code, subcode, status, kind) => {
    expect(classifyGraphError(code, subcode, status)).toBe(kind);
  });
});

describe("MetaAdsGraphClient", () => {
  let restore: () => void;
  let logs: jest.SpyInstance[];
  beforeEach(() => {
    restore = isolateEnv({ ...META_ADS_ENV });
    logs = (["log", "warn", "error", "debug"] as const).map((m) => jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined));
  });
  afterEach(() => {
    restore();
    jest.restoreAllMocks();
  });
  const logged = () => JSON.stringify(logs.flatMap((s) => s.mock.calls));

  it("sends Bearer + appsecret_proof to graph.facebook.com at META_ADS_GRAPH_VERSION", async () => {
    const g = fakeGraph(marketingHandlers());
    await new MetaAdsGraphClient(g.fetch).me(ADS_TOKEN);
    const call = g.calls[0];
    const url = new URL(call.url);
    expect(url.origin).toBe("https://graph.facebook.com");
    expect(url.pathname).toBe("/v23.0/me");
    expect(call.headers.Authorization).toBe(`Bearer ${ADS_TOKEN}`);
    const expected = createHmac("sha256", META_ADS_ENV.META_ADS_APP_SECRET).update(ADS_TOKEN).digest("hex");
    expect(url.searchParams.get("appsecret_proof")).toBe(expected);
    expect(appSecretProof(ADS_TOKEN, META_ADS_ENV.META_ADS_APP_SECRET)).toBe(expected);
    // The token itself never rides in the query.
    expect(call.url).not.toContain(ADS_TOKEN);
  });

  it("falls back to META_GRAPH_VERSION and honours only a loopback base", async () => {
    restore();
    restore = isolateEnv({ ...META_ADS_ENV, META_ADS_GRAPH_VERSION: "latest", META_GRAPH_VERSION: "v22.0", META_GRAPH_BASE_URL: "http://127.0.0.1:4999" });
    const g = fakeGraph(marketingHandlers());
    await new MetaAdsGraphClient(g.fetch).me(ADS_TOKEN);
    expect(g.calls[0].url.startsWith("http://127.0.0.1:4999/v22.0/me?")).toBe(true);
  });

  it("insights asks for spend only (never `actions`), level=ad, daily, and follows the cursor", async () => {
    const g = fakeGraph([
      [/insights.*after=CUR2/, { body: { data: [insightRow("1", "2026-11-01", "2.00")] } }],
      [/insights/, { body: { data: [insightRow("1", "2026-11-02", "1.50")], paging: { cursors: { after: "CUR2" }, next: "https://graph.facebook.com/next?access_token=SECRET" } } }],
    ]);
    const c = new MetaAdsGraphClient(g.fetch);
    const p1 = await c.insights("act_111", ADS_TOKEN, { since: "2026-11-01", until: "2026-11-07" });
    expect(p1.after).toBe("CUR2");
    const p2 = await c.insights("act_111", ADS_TOKEN, { since: "2026-11-01", until: "2026-11-07", after: p1.after });
    expect(p2.after).toBeNull();
    const q = new URL(g.calls[0].url).searchParams;
    expect(q.get("fields")).toBe("ad_id,ad_name,adset_name,campaign_name,spend,date_start");
    expect(q.get("fields")).not.toContain("actions");
    expect(q.get("level")).toBe("ad");
    expect(q.get("time_increment")).toBe("1");
    expect(JSON.parse(q.get("time_range")!)).toEqual({ since: "2026-11-01", until: "2026-11-07" });
  });

  it("an error keeps only code, subcode, status and fbtrace_id; no message text, token or proof is logged or thrown", async () => {
    const g = fakeGraph([
      [
        "/me",
        {
          status: 400,
          body: { error: { message: `Invalid token ${ADS_TOKEN} at https://x/?access_token=${ADS_TOKEN}`, code: 190, error_subcode: 463, fbtrace_id: "TRACE1" } },
        },
      ],
    ]);
    const err = (await new MetaAdsGraphClient(g.fetch).me(ADS_TOKEN).catch((e) => e)) as MetaAdsGraphError;
    expect(err).toBeInstanceOf(MetaAdsGraphError);
    expect({ code: err.code, subcode: err.subcode, httpStatus: err.httpStatus, fbtraceId: err.fbtraceId, kind: err.kind }).toEqual({
      code: 190,
      subcode: 463,
      httpStatus: 400,
      fbtraceId: "TRACE1",
      kind: "token",
    });
    const proof = appSecretProof(ADS_TOKEN, META_ADS_ENV.META_ADS_APP_SECRET);
    const all = JSON.stringify({ message: err.message, stack: err.stack, err }) + logged();
    expect(all).not.toContain(ADS_TOKEN);
    expect(all).not.toContain(proof);
    expect(all).not.toContain("Invalid token");
    expect(all).not.toContain(META_ADS_ENV.META_ADS_APP_SECRET);
  });

  it("a network failure is transient, logged without the URL's query", async () => {
    const fetch = jest.fn(async () => {
      throw new Error(`connect ECONNREFUSED https://graph.facebook.com/v23.0/me?appsecret_proof=x&access_token=${ADS_TOKEN}`);
    });
    const err = (await new MetaAdsGraphClient(fetch as never).me(ADS_TOKEN).catch((e) => e)) as MetaAdsGraphError;
    expect(err.kind).toBe("transient");
    expect(logged()).not.toContain(ADS_TOKEN);
    expect(logged()).not.toContain("appsecret_proof");
  });

  it("the code exchange sends the app secret only to Graph and never logs it", async () => {
    const g = fakeGraph([["/oauth/access_token", { status: 400, body: { error: { code: 100, message: "bad code" } } }]]);
    await expect(new MetaAdsGraphClient(g.fetch).exchangeCode("CODE-xyz", "https://b/api/meta-ads/oauth/callback")).rejects.toBeInstanceOf(MetaAdsGraphError);
    const q = new URL(g.calls[0].url).searchParams;
    expect(q.get("client_secret")).toBe(META_ADS_ENV.META_ADS_APP_SECRET);
    expect(q.get("redirect_uri")).toBe("https://b/api/meta-ads/oauth/callback");
    expect(logged()).not.toContain(META_ADS_ENV.META_ADS_APP_SECRET);
    expect(logged()).not.toContain("CODE-xyz");
  });

  it("candidates follow the cursor (never paging.next) and stop at 1000", async () => {
    const accounts = (k: number) =>
      Array.from({ length: 100 }, (_, i) => ({ id: `act_${k * 100 + i + 1}`, name: `A${k}`, currency: "USD" }));
    const g = fakeGraph([
      [
        "/me/adaccounts",
        (url) => {
          const after = new URL(url).searchParams.get("after");
          const k = after ? Number(after.slice(1)) : 0;
          return { body: { data: accounts(k), paging: { cursors: { after: `C${k + 1}` }, next: `https://graph.facebook.com/x?access_token=${ADS_TOKEN}` } } };
        },
      ],
      [
        "/me/accounts",
        (url) =>
          new URL(url).searchParams.get("after")
            ? { body: { data: [{ id: "902", name: "B" }] } }
            : { body: { data: [{ id: "901", name: "A" }], paging: { cursors: { after: "P2" }, next: "https://x" } } },
      ],
    ]);
    const c = new MetaAdsGraphClient(g.fetch);
    const list = await c.adAccounts(ADS_TOKEN);
    expect(list).toHaveLength(1000);
    expect(list[999].id).toBe("act_1000");
    const calls = g.called("/me/adaccounts");
    expect(calls).toHaveLength(10);
    expect(calls.map((x) => new URL(x.url).searchParams.get("after"))).toEqual([null, "C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9"]);
    for (const x of calls) expect(x.url.startsWith("https://graph.facebook.com/v23.0/me/adaccounts?")).toBe(true);
    expect(await c.pages(ADS_TOKEN)).toEqual([
      { id: "901", name: "A" },
      { id: "902", name: "B" },
    ]);
  });

  it("tokenExpiry reads debug_token: 0 is never, a time is that time, invalid is a token error", async () => {
    const g = fakeGraph([["/debug_token", { body: { data: { is_valid: true, expires_at: 1_800_000_000 } } }]]);
    const c = new MetaAdsGraphClient(g.fetch);
    expect(await c.tokenExpiry(ADS_TOKEN)).toEqual(new Date(1_800_000_000_000));
    const q = new URL(g.calls[0].url).searchParams;
    expect(q.get("access_token")).toBe(`${META_ADS_ENV.META_ADS_APP_ID}|${META_ADS_ENV.META_ADS_APP_SECRET}`);
    expect(logged()).not.toContain(META_ADS_ENV.META_ADS_APP_SECRET);
    g.prepend(["/debug_token", { body: { data: { is_valid: true, expires_at: 0 } } }]);
    expect(await c.tokenExpiry(ADS_TOKEN)).toBeNull();
    g.prepend(["/debug_token", { body: { data: { is_valid: false } } }]);
    expect(((await c.tokenExpiry(ADS_TOKEN).catch((e) => e)) as MetaAdsGraphError).kind).toBe("token");
  });

  it("drops malformed ad accounts and pages", async () => {
    const g = fakeGraph([
      ["/me/adaccounts", { body: { data: [{ id: "act_1", name: "A", currency: "USD" }, { id: "1/../x" }, { id: "act_2", currency: "usd" }] } }],
      ["/me/accounts", { body: { data: [{ id: "77", name: "P" }, { id: "bad id" }] } }],
    ]);
    const c = new MetaAdsGraphClient(g.fetch);
    expect(await c.adAccounts(ADS_TOKEN)).toEqual([
      { id: "act_1", name: "A", currency: "USD", timezone: null, accountStatus: null },
      { id: "act_2", name: null, currency: null, timezone: null, accountStatus: null },
    ]);
    expect(await c.pages(ADS_TOKEN)).toEqual([{ id: "77", name: "P" }]);
  });
});
