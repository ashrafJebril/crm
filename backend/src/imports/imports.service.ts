import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { MediaService } from "../media/media.service";
import { PermissionService } from "../permissions/permission.service";
import type { Viewer } from "../permissions/visibility";
import { ImportFileError, parseFile } from "./parse-file";
import { importConflict, importError, loadContext, parseOptions, planBatch } from "./import-plan";
import { suggestMapping } from "./suggest-mapping";
import { ImportRunnerService } from "./import-runner.service";
import {
  DupTracker,
  IMPORT_BATCH_SIZE,
  MAX_STORED_ERRORS,
  type FieldDef,
  type ImportMapping,
} from "./import-rows";

const SAMPLE_ROWS = 20;
const MIME_BY_EXT: Record<string, string> = {
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

@Injectable()
export class ImportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    private readonly perm: PermissionService,
    private readonly runner: ImportRunnerService,
  ) {}

  private async require(workspaceId: string, viewer: Viewer, permission: string) {
    if (!(await this.perm.viewerCan(workspaceId, viewer, permission))) {
      throw new ForbiddenException({ message: "imports.forbidden", messageKey: "imports.forbidden", permission });
    }
  }

  /** Extra permissions implied by the job kind / options (routes need contacts.create). */
  private async requireForOptions(
    workspaceId: string,
    viewer: Viewer,
    kind: string,
    options: { updateExisting: boolean; groupId?: string; pipeline?: unknown },
  ) {
    if (options.updateExisting) await this.require(workspaceId, viewer, "contacts.update");
    // A new audience group needs audiences.create; adding to an existing group
    // (either kind) needs audiences.update.
    if (kind === "audience" && !options.groupId) await this.require(workspaceId, viewer, "audiences.create");
    if (options.groupId) await this.require(workspaceId, viewer, "audiences.update");
    if (options.pipeline) {
      await this.require(workspaceId, viewer, "tickets.create");
      await this.require(workspaceId, viewer, "contacts.update");
    }
  }

  private async findJob(workspaceId: string, id: string) {
    const job = await this.prisma.importJob.findFirst({ where: { id, workspaceId } });
    if (!job) throw new NotFoundException("Import not found");
    return job;
  }

  /** Public job view: the internal storage reference is not exposed. */
  private view<T extends { fileMediaId?: string }>(job: T): Omit<T, "fileMediaId"> {
    const { fileMediaId: _omit, ...rest } = job;
    return rest;
  }

  async job(workspaceId: string, id: string) {
    return this.view(await this.findJob(workspaceId, id));
  }

  async create(
    workspaceId: string,
    viewer: Viewer,
    file: { buffer: Buffer; originalname: string } | undefined,
    kind: string,
  ) {
    if (kind !== "contacts" && kind !== "audience") throw importError("imports.invalid_kind");
    if (!file) throw importError("imports.file_missing");
    if (kind === "audience" && !(await this.perm.viewerCan(workspaceId, viewer, "audiences.create"))) {
      // Importing into an existing group only needs audiences.update.
      await this.require(workspaceId, viewer, "audiences.update");
    }
    let parsed;
    try {
      parsed = await parseFile(file.buffer, file.originalname);
    } catch (e) {
      if (e instanceof ImportFileError) throw importError(e.messageKey);
      throw e;
    }
    const ext = /\.([^.\\/]+)$/.exec(file.originalname)?.[1]?.toLowerCase() ?? "csv";
    const stored = await this.media.ingestDocument({
      workspaceId,
      buffer: file.buffer,
      mimeType: MIME_BY_EXT[ext] ?? "text/csv",
      fileName: file.originalname,
      uploadedById: viewer.userId,
    });
    const job = await this.prisma.importJob.create({
      data: {
        workspaceId,
        createdById: viewer.userId,
        kind,
        status: "uploaded",
        fileMediaId: stored.id,
        fileName: file.originalname,
        totalRows: parsed.rows.length,
      },
    });
    const defs = (await this.prisma.customFieldDef.findMany({
      where: { workspaceId, entity: "contact", archivedAt: null },
    })) as unknown as FieldDef[];
    return {
      id: job.id,
      fileName: job.fileName,
      headers: parsed.headers,
      sampleRows: parsed.rows.slice(0, SAMPLE_ROWS),
      totalRows: parsed.rows.length,
      suggestedMapping: suggestMapping(parsed.headers, defs),
    };
  }

  async preview(
    workspaceId: string,
    viewer: Viewer,
    id: string,
    body: { mapping: ImportMapping; options?: Record<string, unknown> },
  ) {
    const job = await this.findJob(workspaceId, id);
    if (job.status !== "uploaded" && job.status !== "previewed") throw importConflict("imports.invalid_state");
    const options = parseOptions(body.options, job.kind);
    await this.requireForOptions(workspaceId, viewer, job.kind, options);

    const parsed = await parseFile(await this.media.readBuffer(workspaceId, job.fileMediaId), job.fileName);
    const ctx = await loadContext(this.prisma, workspaceId, parsed.headers, body.mapping, options, job.totalRows);

    const counts = { new: 0, update: 0, unchanged: 0, invalid: 0, duplicateInFile: 0 };
    const invalidSamples: { row: number; column: string | null; key: string }[] = [];
    const tracker = new DupTracker(options.matchBy);
    for (let offset = 0; offset < parsed.rows.length; offset += IMPORT_BATCH_SIZE) {
      const end = Math.min(offset + IMPORT_BATCH_SIZE, parsed.rows.length);
      const plan = await planBatch(
        this.prisma,
        workspaceId,
        ctx,
        parsed.rows.slice(offset, end),
        parsed.rowNumbers.slice(offset, end),
        tracker,
      );
      counts.new += plan.news.length;
      counts.update += plan.updates.length;
      counts.unchanged += plan.unchanged.length;
      counts.invalid += plan.invalid.length;
      counts.duplicateInFile += plan.duplicates;
      for (const inv of plan.invalid) {
        for (const e of inv.errors) {
          if (invalidSamples.length < MAX_STORED_ERRORS) {
            invalidSamples.push({ row: inv.row, column: e.column, key: e.key });
          }
        }
      }
      await new Promise((r) => setImmediate(r));
    }

    // Guarded: a run/cancel that started while we were counting must not be overwritten.
    const saved = await this.prisma.importJob.updateMany({
      where: { id, workspaceId, status: { in: ["uploaded", "previewed"] } },
      data: { status: "previewed", mapping: body.mapping as never, options: options as never },
    });
    if (saved.count === 0) throw importConflict("imports.invalid_state");
    return { counts, invalidSamples };
  }

  async run(workspaceId: string, viewer: Viewer, id: string) {
    const job = await this.findJob(workspaceId, id);
    if (job.status === "running") return this.view(job);
    if (job.status !== "previewed" || !job.mapping || !job.options) throw importError("imports.not_previewed");
    await this.requireForOptions(workspaceId, viewer, job.kind, parseOptions(job.options, job.kind));
    const now = new Date();
    // Compare-and-set so two clicks cannot start the job twice.
    const res = await this.prisma.importJob.updateMany({
      where: { id, workspaceId, status: "previewed" },
      data: { status: "running", startedAt: now, heartbeatAt: now },
    });
    const fresh = await this.job(workspaceId, id);
    if (res.count === 1) this.runner.kick(id);
    return fresh;
  }

  async cancel(workspaceId: string, id: string) {
    const job = await this.findJob(workspaceId, id);
    const res = await this.prisma.importJob.updateMany({
      where: { id, workspaceId, status: { in: ["uploaded", "previewed", "running"] } },
      data: { status: "cancelled", finishedAt: new Date() },
    });
    if (res.count === 1) {
      // A cancelled job never resumes; drop its stored upload.
      await this.media.remove(workspaceId, job.fileMediaId).catch(() => undefined);
    }
    return this.job(workspaceId, id);
  }

  async list(workspaceId: string, limit = 10) {
    const take = Math.min(Math.max(Number.isFinite(limit) ? limit : 10, 1), 50);
    const rows = await this.prisma.importJob.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      take,
    });
    return rows.map((r) => this.view(r));
  }
}
