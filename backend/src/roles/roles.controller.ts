import { Body, Controller, Delete, Get, Param, Patch, Post } from "@nestjs/common";
import { CurrentWorkspace } from "../common/current-workspace.decorator";
import { RolesService } from "./roles.service";
import { CreateRoleDto, UpdateRoleDto } from "./roles.dto";

/** Permissions come from the global PermissionGuard (permission-map.ts):
 *  GET roles.view, POST roles.create, PATCH roles.update, DELETE roles.delete. */
@Controller("roles")
export class RolesController {
  constructor(private readonly svc: RolesService) {}

  @Get()
  list(@CurrentWorkspace() ws: string) {
    return this.svc.list(ws);
  }

  @Post()
  create(@CurrentWorkspace() ws: string, @Body() dto: CreateRoleDto) {
    return this.svc.create(ws, dto);
  }

  @Patch(":id")
  update(@CurrentWorkspace() ws: string, @Param("id") id: string, @Body() dto: UpdateRoleDto) {
    return this.svc.update(ws, id, dto);
  }

  @Delete(":id")
  remove(@CurrentWorkspace() ws: string, @Param("id") id: string) {
    return this.svc.remove(ws, id);
  }
}
