import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { MediaService } from "../media/media.service";
import { TagsService } from "../tags/tags.module";
import { ContactsBulkService } from "../contacts/contacts-bulk.service";
import { BulkContactsDto } from "../contacts/contacts.dto";
import { MarketingOutboundService } from "../segments/marketing-outbound.service";
import { addManualMembers } from "../segments/segment-members";
import { NotificationsService } from "../notifications/notifications.service";
import { workspaceContext } from "../common/workspace-context";
import { parseFile } from "./parse-file";
import { importGroupId, loadContext, parseOptions, planBatch, type BatchPlan, type StoredName } from "./import-plan";
import { effectiveNameParts, joinName } from "../contacts/contact-name";
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
  job: {
    id: string;
    workspaceId: string;
    createdById: string;
    fileMediaId: string;
    options: unknown;
    errors: unknown;
  } | null;
  /** The runner's in-memory error list (persisted on every batch). */
  errors?: StoredError[];
  /** Group whose membership this run changed; pushed to HJZ once when the run ends. */
  touchedGroup?: string;
}

const MAX_TRANSIENT_ATTEMPTS = 3;
const TRANSIENT_CODES = new Set(["P1001", "P1008", "P1017", "P2024"]);

/** Connection / timeout class errors that a later resume can survive. */
function isTransient(e: unknown): boolean {
  const code = (e as { code?: unknown })?.code;
  if (typeof code === "string" && (TRANSIENT_CODES.has(code) || /^(ECONNRESET|ETIMEDOUT|ECONNREFUSED)$/.test(code))) {
    return true;
  }
  return /can't reach database|connection (terminated|closed|reset)|timed out|timeout/i.test((e as Error)?.message ?? "");
}

const NOOP_OUTBOUND = { emitSegmentUpserted: async () => true };

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
      await this.fail(jobId, lease, e);
    } finally {
      if (lease.touchedGroup && lease.job) {
        void this.outbound.emitSegmentUpserted(lease.job.workspaceId, lease.touchedGroup);
      }
      this.inFlight.delete(jobId);
    }
  }

  /**
   * Transient database errors leave the job `running` (the resume scheduler
   * retries it) up to MAX_TRANSIENT_ATTEMPTS; anything else fails it with a
   * stored reason and a notification to the creator.
   */
  private async fail(jobId: string, lease: Lease, e: unknown): Promise<void> {
    this.log.error(`import ${jobId} failed: ${(e as Error).message}`);
    try {
      const job = lease.job;
      if (job && isTransient(e)) {
        const opts = (job.options && typeof job.options === "object" ? job.options : {}) as Record<string, unknown>;
        const attempts = (Number(opts.attempts) || 0) + 1;
        if (attempts < MAX_TRANSIENT_ATTEMPTS) {
          await this.prisma.importJob.updateMany({
            where: { id: jobId, status: "running", heartbeatAt: lease.beat },
            data: { options: { ...opts, attempts } as never },
          });
          return;
        }
      }
      const prior = lease.errors ?? ((job?.errors as StoredError[] | null) ?? []);
      const errors: StoredError[] = [
        { row: 0, column: null, key: "imports.err.job_failed" },
        ...prior.filter((x) => x.key !== "imports.err.job_failed").slice(0, MAX_STORED_ERRORS - 1),
      ];
      const res = await this.prisma.importJob.updateMany({
        where: { id: jobId, status: "running", heartbeatAt: lease.beat },
        data: { status: "failed", finishedAt: new Date(), errors: errors as never },
      });
      if (res.count === 1 && job) {
        await this.removeFile(lease);
        await this.notifications.notify(job.workspaceId, [job.createdById], {
          type: "import_finished", // same preference as a finished import
          title: "import.failed",
          body: JSON.stringify({}),
        });
      }
    } catch (inner) {
      this.log.error(`import ${jobId} failure handling crashed: ${(inner as Error).message}`);
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
    // Creating the group and writing options sit behind a fenced gate so a
    // cancelled or re-claimed job does not create anything.
    if (job.kind === "audience" && !options.groupId) {
      const claimed = nextBeat(lease.beat);
      const gate = await this.prisma.importJob.updateMany({
        where: { id: jobId, status: "running", heartbeatAt: lease.beat },
        data: { heartbeatAt: claimed },
      });
      if (gate.count === 0) return;
      lease.beat = claimed;
      const gid = importGroupId(jobId);
      let seg = await this.prisma.segment.findFirst({ where: { id: gid, workspaceId: ws } });
      if (!seg) {
        seg = await this.prisma.segment.create({
          data: { id: gid, workspaceId: ws, name: options.newGroupName ?? job.fileName, origin: "manual", filter: "{}" },
        });
      }
      options.groupId = seg.id;
      lease.touchedGroup = seg.id;
      const withGroup = { ...(job.options as object), groupId: seg.id };
      const saved = await this.prisma.importJob.updateMany({
        where: { id: jobId, status: "running", heartbeatAt: lease.beat },
        data: { options: withGroup },
      });
      if (saved.count === 0) return;
      job.options = withGroup;
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
    lease.errors = errors;

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
      if (await this.apply(ws, ctx, plan, job.kind)) lease.touchedGroup = options.groupId;

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
      if (res.count === 0) {
        // Cancelled mid-batch: the batch is already written, so record its
        // counters (heartbeat-fenced, status-agnostic) to keep the report accurate.
        await this.prisma.importJob.updateMany({
          where: { id: jobId, heartbeatAt: lease.beat },
          data: { processed: end, created, updated, skipped, failed, duplicateInFile, errors: errors as never },
        });
        return;
      }
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
  private async apply(ws: string, ctx: ImportContext, plan: BatchPlan, kind: string): Promise<boolean> {
    let groupChanged = false;
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
      return this.prisma.contact.update({ where: { id: u.id }, data: updateData(u.rec, u.stored, ctx.mapping) });
    });
    // Matched-but-unchanged contacts still get the job's tags and group.
    for (const u of plan.unchanged) tagSets.push({ id: u.id, tags: baseTags });
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
      const ids = [...worked, ...plan.unchanged.map((u) => u.id)];
      // The HJZ push happens once per run, not per batch.
      if (ids.length) {
        await addManualMembers(this.prisma, NOOP_OUTBOUND, ws, options.groupId, ids);
        groupChanged = true;
      }
    }
    if (options.pipeline && worked.length) {
      await this.bulk.run(
        ws,
        Object.assign(new BulkContactsDto(), {
          ids: [...new Set(worked)],
          op: "addToPipeline" as const,
          pipelineId: options.pipeline.pipelineId,
          stageId: options.pipeline.stageId,
        }),
      );
    }
    return groupChanged;
  }
}

function updateData(rec: NormalizedRow, stored: StoredName, mapping: ImportMapping) {
  const data: Record<string, unknown> = {};
  const partsMapped = Object.values(mapping).some((t) => t === "firstName" || t === "lastName");
  if (rec.firstName != null || rec.lastName != null) {
    if (partsMapped) {
      // Only the mapped, non-empty parts change; the rest stay as stored.
      const cur = effectiveNameParts(stored);
      const firstName = rec.firstName ?? cur.firstName;
      const lastName = rec.lastName ?? cur.lastName;
      data.firstName = firstName;
      data.lastName = lastName;
      data.name = joinName(firstName, lastName);
    } else {
      // A single "name" column replaces the whole name.
      data.name = rec.name;
      data.firstName = rec.firstName;
      data.lastName = rec.lastName;
    }
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
