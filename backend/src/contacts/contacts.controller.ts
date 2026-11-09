import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Res } from "@nestjs/common";
import type { Response } from "express";
import { ContactsExportService, EXPORT_IDS_CAP, type PreparedExport } from "./contacts-export.service";
import { ContactsService } from "./contacts.service";
import { ContactTimelineService } from "./contact-timeline.service";
import { CustomerThreadService } from "./customer-thread.service";
import { ContactsBulkService } from "./contacts-bulk.service";
import { parseContactFilter } from "./contact-filter";
import { BulkContactsDto, CreateContactDto, UpdateContactDto } from "./contacts.dto";
import { CurrentViewer, CurrentWorkspace } from "../common/current-workspace.decorator";
import type { Viewer } from "../permissions/visibility";
import { assertRequestPermission, type PermissionRequest } from "../permissions/permission.guard";

@Controller("contacts")
export class ContactsController {
  constructor(
    private readonly svc: ContactsService,
    private readonly bulkSvc: ContactsBulkService,
    private readonly exportSvc: ContactsExportService,
    private readonly timelineSvc: ContactTimelineService,
    private readonly threadSvc: CustomerThreadService,
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

  /**
   * Streamed CSV export (contacts.manage). Same filter as /contacts/page plus an
   * optional comma-separated `ids` selection (max 10 000). Declared before :id.
   */
  @Get("export")
  async export(
    @CurrentWorkspace() workspaceId: string,
    @Query() query: Record<string, string>,
    @Res() res: Response,
  ) {
    const rawIds = query.ids;
    const ids =
      typeof rawIds === "string" && rawIds.trim()
        ? [...new Set(rawIds.split(",").map((s) => s.trim()).filter(Boolean))]
        : undefined;
    const job = await this.exportSvc.prepare(workspaceId, parseContactFilter(query), ids);
    await this.stream(res, job);
  }

  /**
   * Same export as GET, with the selection in a JSON body so a large
   * selection (up to 10 000 ids) does not overflow the URL. Body:
   * `{ ids?: string[], ...ContactListFilter }` (contacts.manage).
   */
  @Post("export")
  async exportPost(
    @CurrentWorkspace() workspaceId: string,
    @Body() body: Record<string, unknown>,
    @Res() res: Response,
  ) {
    const { ids: rawIds, ...rest } = body ?? {};
    let ids: string[] | undefined;
    if (rawIds !== undefined && rawIds !== null) {
      if (!Array.isArray(rawIds) || rawIds.some((x) => typeof x !== "string")) {
        throw new BadRequestException("ids must be an array of strings");
      }
      if (rawIds.length > EXPORT_IDS_CAP) throw new BadRequestException(`ids is limited to ${EXPORT_IDS_CAP}`);
      ids = [...new Set((rawIds as string[]).map((x) => x.trim()).filter(Boolean))];
      if (!ids.length) ids = undefined;
    }
    const job = await this.exportSvc.prepare(workspaceId, parseContactFilter(rest), ids);
    await this.stream(res, job);
  }

  private async stream(res: Response, job: PreparedExport) {
    let closed = false;
    res.on("close", () => {
      if (!res.writableEnded) closed = true;
    });
    res.status(200);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${job.filename}"`);
    res.setHeader("Cache-Control", "no-store");
    try {
      await job.run({
        aborted: () => closed,
        write: (chunk) => {
          if (closed) return;
          if (res.write(chunk)) return;
          return new Promise<void>((resolve) => {
            const done = () => {
              res.off("drain", done);
              res.off("close", done);
              resolve();
            };
            res.once("drain", done);
            res.once("close", done);
          });
        },
      });
    } catch (err) {
      // Headers are already sent; the best we can do is cut the stream.
      if (!res.headersSent) throw err;
      res.destroy(err as Error);
      return;
    }
    if (!closed) res.end();
  }

  @Post("bulk")
  bulk(@CurrentWorkspace() workspaceId: string, @Body() dto: BulkContactsDto, @Req() req: PermissionRequest) {
    // The route needs contacts.update (permission map); a bulk delete must not
    // be a side door around contacts.delete.
    if (dto.op === "delete") assertRequestPermission(req, "contacts.delete");
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
  summary(@CurrentWorkspace() workspaceId: string, @Param("id") id: string, @CurrentViewer() viewer: Viewer) {
    return this.svc.summary(workspaceId, id, viewer);
  }

  @Get(":id/timeline")
  timeline(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @CurrentViewer() viewer: Viewer,
    @Query("before") before?: string,
    @Query("limit") limit?: string,
  ) {
    return this.timelineSvc.timeline(workspaceId, id, viewer, { before, limit: limit ? Number(limit) : undefined });
  }

  /** SP-31: all of the contact's conversations stitched into one thread, plus events. */
  @Get(":id/thread")
  thread(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @CurrentViewer() viewer: Viewer,
    @Query("before") before?: string,
    @Query("limit") limit?: string,
  ) {
    return this.threadSvc.thread(workspaceId, id, viewer, { before, limit: limit ? Number(limit) : undefined });
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
