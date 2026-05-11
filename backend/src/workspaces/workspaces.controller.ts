import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
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
  UpdateMemberRoleDto,
  UpdateWorkspaceDto,
} from "./workspaces.dto";
import type { JwtPayload } from "../auth/auth.guard";

@Controller("workspaces")
export class WorkspacesController {
  constructor(private readonly svc: WorkspacesService) {}

  @Get()
  list(@Req() req: Request & { user: JwtPayload }) {
    return this.svc.listForUser(req.user.sub);
  }

  @Post()
  create(
    @Body() dto: CreateWorkspaceDto,
    @Req() req: Request & { user: JwtPayload },
  ) {
    return this.svc.create(dto, req.user.sub);
  }

  @Get(":id")
  async get(
    @Param("id") id: string,
    @Req() req: Request & { user: JwtPayload },
  ) {
    await this.svc.requireMember(req.user.sub, id);
    return this.svc.get(id);
  }

  @Patch(":id")
  async update(
    @Param("id") id: string,
    @Body() dto: UpdateWorkspaceDto,
    @Req() req: Request & { user: JwtPayload },
  ) {
    const role = await this.svc.requireMember(req.user.sub, id);
    if (role !== "owner" && role !== "admin") {
      throw new ForbiddenException("Only owner or admin can edit a workspace");
    }
    return this.svc.update(id, dto);
  }

  @Get(":id/members")
  async listMembers(
    @Param("id") id: string,
    @Req() req: Request & { user: JwtPayload },
  ) {
    await this.svc.requireMember(req.user.sub, id);
    return this.svc.listMembers(id);
  }

  @Post(":id/members")
  async addMember(
    @Param("id") id: string,
    @Body() dto: AddMemberDto,
    @Req() req: Request & { user: JwtPayload },
  ) {
    const role = await this.svc.requireMember(req.user.sub, id);
    if (role !== "owner" && role !== "admin") {
      throw new ForbiddenException("Only owner or admin can add members");
    }
    return this.svc.addMember(id, dto);
  }

  @Patch(":id/members/:userId")
  async updateMemberRole(
    @Param("id") id: string,
    @Param("userId") userId: string,
    @Body() dto: UpdateMemberRoleDto,
    @Req() req: Request & { user: JwtPayload },
  ) {
    const role = await this.svc.requireMember(req.user.sub, id);
    if (role !== "owner" && role !== "admin") {
      throw new ForbiddenException("Only owner or admin can change member roles");
    }
    return this.svc.updateMemberRole(id, userId, dto);
  }

  @Delete(":id/members/:userId")
  async removeMember(
    @Param("id") id: string,
    @Param("userId") userId: string,
    @Req() req: Request & { user: JwtPayload },
  ) {
    const role = await this.svc.requireMember(req.user.sub, id);
    if (role !== "owner" && role !== "admin") {
      throw new ForbiddenException("Only owner or admin can remove members");
    }
    return this.svc.removeMember(id, userId);
  }
}
