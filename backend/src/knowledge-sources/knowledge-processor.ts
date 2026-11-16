/**
 * SP-21 background processing of `file` and `typed_doc` sources: an
 * immediate kick after upload or reprocess, plus a sweep every minute.
 *
 * Lease (SP-03 / SP-10 runner pattern): a run claims a `queued` source by
 * compare-and-set to `processing` with `leaseUntil = now + 20 min`. A
 * heartbeat moves the lease forward while the run is alive (a long streamed
 * transcription), each move a compare-and-set on the lease it holds. Every
 * write is fenced on `{status: "processing", leaseUntil: <our lease>}`, so two
 * processes (or a run that outlived its lease) never both write. A source
 * still `processing` after its lease ran out is failed by the sweep with
 * `knowledge.processing_stalled` (no heartbeat for 20 min).
 *
 * Absolute cap: a run may last at most MAX_RUN_MS (45 min) from its claim,
 * heartbeat or not. The claim time is kept in `syncStartedAt` (for file
 * sources it means "processing started at"; websites use it for their own
 * lease in Task 2). The heartbeat never extends the lease past the cap, the
 * sweep fails any run claimed longer ago than the cap, and the run itself
 * stops waiting at the cap (its slot is freed; anything the abandoned work
 * writes later is fenced out). The Claude stream has its own 30-min abort.
 *
 * Concurrency: at most KNOWLEDGE_MAX_CONCURRENT_RUNS runs per process (each
 * holds a file of up to 20 MB plus its base64 copy in memory). Kicks beyond
 * that wait in an in-process queue; sources stay `queued` in the database, so
 * the sweep (here or in another process) picks them up too.
 *
 * Transient provider failures (429, 529, 5xx, network after the SDK's own
 * retries) are retried once: the source goes back to `queued` with
 * `leaseUntil` as a "not before" time RETRY_BACKOFF_MS ahead and
 * `consecutiveFailures = 1`; a second transient failure is `ai_failed`.
 *
 * The only outputs are the source's chunks and its status / error /
 * itemCount / contentHash. Extracted text and transcriptions are data: they
 * never reach settings, sends or another workspace, and are never logged.
 */
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { createHash } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { MediaService } from "../media/media.service";
import { PROCESSING_STALL_MS, type KbFileType } from "./knowledge-constants";
import { failureKey, KnowledgeFailure } from "./knowledge-errors";
import { defaultPdfText, extractFile, readTyped, typeOfMime, typedChunks, type PdfTextFn } from "./knowledge-extract";
import type { Chunk } from "./knowledge-chunker";
import type { KnowledgeVisionPort } from "./knowledge-vision";
import { isTypedKind } from "./typed-docs";

export const KNOWLEDGE_VISION = Symbol("KNOWLEDGE_VISION");
export const KNOWLEDGE_PDF_TEXT = Symbol("KNOWLEDGE_PDF_TEXT");
/** Sources picked per sweep. */
export const SWEEP_BATCH = 10;
/** Runs in flight per process (memory bound: files are read whole). */
export const KNOWLEDGE_MAX_CONCURRENT_RUNS = 2;
/** How often a live run extends its lease. */
export const HEARTBEAT_MS = 5 * 60 * 1000;
/** Wait before the single retry of a transient provider failure. */
export const RETRY_BACKOFF_MS = 5 * 60 * 1000;
/** Transient retries before the failure is final. */
export const MAX_TRANSIENT_RETRIES = 1;
/** Absolute cap on one run, from its claim, whatever its heartbeat. */
export const MAX_RUN_MS = 45 * 60 * 1000;

class LeaseLost extends Error {}
class RunCapped extends Error {}

const FILE_KINDS = ["file", "typed_doc"];

/** Chunk rows as stored. */
export function chunkRowsFor(workspaceId: string, sourceId: string, chunks: Chunk[], pageId: string | null = null) {
  return chunks.map((c, ord) => ({
    workspaceId,
    sourceId,
    pageId,
    ord,
    heading: c.heading ?? null,
    text: c.text,
    rowRef: c.rowRef ?? null,
    validTo: c.validTo ? new Date(`${c.validTo}T00:00:00.000Z`) : null,
  }));
}

/** The lease a run holds; the heartbeat moves `at` forward. */
interface Lease {
  at: Date;
  /** The claim time (stored in `syncStartedAt`). */
  claimedAt: Date;
  /** The heartbeat write in flight, awaited before any fenced write. */
  beat: Promise<void>;
}

