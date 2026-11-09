import { Logger } from "@nestjs/common";
import { MetaGraphClient, MetaGraphError } from "./meta-graph.client";
import { fakeGraph, graphError, isolateEnv } from "./test-graph";

describe("MetaGraphClient", () => {
  let restore: () => void;
  beforeEach(() => (restore = isolateEnv()));
  afterEach(() => {
    restore();
    jest.restoreAllMocks();
  });

  it("exchanges a code for a token; secrets stay in the query and out of every log line", async () => {
    const g = fakeGraph([["GET https://graph.facebook.com/v21.0/oauth/access_token", { body: { access_token: "BIZ-TOKEN" } }]]);
    const client = new MetaGraphClient(g.fetch);
    await expect(client.exchangeCode("app-1", "SECRET-1", "CODE/1")).resolves.toBe("BIZ-TOKEN");
    const u = new URL(g.calls[0].url);
    expect(u.searchParams.get("client_id")).toBe("app-1");
    expect(u.searchParams.get("client_secret")).toBe("SECRET-1");
    expect(u.searchParams.get("code")).toBe("CODE/1");
  });

  it("a refused exchange throws a MetaGraphError with no secret or code in it, and logs a redacted URL", async () => {
    const logs: string[] = [];
    jest.spyOn(Logger.prototype, "warn").mockImplementation((m: unknown) => void logs.push(String(m)));
    jest.spyOn(Logger.prototype, "error").mockImplementation((m: unknown) => void logs.push(String(m)));
    const g = fakeGraph([["/oauth/access_token", graphError(100, "Invalid verification code format SECRET-1 CODE-9")]]);
    const err = await new MetaGraphClient(g.fetch).exchangeCode("app-1", "SECRET-1", "CODE-9").catch((e) => e);
    expect(err).toBeInstanceOf(MetaGraphError);
    expect(err.code).toBe(100);
    const text = `${err.message} ${JSON.stringify(err)} ${logs.join(" ")}`;
    expect(text).not.toContain("SECRET-1");
    expect(text).not.toContain("CODE-9");
    expect(logs.join(" ")).toContain("client_secret=***");
  });

  it("sends the token as a Bearer header, never in the URL", async () => {
    const g = fakeGraph([
      ["POST https://graph.facebook.com/v21.0/waba-1/subscribed_apps", { body: { success: true } }],
      ["GET https://graph.facebook.com/v21.0/pn-1?fields=", { body: { id: "pn-1", display_phone_number: "+962 7 9000 0001" } }],
      ["POST https://graph.facebook.com/v21.0/pn-1/register", { body: { success: true } }],
    ]);
    const client = new MetaGraphClient(g.fetch);
    await client.subscribeApp("waba-1", "TOK");
    await client.getPhoneNumber("pn-1", "TOK");
    await client.register("pn-1", "TOK", "123456");
    for (const c of g.calls) {
      expect(c.url).not.toContain("TOK");
      expect(c.headers.Authorization).toBe("Bearer TOK");
    }
    expect(g.calls[2].body).toEqual({ messaging_product: "whatsapp", pin: "123456" });
  });

  it("subscribe with success:false is an error", async () => {
    const g = fakeGraph([["subscribed_apps", { body: { success: false } }]]);
    await expect(new MetaGraphClient(g.fetch).subscribeApp("w", "t")).rejects.toBeInstanceOf(MetaGraphError);
  });

  it("landline calls hit the documented edges", async () => {
    const g = fakeGraph([
      ["POST https://graph.facebook.com/v21.0/waba-1/phone_numbers", { body: { id: "pn-new" } }],
      ["GET https://graph.facebook.com/v21.0/waba-1/phone_numbers", { body: { data: [{ id: "pn-new", display_phone_number: "+1 555" }] } }],
      ["POST https://graph.facebook.com/v21.0/pn-new/request_code", { body: { success: true } }],
      ["POST https://graph.facebook.com/v21.0/pn-new/verify_code", { body: { success: true } }],
    ]);
    const client = new MetaGraphClient(g.fetch);
    await expect(client.addPhoneNumber("waba-1", "t", { cc: "962", phoneNumber: "65000000", verifiedName: "Shop" })).resolves.toEqual({ id: "pn-new" });
    await expect(client.listPhoneNumbers("waba-1", "t")).resolves.toEqual([{ id: "pn-new", display_phone_number: "+1 555" }]);
    await client.requestCode("pn-new", "t", "VOICE", "en_US");
    await client.verifyCode("pn-new", "t", "123456");
    expect(g.calls[0].body).toEqual({ cc: "962", phone_number: "65000000", verified_name: "Shop" });
    expect(g.calls[2].body).toEqual({ code_method: "VOICE", language: "en_US" });
    expect(g.calls[3].body).toEqual({ code: "123456" });
  });

  it("a network failure is a MetaGraphError without the original error attached", async () => {
    const fetch = jest.fn(async () => {
      throw new Error("connect ECONNREFUSED https://graph.facebook.com/oauth?client_secret=S3");
    });
    const err = await new MetaGraphClient(fetch as never).exchangeCode("a", "S3", "c").catch((e) => e);
    expect(err).toBeInstanceOf(MetaGraphError);
    expect(err.status).toBe(0);
    expect(err.cause).toBeUndefined();
    expect(err.message).not.toContain("S3");
  });

  it("honours a valid META_GRAPH_VERSION and ignores junk", async () => {
    restore();
    restore = isolateEnv({ META_GRAPH_VERSION: "v23.0" });
    const g = fakeGraph([["subscribed_apps", { body: { success: true } }]]);
    await new MetaGraphClient(g.fetch).subscribeApp("w", "t");
    expect(g.calls[0].url).toBe("https://graph.facebook.com/v23.0/w/subscribed_apps");
    process.env.META_GRAPH_VERSION = "../evil";
    await new MetaGraphClient(g.fetch).subscribeApp("w", "t");
    expect(g.calls[1].url).toBe("https://graph.facebook.com/v21.0/w/subscribed_apps");
  });
});
