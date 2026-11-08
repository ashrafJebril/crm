import {
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
import { PermissionService } from "../permissions/permission.service";
import { missingPermission } from "../permissions/permission.guard";
import type { Permission } from "../permissions/catalog";

type AuthedReq = Request & { user: JwtPayload };

@Controller("workspaces")
export class WorkspacesController {
  constructor(
    private readonly svc: WorkspacesService,
    private readonly permissions: PermissionService,
  ) {}

  /**
   * Member/settings routes: the global PermissionGuard has already checked
   * the permission (permission-map.ts) against the JWT workspace. Here we
   * only require that the caller is a member of :id. When :id is not the JWT
   * workspace the guard's check does not cover it, so the permission is
   * evaluated for :id instead of trusting the other workspace's role.
   */
  private async authorize(id: string, req: AuthedReq, permission: Permission) {
    await this.svc.requireMember(req.user.sub, id);
    if (id === req.user.workspaceId || req.user.isSuperAdmin) return;
    const eff = await this.permissions.effective(id, req.user.sub);
    if (!this.permissions.can(eff, permission)) throw missingPermission(permission);
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
    await this.authorize(id, req, "settings.update");
    return this.svc.update(id, dto);
  }

  @Get(":id/members")
  async listMembers(@Param("id") id: string, @Req() req: AuthedReq) {
    await this.authorize(id, req, "members.view");
    return this.svc.listMembers(id);
  }

  @Post(":id/members")
  async addMember(
    @Param("id") id: string,
    @Body() dto: AddMemberDto,
    @Req() req: AuthedReq,
  ) {
    await this.authorize(id, req, "members.create");
    return this.svc.addMember(id, dto);
  }

  @Post(":id/invite")
  async invite(
    @Param("id") id: string,
    @Body() dto: InviteByEmailDto,
    @Req() req: AuthedReq,
  ) {
    await this.authorize(id, req, "members.create");
    return this.svc.inviteByEmail(id, dto);
  }

  @Patch(":id/members/:userId")
  async updateMemberRole(
    @Param("id") id: string,
    @Param("userId") userId: string,
    @Body() dto: UpdateMemberRoleDto,
    @Req() req: AuthedReq,
  ) {
    await this.authorize(id, req, "members.update");
    return this.svc.updateMemberRole(id, userId, dto);
  }

  @Patch(":id/members/:userId/password")
  async resetMemberPassword(
    @Param("id") id: string,
    @Param("userId") userId: string,
    @Body() dto: ResetMemberPasswordDto,
    @Req() req: AuthedReq,
  ) {
    await this.authorize(id, req, "members.update");
    return this.svc.resetMemberPassword(id, userId, dto, {
      isSuperAdmin: !!req.user.isSuperAdmin,
    });
  }

  @Delete(":id/members/:userId")
  async removeMember(
    @Param("id") id: string,
    @Param("userId") userId: string,
    @Req() req: AuthedReq,
  ) {
    await this.authorize(id, req, "members.delete");
    return this.svc.removeMember(id, userId);
  }
}
