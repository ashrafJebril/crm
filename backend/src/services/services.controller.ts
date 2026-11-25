import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from "@nestjs/common";
import { CurrentWorkspace } from "../common/current-workspace.decorator";
import { ServicesService } from "./services.service";
import { CreateServiceDto, ListCatalogQuery, SetServiceStaffDto, UpdateServiceDto } from "./services.dto";

/**
 * SP-10 services catalog. Permissions come from permission-map.ts:
 * `bookings.view` to list, `bookings.manage` for every write (ruling 12).
 * Every `:id` route is workspace-scoped (a foreign id is 404).
 */
@Controller("services")
export class ServicesController {
  constructor(private readonly svc: ServicesService) {}

  @Get()
  list(@CurrentWorkspace() workspaceId: string, @Query() query: ListCatalogQuery) {
    return this.svc.list(workspaceId, { active: query.active, q: query.q });
  }

  @Post()
  create(@CurrentWorkspace() workspaceId: string, @Body() dto: CreateServiceDto) {
    return this.svc.create(workspaceId, dto);
  }

  @Get(":id/delete-preview")
  deletePreview(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.deletePreview(workspaceId, id);
  }

  @Patch(":id")
  update(@CurrentWorkspace() workspaceId: string, @Param("id") id: string, @Body() dto: UpdateServiceDto) {
    return this.svc.update(workspaceId, id, dto);
  }

  @Put(":id/staff")
  setStaff(@CurrentWorkspace() workspaceId: string, @Param("id") id: string, @Body() dto: SetServiceStaffDto) {
    return this.svc.setStaff(workspaceId, id, dto.staffIds);
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
