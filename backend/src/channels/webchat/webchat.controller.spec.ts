import "reflect-metadata";
import type { ExecutionContext } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { IS_PUBLIC_KEY } from "../../auth/public.decorator";
import { ROUTE_PERMISSIONS, routesOf } from "../../permissions/permission-map";
import { ChannelTransportRegistry } from "../channel-transport";
import { channelErrorKey } from "../channel-errors";
import { InboundSinkService } from "../inbound-sink.service";
import { makeFakePrisma } from "../test-prisma";
import { WebchatController } from "./webchat.controller";
import { WebchatService } from "./webchat.service";
import { WidgetOriginGuard } from "./widget-origin.guard";
import { WidgetRateLimiter, WidgetRateLimitGuard } from "./widget-rate-limit.guard";
import { mintVisitor } from "./visitor-token";

const API = "https://api.example.com";
const SECRET_TOKEN = "987654:AAF-secret_tok";

const wc = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  workspaceId: "ws_secret_1",
  kind: "webchat",
  provider: "native",
  externalId: null,
  displayName: "Shop",
  status: "active",
  isDefault: true,
  integrationId: "int_secret",
  secretsEnc: JSON.stringify({ botToken: SECRET_TOKEN }),
  webhookSecretHash: "f".repeat(64),
  config: {
    allowedOrigins: ["https://shop.example", "https://*.shop.com"],
    greeting: "Hi!",
    greetingAr: "أهلًا",
    color: "#0f766e",
    position: "start",
    askName: true,
    lang: "en",
    wabaId: "waba_secret",
    botToken: SECRET_TOKEN,
  },
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

function build(seed: Record<string, unknown[]> = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const prisma = makeFakePrisma({
    channel: [
      wc("W1"),
      wc("W2", { status: "disconnected", isDefault: false }),
      wc("T1", { kind: "telegram", provider: "telegram", externalId: "1", isDefault: false }),
    ],
    workspace: [{ id: "ws_secret_1", name: "Shop Co", lang: "ar", logoMediaId: null, brandColor: "#123456" }],
    ...seed,
  } as never);
  prisma.raw = prisma;
  const realtime = { emitToWorkspace: jest.fn(), emitToWidgetVisitor: jest.fn() };
  const sink = new InboundSinkService(prisma, realtime as never, { onInboundMessage: jest.fn(async () => {}) } as never);
  const transports = new ChannelTransportRegistry();
  const svc = new WebchatService(prisma, sink, transports, realtime as never);
  svc.onModuleInit();
  const limiter = new WidgetRateLimiter(clock.now);
  const rate = new WidgetRateLimitGuard(limiter);
  const origin = new WidgetOriginGuard(prisma);
  const ctrl = new WebchatController(svc);
  return { prisma, realtime, svc, transports, rate, origin, ctrl, clock };
}

type B = ReturnType<typeof build>;

interface Call {
  method?: "GET" | "POST";
  channelId?: string;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  /** Sent as the X-Visitor-Token header. */
  token?: string;
  ip?: string;
}

/** The Nest pipeline for one public widget route: rate-limit guard, origin
 *  guard, then the handler. Returns {status, body, headers}. */
