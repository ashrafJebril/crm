/**
 * SP-21 background processing of `file` and `typed_doc` sources: an
 * immediate kick after upload or reprocess, plus a sweep every minute.
 *
 * Lease (SP-03 / SP-10 runner pattern): a run claims a `queued` source by
 * compare-and-set to `processing` with `leaseUntil = claim + 20 min`. Every
 * later write is fenced on `{status: "processing", leaseUntil: <our lease>}`,
 * so two processes (or a run that outlived its lease) never both write. A
 * source still `processing` after its lease is failed by the sweep with
 * `knowledge.processing_stalled`.
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

class LeaseLost extends Error {}

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

@Injectable()
export class KnowledgeProcessor {
  private readonly log = new Logger(KnowledgeProcessor.name);
  private readonly inFlight = new Set<string>();
  private sweeping = false;
  private readonly pdfText: PdfTextFn;

  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    @Inject(KNOWLEDGE_VISION) private readonly vision: KnowledgeVisionPort,
    @Optional() @Inject(KNOWLEDGE_PDF_TEXT) pdfText?: PdfTextFn,
  ) {
    this.pdfText = pdfText ?? defaultPdfText;
  }

  /** Process a queued source in the background; never throws. */
  kick(sourceId: string): void {
    setImmediate(() => {
      void this.run(sourceId).catch(() => this.log.warn(`knowledge source ${sourceId}: run crashed`));
    });
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async sweep(now = new Date()): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    try {
      await this.failStalled(now);
      const queued = await this.prisma.knowledgeSource.findMany({
        where: { status: "queued", kind: { in: ["file", "typed_doc"] } },
        select: { id: true },
        orderBy: { updatedAt: "asc" },
        take: SWEEP_BATCH,
      });
      let ran = 0;
      for (const s of queued) if (await this.run(s.id, now)) ran += 1;
      return ran;
    } catch (e) {
      this.log.warn(`knowledge sweep failed (${(e as Error)?.name ?? "error"})`);
      return 0;
    } finally {
      this.sweeping = false;
    }
  }

  /** Sources whose processing lease ran out are failed (`knowledge.processing_stalled`). */
  async failStalled(now = new Date()): Promise<number> {
    const r = await this.prisma.knowledgeSource.updateMany({
      where: { status: "processing", kind: { in: ["file", "typed_doc"] }, leaseUntil: { lt: now } },
      data: { status: "failed", error: "knowledge.processing_stalled", leaseUntil: null },
    });
    return r.count;
  }

  /** Claim and process one source. False when it was not queued or another run holds it. */
  async run(sourceId: string, now = new Date()): Promise<boolean> {
    if (this.inFlight.has(sourceId)) return false;
    this.inFlight.add(sourceId);
    try {
      const lease = new Date(now.getTime() + PROCESSING_STALL_MS);
      const claim = await this.prisma.knowledgeSource.updateMany({
        where: { id: sourceId, status: "queued", kind: { in: ["file", "typed_doc"] } },
        data: { status: "processing", leaseUntil: lease, error: null },
      });
      if (claim.count !== 1) return false;
      try {
        await this.process(sourceId, lease);
      } catch (e) {
        if (e instanceof LeaseLost) return true;
        const key = failureKey(e);
        // Only the key is logged: never file text, never provider text.
        this.log.warn(`knowledge source ${sourceId}: failed (${key})`);
        await this.prisma.knowledgeSource.updateMany({
          where: { id: sourceId, status: "processing", leaseUntil: lease },
          data: { status: "failed", error: key, leaseUntil: null },
        });
      }
      return true;
    } finally {
      this.inFlight.delete(sourceId);
    }
  }

  private async process(sourceId: string, lease: Date): Promise<void> {
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
    let itemCount: number;
    if (src.kind === "typed_doc") {
      if (!isTypedKind(src.typedKind)) throw new KnowledgeFailure("knowledge.unreadable");
      const typed = await readTyped({ buffer, fileName: file.fileName }, src.typedKind);
      if (typed.validation.missing.length || typed.validation.rows.length === 0) throw new KnowledgeFailure("knowledge.empty");
      // Upload refused bad rows unless the member confirmed "keep the valid rows":
      // only valid rows are ever stored.
      chunks = typedChunks(src.typedKind, typed);
      itemCount = chunks.length;
    } else {
      chunks = await extractFile({ buffer, type, fileName: file.fileName }, { vision: this.vision, pdfText: this.pdfText });
      itemCount = chunks.length;
    }
    const contentHash = createHash("sha256").update(buffer).digest("hex");

    await this.prisma.$transaction(async (tx) => {
      const done = await tx.knowledgeSource.updateMany({
        where: { id: src.id, status: "processing", leaseUntil: lease },
        data: { status: "ready", error: null, itemCount, contentHash, leaseUntil: null },
      });
      if (done.count !== 1) throw new LeaseLost();
      await tx.knowledgeChunk.deleteMany({ where: { workspaceId: src.workspaceId, sourceId: src.id } });
      await tx.knowledgeChunk.createMany({ data: chunkRowsFor(src.workspaceId, src.id, chunks) });
    });
  }
}