@Injectable()
export class KnowledgeProcessor {
  private readonly log = new Logger(KnowledgeProcessor.name);
  private readonly inFlight = new Set<string>();
  private readonly pending = new Set<string>();
  private sweeping = false;
  private readonly pdfText: PdfTextFn;
  /** Overridable in specs. */
  protected heartbeatMs = HEARTBEAT_MS;
  protected maxConcurrent = KNOWLEDGE_MAX_CONCURRENT_RUNS;
  protected maxRunMs = MAX_RUN_MS;

  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    @Inject(KNOWLEDGE_VISION) private readonly vision: KnowledgeVisionPort,
    @Optional() @Inject(KNOWLEDGE_PDF_TEXT) pdfText?: PdfTextFn,
  ) {
    this.pdfText = pdfText ?? defaultPdfText;
  }

  /** Queue a source for processing in this process; never throws. */
  kick(sourceId: string): void {
    this.pending.add(sourceId);
    setImmediate(() => this.pump());
  }

  /** Runs in flight in this process (specs, diagnostics). */
  activeRuns(): number {
    return this.inFlight.size;
  }

  /** Start queued kicks while slots are free. */
  private pump(): void {
    while (this.pending.size > 0 && this.inFlight.size < this.maxConcurrent) {
      const id = this.pending.values().next().value as string;
      this.pending.delete(id);
      void this.run(id)
        .catch(() => this.log.warn(`knowledge source ${id}: run crashed`))
        .finally(() => this.pump());
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async sweep(now = new Date()): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    try {
      await this.failStalled(now);
      const queued = await this.prisma.knowledgeSource.findMany({
        where: { status: "queued", kind: { in: FILE_KINDS }, OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
        select: { id: true },
        orderBy: { updatedAt: "asc" },
        take: SWEEP_BATCH,
      });
      let ran = 0;
      for (const s of queued) {
        if (this.inFlight.size >= this.maxConcurrent) break;
        if (await this.run(s.id, now)) ran += 1;
      }
      return ran;
    } catch (e) {
      this.log.warn(`knowledge sweep failed (${(e as Error)?.name ?? "error"})`);
      return 0;
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Fail (`knowledge.processing_stalled`) the runs whose lease ran out, and
   * the runs claimed more than the absolute cap ago even if they still beat.
   */
  async failStalled(now = new Date()): Promise<number> {
    const r = await this.prisma.knowledgeSource.updateMany({
      where: {
        status: "processing",
        kind: { in: FILE_KINDS },
        OR: [{ leaseUntil: { lt: now } }, { syncStartedAt: { lt: new Date(now.getTime() - this.maxRunMs) } }],
      },
      data: { status: "failed", error: "knowledge.processing_stalled", leaseUntil: null, syncStartedAt: null },
    });
    return r.count;
  }

  /**
   * Claim and process one source. False when no slot is free, when it is not
   * queued (or its retry time has not come), or when another run holds it.
   */
  async run(sourceId: string, now = new Date()): Promise<boolean> {
    if (this.inFlight.has(sourceId) || this.inFlight.size >= this.maxConcurrent) return false;
    this.inFlight.add(sourceId);
    let timer: NodeJS.Timeout | undefined;
    let cap: NodeJS.Timeout | undefined;
    try {
      const lease: Lease = { at: new Date(now.getTime() + PROCESSING_STALL_MS), claimedAt: now, beat: Promise.resolve() };
      const claim = await this.prisma.knowledgeSource.updateMany({
        where: {
          id: sourceId,
          status: "queued",
          kind: { in: FILE_KINDS },
          OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
        },
        data: { status: "processing", leaseUntil: lease.at, syncStartedAt: now, error: null },
      });
      if (claim.count !== 1) return false;
      timer = setInterval(() => {
        lease.beat = lease.beat.then(() => this.heartbeat(sourceId, lease)).catch(() => undefined);
      }, this.heartbeatMs);
      timer.unref?.();
      // Stop waiting at the absolute cap: the slot is freed even if the work hangs.
      const capped = new Promise<never>((_, reject) => {
        cap = setTimeout(() => reject(new RunCapped()), Math.max(0, now.getTime() + this.maxRunMs - Date.now()));
        cap.unref?.();
      });
      const work = this.process(sourceId, lease);
      work.catch(() => undefined); // an abandoned run's late rejection is not unhandled
      try {
        await Promise.race([work, capped]);
      } catch (e) {
        if (e instanceof LeaseLost) return true;
        clearInterval(timer);
        await lease.beat;
        if (e instanceof RunCapped) {
          this.log.warn(`knowledge source ${sourceId}: run over the absolute cap`);
          await this.prisma.knowledgeSource.updateMany({
            where: { id: sourceId, status: "processing", leaseUntil: lease.at },
            data: { status: "failed", error: "knowledge.processing_stalled", leaseUntil: null, syncStartedAt: null },
          });
          return true;
        }
        await this.fail(sourceId, lease, e);
      }
      return true;
    } finally {
      if (timer) clearInterval(timer);
      if (cap) clearTimeout(cap);
      this.inFlight.delete(sourceId);
    }
  }

  /** Move the lease forward if we still hold it, never past the absolute cap. */
  private async heartbeat(sourceId: string, lease: Lease): Promise<void> {
    const capAt = lease.claimedAt.getTime() + this.maxRunMs;
    // Strictly later than the current lease (every lease value is unique), at most the cap.
    const next = new Date(Math.min(Math.max(Date.now() + PROCESSING_STALL_MS, lease.at.getTime() + 1), capAt));
    if (next.getTime() <= lease.at.getTime()) return;
    const r = await this.prisma.knowledgeSource.updateMany({
      where: { id: sourceId, status: "processing", leaseUntil: lease.at },
      data: { leaseUntil: next },
    });
    if (r.count === 1) lease.at = next;
  }

  /** Record a failure: a first transient provider failure is queued again after a backoff. */
  private async fail(sourceId: string, lease: Lease, e: unknown): Promise<void> {
    const key = failureKey(e);
    if (e instanceof KnowledgeFailure && e.transient) {
      const retry = await this.prisma.knowledgeSource.updateMany({
        where: { id: sourceId, status: "processing", leaseUntil: lease.at, consecutiveFailures: { lt: MAX_TRANSIENT_RETRIES } },
        data: { status: "queued", error: null, leaseUntil: new Date(Date.now() + RETRY_BACKOFF_MS), syncStartedAt: null, consecutiveFailures: { increment: 1 } },
      });
      if (retry.count === 1) {
        this.log.warn(`knowledge source ${sourceId}: transient failure, retry queued`);
        return;
      }
    }
    // Only the key is logged: never file text, never provider text.
    this.log.warn(`knowledge source ${sourceId}: failed (${key})`);
    await this.prisma.knowledgeSource.updateMany({
      where: { id: sourceId, status: "processing", leaseUntil: lease.at },
      data: { status: "failed", error: key, leaseUntil: null, syncStartedAt: null },
    });
  }

  private async process(sourceId: string, lease: Lease): Promise<void> {
    const src = await this.prisma.knowledgeSource.findFirst({ where: { id: sourceId } });
    if (!src) throw new LeaseLost();
    if (!src.mediaId) throw new KnowledgeFailure("knowledge.unreadable");
    const file = await this.prisma.media.findFirst({
      where: { id: src.mediaId, workspaceId: src.workspaceId },
      select: { id: true, mimeType: true, fileName: true },
    });
    const type: KbFileType | null = file ? typeOfMime(file.mimeType) : null;
    if (!file || !type) throw new KnowledgeFailure("knowledge.unreadable");
    let buffer: Buffer;
    try {
      buffer = await this.media.readBuffer(src.workspaceId, file.id);
    } catch {
      throw new KnowledgeFailure("knowledge.unreadable");
    }

    let chunks: Chunk[];
    if (src.kind === "typed_doc") {
      if (!isTypedKind(src.typedKind)) throw new KnowledgeFailure("knowledge.unreadable");
      const typed = await readTyped({ buffer, fileName: file.fileName }, src.typedKind);
      if (typed.validation.missing.length || typed.validation.rows.length === 0) throw new KnowledgeFailure("knowledge.empty");
      // Upload refused bad rows unless the member confirmed "keep the valid rows":
      // only valid rows are ever stored.
      chunks = typedChunks(src.typedKind, typed);
    } else {
      chunks = await extractFile({ buffer, type, fileName: file.fileName }, { vision: this.vision, pdfText: this.pdfText });
    }
    const contentHash = createHash("sha256").update(buffer).digest("hex");

    await lease.beat;
    await this.prisma.$transaction(async (tx) => {
      const done = await tx.knowledgeSource.updateMany({
        where: { id: src.id, status: "processing", leaseUntil: lease.at },
        data: { status: "ready", error: null, itemCount: chunks.length, contentHash, leaseUntil: null, syncStartedAt: null, consecutiveFailures: 0 },
      });
      if (done.count !== 1) throw new LeaseLost();
      await tx.knowledgeChunk.deleteMany({ where: { workspaceId: src.workspaceId, sourceId: src.id } });
      await tx.knowledgeChunk.createMany({ data: chunkRowsFor(src.workspaceId, src.id, chunks) });
    });
  }
}
