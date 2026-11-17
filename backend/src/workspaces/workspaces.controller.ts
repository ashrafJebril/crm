import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
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
import { HandoverService } from "../members/handover.service";
import { HandoverDto, RemoveMemberDto } from "../members/members.dto";

type AuthedReq = Request & { user: JwtPayload };

/** Returned as-is; the frontend maps it to its own translation. */
export const SWITCH_WORKSPACE_FIRST = "Switch to this workspace first";

@Controller("workspaces")
export class WorkspacesController {
  constructor(
    private readonly svc: WorkspacesService,
    // Always injected by Nest (WorkspacesModule imports MembersModule).
    // Optional only so specs that build this controller by hand for the
    // pre-SP-26 routes keep their one-argument constructor.
    private readonly handover?: HandoverService,
  ) {}

  private get handovers(): HandoverService {
    if (!this.handover) throw new Error("HandoverService is not available");
    return this.handover;
  }

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
    return this.svc.update(id, dto, actorOf(req.user));
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

  // SP-26: declared before the :userId routes.
  @Get(":id/members/:userId/open-work")
  async openWork(
    @Param("id") id: string,
    @Param("userId") userId: string,
    @Query("handoverTo") handoverTo: string | undefined,
    @Req() req: AuthedReq,
  ) {
    await this.authorize(id, req);
    return this.handovers.openWorkFor(id, userId, typeof handoverTo === "string" && handoverTo ? handoverTo : undefined);
  }

  @Post(":id/members/:userId/handover")
  async handOver(
    @Param("id") id: string,
    @Param("userId") userId: string,
    @Body() dto: HandoverDto,
    @Req() req: AuthedReq,
  ) {
    await this.authorize(id, req);
    return this.handovers.handOverOnly(id, userId, dto.handoverTo, actorOf(req.user));
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

  /** SP-26: 409 members.handover_required {openWork} while the member holds
   *  open work and no `handoverTo` is given; else `{ ok, moved }`. */
  @Delete(":id/members/:userId")
  async removeMember(
    @Param("id") id: string,
    @Param("userId") userId: string,
    @Req() req: AuthedReq,
    @Body() dto?: RemoveMemberDto,
  ) {
    await this.authorize(id, req);
    return this.svc.removeMember(id, userId, actorOf(req.user), dto?.handoverTo || undefined);
  }
}
