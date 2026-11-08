import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from "@nestjs/common";
import { CurrentWorkspace } from "../common/current-workspace.decorator";
import { RequirePermission } from "../permissions/require-permission.decorator";
import { CustomFieldsService } from "./custom-fields.service";
import { CreateCustomFieldDto, SetContactFieldsDto, UpdateCustomFieldDto } from "./custom-fields.dto";

/**
 * Field definitions are workspace settings (settings.manage — owner/admin
 * system roles); field values on a contact (`PUT contacts/:id/fields`) need
 * contacts.update (route map).
 */
@Controller()
export class CustomFieldsController {
  constructor(private readonly svc: CustomFieldsService) {}

  @Get("custom-fields")
  list(@CurrentWorkspace() ws: string, @Query("includeArchived") includeArchived?: string) {
    return this.svc.list(ws, includeArchived === "1" || includeArchived === "true");
  }

  @Post("custom-fields")
  @RequirePermission("settings", "manage")
  create(@CurrentWorkspace() ws: string, @Body() dto: CreateCustomFieldDto) {
    return this.svc.create(ws, dto);
  }

  @Patch("custom-fields/:id")
  @RequirePermission("settings", "manage")
  update(@CurrentWorkspace() ws: string, @Param("id") id: string, @Body() dto: UpdateCustomFieldDto) {
    return this.svc.update(ws, id, dto);
  }

  @Get("custom-fields/:id/delete-preview")
  deletePreview(@CurrentWorkspace() ws: string, @Param("id") id: string) {
    return this.svc.deletePreview(ws, id);
  }

  @Delete("custom-fields/:id")
  @RequirePermission("settings", "manage")
  remove(@CurrentWorkspace() ws: string, @Param("id") id: string) {
    return this.svc.remove(ws, id);
  }

  @Get("contacts/:id/fields")
  getForContact(@CurrentWorkspace() ws: string, @Param("id") id: string) {
    return this.svc.getForContact(ws, id);
  }

  @Put("contacts/:id/fields")
  setForContact(@CurrentWorkspace() ws: string, @Param("id") id: string, @Body() dto: SetContactFieldsDto) {
    return this.svc.setForContact(ws, id, dto.values);
  }
}
