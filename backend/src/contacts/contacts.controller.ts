import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { ContactsService } from "./contacts.service";
import { CreateContactDto, UpdateContactDto } from "./contacts.dto";
import { CurrentWorkspace } from "../common/current-workspace.decorator";

@Controller("contacts")
export class ContactsController {
  constructor(private readonly svc: ContactsService) {}

  @Get()
  list(
    @CurrentWorkspace() workspaceId: string,
    @Query("segmentId") segmentId?: string,
  ) {
    return this.svc.list(workspaceId, { segmentId });
  }

  /** Paged table data. Declared before :id so "page" isn't read as an id. */
  @Get("page")
  page(
    @CurrentWorkspace() workspaceId: string,
    @Query("segmentId") segmentId?: string,
    @Query("q") q?: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
  ) {
    return this.svc.listPage(workspaceId, {
      segmentId: segmentId || undefined,
      q,
      page: Number(page ?? 1),
      pageSize: Number(pageSize ?? 50),
    });
  }

  @Get("stats")
  stats(@CurrentWorkspace() workspaceId: string) {
    return this.svc.stats(workspaceId);
  }

  @Get(":id")
  get(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.get(workspaceId, id);
  }

  @Get(":id/summary")
  summary(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.summary(workspaceId, id);
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
