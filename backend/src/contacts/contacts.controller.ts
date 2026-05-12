import { Body, Controller, Delete, Get, Param, Patch, Post } from "@nestjs/common";
import { ContactsService } from "./contacts.service";
import { CreateContactDto, UpdateContactDto } from "./contacts.dto";
import { CurrentWorkspace } from "../common/current-workspace.decorator";

@Controller("contacts")
export class ContactsController {
  constructor(private readonly svc: ContactsService) {}

  @Get()
  list(@CurrentWorkspace() workspaceId: string) {
    return this.svc.list(workspaceId);
  }

  @Get(":id")
  get(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.get(workspaceId, id);
  }

  @Post()
  create(
    @CurrentWorkspace() workspaceId: string,
    @Body() dto: CreateContactDto,
  ) {
    return this.svc.create(workspaceId, dto);
  }

  @Patch(":id")
  update(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Body() dto: UpdateContactDto,
  ) {
    return this.svc.update(workspaceId, id, dto);
  }

  @Delete(":id")
  remove(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
  ) {
    return this.svc.remove(workspaceId, id);
  }
}
