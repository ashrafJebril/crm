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
  get(@Param("id") id: string) {
    return this.svc.get(id);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() dto: UpdateWorkspaceDto) {
    return this.svc.update(id, dto);
  }

  @Get(":id/members")
  listMembers(@Param("id") id: string) {
    return this.svc.listMembers(id);
  }

  @Post(":id/members")
  addMember(@Param("id") id: string, @Body() dto: AddMemberDto) {
    return this.svc.addMember(id, dto);
  }

  @Patch(":id/members/:userId")
  updateMemberRole(
    @Param("id") id: string,
    @Param("userId") userId: string,
    @Body() dto: UpdateMemberRoleDto,
  ) {
    return this.svc.updateMemberRole(id, userId, dto);
  }

  @Delete(":id/members/:userId")
  removeMember(@Param("id") id: string, @Param("userId") userId: string) {
    return this.svc.removeMember(id, userId);
  }
}
