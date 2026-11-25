import type { ExecutionContext } from "@nestjs/common";
import { channelErrorKey } from "../channel-errors";
import { mintVisitor } from "./visitor-token";
import { WidgetRateLimiter, WidgetRateLimitGuard, widgetRateLimiterProvider } from "./widget-rate-limit.guard";

beforeAll(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "x".repeat(40);
});

function ctx(req: Record<string, unknown>) {
  const headers: Record<string, string> = {};
  const res = { setHeader: (k: string, v: string) => (headers[k] = v) };
  const context = { switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) } as unknown as ExecutionContext;
  return { context, headers };
}

describe("WidgetRateLimitGuard", () => {
  it("429 widget.rate_limited with Retry-After once the IP read budget is spent, and frees up as the window slides", () => {
    let t = 0;
    const guard = new WidgetRateLimitGuard(new WidgetRateLimiter(() => t));
    const req = { method: "GET", params: { channelId: "W1" }, headers: {}, ip: "1.1.1.1" };
    for (let i = 0; i < 120; i++) expect(guard.canActivate(ctx(req).context)).toBe(true);
    const c = ctx(req);
    let err: unknown;
    try {
      guard.canActivate(c.context);
    } catch (e) {
      err = e;
    }
    expect(channelErrorKey(err)).toBe("widget.rate_limited");
    expect((err as { getStatus(): number }).getStatus()).toBe(429);
    expect(c.headers["Retry-After"]).toBe("60");
    t += 60_001;
    expect(guard.canActivate(ctx(req).context)).toBe(true);
  });

  it("POST counts per IP+channel, and per visitor only when the token verifies", () => {
    const guard = new WidgetRateLimitGuard(new WidgetRateLimiter(() => 0));
    const v = mintVisitor("W1");
    const post = (ip: string, body: { visitorId?: string; visitorToken?: string }, channelId = "W1") => {
      const { visitorToken, ...rest } = body;
      const headers = visitorToken ? { "x-visitor-token": visitorToken } : {};
      try {
        return guard.canActivate(ctx({ method: "POST", params: { channelId }, headers, ip, body: rest }).context);
      } catch (e) {
        return channelErrorKey(e);
      }
    };
    for (let i = 0; i < 10; i++) expect(post(`ip${i}`, { ...v })).toBe(true);
    expect(post("ipX", { ...v })).toBe("widget.rate_limited");
    // the per-IP bucket is per channel (verified visitors, so the new-visitor cap is not involved)
    for (let i = 0; i < 30; i++) expect(post("same", { ...mintVisitor("W2") }, "W2")).toBe(true);
    expect(post("same", { ...mintVisitor("W2") }, "W2")).toBe("widget.rate_limited");
    expect(post("same", { ...mintVisitor("W3") }, "W3")).toBe(true);
  });

  it("I2: POSTs without a visitorId mint visitors: 5/hour per IP+channel and 200/hour per channel", () => {
    let t = 0;
    const guard = new WidgetRateLimitGuard(new WidgetRateLimiter(() => t));
    const post = (ip: string, channelId = "W1", body: Record<string, unknown> = {}) => {
      const c = ctx({ method: "POST", params: { channelId }, headers: {}, ip, body });
      try {
        return { ok: guard.canActivate(c.context), headers: c.headers };
      } catch (e) {
        return { key: channelErrorKey(e), retryAfter: (e as { getResponse(): { retryAfter?: number } }).getResponse().retryAfter, headers: c.headers };
      }
    };
    for (let i = 0; i < 5; i++) expect(post("a").ok).toBe(true);
    const refused = post("a");
    expect(refused.key).toBe("widget.rate_limited");
    expect(refused.retryAfter).toBe(3600);
    expect(refused.headers["Retry-After"]).toBe("3600");
    // an empty or null visitorId is a new visitor too
    expect(post("a", "W1", { visitorId: "" }).key).toBe("widget.rate_limited");
    expect(post("a", "W1", { visitorId: null }).key).toBe("widget.rate_limited");
    // other channel / other IP are separate buckets
    expect(post("a", "W2").ok).toBe(true);
    expect(post("b").ok).toBe(true);
    // per-channel cap: 200/hour across IPs (6 already used on W1)
    for (let i = 0; i < 194; i++) {
      if (i % 25 === 0) t += 61_000; // stay clear of the per-minute buckets
      expect(post(`ip${i}`).ok).toBe(true);
    }
    expect(post("fresh").key).toBe("widget.rate_limited");
    expect(post("fresh", "W2").ok).toBe(true);
    // a verified visitor is not a new visitor
    expect(post("fresh", "W1", { visitorId: mintVisitor("W1").visitorId }).ok).toBe(true);
    t += 3600_000 + 1;
    expect(post("fresh").ok).toBe(true);
  });

  it("m1: a malformed channel id is 404 and counts nothing; POSTs share a 60/min per-IP bucket", () => {
    const limiter = new WidgetRateLimiter(() => 0);
    const guard = new WidgetRateLimitGuard(limiter);
    const run = (channelId: string, method = "POST") => {
      try {
        return guard.canActivate(ctx({ method, params: { channelId }, headers: {}, ip: "6.6.6.6", body: {} }).context);
      } catch (e) {
        return channelErrorKey(e);
      }
    };
    for (const bad of ["", "a b", "../x", "x".repeat(65)]) expect(run(bad)).toBe("widget.channel_unavailable");
    expect(limiter.postPerIpAll.size() + limiter.postPerIp.size() + limiter.readPerIp.size()).toBe(0);
    for (let i = 0; i < 60; i++) expect(run(`c${i}`)).toBe(true);
    expect(run("c61")).toBe("widget.rate_limited");
  });

  it("the module provider builds a real-clock limiter", () => {
    expect(widgetRateLimiterProvider.useFactory()).toBeInstanceOf(WidgetRateLimiter);
  });
});
