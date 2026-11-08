import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { MediaService } from "../media/media.service";
import { TagsService } from "../tags/tags.module";
import { ContactsBulkService } from "../contacts/contacts-bulk.service";
import { MarketingOutboundService } from "../segments/marketing-outbound.service";
import { addManualMembers } from "../segments/segment-members";
import { NotificationsService } from "../notifications/notifications.service";
import { workspaceContext } from "../common/workspace-context";
import { parseFile } from "./parse-file";
import { importGroupId, loadContext, parseOptions, planBatch, type BatchPlan } from "./import-plan";
import {
  DupTracker,
  IMPORT_BATCH_SIZE,
  MAX_STORED_ERRORS,
  normalizeRow,
  type ImportContext,
  type ImportMapping,
  type NormalizedRow,
} from "./import-rows";

type StoredError = { row: number; column: string | null; key: string };

/** The runner's lease on a job: the heartbeat value it last wrote. */
interface Lease {
  beat: Date | null;
  job: { id: string; workspaceId: string; fileMediaId: string } | null;
}

/** Strictly increasing heartbeat so every lease value is unique. */
function nextBeat(prev: Date | null): Date {
  return new Date(Math.max(Date.now(), (prev?.getTime() ?? 0) + 1));
}

/**
 * Runs an ImportJob in the background: 500 rows per batch, persisting
 * `processed` + counters + heartbeat after each batch and yielding the event
 * loop (setImmediate) between batches so a 50k-row import never starves HTTP.
 *
 * Exactly-once resume: each created contact gets a deterministic id derived
 * from (jobId, source row number). A resumed batch finds the contacts this job
 * already created by id (so rows without phone or email are not duplicated
 * either), creates only the missing ones, and re-applies custom values, tags,
 * group and pipeline to all of them.
 *
 * Lease fencing: every batch start and progress write is conditional on the
 * heartbeat value this runner last wrote; if the resume scheduler claimed the
 * job (fresh heartbeat) the stale runner's next write matches nothing and it stops.
 *
 * Workflows: contacts are written with `createMany`, which emits no per-contact
 * `contact_created` workflow trigger. That is deliberate for bulk imports.
 */
@Injectable()
export class ImportRunnerService {
  private readonly log = new Logger(ImportRunnerService.name);
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    private readonly tags: TagsService,
    private readonly bulk: ContactsBulkService,
    private readonly outbound: MarketingOutboundService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Start (or resume) a job in the background; never throws. */
  kick(jobId: string): void {
    setImmediate(() => {
      void this.run(jobId).catch((e) => this.log.error(`import ${jobId} crashed: ${(e as Error).message}`));
    });
  }

  /** Overridable yield point (spied on in tests). */
  protected yieldTick(): Promise<void> {
    return new Promise((r) => setImmediate(r));
  }

  isRunning(jobId: string): boolean {
    return this.inFlight.has(jobId);
  }

  async run(jobId: string): Promise<void> {
    if (this.inFlight.has(jobId)) return;
    this.inFlight.add(jobId);
    const lease: Lease = { beat: null, job: null };
    try {
      const job = await this.prisma.importJob.findFirst({ where: { id: jobId } });
      if (!job || job.status !== "running") return;
      lease.beat = job.heartbeatAt;
      lease.job = job;
      await workspaceContext.run({ workspaceId: job.workspaceId, userId: job.createdById }, () =>
        this.execute(job, lease),
      );
    } catch (e) {
      this.log.error(`import ${jobId} failed: ${(e as Error).message}`);
      const res = await this.prisma.importJob.updateMany({
        where: { id: jobId, status: "running", heartbeatAt: lease.beat },
        data: { status: "failed", finishedAt: new Date() },
      });
      if (res.count === 1) await this.removeFile(lease);
    } finally {
      this.inFlight.delete(jobId);
    }
  }

  /** The stored upload is only needed while the job can still run. */
  private async removeFile(lease: Lease): Promise<void> {
    if (!lease.job) return;
    try {
      await this.media.remove(lease.job.workspaceId, lease.job.fileMediaId);
    } catch (e) {
      this.log.warn(`import file cleanup failed: ${(e as Error).message}`);
    }
  }