async function call(b: B, route: "page" | "config" | "messages" | "send", c: Call = {}) {
  const headers: Record<string, string> = { host: "api.example.com", "x-forwarded-proto": "https", ...(c.token !== undefined ? { "x-visitor-token": c.token } : {}), ...(c.headers ?? {}) };
  const req: Record<string, unknown> = {
    method: c.method ?? (route === "send" ? "POST" : "GET"),
    params: { channelId: c.channelId ?? "W1" },
    query: c.query ?? {},
    body: c.body,
    headers,
    ip: c.ip ?? "10.0.0.1",
  };
  const resHeaders: Record<string, string> = {};
  const res = { setHeader: (k: string, v: string) => (resHeaders[k.toLowerCase()] = v) };
  const context = { switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) } as unknown as ExecutionContext;
  try {
    await b.rate.canActivate(context);
    await b.origin.canActivate(context);
    let out: unknown;
    if (route === "page") {
      const q = (c.query ?? {}) as Record<string, string | undefined>;
      out = await b.ctrl.page(req as never, q.embed, q.lang, q.parent, res);
    }
    if (route === "config") out = await b.ctrl.config(req as never, (c.query ?? {}) as never, res);
    if (route === "messages") out = await b.ctrl.messages(req as never, (c.query ?? {}) as never, res);
    if (route === "send") out = await b.ctrl.send(req as never, (c.body ?? {}) as never, res);
    return { status: 200, body: out, headers: resHeaders };
  } catch (e) {
    const err = e as { getStatus?: () => number; getResponse?: () => unknown };
    if (!err.getStatus) throw e;
    return { status: err.getStatus(), body: err.getResponse!(), key: channelErrorKey(e), headers: resHeaders };
  }
}

beforeAll(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "x".repeat(40);
  process.env.PUBLIC_BASE_URL = API;
});

describe("widget rejects foreign origin", () => {
  it("Origin: https://evil.example → 403 widget.origin_forbidden", async () => {
    const b = build();
    for (const route of ["config", "page"] as const) {
      const r = await call(b, route, { headers: { origin: "https://evil.example" } });
      expect(r).toMatchObject({ status: 403, key: "widget.origin_forbidden" });
    }
    const r = await call(b, "send", { headers: { origin: "https://evil.example" }, body: { body: "hi" } });
    expect(r).toMatchObject({ status: 403, key: "widget.origin_forbidden" });
    expect(b.prisma.db.message).toHaveLength(0);
  });

  it("API origin with parent=https://evil.example → 403 (query and body)", async () => {
    const b = build();
    const q = await call(b, "config", { headers: { origin: API }, query: { parent: "https://evil.example" } });
    expect(q).toMatchObject({ status: 403, key: "widget.origin_forbidden" });
    const p = await call(b, "send", { headers: { origin: API }, body: { body: "hi", parent: "https://shop.com.evil.io" } });
    expect(p).toMatchObject({ status: 403, key: "widget.origin_forbidden" });
    const page = await call(b, "page", { query: { embed: "1", parent: "https://evil.example" } });
    expect(page).toMatchObject({ status: 403, key: "widget.origin_forbidden" });
  });

  it("API origin with an allowed parent → 200", async () => {
    const b = build();
    const r = await call(b, "config", { headers: { origin: API }, query: { parent: "https://shop.example" } });
    expect(r.status).toBe(200);
    const w = await call(b, "config", { headers: { origin: API }, query: { parent: "https://a.shop.com" } });
    expect(w.status).toBe(200);
    const s = await call(b, "send", { headers: { origin: API }, body: { body: "hello", parent: "https://a.shop.com" } });
    expect(s.status).toBe(200);
  });

  it("a *.shop.com wildcard matches a.shop.com but not shop.com.evil.io", async () => {
    const b = build();
    expect((await call(b, "config", { query: { parent: "https://a.shop.com" } })).status).toBe(200);
    expect((await call(b, "config", { query: { parent: "https://shop.com.evil.io" } })).status).toBe(403);
    expect((await call(b, "config", { query: { parent: "https://shop.com" } })).status).toBe(403);
  });

  it("the direct hosted page (no Origin, no parent) is served; an allowed site's own Origin is accepted", async () => {
    const b = build();
    expect((await call(b, "config")).status).toBe(200);
    expect((await call(b, "config", { headers: { origin: "https://shop.example" } })).status).toBe(200);
  });

  it("a stored http origin is ignored in production (re-validated on read, M2)", async () => {
    const b = build({ channel: [wc("W1", { config: { allowedOrigins: ["http://localhost:5173"] } })] });
    expect((await call(b, "config", { query: { parent: "http://localhost:5173" } })).status).toBe(200);
    const old = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect((await call(b, "config", { query: { parent: "http://localhost:5173" } })).status).toBe(403);
    } finally {
      process.env.NODE_ENV = old;
    }
  });

  it("every widget route is @Public, mapped public and guarded rate-limit first, then origin", () => {
    const routes = routesOf(WebchatController);
    expect(routes.map((r) => r.key).sort()).toEqual(
      ["GET /chat/:channelId", "GET /widget.js", "GET /widget/:channelId/config", "GET /widget/:channelId/messages", "POST /widget/:channelId/messages"].sort(),
    );
    for (const r of routes) {
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, r.handler)).toBe(true);
      expect(ROUTE_PERMISSIONS[r.key]).toBe("public");
      if (r.key === "GET /widget.js") continue;
      expect(Reflect.getMetadata(GUARDS_METADATA, r.handler)).toEqual([WidgetRateLimitGuard, WidgetOriginGuard]);
    }
  });
});

