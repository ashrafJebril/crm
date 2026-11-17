import { Body, Controller, Get, HttpException, HttpStatus, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { Public } from "../auth/public.decorator";
import { AuthService } from "../auth/auth.service";
import { SlidingWindowLimiter } from "../common/rate-limit";
import { InvitationsService } from "./invitations.service";
import { AcceptInvitationDto } from "./members.dto";
import { INVITE_PUBLIC_LIMIT } from "./members-constants";

/** Fly-Client-IP (set by Fly's edge, as auth.controller.ts reads it), else the socket. */
function clientIp(req: Request): string {
  const fly = req.headers["fly-client-ip"];
  return ((Array.isArray(fly) ? fly[0] : fly)?.trim() || req.ip || "unknown").slice(0, 64);
}

/**
 * SP-26 public invitation routes: preview and accept for a signed-out
 * invitee. Declared in their own controller (route order) and registered in
 * AuthModule, which issues the session. Every invalid token gives the same
 * 410; both routes share 30 hits per 15 min per IP.
 */
@Controller("invitations")
export class PublicInvitationsController {
  readonly limiter = new SlidingWindowLimiter(INVITE_PUBLIC_LIMIT);

  constructor(
    private readonly invitations: InvitationsService,
    private readonly auth: AuthService,
  ) {}

  private limit(req: Request): void {
    const hit = this.limiter.hit(`ip:${clientIp(req)}`);
    if (!hit.ok) {
      throw new HttpException(
        { statusCode: HttpStatus.TOO_MANY_REQUESTS, message: "auth.rate_limited", retryAfterSec: hit.retryAfterSec },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  @Public()
  @Get("preview")
  preview(@Query("token") token: unknown, @Req() req: Request) {
    this.limit(req);
    return this.invitations.preview(token);
  }

  @Public()
  @Post("accept")
  async accept(@Body() dto: AcceptInvitationDto, @Req() req: Request) {
    this.limit(req);
    const res = await this.invitations.acceptWithToken(dto);
    return { ...(await this.auth.issueFor(res.userId, res.workspaceId)), rolePending: res.rolePending };
  }
}
