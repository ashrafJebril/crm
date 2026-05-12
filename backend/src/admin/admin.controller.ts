import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { AdminService } from "./admin.service";
import { SuspendWorkspaceDto, UpdateWorkspaceAdminDto } from "./admin.dto";
import { SuperAdminGuard } from "./super-admin.guard";
import type { JwtPayload } from "../auth/auth.guard";

@Controller("admin")
@UseGuards(SuperAdminGuard)
export class AdminController {
  constructor(private readonly svc: AdminService) {}

  @Get("workspaces")
  listWorkspaces() {
    return this.svc.listWorkspaces();
  }

  @Get("workspaces/:id")
  getWorkspace(@Param("id") id: string) {
    return this.svc.getWorkspace(id);
  }

  @Patch("workspaces/:id")
  updateWorkspace(
    @Param("id") id: string,
    @Body() dto: UpdateWorkspaceAdminDto,
  ) {
    return this.svc.updateWorkspace(id, dto);
  }

  @Post("workspaces/:id/suspend")
  suspendWorkspace(
    @Param("id") id: string,
    @Body() dto: SuspendWorkspaceDto,
  ) {
    return this.svc.suspendWorkspace(id, dto);
  }

  @Post("workspaces/:id/impersonate")
  impersonate(
    @Param("id") id: string,
    @Req() req: Request & { user: JwtPayload },
  ) {
    return this.svc.impersonateWorkspace(req.user.sub, id);
  }

  @Get("users")
  listUsers() {
    return this.svc.listUsers();
  }
}