  private async execute(
    job: NonNullable<Awaited<ReturnType<PrismaService["importJob"]["findFirst"]>>>,
    lease: Lease,
  ): Promise<void> {
    const jobId = job.id;
    const ws = job.workspaceId;

    const parsed = await parseFile(await this.media.readBuffer(ws, job.fileMediaId), job.fileName);
    const options = parseOptions(job.options, job.kind);
    const ctx = await loadContext(this.prisma, ws, parsed.headers, job.mapping as ImportMapping, options, 0);

    // Audience import: one group per job, with a job-derived id so a crash
    // between creating it and persisting options cannot create a second one.
    if (job.kind === "audience" && !options.groupId) {
      const gid = importGroupId(jobId);
      let seg = await this.prisma.segment.findFirst({ where: { id: gid, workspaceId: ws } });
      if (!seg) {
        seg = await this.prisma.segment.create({
          data: { id: gid, workspaceId: ws, name: options.newGroupName ?? job.fileName, origin: "manual", filter: "{}" },
        });
        void this.outbound.emitSegmentUpserted(ws, seg.id);
      }
      options.groupId = seg.id;
      await this.prisma.importJob.updateMany({
        where: { id: jobId },
        data: { options: { ...(job.options as object), groupId: seg.id } },
      });
    }

    const tracker = new DupTracker(options.matchBy);
    const start = Math.min(job.processed, parsed.rows.length);
    for (let i = 0; i < start; i++) {
      const r = normalizeRow(parsed.rows[i], ctx);
      if (r.ok) tracker.isDuplicate(r.rec);
      if (i % 5000 === 4999) await this.yieldTick();
    }

    let created = job.created;
    let updated = job.updated;
    let skipped = job.skipped;
    let failed = job.failed;
    let duplicateInFile = job.duplicateInFile;
    const errors = ((job.errors as StoredError[] | null) ?? []).slice(0, MAX_STORED_ERRORS);

    for (let offset = start; offset < parsed.rows.length; offset += IMPORT_BATCH_SIZE) {
      // Batch-start fence: still running, and still our lease.
      const claimed = nextBeat(lease.beat);
      const gate = await this.prisma.importJob.updateMany({
        where: { id: jobId, status: "running", heartbeatAt: lease.beat },
        data: { heartbeatAt: claimed },
      });
      if (gate.count === 0) return; // cancelled, or another runner took over
      lease.beat = claimed;

      const end = Math.min(offset + IMPORT_BATCH_SIZE, parsed.rows.length);
      const plan = await planBatch(
        this.prisma,
        ws,
        ctx,
        parsed.rows.slice(offset, end),
        parsed.rowNumbers.slice(offset, end),
        tracker,
        jobId,
      );
      await this.apply(ws, ctx, plan, job.kind);

      created += plan.news.length + plan.resumed.length;
      updated += plan.updates.length;
      skipped += plan.unchanged.length;
      failed += plan.invalid.length;
      duplicateInFile += plan.duplicates;
      for (const inv of plan.invalid) {
        for (const e of inv.errors) {
          if (errors.length < MAX_STORED_ERRORS) errors.push({ row: inv.row, column: e.column, key: e.key });
        }
      }

      const next = nextBeat(lease.beat);
      const res = await this.prisma.importJob.updateMany({
        where: { id: jobId, status: "running", heartbeatAt: lease.beat },
        data: {
          processed: end,
          created,
          updated,
          skipped,
          failed,
          duplicateInFile,
          errors: errors as never,
          heartbeatAt: next,
        },
      });
      if (res.count === 0) return;
      lease.beat = next;
      await this.yieldTick();
    }

    const finished = nextBeat(lease.beat);
    const done = await this.prisma.importJob.updateMany({
      where: { id: jobId, status: "running", heartbeatAt: lease.beat },
      data: { status: "done", processed: parsed.rows.length, finishedAt: new Date(), heartbeatAt: finished },
    });
    if (done.count === 0) return;
    await this.notifications.notify(ws, [job.createdById], {
      type: "import_finished",
      title: "import.finished",
      body: JSON.stringify({ created, updated, failed }),
    });
    await this.removeFile(lease);
  }

