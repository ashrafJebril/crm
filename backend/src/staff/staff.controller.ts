import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from "@nestjs/common";
import { CurrentWorkspace } from "../common/current-workspace.decorator";
import { StaffService } from "./staff.service";
import { CreateStaffDto, ListCatalogQuery, SetStaffServicesDto, UpdateStaffDto } from "./staff.dto";

/**
 * SP-10 staff resources. Permissions come from permission-map.ts:
 * `bookings.view` to list, `bookings.manage` for every write (ruling 12).
 * Every `:id` route is workspace-scoped (a foreign id is 404).
 */
@Controller("staff")
export class StaffController {
  constructor(private readonly svc: StaffService) {}

  @Get()
  list(@CurrentWorkspace() workspaceId: string, @Query() query: ListCatalogQuery) {
    return this.svc.list(workspaceId, { active: query.active, q: query.q });
  }

  @Post()
  create(@CurrentWorkspace() workspaceId: string, @Body() dto: CreateStaffDto) {
    return this.svc.create(workspaceId, dto);
  }

  @Get(":id/delete-preview")
  deletePreview(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.deletePreview(workspaceId, id);
  }

  @Patch(":id")
  update(@CurrentWorkspace() workspaceId: string, @Param("id") id: string, @Body() dto: UpdateStaffDto) {
    return this.svc.update(workspaceId, id, dto);
  }

  @Put(":id/services")
  setServices(@CurrentWorkspace() workspaceId: string, @Param("id") id: string, @Body() dto: SetStaffServicesDto) {
    return this.svc.setServices(workspaceId, id, dto.serviceIds);
  }

  @Delete(":id")
  remove(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.remove(workspaceId, id);
  }

  @Post(":id/restore")
  restore(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.restore(workspaceId, id);
  }
}
