import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import type { Channel } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { channelError } from "../channel-errors";
import { isAllowedOrigin, isProduction, originOptions } from "./origin-match";

/** The request shape the widget guards and handlers read. */
export interface WidgetRequest {
  method?: string;
  params: Record<string, string | undefined>;
  query?: Record<string, unknown>;
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  /** Set by WidgetOriginGuard: the live web chat channel. */
  widgetChannel?: Channel;
  /** Set by WidgetOriginGuard: the verified embedding origin, if any. */
  widgetParent?: string | null;
}

export const CHANNEL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** The header that carries the visitor token on HTTP routes (never a URL). */
export const VISITOR_TOKEN_HEADER = "x-visitor-token";

/** The visitor token from the X-Visitor-Token header, if any. */
export function visitorTokenHeader(req: { headers: Record<string, string | string[] | undefined> }): string | undefined {
  const v = req.headers?.[VISITOR_TOKEN_HEADER];
  return typeof v === "string" ? v : undefined;
}
const HOST_RE = /^[a-z0-9.-]+(?::\d{1,5})?$/;

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/**
 * The API's own origin(s): `PUBLIC_BASE_URL`, plus the origin the browser
 * addressed (`Host`, with `X-Forwarded-Proto` behind Fly's proxy). A browser
 * always sends the real Host of the server it calls, so a page on another
 * site cannot claim our origin this way. Outside production the http form
 * of the Host is accepted too (local dev).
 */
export function apiOrigins(req: { headers: Record<string, string | string[] | undefined> }): string[] {
  const out: string[] = [];
  const pub = (process.env.PUBLIC_BASE_URL ?? "").trim();
  if (pub) {
    try {
      out.push(new URL(pub).origin.toLowerCase());
    } catch {
      /* ignore a malformed PUBLIC_BASE_URL */
    }
  }
  const host = (one(req.headers?.host) ?? "").trim().toLowerCase();
  if (HOST_RE.test(host)) {
    const proto = (one(req.headers?.["x-forwarded-proto"]) ?? "").split(",")[0].trim().toLowerCase();
    if (proto === "https" || isProduction()) out.push(`https://${host}`);
    else out.push(`http://${host}`, `https://${host}`);
  }
  return [...new Set(out)];
}

/** The origin the hosted page is served from (CSP connect-src, socket URL). */
export function primaryApiOrigin(req: { headers: Record<string, string | string[] | undefined> }): string {
  return apiOrigins(req)[0] ?? "http://localhost:3001";
}

/** The client IP for rate limiting: Fly's edge sets (and overwrites)
 *  Fly-Client-IP; off Fly, the socket address. Same rule as auth login. */
export function clientIp(req: { headers: Record<string, string | string[] | undefined>; ip?: string }): string {
  return (one(req.headers?.["fly-client-ip"]) ?? "").trim() || req.ip || "unknown";
}

/** The claimed embedding origin, from the query or the JSON body. */
function claimedParent(req: WidgetRequest): unknown {
  const q = req.query?.parent;
  if (q !== undefined) return q;
  const b = req.body;
  return b && typeof b === "object" ? (b as { parent?: unknown }).parent : undefined;
}

/**
 * Gate for every public widget route except the loader:
 *  - `:channelId` must be a live web chat channel (kind webchat, provider
 *    native, not disconnected), else 404 widget.channel_unavailable;
 *  - an `Origin` header, when present, must be the API's own origin or one
 *    of the channel's allowedOrigins, else 403 widget.origin_forbidden;
 *  - a claimed `parent` (query or body), when present, must be one of the
 *    channel's allowedOrigins, else 403 widget.origin_forbidden.
 * Stored origins are re-validated on every read (origin-match.ts). The
 * lookup is by id across workspaces (public route, no workspace context);
 * the verified row rides on the request.
 */
@Injectable()
export class WidgetOriginGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<WidgetRequest>();
    const id = req.params?.channelId;
    if (typeof id !== "string" || !CHANNEL_ID_RE.test(id)) throw channelError("widget.channel_unavailable");
    const channel = await this.prisma.raw.channel.findFirst({
      where: { id, kind: "webchat", provider: "native", status: { not: "disconnected" } },
    });
    if (!channel) throw channelError("widget.channel_unavailable");

    const opts = originOptions();
    const origin = one(req.headers?.origin);
    if (origin !== undefined) {
      const o = origin.trim().toLowerCase();
      const ok = apiOrigins(req).includes(o) || isAllowedOrigin(o, channel.config, opts);
      if (!ok) throw channelError("widget.origin_forbidden");
    }
    const parent = claimedParent(req);
    if (parent !== undefined && parent !== "") {
      if (typeof parent !== "string" || !isAllowedOrigin(parent, channel.config, opts)) {
        throw channelError("widget.origin_forbidden");
      }
      req.widgetParent = parent.trim().toLowerCase();
    } else {
      req.widgetParent = null;
    }
    req.widgetChannel = channel;
    return true;
  }
}
