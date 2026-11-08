import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { ContactsService } from "./contacts.service";
import { ContactsBulkService } from "./contacts-bulk.service";
import { parseContactFilter } from "./contact-filter";
import { BulkContactsDto, CreateContactDto, UpdateContactDto } from "./contacts.dto";
import { CurrentWorkspace } from "../common/current-workspace.decorator";

@Controller("contacts")
export class ContactsController {
  constructor(
    private readonly svc: ContactsService,
    private readonly bulkSvc: ContactsBulkService,
  ) {}

  @Get()
  list(
    @CurrentWorkspace() workspaceId: string,
    @Query("segmentId") segmentId?: string,
  ) {
    return this.svc.list(workspaceId, { segmentId });
  }

  /**
   * Paged table data. Declared before :id so "page" isn't read as an id.
   * Accepts the shared ContactListFilter as query params (see parseContactFilter).
   */
  @Get("page")
  page(@CurrentWorkspace() workspaceId: string, @Query() query: Record<string, string>) {
    return this.svc.listPage(workspaceId, {
      ...parseContactFilter(query),
      page: Number(query.page ?? 1),
      pageSize: Number(query.pageSize ?? 50),
    });
  }

  /** Select-all: every id matching the filter (capped at 10 000). */
  @Get("ids")
  ids(@CurrentWorkspace() workspaceId: string, @Query() query: Record<string, string>) {
    return this.svc.listIds(workspaceId, parseContactFilter(query));
  }

  @Post("bulk")
  bulk(@CurrentWorkspace() workspaceId: string, @Body() dto: BulkContactsDto) {
    return this.bulkSvc.run(workspaceId, dto);
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

  @Get(":id/tickets")
  tickets(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
  ) {
    return this.svc.pagedTickets(workspaceId, id, { page: Number(page ?? 1), pageSize: Number(pageSize ?? 20) });
  }

  @Get(":id/appointments")
  appointments(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
  ) {
    return this.svc.pagedAppointments(workspaceId, id, { page: Number(page ?? 1), pageSize: Number(pageSize ?? 20) });
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
    @Query("force") force?: string,
  ) {
    return this.svc.remove(workspaceId, id, force === "1" || force === "true");
  }
}
