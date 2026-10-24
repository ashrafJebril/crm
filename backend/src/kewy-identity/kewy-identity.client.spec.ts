import { KewyIdentityClient, KEWY_IDP_SECRET_HEADER } from "./kewy-identity.client";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

describe("KewyIdentityClient", () => {
  const env = { ...process.env };
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    process.env.KEWY_IDP_URL = "https://kewy.test/api/idp/v1/";
    process.env.KEWY_IDP_SECRET = "s3cret";
    fetchMock = jest.spyOn(global, "fetch");
  });
  afterEach(() => {
    fetchMock.mockRestore();
    process.env = { ...env };
  });

  const client = new KewyIdentityClient();

  it("sends the secret header, JSON body and a timeout signal", async () => {
    fetchMock.mockResolvedValue(json(200, { accountId: "a1", identities: [], tenants: [] }));
    const r = await client.authenticate({ identifier: "a@b.co", password: "pw", clientIp: "1.2.3.4" });
    expect(r).toEqual({ kind: "ok", status: 200, data: expect.objectContaining({ accountId: "a1" }) });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://kewy.test/api/idp/v1/authenticate");
    expect(init.method).toBe("POST");
    expect(init.headers[KEWY_IDP_SECRET_HEADER]).toBe("s3cret");
    expect(JSON.parse(init.body)).toEqual({ identifier: "a@b.co", password: "pw", clientIp: "1.2.3.4" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("url-encodes the external user id", async () => {
    fetchMock.mockResolvedValue(json(200, { removed: true }));
    await client.deleteIdentity("a/b c");
    expect(fetchMock.mock.calls[0][0]).toBe("https://kewy.test/api/idp/v1/identities/a%2Fb%20c");
    expect(fetchMock.mock.calls[0][1].method).toBe("DELETE");
  });

  it.each([
    [401, "INVALID_CREDENTIALS"],
    [403, "ACCOUNT_DISABLED"],
    [404, "IDENTITY_NOT_FOUND"],
    [401, "UNAUTHORIZED_PRODUCT"],
  ])("classifies %i %s as a definite rejection", async (status, code) => {
    fetchMock.mockResolvedValue(json(status, { error: code }));
    expect(await client.authenticate({ identifier: "a@b.co", password: "x" })).toEqual({
      kind: "rejected",
      status,
      code,
    });
  });

  it("carries retryAfterSec on a 429", async () => {
    fetchMock.mockResolvedValue(json(429, { error: "RATE_LIMITED", retryAfterSec: 120 }, { "retry-after": "120" }));
    expect(await client.authenticate({ identifier: "a@b.co", password: "x" })).toEqual({
      kind: "rejected",
      status: 429,
      code: "RATE_LIMITED",
      retryAfterSec: 120,
    });
  });

  it("falls back to an HTTP_<status> code for a 4xx without a JSON body", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 400 }));
    expect(await client.mirrorIdentity({ externalUserId: "u1" })).toEqual({
      kind: "rejected",
      status: 400,
      code: "HTTP_400",
    });
  });

  it.each([500, 502, 503])("classifies %i as unreachable", async (status) => {
    fetchMock.mockResolvedValue(json(status, { error: "INTERNAL" }));
    expect(await client.authenticate({ identifier: "a@b.co", password: "x" })).toEqual({
      kind: "unreachable",
      reason: `HTTP ${status}`,
      status,
    });
  });

  it("classifies a network error as unreachable", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const r = await client.authenticate({ identifier: "a@b.co", password: "x" });
    expect(r).toEqual({ kind: "unreachable", reason: "network error: fetch failed" });
  });

  it("classifies a timeout as unreachable", async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
    const r = await client.authenticate({ identifier: "a@b.co", password: "x" });
    expect(r).toEqual({ kind: "unreachable", reason: "timeout after 5000ms" });
  });

  it("classifies an unparseable 2xx body as unreachable", async () => {
    fetchMock.mockResolvedValue(new Response("<html>", { status: 200 }));
    const r = await client.authenticate({ identifier: "a@b.co", password: "x" });
    expect(r).toMatchObject({ kind: "unreachable", status: 200 });
  });

  it("does not call out when not configured", async () => {
    delete process.env.KEWY_IDP_SECRET;
    expect(client.configured).toBe(false);
    expect(await client.authenticate({ identifier: "a@b.co", password: "x" })).toEqual({
      kind: "unreachable",
      reason: "not configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
