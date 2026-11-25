import { Body, Controller, Delete, Get, Param, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import type { JwtPayload } from "../auth/auth.guard";
import { actorOf } from "../permissions/permission.service";
import { InvitationsService } from "./invitations.service";
import { assertJwtWorkspace } from "./jwt-workspace";
import { CreateInvitationDto } from "./members.dto";

type AuthedReq = Request & { user: JwtPayload };

/** SP-26 workspace invitation routes (permissions in permission-map.ts). */
@Controller("workspaces/:id/invitations")
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Get()
  list(@Param("id") id: string, @Query("status") status: string | undefined, @Req() req: AuthedReq) {
    assertJwtWorkspace(id, req.user);
    return this.invitations.list(id, typeof status === "string" ? status : undefined);
  }

  @Post()
  create(@Param("id") id: string, @Body() dto: CreateInvitationDto, @Req() req: AuthedReq) {
    assertJwtWorkspace(id, req.user);
    return this.invitations.create(id, dto, actorOf(req.user));
  }

  @Post(":invId/resend")
  resend(@Param("id") id: string, @Param("invId") invId: string, @Req() req: AuthedReq) {
    assertJwtWorkspace(id, req.user);
    return this.invitations.resend(id, invId, actorOf(req.user));
  }

  @Delete(":invId")
  revoke(@Param("id") id: string, @Param("invId") invId: string, @Req() req: AuthedReq) {
    assertJwtWorkspace(id, req.user);
    return this.invitations.revoke(id, invId, actorOf(req.user));
  }
}
