/**
 * SP-21 knowledge sources: CRUD for content, FAQs, guidelines, files and
 * typed documents; preview, pages, file download, delete.
 *
 * Every read and write is scoped to the caller's workspace: a foreign or
 * unknown id is 404 `knowledge.not_found`. Content, guidelines and FAQs carry
 * an optimistic `version`; a stale save is 409 `knowledge.version_conflict
 * {current}`. Content and guidelines are singletons (the first save creates
 * them, under a per-workspace advisory lock). Uploaded files are Media rows
 * hidden from the library (ruling 9), created in the same transaction as the
 * sources that reference them; a batch with one bad file creates nothing.
 */
import { Injectable, Logger, Optional } from "@nestjs/common";
import type { Response } from "express";
import type { KnowledgeSource, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { MediaService } from "../media/media.service";
import { familyOfMime, sniffFamily, SNIFF_BYTES } from "../media/sniff";
import { chunkText, type Chunk } from "./knowledge-chunker";
import {
  FAQ_ANSWER_MAX,
  FAQ_MAX,
  FAQ_QUESTION_MAX,
  GUIDELINES_MAX,
  KB_BATCH_MAX,
  KB_FILE_MAX_BYTES,
  PAGE_STATES,
  PREVIEW_MAX_ITEMS,
  type KbFileType,
  type KnowledgeKind,
  type KnowledgeStatus,
  type PageState,
  type TypedKind,
} from "./knowledge-constants";
import { tiptapToText } from "./knowledge-content";
import { knowledgeError, KnowledgeFailure } from "./knowledge-errors";
import { MIME_OF_TYPE, readTyped } from "./knowledge-extract";
import { chunkRowsFor, KnowledgeProcessor } from "./knowledge-processor";
import { KnowledgePublisher } from "./knowledge-publisher";
import type {
  KnowledgePageDto,
  KnowledgePreviewDto,
  KnowledgeSourceDto,
} from "./knowledge-sources.dto";
import { isTypedKind } from "./typed-docs";

export const CONTENT_TITLE = "Business content";
export const GUIDELINES_TITLE = "Guidelines";
/** Titles are trimmed to this (FAQ titles hold the question). */
export const TITLE_MAX = 200;
export const PAGES_PAGE_SIZE = 50;

export interface UploadedFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

type SourceWithMedia = KnowledgeSource & { media?: { fileName: string; mimeType: string; sizeBytes: number } | null };

const EXT_TYPE: Record<string, KbFileType> = {
  pdf: "pdf",
  xlsx: "xlsx",
  csv: "csv",
  jpg: "jpeg",
  jpeg: "jpeg",
  png: "png",
  webp: "webp",
};

/** Normalise a FAQ question for the duplicate check (trimmed, spaces collapsed, case-folded). */
export function questionKey(q: string): string {
  return q.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

/**
 * The knowledge type of an upload, by extension and declared type, confirmed
 * by the file's first bytes (an HTML page renamed `.pdf` is refused). Null
 * when it is not an accepted type. ODS and every other format are refused
 * (ruling 6).
 */
export function classifyUpload(f: { originalname: string; mimetype: string; buffer: Buffer }): KbFileType | null {
  const ext = /\.([^.\\/]+)$/.exec(f.originalname || "")?.[1]?.toLowerCase() ?? "";
  const type = EXT_TYPE[ext];
  if (!type) return null;
  const head = f.buffer.subarray(0, Math.max(SNIFF_BYTES, 512));
  switch (type) {
    case "pdf":
    case "jpeg":
    case "png":
    case "webp":
      return sniffFamily(head) === familyOfMime(MIME_OF_TYPE[type]) ? type : null;
    case "xlsx":
      // An OOXML workbook is a zip archive (`PK\x03\x04`).
      return head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04 ? type : null;
    case "csv": {
      // Text only: no NUL bytes, no known binary signature, not an HTML page.
      if (head.includes(0)) return null;
      if (sniffFamily(head)) return null;
      const start = head.toString("utf8").replace(/^﻿/, "").trimStart().slice(0, 15).toLowerCase();
      if (start.startsWith("<!doctype") || start.startsWith("<html") || start.startsWith("<?xml")) return null;
      return type;
    }
  }
}

@Injectable()
export class KnowledgeSourcesService {
  private readonly log = new Logger(KnowledgeSourcesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    private readonly processor: KnowledgeProcessor,
    /** SP-21 Task 2: after-commit publishing (absent in specs that do not need it). */
    @Optional() private readonly publisher?: KnowledgePublisher,
  ) {}

  // ─── Reads ──────────────────────────────────────────────────────────────

  toDto(row: SourceWithMedia, pageCounts?: Partial<Record<PageState, number>>): KnowledgeSourceDto {
    const dto: KnowledgeSourceDto = {
      id: row.id,
      kind: row.kind as KnowledgeKind,
      status: row.status as KnowledgeStatus,
      error: row.error ?? null,
      title: row.title,
      order: row.order,
      typedKind: (row.typedKind as TypedKind | null) ?? null,
      url: row.url ?? null,
      scope: (row.scope as "site" | "path" | null) ?? null,
      schedule: (row.schedule as KnowledgeSourceDto["schedule"]) ?? null,
      lastSyncAt: row.lastSyncAt ?? null,
      nextSyncAt: row.nextSyncAt ?? null,
      consecutiveFailures: row.consecutiveFailures,
      lastRun: row.lastRun ?? null,
      itemCount: row.itemCount,
      publishState: row.publishState,
      legacy: !!row.legacyRef,
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      file: row.media ? { fileName: row.media.fileName, mimeType: row.media.mimeType, sizeBytes: row.media.sizeBytes } : null,
    };
    if (row.kind === "content") dto.bodyJson = row.bodyJson ?? null;
    if (row.kind === "content" || row.kind === "guideline" || row.kind === "faq") dto.body = row.body ?? null;
    if (row.kind === "faq") dto.question = row.question ?? null;
    if (row.kind === "website") dto.pageCounts = pageCounts ?? {};
    return dto;
  }

  private readonly include = { media: { select: { fileName: true, mimeType: true, sizeBytes: true } } } as const;

  private async pageCounts(workspaceId: string, ids: string[]): Promise<Map<string, Partial<Record<PageState, number>>>> {
    const out = new Map<string, Partial<Record<PageState, number>>>();
    if (ids.length === 0) return out;
    const groups = await this.prisma.knowledgePage.groupBy({
      by: ["sourceId", "state"],
      where: { workspaceId, sourceId: { in: ids } },
      _count: { _all: true },
    });
    for (const g of groups as unknown as { sourceId: string; state: string; _count: { _all: number } }[]) {
      if (!(PAGE_STATES as readonly string[]).includes(g.state)) continue;
      const m = out.get(g.sourceId) ?? {};
      m[g.state as PageState] = g._count._all;
      out.set(g.sourceId, m);
    }
    return out;
  }

  /** The row, or 404 `knowledge.not_found` (unknown or another workspace's). */
  async load(workspaceId: string, id: string): Promise<SourceWithMedia> {
    const row = await this.prisma.knowledgeSource.findFirst({ where: { id: String(id ?? ""), workspaceId }, include: this.include });
    if (!row) throw knowledgeError("knowledge.not_found");
    return row as SourceWithMedia;
  }

  async list(workspaceId: string, q: { kind?: string; status?: string } = {}): Promise<{ items: KnowledgeSourceDto[] }> {
    const rows = (await this.prisma.knowledgeSource.findMany({
      where: { workspaceId, ...(q.kind ? { kind: q.kind } : {}), ...(q.status ? { status: q.status } : {}) },
      include: this.include,
      orderBy: [{ kind: "asc" }, { order: "asc" }, { createdAt: "desc" }],
    })) as SourceWithMedia[];
    const counts = await this.pageCounts(workspaceId, rows.filter((r) => r.kind === "website").map((r) => r.id));
    return { items: rows.map((r) => this.toDto(r, counts.get(r.id))) };
  }

  async get(workspaceId: string, id: string): Promise<KnowledgeSourceDto> {
    const row = await this.load(workspaceId, id);
    const counts = row.kind === "website" ? await this.pageCounts(workspaceId, [row.id]) : undefined;
    return this.toDto(row, counts?.get(row.id));
  }

  /**
   * "What your assistant learned": the source's chunks grouped by sheet or
   * section heading, else "General" (heading null), in chunk order; at most
   * PREVIEW_MAX_ITEMS items.
   */
  async preview(workspaceId: string, id: string): Promise<KnowledgePreviewDto> {
    const src = await this.load(workspaceId, id);
    const chunks = await this.prisma.knowledgeChunk.findMany({
      where: { workspaceId, sourceId: src.id },
      orderBy: [{ ord: "asc" }],
      take: PREVIEW_MAX_ITEMS + 1,
      include: { page: { select: { url: true } } },
    });
    return previewGroups(src.id, chunks as unknown as PreviewChunk[]);
  }

  async pages(workspaceId: string, id: string, q: { state?: string; cursor?: string } = {}) {
    const src = await this.load(workspaceId, id);
    let cursor: { id: string; url: string } | null = null;
    if (q.cursor) {
      cursor = await this.prisma.knowledgePage.findFirst({ where: { id: q.cursor, workspaceId, sourceId: src.id }, select: { id: true, url: true } });
      if (!cursor) throw knowledgeError("knowledge.not_found");
    }
    const rows = await this.prisma.knowledgePage.findMany({
      where: {
        workspaceId,
        sourceId: src.id,
        ...(q.state ? { state: q.state } : {}),
        ...(cursor ? { OR: [{ url: { gt: cursor.url } }, { url: cursor.url, id: { gt: cursor.id } }] } : {}),
      },
      orderBy: [{ url: "asc" }, { id: "asc" }],
      take: PAGES_PAGE_SIZE + 1,
    });
    const items: KnowledgePageDto[] = rows.slice(0, PAGES_PAGE_SIZE).map((p) => ({
      id: p.id,
      url: p.url,
      title: p.title ?? null,
      state: p.state as PageState,
      httpStatus: p.httpStatus ?? null,
      lastReadAt: p.lastReadAt ?? null,
      removedAt: p.removedAt ?? null,
    }));
    return { items, nextCursor: rows.length > PAGES_PAGE_SIZE ? items[items.length - 1].id : null };
  }

  /** The stored file's bytes, proxied (never a storage URL). */
  async sendFile(workspaceId: string, id: string, res: Response): Promise<void> {
    const src = await this.load(workspaceId, id);
    if (!src.mediaId) throw knowledgeError("knowledge.not_found");
    const row = await this.prisma.media.findFirst({ where: { id: src.mediaId, workspaceId } });
    if (!row) throw knowledgeError("knowledge.not_found");
    const resolved = await this.media.resolveServeForRow(row, 300);
    await this.media.sendResolved(res, resolved, { cacheControl: "private, no-store", label: "knowledge file" });
  }

  // ─── Delete ─────────────────────────────────────────────────────────────

  /**
   * Remove a source with its chunks and pages (FK cascade), then its stored
   * file when no other row references it (best-effort: a file another
   * feature uses stays). Task 2 adds the upstream copy removal.
   */
  async remove(workspaceId: string, id: string): Promise<{ ok: true }> {
    const src = await this.load(workspaceId, id);
    await this.prisma.knowledgeSource.deleteMany({ where: { id: src.id, workspaceId } });
    // The upstream copies go too (best-effort; never fails the delete).
    await this.publisher?.unpublish(src);
    if (src.mediaId) {
      const others = await this.prisma.knowledgeSource.count({ where: { workspaceId, mediaId: src.mediaId } });
      if (others === 0) {
        await this.media.remove(workspaceId, src.mediaId).catch((e) => {
          this.log.warn(`knowledge source ${src.id}: stored file kept (${(e as Error)?.name ?? "error"})`);
        });
      }
    }
    return { ok: true };
  }

  // ─── Content and guidelines (singletons) ────────────────────────────────

  private async lockSingleton(tx: Pick<PrismaService, "$executeRaw">, workspaceId: string, kind: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`knowledge:${kind}:${workspaceId}`}))`;
  }

  /** Save a singleton (content or guideline) with its version check and chunks. */
  private async saveSingleton(
    workspaceId: string,
    userId: string | null,
    kind: "content" | "guideline",
    data: { title: string; body: string; bodyJson?: Prisma.InputJsonValue },
    version: number,
    chunks: Chunk[],
  ): Promise<KnowledgeSourceDto> {
    const saved = await this.prisma.$transaction(async (tx) => {
      await this.lockSingleton(tx, workspaceId, kind);
      const cur = await tx.knowledgeSource.findFirst({ where: { workspaceId, kind }, orderBy: { createdAt: "asc" } });
      let id: string;
      if (!cur) {
        const created = await tx.knowledgeSource.create({
          data: { workspaceId, kind, status: "ready", ...data, itemCount: chunks.length, createdById: userId, version: 1 },
        });
        id = created.id;
      } else {
        const r = await tx.knowledgeSource.updateMany({
          where: { id: cur.id, workspaceId, version },
          data: { ...data, itemCount: chunks.length, status: "ready", error: null, version: { increment: 1 } },
        });
        if (r.count !== 1) return { conflict: cur.id };
        id = cur.id;
      }
      await tx.knowledgeChunk.deleteMany({ where: { workspaceId, sourceId: id } });
      if (chunks.length) await tx.knowledgeChunk.createMany({ data: chunkRowsFor(workspaceId, id, chunks) });
      return { id };
    });
    if ("conflict" in saved) {
      throw knowledgeError("knowledge.version_conflict", { current: await this.get(workspaceId, saved.conflict as string) });
    }
    this.publisher?.schedule(saved.id);
    return this.get(workspaceId, saved.id);
  }

  async putContent(workspaceId: string, userId: string | null, body: { bodyJson: unknown; version: number }) {
    const text = tiptapToText(body.bodyJson);
    return this.saveSingleton(
      workspaceId,
      userId,
      "content",
      { title: CONTENT_TITLE, body: text, bodyJson: body.bodyJson as Prisma.InputJsonValue },
      body.version,
      chunkText(text),
    );
  }

  /** Guidelines are instructions for the agent's prompt (Task 2 publishes them), not searchable chunks. */
  async putGuidelines(workspaceId: string, userId: string | null, body: { body: string; version: number }) {
    const text = String(body.body ?? "").trim();
    if (text.length > GUIDELINES_MAX) throw knowledgeError("knowledge.guidelines_too_long", { max: GUIDELINES_MAX });
    return this.saveSingleton(workspaceId, userId, "guideline", { title: GUIDELINES_TITLE, body: text }, body.version, []);
  }

  // ─── FAQs ───────────────────────────────────────────────────────────────

  private checkFaq(question: string | undefined, answer: string | undefined) {
    if (question !== undefined && question.length > FAQ_QUESTION_MAX) throw knowledgeError("knowledge.faq_too_long", { field: "question", max: FAQ_QUESTION_MAX });
    if (answer !== undefined && answer.length > FAQ_ANSWER_MAX) throw knowledgeError("knowledge.faq_too_long", { field: "answer", max: FAQ_ANSWER_MAX });
  }

  private faqChunk(question: string, answer: string): Chunk[] {
    return [{ heading: null, text: `${question}\n${answer}` }];
  }

  private async duplicateQuestion(tx: Pick<PrismaService, "knowledgeSource">, workspaceId: string, question: string, exceptId?: string) {
    const key = questionKey(question);
    const faqs = await tx.knowledgeSource.findMany({ where: { workspaceId, kind: "faq" }, select: { id: true, question: true } });
    return faqs.some((f) => f.id !== exceptId && questionKey(f.question ?? "") === key);
  }

  /** New FAQs go on top (order = current minimum − 1). */
  async createFaq(workspaceId: string, userId: string | null, body: { question: string; answer: string }) {
    const question = String(body.question ?? "").trim();
    const answer = String(body.answer ?? "").trim();
    this.checkFaq(question, answer);
    if (!question || !answer) throw knowledgeError("knowledge.content_invalid");
    const id = await this.prisma.$transaction(async (tx) => {
      await this.lockSingleton(tx, workspaceId, "faq");
      const count = await tx.knowledgeSource.count({ where: { workspaceId, kind: "faq" } });
      if (count >= FAQ_MAX) throw knowledgeError("knowledge.faq_limit", { limit: FAQ_MAX });
      if (await this.duplicateQuestion(tx, workspaceId, question)) throw knowledgeError("knowledge.faq_duplicate");
      const top = await tx.knowledgeSource.findFirst({ where: { workspaceId, kind: "faq" }, orderBy: { order: "asc" }, select: { order: true } });
      const row = await tx.knowledgeSource.create({
        data: {
          workspaceId,
          kind: "faq",
          status: "ready",
          title: question.slice(0, TITLE_MAX),
          question,
          body: answer,
          order: top ? top.order - 1 : 0,
          itemCount: 1,
          createdById: userId,
          version: 1,
        },
      });
      await tx.knowledgeChunk.createMany({ data: chunkRowsFor(workspaceId, row.id, this.faqChunk(question, answer)) });
      return row.id;
    });
    this.publisher?.schedule(id);
    return this.get(workspaceId, id);
  }

  async patchFaq(workspaceId: string, id: string, body: { question?: string; answer?: string; version: number }) {
    const src = await this.load(workspaceId, id);
    if (src.kind !== "faq") throw knowledgeError("knowledge.not_found");
    const question = body.question === undefined ? undefined : String(body.question).trim();
    const answer = body.answer === undefined ? undefined : String(body.answer).trim();
    this.checkFaq(question, answer);
    if (question === "" || answer === "") throw knowledgeError("knowledge.content_invalid");
    const outcome = await this.prisma.$transaction(async (tx) => {
      await this.lockSingleton(tx, workspaceId, "faq");
      if (question !== undefined && (await this.duplicateQuestion(tx, workspaceId, question, src.id))) throw knowledgeError("knowledge.faq_duplicate");
      const q = question ?? src.question ?? "";
      const a = answer ?? src.body ?? "";
      const r = await tx.knowledgeSource.updateMany({
        where: { id: src.id, workspaceId, kind: "faq", version: body.version },
        data: { question: q, title: q.slice(0, TITLE_MAX), body: a, version: { increment: 1 } },
      });
      if (r.count !== 1) return "conflict" as const;
      await tx.knowledgeChunk.deleteMany({ where: { workspaceId, sourceId: src.id } });
      await tx.knowledgeChunk.createMany({ data: chunkRowsFor(workspaceId, src.id, this.faqChunk(q, a)) });
      return "ok" as const;
    });
    if (outcome === "conflict") throw knowledgeError("knowledge.version_conflict", { current: await this.get(workspaceId, src.id) });
    this.publisher?.schedule(src.id);
    return this.get(workspaceId, src.id);
  }

  /** `ids` must be exactly the workspace's FAQ ids (each once); they get order 0..n-1. */
  async reorderFaqs(workspaceId: string, body: { ids: string[] }) {
    const ids = Array.isArray(body?.ids) ? body.ids.map(String) : [];
    await this.prisma.$transaction(async (tx) => {
      await this.lockSingleton(tx, workspaceId, "faq");
      const faqs = await tx.knowledgeSource.findMany({ where: { workspaceId, kind: "faq" }, select: { id: true } });
      const have = new Set(faqs.map((f) => f.id));
      if (new Set(ids).size !== ids.length || ids.length !== have.size || ids.some((i) => !have.has(i))) {
        throw knowledgeError("knowledge.reorder_mismatch");
      }
      for (let i = 0; i < ids.length; i++) {
        await tx.knowledgeSource.updateMany({ where: { id: ids[i], workspaceId, kind: "faq" }, data: { order: i } });
      }
    });
    return this.list(workspaceId, { kind: "faq" });
  }

  // ─── Files and typed documents ──────────────────────────────────────────

  /**
   * Upload a batch (≤ KB_BATCH_MAX files, each ≤ KB_FILE_MAX_BYTES). Every
   * file is checked (type by extension and signature, size; typed sheets:
   * template columns and rows) before anything is stored, so one bad file
   * refuses the whole batch and creates nothing. With `typedKind`, each file
   * is an XLSX/CSV checked against that template; bad rows refuse the file
   * unless `acceptValidRows` is true and at least one row is good.
   */
  async uploadFiles(
    workspaceId: string,
    userId: string,
    files: UploadedFile[],
    opts: { typedKind?: unknown; acceptValidRows?: unknown } = {},
  ): Promise<{ items: KnowledgeSourceDto[] }> {
    if (!files?.length) throw knowledgeError("knowledge.file_type", { fileName: null });
    if (files.length > KB_BATCH_MAX) throw knowledgeError("knowledge.batch_too_large", { max: KB_BATCH_MAX });
    let typedKind: TypedKind | null = null;
    if (opts.typedKind !== undefined && opts.typedKind !== null && opts.typedKind !== "") {
      if (!isTypedKind(opts.typedKind)) throw knowledgeError("knowledge.file_type", { field: "typedKind" });
      typedKind = opts.typedKind;
    }
    const acceptValidRows = opts.acceptValidRows === true || opts.acceptValidRows === "true";

    // 1. Type and size of every file.
    const checked = files.map((f) => {
      const fileName = String(f.originalname ?? "").slice(0, 255);
      const size = f.buffer?.length ?? f.size ?? 0;
      if (size > KB_FILE_MAX_BYTES || (f.size ?? 0) > KB_FILE_MAX_BYTES) {
        throw knowledgeError("knowledge.file_too_large", { maxBytes: KB_FILE_MAX_BYTES, fileName });
      }
      const type = classifyUpload({ originalname: fileName, mimetype: f.mimetype, buffer: f.buffer ?? Buffer.alloc(0) });
      if (!type || (typedKind && type !== "xlsx" && type !== "csv")) throw knowledgeError("knowledge.file_type", { fileName });
      return { file: f, fileName, type, itemCount: 0 };
    });

    // 2. Typed sheets: template columns and rows.
    if (typedKind) {
      for (const c of checked) {
        let typed;
        try {
          typed = await readTyped({ buffer: c.file.buffer, fileName: c.fileName }, typedKind);
        } catch (e) {
          if (e instanceof KnowledgeFailure && e.key === "knowledge.empty") {
            throw knowledgeError("knowledge.typed_rows", { rowErrors: [], total: 0, validRows: 0, fileName: c.fileName });
          }
          throw knowledgeError("knowledge.file_type", { fileName: c.fileName });
        }
        const v = typed.validation;
        if (v.missing.length) {
          throw knowledgeError("knowledge.template_columns", { missing: v.missing, unknown: v.unknown, fileName: c.fileName });
        }
        const tooMany = v.rowErrors.some((r) => r.error === "too_many_rows");
        if (tooMany || (v.total > 0 && !(acceptValidRows && v.rows.length > 0))) {
          throw knowledgeError("knowledge.typed_rows", { rowErrors: v.rowErrors, total: v.total, validRows: v.rows.length, fileName: c.fileName });
        }
        c.itemCount = v.rows.length;
      }
    }

    // 3. Store the objects, then the Media rows and sources in one transaction.
    const stored: { storageKind: string; storedPath: string }[] = [];
    let ids: string[];
    try {
      for (const c of checked) {
        stored.push(
          await this.media.putKnowledgeFile({ workspaceId, buffer: c.file.buffer, mimeType: MIME_OF_TYPE[c.type], fileName: c.fileName }),
        );
      }
      ids = await this.prisma.$transaction(async (tx) => {
        const out: string[] = [];
        for (let i = 0; i < checked.length; i++) {
          const c = checked[i];
          const m = await tx.media.create({
            data: {
              workspaceId,
              fileName: c.fileName,
              mimeType: MIME_OF_TYPE[c.type],
              sizeBytes: c.file.buffer.length,
              storedPath: stored[i].storedPath,
              storageKind: stored[i].storageKind,
              uploadedById: userId,
            },
          });
          const s = await tx.knowledgeSource.create({
            data: {
              workspaceId,
              kind: typedKind ? "typed_doc" : "file",
              status: "queued",
              title: c.fileName.slice(0, TITLE_MAX) || "file",
              mediaId: m.id,
              typedKind,
              itemCount: c.itemCount,
              createdById: userId,
            },
          });
          out.push(s.id);
        }
        return out;
      });
    } catch (e) {
      for (const s of stored) await this.media.discardStored(s);
      throw e;
    }
    for (const id of ids) this.processor.kick(id);
    const rows = (await this.prisma.knowledgeSource.findMany({ where: { workspaceId, id: { in: ids } }, include: this.include })) as SourceWithMedia[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    return { items: ids.map((id) => this.toDto(byId.get(id) as SourceWithMedia)) };
  }

  /** Queue a file or typed document again (e.g. after a failure). */
  async reprocess(workspaceId: string, id: string): Promise<KnowledgeSourceDto> {
    const src = await this.load(workspaceId, id);
    if (src.kind !== "file" && src.kind !== "typed_doc") throw knowledgeError("knowledge.not_found");
    if (!src.mediaId) throw knowledgeError("knowledge.not_found");
    const r = await this.prisma.knowledgeSource.updateMany({
      where: { id: src.id, workspaceId, status: { in: ["ready", "failed", "queued"] } },
      data: { status: "queued", error: null, leaseUntil: null, consecutiveFailures: 0 },
    });
    if (r.count !== 1) throw knowledgeError("knowledge.syncing");
    this.processor.kick(src.id);
    return this.get(workspaceId, src.id);
  }
}

type PreviewChunk = { id: string; heading: string | null; text: string; rowRef: number | null; page?: { url: string } | null };

/** Group chunks by heading in first-seen order (sheet, section, or "General" = null). Pure. */
export function previewGroups(sourceId: string, chunks: PreviewChunk[]): KnowledgePreviewDto {
  const truncated = chunks.length > PREVIEW_MAX_ITEMS;
  const groups: KnowledgePreviewDto["groups"] = [];
  const byHeading = new Map<string | null, KnowledgePreviewDto["groups"][number]>();
  for (const c of chunks.slice(0, PREVIEW_MAX_ITEMS)) {
    const heading = c.heading?.trim() ? c.heading : null;
    let g = byHeading.get(heading);
    if (!g) {
      g = { heading, items: [] };
      byHeading.set(heading, g);
      groups.push(g);
    }
    g.items.push({ chunkId: c.id, text: c.text, rowRef: c.rowRef ?? null, url: c.page?.url ?? null });
  }
  return { sourceId, groups, truncated };
}
