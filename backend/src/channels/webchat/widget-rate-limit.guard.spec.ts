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
    const post = (ip: string, body: unknown, channelId = "W1") => {
      try {
        return guard.canActivate(ctx({ method: "POST", params: { channelId }, headers: {}, ip, body }).context);
      } catch (e) {
        return channelErrorKey(e);
      }
    };
    for (let i = 0; i < 10; i++) expect(post(`ip${i}`, { ...v })).toBe(true);
    expect(post("ipX", { ...v })).toBe("widget.rate_limited");
    // the per-IP bucket is per channel
    for (let i = 0; i < 30; i++) expect(post("same", {}, "W2")).toBe(true);
    expect(post("same", {}, "W2")).toBe("widget.rate_limited");
    expect(post("same", {}, "W3")).toBe(true);
  });

  it("the module provider builds a real-clock limiter", () => {
    expect(widgetRateLimiterProvider.useFactory()).toBeInstanceOf(WidgetRateLimiter);
  });
});
