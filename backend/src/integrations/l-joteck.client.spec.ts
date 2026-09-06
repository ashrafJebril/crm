import { BadGatewayException, HttpException, ServiceUnavailableException } from "@nestjs/common";
import { LJoteckClient } from "./l-joteck.client";

describe("LJoteckClient", () => {
  let client: LJoteckClient;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env.L_API_URL = "http://l.test/";
    process.env.L_JOTECK_SECRET = "shh";
    client = new LJoteckClient();
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    delete process.env.L_API_URL;
    delete process.env.L_JOTECK_SECRET;
    jest.restoreAllMocks();
  });

  it("is enabled only when both env vars are set", () => {
    expect(client.enabled).toBe(true);
    delete process.env.L_JOTECK_SECRET;
    expect(new LJoteckClient().enabled).toBe(false);
  });

  it("sends the secret header and joteck-prefixed path, trimming a trailing slash", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) });
    await client.request("/workspaces/ws-1/documents");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://l.test/api/v1/joteck/workspaces/ws-1/documents");
    expect(init.headers["x-joteck-secret"]).toBe("shh");
    expect(init.method).toBe("GET");
  });

  it("JSON-encodes a body and sets content-type", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 201, text: async () => JSON.stringify({ id: "1" }) });
    await client.request("/workspaces/ws-1/tools", { method: "POST", body: { name: "x" } });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["content-type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ name: "x" }));
  });

  it("passes formData through untouched and without a content-type header", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 202, text: async () => JSON.stringify({ id: "1" }) });
    const fd = new FormData();
    await client.request("/workspaces/ws-1/documents", { method: "POST", formData: fd });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).toBe(fd);
    expect(init.headers["content-type"]).toBeUndefined();
  });

  it("returns undefined for a 204", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204, text: async () => "" });
    await expect(client.request("/workspaces/ws-1/tools/t1")).resolves.toBeUndefined();
  });

  it("throws HttpException with the upstream status and detail message on a non-2xx", async () => {
    fetchMock.mockResolvedValue({
      ok: false, status: 409, text: async () => JSON.stringify({ detail: "already exists", code: "conflict" }),
    });
    await expect(client.request("/workspaces/ws-1/tools", { method: "POST" })).rejects.toMatchObject({
      status: 409,
      message: "already exists",
    });
  });

  it("throws BadGatewayException when the platform is unreachable", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(client.request("/workspaces/ws-1/tools")).rejects.toBeInstanceOf(BadGatewayException);
  });

  it("throws ServiceUnavailableException when not configured", async () => {
    delete process.env.L_JOTECK_SECRET;
    await expect(new LJoteckClient().request("/workspaces/ws-1/tools")).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it("is still an HttpException on the non-2xx path (subclass check)", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, text: async () => JSON.stringify({ detail: "not found" }) });
    await expect(client.request("/workspaces/ws-1/tools/t1", { method: "DELETE" })).rejects.toBeInstanceOf(
      HttpException,
    );
  });
});
