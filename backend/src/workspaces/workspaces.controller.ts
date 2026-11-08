import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
} from "@nestjs/common";
import type { Request } from "express";
import { WorkspacesService } from "./workspaces.service";
import {
  AddMemberDto,
  CreateWorkspaceDto,
  InviteByEmailDto,
  ResetMemberPasswordDto,
  UpdateMemberRoleDto,
  UpdateWorkspaceDto,
} from "./workspaces.dto";
import type { JwtPayload } from "../auth/auth.guard";
import { actorOf } from "../permissions/permission.service";

type AuthedReq = Request & { user: JwtPayload };

/** Returned as-is; the frontend maps it to its own translation. */
export const SWITCH_WORKSPACE_FIRST = "Switch to this workspace first";

@Controller("workspaces")
export class WorkspacesController {
  constructor(private readonly svc: WorkspacesService) {}

  /**
   * Member/settings routes: the global PermissionGuard has already checked
   * the permission (permission-map.ts) against the JWT workspace, and the
   * request's tenancy context is that workspace too. A different :id would
   * be checked against the wrong role and have its queries rewritten to the
   * JWT workspace, so it is refused outright (super-admins excepted); the
   * caller must switch workspaces first. Membership of :id is still required.
   */
  private async authorize(id: string, req: AuthedReq) {
    if (id !== req.user.workspaceId && !req.user.isSuperAdmin) {
      throw new BadRequestException(SWITCH_WORKSPACE_FIRST);
    }
    await this.svc.requireMember(req.user.sub, id);
  }

  @Get()
  list(@Req() req: AuthedReq) {
    return this.svc.listForUser(req.user.sub);
  }

  @Post()
  create(@Body() dto: CreateWorkspaceDto, @Req() req: AuthedReq) {
    return this.svc.create(dto, req.user.sub);
  }

  @Get(":id")
  async get(@Param("id") id: string, @Req() req: AuthedReq) {
    await this.svc.requireMember(req.user.sub, id);
    return this.svc.get(id);
  }

  @Patch(":id")
  async update(
    @Param("id") id: string,
    @Body() dto: UpdateWorkspaceDto,
    @Req() req: AuthedReq,
  ) {
    await this.authorize(id, req);
    return this.svc.update(id, dto);
  }

  @Get(":id/members")
  async listMembers(@Param("id") id: string, @Req() req: AuthedReq) {
    await this.authorize(id, req);
    return this.svc.listMembers(id);
  }

  @Post(":id/members")
  async addMember(
    @Param("id") id: string,
    @Body() dto: AddMemberDto,
    @Req() req: AuthedReq,
  ) {
    await this.authorize(id, req);
    return this.svc.addMember(id, dto, actorOf(req.user));
  }

  @Post(":id/invite")
  async invite(
    @Param("id") id: string,
    @Body() dto: InviteByEmailDto,
    @Req() req: AuthedReq,
  ) {
    await this.authorize(id, req);
    return this.svc.inviteByEmail(id, dto, actorOf(req.user));
  }

  @Patch(":id/members/:userId")
  async updateMemberRole(
    @Param("id") id: string,
    @Param("userId") userId: string,
    @Body() dto: UpdateMemberRoleDto,
    @Req() req: AuthedReq,
  ) {
    await this.authorize(id, req);
    return this.svc.updateMemberRole(id, userId, dto, actorOf(req.user));
  }

  @Patch(":id/members/:userId/password")
  async resetMemberPassword(
    @Param("id") id: string,
    @Param("userId") userId: string,
    @Body() dto: ResetMemberPasswordDto,
    @Req() req: AuthedReq,
  ) {
    await this.authorize(id, req);
    return this.svc.resetMemberPassword(id, userId, dto, actorOf(req.user));
  }

  @Delete(":id/members/:userId")
  async removeMember(
    @Param("id") id: string,
    @Param("userId") userId: string,
    @Req() req: AuthedReq,
  ) {
    await this.authorize(id, req);
    return this.svc.removeMember(id, userId, actorOf(req.user));
  }
}