  /** Writes one planned batch. Every step is idempotent so a replay is safe. */
  private async apply(ws: string, ctx: ImportContext, plan: BatchPlan, kind: string): Promise<void> {
    const { options } = ctx;
    const tagSets: { id: string; tags: string[] }[] = [];
    const customRows: { defId: string; contactId: string; value: unknown }[] = [];
    const baseTags = options.tags ?? [];

    if (plan.news.length) {
      await this.prisma.contact.createMany({
        data: plan.news.map(({ id, rec }) => ({
          id,
          workspaceId: ws,
          name: rec.name,
          firstName: rec.firstName,
          lastName: rec.lastName,
          phone: rec.phone,
          email: rec.email,
          industry: rec.industry ?? "",
          lifecycle: rec.lifecycle ?? "lead",
          source: rec.source ?? "Import",
          value: rec.value,
          lastSeen: "just now",
          tags: "[]",
          ownerId: rec.ownerId ?? options.ownerId ?? null,
        })),
        skipDuplicates: true,
      });
    }
    const createdHere = [...plan.news, ...plan.resumed];
    for (const { id, rec } of createdHere) {
      tagSets.push({ id, tags: [...baseTags, ...rec.tags] });
      for (const [defId, value] of Object.entries(rec.custom)) customRows.push({ defId, contactId: id, value });
    }

    const updateOps = plan.updates.map((u) => {
      tagSets.push({ id: u.id, tags: [...baseTags, ...u.rec.tags] });
      return this.prisma.contact.update({ where: { id: u.id }, data: updateData(u.rec) });
    });
    if (updateOps.length) await this.prisma.$transaction(updateOps);

    const overwrite = new Map<string, string[]>();
    for (const u of plan.updates) {
      for (const [defId, value] of Object.entries(u.rec.custom)) {
        customRows.push({ defId, contactId: u.id, value });
        overwrite.set(defId, [...(overwrite.get(defId) ?? []), u.id]);
      }
    }
    if (customRows.length) {
      const ops = [
        ...[...overwrite].map(([defId, ids]) =>
          this.prisma.customFieldValue.deleteMany({ where: { defId, contactId: { in: ids } } }),
        ),
        this.prisma.customFieldValue.createMany({
          data: customRows.map((r) => ({ ...r, value: r.value as never })),
          skipDuplicates: true,
        }),
      ];
      await this.prisma.$transaction(ops);
    }

    // Tags: one set-based assign per distinct tag set in the batch.
    const bySet = new Map<string, { tags: string[]; ids: string[] }>();
    for (const t of tagSets) {
      const tags = [...new Set(t.tags)].sort();
      if (!tags.length) continue;
      const key = JSON.stringify(tags);
      const g = bySet.get(key) ?? { tags, ids: [] };
      g.ids.push(t.id);
      bySet.set(key, g);
    }
    for (const g of bySet.values()) await this.tags.assign(ws, { contactIds: g.ids, add: g.tags });

    const worked = [...createdHere.map((c) => c.id), ...plan.updates.map((u) => u.id)];
    if (options.groupId) {
      const ids = kind === "audience" ? [...worked, ...plan.unchanged.map((u) => u.id)] : worked;
      if (ids.length) await addManualMembers(this.prisma, this.outbound, ws, options.groupId, ids);
    }
    if (options.pipeline && worked.length) {
      await this.bulk.run(ws, {
        ids: [...new Set(worked)],
        op: "addToPipeline",
        pipelineId: options.pipeline.pipelineId,
        stageId: options.pipeline.stageId,
      } as never);
    }
  }
}

function updateData(rec: NormalizedRow) {
  const data: Record<string, unknown> = {};
  if (rec.firstName != null || rec.lastName != null) {
    data.name = rec.name;
    data.firstName = rec.firstName;
    data.lastName = rec.lastName;
  }
  if (rec.phone) data.phone = rec.phone;
  if (rec.email) data.email = rec.email;
  if (rec.lifecycle) data.lifecycle = rec.lifecycle;
  if (rec.source) data.source = rec.source;
  if (rec.industry) data.industry = rec.industry;
  if (rec.value) data.value = rec.value;
  if (rec.ownerId) data.ownerId = rec.ownerId;
  return data;
}
