import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { SlidingWindowLimiter } from "../../common/rate-limit";
import { channelError } from "../channel-errors";
import { verifyVisitorToken } from "./visitor-token";
import { clientIp, type WidgetRequest } from "./widget-origin.guard";

const MINUTE = 60_000;

/**
 * The widget's in-memory limits (Global Constraints, per machine):
 *  - `POST /widget/:id/messages`: 30/min per IP and channel, and 10/min per
 *    verified visitor;
 *  - reads (config, history, hosted page, socket handshakes): 120/min per IP.
 * Built by a factory provider so specs can pass a fake clock.
 */
export class WidgetRateLimiter {
  readonly postPerIp: SlidingWindowLimiter;
  readonly postPerVisitor: SlidingWindowLimiter;
  readonly readPerIp: SlidingWindowLimiter;

  constructor(now: () => number = Date.now) {
    this.postPerIp = new SlidingWindowLimiter({ limit: 30, windowMs: MINUTE, now });
    this.postPerVisitor = new SlidingWindowLimiter({ limit: 10, windowMs: MINUTE, now });
    this.readPerIp = new SlidingWindowLimiter({ limit: 120, windowMs: MINUTE, now });
  }
}

export const widgetRateLimiterProvider = {
  provide: WidgetRateLimiter,
  useFactory: () => new WidgetRateLimiter(),
};

interface Res {
  setHeader?(name: string, value: string): unknown;
}

/**
 * 429 `widget.rate_limited {retryAfter}` with a `Retry-After` header when a
 * limit is exceeded. Runs before WidgetOriginGuard so a flood never reaches
 * the database. The per-visitor bucket counts only a visitor whose token
 * verifies (an unverified id cannot drain someone else's bucket).
 */
@Injectable()
export class WidgetRateLimitGuard implements CanActivate {
  constructor(private readonly limits: WidgetRateLimiter) {}

  canActivate(ctx: ExecutionContext): boolean {
    const http = ctx.switchToHttp();
    const req = http.getRequest<WidgetRequest>();
    const res = http.getResponse<Res>();
    const ip = clientIp(req);
    const channelId = String(req.params?.channelId ?? "-").slice(0, 64);

    const refuse = (retryAfter: number): never => {
      res?.setHeader?.("Retry-After", String(retryAfter));
      throw channelError("widget.rate_limited", { retryAfter });
    };

    if ((req.method ?? "GET").toUpperCase() === "POST") {
      const byIp = this.limits.postPerIp.hit(`${ip}|${channelId}`);
      if (!byIp.ok) refuse(byIp.retryAfterSec);
      const body = (req.body && typeof req.body === "object" ? req.body : {}) as { visitorId?: unknown; visitorToken?: unknown };
      if (body.visitorId !== undefined && verifyVisitorToken(channelId, body.visitorId, body.visitorToken)) {
        const byVisitor = this.limits.postPerVisitor.hit(`${channelId}|${String(body.visitorId)}`);
        if (!byVisitor.ok) refuse(byVisitor.retryAfterSec);
      }
      return true;
    }
    const read = this.limits.readPerIp.hit(ip);
    if (!read.ok) refuse(read.retryAfterSec);
    return true;
  }
}