describe("widget rate limit returns 429", () => {
  it("POST: 10/min per visitor, with Retry-After", async () => {
    const b = build();
    const first = await call(b, "send", { body: { body: "m0" } });
    const { visitorId, visitorToken } = first.body as { visitorId: string; visitorToken: string };
    // The minting message counts against the IP bucket only (the visitor did
    // not exist yet); then 10 verified posts per minute per visitor.
    for (let i = 1; i <= 10; i++) {
      const r = await call(b, "send", { body: { body: `m${i}`, visitorId }, token: visitorToken, ip: `10.0.1.${i}` });
      expect(r.status).toBe(200);
    }
    const r = await call(b, "send", { body: { body: "too many", visitorId }, token: visitorToken, ip: "10.0.2.1" });
    expect(r).toMatchObject({ status: 429, key: "widget.rate_limited" });
    expect(Number(r.headers["retry-after"])).toBeGreaterThan(0);
    b.clock.advance(61_000);
    expect((await call(b, "send", { body: { body: "later", visitorId }, token: visitorToken })).status).toBe(200);
  });

  it("POST: 30/min per IP and channel, across visitors", async () => {
    const b = build();
    // 30 verified visitors (minted from distinct IPs), then all post from one IP
    const visitors: Array<{ visitorId: string; visitorToken: string }> = [];
    for (let i = 0; i < 31; i++) {
      const r = await call(b, "send", { body: { body: `hi${i}` }, ip: `10.8.${i}.1` });
      visitors.push(r.body as { visitorId: string; visitorToken: string });
    }
    const post = (v: { visitorId: string; visitorToken: string }, ip = "10.0.0.1") =>
      call(b, "send", { body: { body: "m", visitorId: v.visitorId }, token: v.visitorToken, ip });
    for (let i = 0; i < 30; i++) expect((await post(visitors[i])).status).toBe(200);
    expect(await post(visitors[30])).toMatchObject({ status: 429, key: "widget.rate_limited" });
    // another IP is unaffected
    expect((await post(visitors[30], "10.9.9.9")).status).toBe(200);
  });

  it("POST without visitorId: 5 new visitors per hour per IP and channel (I2)", async () => {
    const b = build();
    for (let i = 0; i < 5; i++) expect((await call(b, "send", { body: { body: `m${i}` } })).status).toBe(200);
    const r = await call(b, "send", { body: { body: "x" } });
    expect(r).toMatchObject({ status: 429, key: "widget.rate_limited", body: { retryAfter: expect.any(Number) } });
    expect((r.body as { retryAfter: number }).retryAfter).toBeGreaterThan(60);
    expect(r.headers["retry-after"]).toBe(String((r.body as { retryAfter: number }).retryAfter));
    // no extra contact/conversation was created by the refused request
    expect(b.prisma.db.conversation).toHaveLength(5);
    // another IP may still start a chat; the same IP may again after the hour
    expect((await call(b, "send", { body: { body: "x" }, ip: "10.9.9.9" })).status).toBe(200);
    b.clock.advance(60 * 60_000 + 1);
    expect((await call(b, "send", { body: { body: "x" } })).status).toBe(200);
  });

  it("POST without visitorId: at most 200 new visitors per hour per channel, whatever the IPs (I2)", async () => {
    const b = build();
    const known = (await call(b, "send", { body: { body: "first" }, ip: "10.250.9.9" })).body as {
      visitorId: string;
      visitorToken: string;
    };
    for (let i = 1; i < 200; i++) {
      expect((await call(b, "send", { body: { body: "x" }, ip: `10.20.${i}.9` })).status).toBe(200);
      if (i % 25 === 0) b.clock.advance(61_000); // stay clear of the per-minute buckets
    }
    const r = await call(b, "send", { body: { body: "x" }, ip: "10.250.0.1" });
    expect(r).toMatchObject({ status: 429, key: "widget.rate_limited", body: { retryAfter: expect.any(Number) } });
    // a known visitor keeps chatting while new ones are capped
    const again = await call(b, "send", { body: { body: "still here", visitorId: known.visitorId }, token: known.visitorToken, ip: "10.250.0.1" });
    expect(again.status).toBe(200);
  });

  it("an unverified visitor id cannot drain someone else's bucket", async () => {
    const b = build();
    const first = await call(b, "send", { body: { body: "m0" } });
    const { visitorId, visitorToken } = first.body as { visitorId: string; visitorToken: string };
    for (let i = 0; i < 20; i++) {
      await call(b, "send", { body: { body: "spoof", visitorId }, token: "A".repeat(43), ip: `10.3.0.${i}` });
    }
    expect((await call(b, "send", { body: { body: "mine", visitorId }, token: visitorToken, ip: "10.4.0.1" })).status).toBe(200);
  });

  it("GET: 120/min per IP, using Fly-Client-IP when present", async () => {
    const b = build();
    for (let i = 0; i < 120; i++) await call(b, "config", { headers: { "fly-client-ip": "1.2.3.4" }, ip: `10.5.${i}.1` });
    const r = await call(b, "config", { headers: { "fly-client-ip": "1.2.3.4" } });
    expect(r).toMatchObject({ status: 429, key: "widget.rate_limited" });
    expect(r.headers["retry-after"]).toBeDefined();
    expect((await call(b, "config", { headers: { "fly-client-ip": "5.6.7.8" } })).status).toBe(200);
  });
});

