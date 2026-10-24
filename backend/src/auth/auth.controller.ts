import { Body, Controller, Get, Patch, Post, Req } from "@nestjs/common";
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
  constructor(private readonly auth: AuthService) {}

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
