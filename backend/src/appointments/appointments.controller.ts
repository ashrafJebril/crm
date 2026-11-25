import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { AppointmentsService } from "./appointments.service";
import {
  CreateAppointmentDto,
  ListAppointmentsQuery,
  SearchAppointmentsQuery,
  UpdateAppointmentDto,
} from "./appointments.dto";
import { CurrentWorkspace } from "../common/current-workspace.decorator";

@Controller("appointments")
export class AppointmentsController {
  constructor(private readonly svc: AppointmentsService) {}

  /** SP-10: no query params → every booking, as before (ruling 13). */
  @Get()
  list(@CurrentWorkspace() workspaceId: string, @Query() query: ListAppointmentsQuery) {
    return this.svc.list(workspaceId, query);
  }

  /** SP-10 booking search typeahead. Declared before `:id`. */
  @Get("search")
  search(@CurrentWorkspace() workspaceId: string, @Query() query: SearchAppointmentsQuery) {
    return this.svc.search(workspaceId, query.q);
  }

  @Get(":id")
  get(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.get(workspaceId, id);
  }

  @Post()
  create(@CurrentWorkspace() workspaceId: string, @Body() dto: CreateAppointmentDto) {
    return this.svc.create(workspaceId, dto);
  }

  @Patch(":id")
  update(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Body() dto: UpdateAppointmentDto,
  ) {
    return this.svc.update(workspaceId, id, dto);
  }

  @Delete(":id")
  remove(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.remove(workspaceId, id);
  }
}