describe("widget visitor token required to read history", () => {
  it("only the token holder reads their own thread", async () => {
    const b = build();
    const a = await call(b, "send", { body: { body: "from A", name: "Alice" } });
    const { visitorId, visitorToken } = a.body as { visitorId: string; visitorToken: string };
    const other = await call(b, "send", { body: { body: "from B" }, ip: "10.0.0.2" });

    const ok = await call(b, "messages", { query: { visitorId }, token: visitorToken });
    expect(ok.status).toBe(200);
    expect((ok.body as { items: { body: string; from: string }[] }).items).toEqual([
      expect.objectContaining({ body: "from A", from: "visitor" }),
    ]);

    const noToken = await call(b, "messages", { query: { visitorId } });
    expect(noToken).toMatchObject({ status: 403, key: "widget.visitor_forbidden" });
    const wrong = await call(b, "messages", { query: { visitorId }, token: (other.body as { visitorToken: string }).visitorToken });
    expect(wrong).toMatchObject({ status: 403, key: "widget.visitor_forbidden" });
    // a token minted for another channel does not open this channel's thread
    const foreign = mintVisitor("W9");
    const cross = await call(b, "messages", { query: { visitorId: foreign.visitorId }, token: foreign.visitorToken });
    expect(cross).toMatchObject({ status: 403 });
  });

  it("posting as an existing visitor needs the token (403 otherwise)", async () => {
    const b = build();
    const a = await call(b, "send", { body: { body: "hi" } });
    const { visitorId } = a.body as { visitorId: string };
    const r = await call(b, "send", { body: { body: "hijack", visitorId }, token: "B".repeat(43) });
    expect(r).toMatchObject({ status: 403, key: "widget.visitor_forbidden" });
    expect(b.prisma.db.message.map((m: { body: string }) => m.body)).toEqual(["hi"]);
  });

  it("first message mints a visitor, records via the sink in the channel's workspace, then appends", async () => {
    const b = build();
    const a = await call(b, "send", { body: { body: "  hello  " } });
    expect(a.status).toBe(200);
    const out = a.body as { visitorId: string; visitorToken: string; message: { id: string; from: string; body: string } };
    expect(out.visitorId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(out.message).toMatchObject({ from: "visitor", body: "hello" });
    const contact = b.prisma.db.contact[0];
    // the workspace language is ar and config.lang is en → the channel's lang wins
    expect(contact).toMatchObject({ workspaceId: "ws_secret_1", externalSource: "webchat", externalId: out.visitorId, name: "Website visitor" });
    const conv = b.prisma.db.conversation[0];
    expect(conv).toMatchObject({ workspaceId: "ws_secret_1", channelId: "W1", channel: "webchat", contactId: contact.id });
    expect(b.realtime.emitToWorkspace).toHaveBeenCalledWith("ws_secret_1", "inbox.activity", expect.objectContaining({ channelId: "W1" }));

    await call(b, "send", { body: { body: "again", visitorId: out.visitorId }, token: out.visitorToken });
    expect(b.prisma.db.conversation).toHaveLength(1);
    expect(b.prisma.db.message).toHaveLength(2);

    const after = await call(b, "messages", { query: { visitorId: out.visitorId, after: new Date(0).toISOString() }, token: out.visitorToken });
    expect((after.body as { items: unknown[] }).items).toHaveLength(2);
  });

  it("the default visitor name follows the language (Arabic workspace, no channel lang)", async () => {
    const b = build({ channel: [wc("W1", { config: { allowedOrigins: [] } })] });
    await call(b, "send", { body: { body: "مرحبا" } });
    expect(b.prisma.db.contact[0].name).toBe("زائر الموقع");
    await call(b, "send", { body: { body: "x", name: "  Sara  " }, ip: "10.0.0.9" });
    expect(b.prisma.db.contact[1].name).toBe("Sara");
  });

  it("message length is 1–2000 and the name at most 80", async () => {
    const b = build();
    expect(await call(b, "send", { body: { body: "   " } })).toMatchObject({ status: 400, key: "widget.invalid_message" });
    expect(await call(b, "send", { body: { body: "x".repeat(2001) } })).toMatchObject({ status: 400, key: "widget.invalid_message" });
    expect(await call(b, "send", { body: { body: "ok", name: "n".repeat(81) } })).toMatchObject({ status: 400, key: "widget.invalid_message" });
    expect((await call(b, "send", { body: { body: "x".repeat(2000) } })).status).toBe(200);
  });

  it("history excludes other channels' threads of the same contact", async () => {
    const b = build({
      channel: [wc("W1"), wc("W3", { isDefault: false })],
    });
    const a = await call(b, "send", { body: { body: "on W1" } });
    const { visitorId } = a.body as { visitorId: string };
    // a W3 conversation for the same contact must not leak into W1's history
    b.prisma.db.conversation.push({ id: "cvX", workspaceId: "ws_secret_1", contactId: b.prisma.db.contact[0].id, channelId: "W3", channel: "webchat", updatedAt: new Date(Date.now() + 1000) });
    b.prisma.db.message.push({ id: "mX", workspaceId: "ws_secret_1", conversationId: "cvX", from: "human", body: "W3 secret", createdAt: new Date() });
    const r = await call(b, "messages", { query: { visitorId }, token: (a.body as { visitorToken: string }).visitorToken });
    expect(JSON.stringify(r.body)).not.toContain("W3 secret");
  });
});

describe("disconnected webchat channel returns 404", () => {
  it.each(["W2", "T1", "nope", "../etc", "x".repeat(65)])("channel %s → 404 widget.channel_unavailable on every route", async (id) => {
    const b = build();
    for (const route of ["page", "config", "messages", "send"] as const) {
      const r = await call(b, route, { channelId: id, body: { body: "hi" } });
      expect(r).toMatchObject({ status: 404, key: "widget.channel_unavailable" });
    }
    expect(b.prisma.db.message).toHaveLength(0);
  });
});

describe("public widget responses contain no secrets or workspace ids", () => {
  it("config, send, history and the page leak nothing beyond the public config", async () => {
    const b = build();
    const config = await call(b, "config");
    expect(config.body).toEqual({
      displayName: "Shop",
      greeting: "Hi!",
      greetingAr: "أهلًا",
      color: "#0f766e",
      position: "start",
      askName: true,
      lang: "en",
      // SP-29: the workspace brand (no logo here, so no workspace id; the channel colour wins).
      brand: { name: "Shop Co", logoUrl: null, color: "#123456" },
    });
    const sent = await call(b, "send", { body: { body: "hi" } });
    const { visitorId, visitorToken } = sent.body as { visitorId: string; visitorToken: string };
    const history = await call(b, "messages", { query: { visitorId }, token: visitorToken });
    const page = await call(b, "page", { query: { embed: "1", parent: "https://shop.example" } });
    const contactId = b.prisma.db.contact[0].id;
    const convId = b.prisma.db.conversation[0].id;
    for (const r of [config, sent, history, page]) {
      const s = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
      for (const bad of [
        "ws_secret_1",
        "workspaceId",
        "int_secret",
        "integrationId",
        "secretsEnc",
        "webhookSecretHash",
        "botToken",
        SECRET_TOKEN,
        "waba_secret",
        "f".repeat(64),
        contactId,
        convId,
        "conversationId",
        "contactId",
      ]) {
        expect({ route: s.slice(0, 40), leaked: s.includes(bad) ? bad : null }).toEqual({ route: s.slice(0, 40), leaked: null });
      }
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
    }
  });
});

describe("hosted page route", () => {
  it("serves text/html with the CSP: frame-ancestors from allowedOrigins when embedded, 'none' for the direct link", async () => {
    const b = build();
    const embed = await call(b, "page", { query: { embed: "1", parent: "https://shop.example" } });
    expect(embed.status).toBe(200);
    expect(embed.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(embed.headers["content-security-policy"]).toContain("frame-ancestors https://shop.example https://*.shop.com");
    expect(embed.headers["content-security-policy"]).toContain("connect-src 'self' wss://api.example.com");
    expect(embed.headers["cache-control"]).toBe("no-store");
    expect(embed.body).toContain('data-parent="https://shop.example"');

    const direct = await call(b, "page");
    expect(direct.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(direct.body).toContain('data-embed="0"');
  });

  it("language: ?lang, then config.lang, then Accept-Language, then the workspace", async () => {
    const b = build({ channel: [wc("W1", { config: { allowedOrigins: [] } })] });
    expect((await call(b, "page", { query: { lang: "en" } })).body).toContain('<html lang="en" dir="ltr">');
    expect((await call(b, "page", { headers: { "accept-language": "en-US,en;q=0.9" } })).body).toContain('<html lang="en" dir="ltr">');
    expect((await call(b, "page")).body).toContain('<html lang="ar" dir="rtl">');
    const c = build({ channel: [wc("W1", { config: { lang: "ar" } })] });
    expect((await call(c, "page", { headers: { "accept-language": "en" } })).body).toContain('<html lang="ar" dir="rtl">');
  });

  it("the loader is served as JavaScript with nosniff", () => {
    const b = build();
    const out = b.ctrl.loader();
    expect(out).toContain("data-channel");
    const headers = Reflect.getMetadata("__headers__", WebchatController.prototype.loader) as { name: string; value: string }[];
    expect(headers).toEqual(
      expect.arrayContaining([
        { name: "Content-Type", value: "application/javascript; charset=utf-8" },
        { name: "X-Content-Type-Options", value: "nosniff" },
      ]),
    );
  });
});

describe("fix round 1", () => {
  it("I2: the hosted link tolerates tracking params (fbclid, utm_*) and ignores a bad lang/embed", async () => {
    const b = build();
    const r = await call(b, "page", { query: { fbclid: "x", utm_source: "y" } });
    expect(r.status).toBe(200);
    expect(String(r.body)).toContain("<!doctype html>");
    const odd = await call(b, "page", { query: { lang: "fr", embed: "yes" } });
    expect(odd.status).toBe(200);
    expect(odd.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    // a repeated (array) query value is not a string: ignored, never thrown
    const arr = await b.ctrl.page({ ...(await guarded(b)), headers: { host: "api.example.com" } } as never, ["1", "0"] as never, ["ar"] as never, undefined, { setHeader: () => {} });
    expect(arr).toContain('data-embed="0"');
  });

  it("m5: history takes the token from X-Visitor-Token only; the query param is refused", async () => {
    const b = build();
    const a = await call(b, "send", { body: { body: "hi" } });
    const { visitorId, visitorToken } = a.body as { visitorId: string; visitorToken: string };
    expect((await call(b, "messages", { query: { visitorId }, token: visitorToken })).status).toBe(200);
    const inQuery = await call(b, "messages", { query: { visitorId, visitorToken } });
    expect(inQuery).toMatchObject({ status: 403, key: "widget.visitor_forbidden" });
  });

  it("m5: posting as an existing visitor takes the token from the header; a body token is ignored", async () => {
    const b = build();
    const a = await call(b, "send", { body: { body: "hi" } });
    const { visitorId, visitorToken } = a.body as { visitorId: string; visitorToken: string };
    expect((await call(b, "send", { body: { body: "2", visitorId }, token: visitorToken })).status).toBe(200);
    const inBody = await call(b, "send", { body: { body: "3", visitorId, visitorToken } });
    expect(inBody).toMatchObject({ status: 403, key: "widget.visitor_forbidden" });
  });

  it("m1: a malformed channel id is 404 before any bucket is counted", async () => {
    const b = build();
    for (let i = 0; i < 200; i++) {
      const r = await call(b, "send", { channelId: "../bad id", body: { body: "x" } });
      expect(r).toMatchObject({ status: 404, key: "widget.channel_unavailable" });
    }
    expect((await call(b, "send", { body: { body: "ok" } })).status).toBe(200);
    expect((await call(b, "config")).status).toBe(200);
  });

  it("m1: POSTs from one IP share a bucket across channel ids (60/min)", async () => {
    const b = build();
    let limited = 0;
    for (let i = 0; i < 61; i++) {
      const r = await call(b, "send", { channelId: `junk${i}`, body: { body: "x" } });
      if (r.status === 429) limited++;
      else expect(r).toMatchObject({ status: 404 });
    }
    expect(limited).toBe(1);
    // the real channel is now refused from that IP too, but not from another IP
    expect(await call(b, "send", { body: { body: "x" } })).toMatchObject({ status: 429, key: "widget.rate_limited" });
    expect((await call(b, "send", { body: { body: "x" }, ip: "10.7.7.7" })).status).toBe(200);
  });
});

/** A request that passed both guards for W1 (for direct handler calls). */
async function guarded(b: B) {
  const req: Record<string, unknown> = { method: "GET", params: { channelId: "W1" }, query: {}, headers: { host: "api.example.com" }, ip: "10.0.0.50" };
  const context = { switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ setHeader: () => {} }) }) } as unknown as ExecutionContext;
  await b.origin.canActivate(context);
  return req;
}
