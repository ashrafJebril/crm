import { HttpException } from "@nestjs/common";
import { ZernioClient, ZernioRateLimitError } from "./zernio.client";

/** SP-14: GET /whatsapp/number-info and the template quality passthrough (mocked fetch). */
describe("ZernioClient number health", () => {
  let fetchMock: jest.Mock;
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    fetchMock.mockResolvedValueOnce({
      ok: status < 400,
      status,
      text: () => Promise.resolve(JSON.stringify(body)),
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    });

  beforeEach(() => {
    process.env.ZERNIO_API_KEY = "test-key";
    delete process.env.ZERNIO_BASE_URL;
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it("whatsappNumberInfo calls GET /whatsapp/number-info with the account id", async () => {
    reply(200, {
      phone: { quality_rating: "GREEN", messaging_limit_tier: "TIER_1K", name_status: "APPROVED", status: "CONNECTED" },
      waba: { id: "w1" },
    });
    const out = await new ZernioClient().whatsappNumberInfo("acc 1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://zernio.com/api/v1/whatsapp/number-info?accountId=acc+1");
    expect(init.method).toBe("GET");
    expect(out).toEqual({
      phone: { quality_rating: "GREEN", messaging_limit_tier: "TIER_1K", name_status: "APPROVED", status: "CONNECTED" },
      waba: { id: "w1" },
    });
  });

  it("accepts a data wrapper and tolerates missing objects", async () => {
    reply(200, { data: { phone: { status: "CONNECTED" } } });
    expect(await new ZernioClient().whatsappNumberInfo("a")).toEqual({ phone: { status: "CONNECTED" } });
    reply(200, { phone: "nope", waba: [] });
    expect(await new ZernioClient().whatsappNumberInfo("a")).toEqual({});
    reply(200, null);
    expect(await new ZernioClient().whatsappNumberInfo("a")).toEqual({});
  });

  it("a 404 surfaces as a 404 and a 429 as ZernioRateLimitError", async () => {
    reply(404, { error: "Account not found" });
    const e = await new ZernioClient().whatsappNumberInfo("a").catch((x) => x);
    expect(e).toBeInstanceOf(HttpException);
    expect(e.getStatus()).toBe(404);
    reply(429, { error: "slow down" }, { "retry-after": "3" });
    const r = await new ZernioClient().whatsappNumberInfo("a").catch((x) => x);
    expect(r).toBeInstanceOf(ZernioRateLimitError);
    expect(r.retryAfterMs).toBe(3000);
  });

  it("whatsappTemplates passes quality_score through when Zernio sends it", async () => {
    reply(200, {
      templates: [
        { id: "t1", name: "a", status: "APPROVED", category: "UTILITY", language: "en", quality_score: { score: "GREEN" } },
        { id: "t2", name: "b", status: "PAUSED", category: "UTILITY", language: "en" },
      ],
    });
    const out = await new ZernioClient().whatsappTemplates("a");
    expect(out[0].quality_score).toEqual({ score: "GREEN" });
    expect(out[1].quality_score).toBeUndefined();
  });
});
