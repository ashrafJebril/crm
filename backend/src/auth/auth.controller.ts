import { Body, Controller, Get, Param, Patch, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { AuthService } from "./auth.service";
import {
  ChangePasswordDto,
  LoginDto,
  RegisterDto,
  SwitchWorkspaceDto,
  UpdateProfileDto,
} from "./dto";
import { Public } from "./public.decorator";
import type { JwtPayload } from "./auth.guard";
import { InvitationsService } from "../members/invitations.service";
import { AcceptInvitationSignedInDto } from "../members/members.dto";

/**
 * The end user's IP, forwarded to Kewy's per-IP login limit. On Fly the edge
 * proxy sets Fly-Client-IP (and overwrites any client-supplied value); off Fly
 * this falls back to the socket address.
 */
function clientIp(req: Request): string | undefined {
  const fly = req.headers["fly-client-ip"];
  const ip = (Array.isArray(fly) ? fly[0] : fly)?.trim() || req.ip || undefined;
  return ip || undefined;
}

@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly invitations: InvitationsService,
  ) {}

  @Public()
  @Post("login")
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.login(dto, clientIp(req));
  }

  @Public()
  @Post("register")
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Get("me")
  me(@Req() req: Request & { user: JwtPayload }) {
    return this.auth.me(req.user.sub);
  }

  @Get("workspaces")
  myWorkspaces(@Req() req: Request & { user: JwtPayload }) {
    return this.auth.myWorkspaces(req.user.sub);
  }

  /** SP-26: activation by slug (ruling 10). */
  @Get("workspaces/by-slug/:slug")
  workspaceBySlug(@Param("slug") slug: string, @Req() req: Request & { user: JwtPayload }) {
    return this.auth.workspaceBySlug(req.user.sub, slug);
  }

  /** SP-26: `{ pending }`, a count only (C1): the invitee opens the emailed link. */
  @Get("invitations")
  myInvitations(@Req() req: Request & { user: JwtPayload }) {
    return this.invitations.pendingCountForUser(req.user.sub);
  }

  /** SP-26: accept with the emailed token while signed in (email must match);
   *  the session switches to that workspace. */
  @Post("invitations/accept")
  async acceptInvitation(@Body() dto: AcceptInvitationSignedInDto, @Req() req: Request & { user: JwtPayload }) {
    const res = await this.invitations.acceptSignedIn(req.user.sub, dto.token);
    return { ...(await this.auth.issueFor(res.userId, res.workspaceId)), rolePending: res.rolePending };
  }

  @Post("switch-workspace")
  switchWorkspace(
    @Body() dto: SwitchWorkspaceDto,
    @Req() req: Request & { user: JwtPayload },
  ) {
    return this.auth.switchWorkspace(req.user.sub, dto);
  }

  @Patch("me")
  updateProfile(
    @Body() dto: UpdateProfileDto,
    @Req() req: Request & { user: JwtPayload },
  ) {
    return this.auth.updateProfile(req.user.sub, dto);
  }

  @Post("change-password")
  changePassword(
    @Body() dto: ChangePasswordDto,
    @Req() req: Request & { user: JwtPayload },
  ) {
    return this.auth.changePassword(req.user.sub, dto);
  }
}
