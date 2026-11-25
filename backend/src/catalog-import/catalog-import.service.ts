import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import type { CatalogImport, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ImportFileError, parseFile } from "../imports/parse-file";
import { MAX_CATALOG_FILE_ROWS, MAX_CATALOG_SOURCE_CHARS } from "../bookings/booking-constants";
import { parsePrice } from "../bookings/catalog-fields";
import { validateSchedule } from "../bookings/schedule";
import {
  CatalogImportFailure,
  catalogImportError,
  failureKey,
} from "./catalog-import-errors";
import { CATALOG_EXTRACTOR, type CatalogExtractor } from "./anthropic-extractor";
import {
  buildProposal,
  fromExtraction,
  validateServiceData,
  validateStaffData,
  type CatalogNames,
  type ImportKind,
  type Proposal,
  type ProposalItem,
  type ServiceItemData,
  type StaffItemData,
} from "./extraction-schema";
import { fetchPageText, parsePublicUrl } from "./fetch-page";
import { plainText } from "./html-to-text";
import { matchTemplate, parseTemplateRows, rowsToText } from "./templates";
import { CatalogImportRunner } from "./catalog-import.runner";

export const PAGE_FETCHER = Symbol("PAGE_FETCHER");
export type PageFetcher = (url: string, maxChars: number) => Promise<string>;

export const IMPORT_KINDS: readonly ImportKind[] = ["auto", "services", "staff"];
export const LIST_LIMIT = 10;
/** Statuses a job never leaves. */
export const FINAL_STATUSES = ["done", "failed", "cancelled"] as const;

export interface CatalogImportDto {
  id: string;
  source: string;
  kind: string;
  status: string;
  extractedBy: string | null;
  fileName: string | null;
  sourceUrl: string | null;
  total: number;
  processed: number;
  created: number;
  skipped: number;
  failed: number;
  errors: unknown;
  errorKey: string | null;
  /** Only in review and after. */
  items?: ProposalItem[];
  /** Truncation notes (more than 100 services / 50 staff proposed). */
  notes?: Proposal["notes"];
  createdAt: Date;
  finishedAt: Date | null;
}

export interface CreateCatalogImportInput {
  source?: unknown;
  kind?: unknown;
  text?: unknown;
  url?: unknown;
  file?: { buffer: Buffer; originalname: string };
}

export interface ItemPatch {
  key?: unknown;
  selected?: unknown;
  data?: unknown;
}

const SERVICE_FIELDS = ["name", "nameAr", "durationMin", "price", "currency", "color", "description"] as const;
const STAFF_FIELDS = ["name", "nameAr", "role", "schedule", "services"] as const;

/**
 * SP-10 catalog import (ruling 1: its own `CatalogImport` table, never an
 * `ImportJob`, so the deployed `main`'s import sweeps never see these rows).
 *
 * States: `extracting → review → running → done | failed | cancelled`.
 *  - Paste, a URL or a non-template file go through AI extraction in the
 *    background (`extracting`); a template file is parsed deterministically
 *    and goes straight to `review`.
 *  - The input text is kept only until extraction ends (then null); it is
 *    never returned and never logged.
 */
@Injectable()
export class CatalogImportService {
  private readonly log = new Logger(CatalogImportService.name);
  private readonly fetchPage: PageFetcher;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CATALOG_EXTRACTOR) private readonly extractor: CatalogExtractor,
    private readonly runner: CatalogImportRunner,
    @Optional() @Inject(PAGE_FETCHER) fetchPage?: PageFetcher,
  ) {
    this.fetchPage = fetchPage ?? ((url, max) => fetchPageText(url, max));
  }

  // ── create ────────────────────────────────────────────────────────────

  async create(workspaceId: string, userId: string | null, input: CreateCatalogImportInput): Promise<CatalogImportDto> {
    const kind = (input.kind ?? "auto") as ImportKind;
    if (!IMPORT_KINDS.includes(kind)) throw catalogImportError("catalog_import.source_invalid", { field: "kind" });
    const source = input.file ? "file" : input.source;
    const base = { workspaceId, createdById: userId, kind, heartbeatAt: new Date() };

    if (source === "paste") {
      if (typeof input.text !== "string" || !input.text.trim()) {
        throw catalogImportError("catalog_import.source_invalid", { field: "text" });
      }
      if (input.text.length > MAX_CATALOG_SOURCE_CHARS) {
        throw catalogImportError("catalog_import.text_too_long", { max: MAX_CATALOG_SOURCE_CHARS });
      }
      this.requireAi();
      const row = await this.prisma.catalogImport.create({
        data: { ...base, source: "paste", status: "extracting", inputText: plainText(input.text, MAX_CATALOG_SOURCE_CHARS) },
      });
      this.kickExtraction(row.id);
      return this.toDto(row);
    }

    if (source === "url") {
      let url: URL;
      try {
        url = parsePublicUrl(typeof input.url === "string" ? input.url.trim() : "");
      } catch {
        throw catalogImportError("catalog_import.url_invalid");
      }
      this.requireAi();
      const row = await this.prisma.catalogImport.create({
        data: { ...base, source: "url", status: "extracting", sourceUrl: url.toString() },
      });
      this.kickExtraction(row.id);
      return this.toDto(row);
    }

    if (source === "file" && input.file) {
      const { buffer, originalname } = input.file;
      let parsed: Awaited<ReturnType<typeof parseFile>>;
      try {
        parsed = await parseFile(buffer, originalname);
      } catch (e) {
        if (e instanceof ImportFileError && e.messageKey === "imports.too_many_rows") {
          throw catalogImportError("catalog_import.too_many_rows", { max: MAX_CATALOG_FILE_ROWS });
        }
        if (e instanceof ImportFileError && e.messageKey === "imports.file_empty") {
          throw catalogImportError("catalog_import.nothing_found");
        }
        throw catalogImportError("catalog_import.file_invalid");
      }
      if (parsed.rows.length > MAX_CATALOG_FILE_ROWS) {
        throw catalogImportError("catalog_import.too_many_rows", { max: MAX_CATALOG_FILE_ROWS });
      }
      const fileName = originalname.slice(0, 200);
      const template = matchTemplate(parsed.headers);
      if (template) {
        // Deterministic: no AI, straight to review.
        const rows = parseTemplateRows(template, parsed.rows);
        const proposal = buildProposal(rows, template, await this.catalogNames(workspaceId));
        if (!proposal.items.length) throw catalogImportError("catalog_import.nothing_found");
        const row = await this.prisma.catalogImport.create({
          data: {
            ...base,
            kind: template,
            source: "file",
            fileName,
            status: "review",
            extractedBy: "template",
            proposal: proposal as unknown as Prisma.InputJsonValue,
            total: proposal.items.length,
            heartbeatAt: null,
          },
        });
        return this.toDto(row);
      }
      const text = rowsToText(parsed.headers, parsed.rows, MAX_CATALOG_SOURCE_CHARS);
      if (!text) throw catalogImportError("catalog_import.nothing_found");
      this.requireAi();
      const row = await this.prisma.catalogImport.create({
        data: { ...base, source: "file", fileName, status: "extracting", inputText: text },
      });
      this.kickExtraction(row.id);
      return this.toDto(row);
    }

    throw catalogImportError("catalog_import.source_invalid", { field: "source" });
  }

  private requireAi() {
    // No key, or an endpoint that is neither Anthropic nor the loopback stub:
    // the wizard still offers the template path.
    if (!this.extractor.available()) throw catalogImportError("catalog_import.ai_unavailable");
  }

  // ── extraction (background) ───────────────────────────────────────────

  /** Starts extraction in the background; never throws. */
  kickExtraction(jobId: string): void {
    setImmediate(() => {
      void this.extract(jobId).catch(() => this.log.warn(`catalog import ${jobId}: extraction crashed`));
    });
  }

  /** extracting → review (or failed with the step's key). Content is never logged. */
  async extract(jobId: string): Promise<void> {
    const job = await this.prisma.catalogImport.findFirst({ where: { id: jobId } });
    if (!job || job.status !== "extracting") return;
    try {
      let text: string;
      if (job.source === "url") {
        text = await this.fetchPage(job.sourceUrl ?? "", MAX_CATALOG_SOURCE_CHARS);
      } else {
        text = job.inputText ?? "";
      }
      if (!text.trim()) throw new CatalogImportFailure("catalog_import.nothing_found");
      const extraction = await this.extractor.extract(text, job.kind as ImportKind);
      const proposal = buildProposal(fromExtraction(extraction), job.kind as ImportKind, await this.catalogNames(job.workspaceId));
      if (!proposal.items.length) throw new CatalogImportFailure("catalog_import.nothing_found");
      await this.prisma.catalogImport.updateMany({
        where: { id: jobId, status: "extracting" },
        data: {
          status: "review",
          extractedBy: "ai",
          proposal: proposal as unknown as Prisma.InputJsonValue,
          total: proposal.items.length,
          inputText: null,
          heartbeatAt: null,
        },
      });
    } catch (e) {
      const key = failureKey(e, "catalog_import.ai_failed");
      this.log.warn(`catalog import ${jobId}: extraction failed (${key})`);
      await this.prisma.catalogImport.updateMany({
        where: { id: jobId, status: "extracting" },
        data: { status: "failed", errorKey: key, inputText: null, heartbeatAt: null, finishedAt: new Date() },
      });
    }
  }

  // ── read ─────────────────────────────────────────────────────────────

  async get(workspaceId: string, id: string): Promise<CatalogImportDto> {
    return this.toDto(await this.find(workspaceId, id));
  }

  async list(workspaceId: string): Promise<CatalogImportDto[]> {
    const rows = await this.prisma.catalogImport.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      take: LIST_LIMIT,
    });
    return rows.map((r) => this.toDto(r));
  }

  // ── review ───────────────────────────────────────────────────────────

  /** `PATCH /catalog-imports/:id/items {items: {key, selected?, data?}[]}`. */
  async patchItems(workspaceId: string, id: string, patches: unknown): Promise<CatalogImportDto> {
    const job = await this.find(workspaceId, id);
    if (job.status !== "review") throw catalogImportError("catalog_import.not_in_review", { status: job.status });
    if (!Array.isArray(patches)) throw catalogImportError("catalog_import.item_invalid", { key: null, field: "items" });
    const proposal = this.proposalOf(job);
    for (const p of patches as ItemPatch[]) {
      const key = typeof p?.key === "string" ? p.key : null;
      const item = key ? proposal.items.find((i) => i.key === key) : undefined;
      if (!item) throw catalogImportError("catalog_import.item_invalid", { key, field: "key" });
      if (p.data !== undefined) {
        item.data = mergeData(item, p.data);
        delete item.error;
      }
      if (p.selected !== undefined) {
        if (typeof p.selected !== "boolean") throw catalogImportError("catalog_import.item_invalid", { key, field: "selected" });
        item.selected = p.selected;
      }
    }
    const res = await this.prisma.catalogImport.updateMany({
      where: { id, workspaceId, status: "review" },
      data: { proposal: proposal as unknown as Prisma.InputJsonValue },
    });
    if (res.count !== 1) {
      const now = await this.find(workspaceId, id);
      throw catalogImportError("catalog_import.not_in_review", { status: now.status });
    }
    return this.get(workspaceId, id);
  }

  /** review → running; the runner creates the selected items. */
  async run(workspaceId: string, id: string): Promise<CatalogImportDto> {
    const job = await this.find(workspaceId, id);
    if (job.status !== "review") throw catalogImportError("catalog_import.not_in_review", { status: job.status });
    const proposal = this.proposalOf(job);
    const selected = proposal.items.filter((i) => i.selected);
    for (const item of selected) {
      const bad =
        item.error ??
        (item.kind === "service" ? validateServiceData(item.data as ServiceItemData) : validateStaffData(item.data as StaffItemData));
      if (bad) throw catalogImportError("catalog_import.item_invalid", { key: item.key, field: bad.field });
    }
    if (!selected.length) throw catalogImportError("catalog_import.nothing_found");
    const now = new Date();
    const res = await this.prisma.catalogImport.updateMany({
      where: { id, workspaceId, status: "review" },
      data: {
        status: "running",
        total: selected.length,
        skipped: proposal.items.length - selected.length,
        processed: 0,
        created: 0,
        failed: 0,
        errors: [],
        inputText: null,
        startedAt: now,
        heartbeatAt: now,
      },
    });
    if (res.count !== 1) {
      const cur = await this.find(workspaceId, id);
      throw catalogImportError("catalog_import.not_in_review", { status: cur.status });
    }
    this.runner.kick(id);
    return this.get(workspaceId, id);
  }

  async cancel(workspaceId: string, id: string): Promise<CatalogImportDto> {
    const job = await this.find(workspaceId, id);
    if (job.status === "cancelled") return this.toDto(job);
    if ((FINAL_STATUSES as readonly string[]).includes(job.status)) {
      throw catalogImportError("catalog_import.already_finished", { status: job.status });
    }
    const res = await this.prisma.catalogImport.updateMany({
      where: { id, workspaceId, status: job.status },
      data: { status: "cancelled", inputText: null, finishedAt: new Date() },
    });
    if (res.count !== 1) return this.cancel(workspaceId, id); // moved on meanwhile: decide again
    return this.get(workspaceId, id);
  }

  // ── helpers ──────────────────────────────────────────────────────────

  private async find(workspaceId: string, id: string): Promise<CatalogImport> {
    const row = await this.prisma.catalogImport.findFirst({ where: { id, workspaceId } });
    if (!row) throw catalogImportError("catalog_import.not_found");
    return row;
  }

  private proposalOf(job: CatalogImport): Proposal {
    const p = (job.proposal ?? { items: [], notes: [] }) as unknown as Proposal;
    return { items: (p.items ?? []).map((i) => ({ ...i, data: { ...i.data } })), notes: p.notes ?? [] };
  }

  /** Non-archived catalog names, for duplicate detection. */
  async catalogNames(workspaceId: string): Promise<CatalogNames> {
    const [services, staff] = await Promise.all([
      this.prisma.service.findMany({ where: { workspaceId, archivedAt: null }, select: { id: true, name: true, nameAr: true } }),
      this.prisma.staffResource.findMany({ where: { workspaceId, archivedAt: null }, select: { id: true, name: true, nameAr: true } }),
    ]);
    return { services, staff };
  }

  toDto(row: CatalogImport): CatalogImportDto {
    const withItems = !["extracting"].includes(row.status) && row.proposal;
    const proposal = withItems ? this.proposalOf(row) : null;
    return {
      id: row.id,
      source: row.source,
      kind: row.kind,
      status: row.status,
      extractedBy: row.extractedBy,
      fileName: row.fileName,
      sourceUrl: row.sourceUrl,
      total: row.total,
      processed: row.processed,
      created: row.created,
      skipped: row.skipped,
      failed: row.failed,
      errors: row.errors,
      errorKey: row.errorKey,
      ...(proposal ? { items: proposal.items, notes: proposal.notes } : {}),
      createdAt: row.createdAt,
      finishedAt: row.finishedAt,
    };
  }
}

/** A review edit merged into an item; any bad field is 400 `catalog_import.item_invalid {key, field}`. */
function mergeData(item: ProposalItem, raw: unknown): ServiceItemData | StaffItemData {
  const fail = (field: string) => catalogImportError("catalog_import.item_invalid", { key: item.key, field });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw fail("data");
  const patch = raw as Record<string, unknown>;
  const allowed: readonly string[] = item.kind === "service" ? SERVICE_FIELDS : STAFF_FIELDS;
  for (const k of Object.keys(patch)) if (!allowed.includes(k)) throw fail(k);

  if (item.kind === "service") {
    const d: ServiceItemData = { ...(item.data as ServiceItemData) };
    for (const k of ["name", "nameAr", "description", "color"] as const) {
      if (patch[k] !== undefined) {
        if (patch[k] !== null && typeof patch[k] !== "string") throw fail(k);
        (d as unknown as Record<string, unknown>)[k] = patch[k];
      }
    }
    if (patch.durationMin !== undefined) {
      d.durationMin = patch.durationMin as number;
      d.durationDefaulted = false;
    }
    if (patch.price !== undefined) {
      try {
        d.price = parsePrice(patch.price);
      } catch {
        throw fail("price");
      }
    }
    if (patch.currency !== undefined) {
      if (patch.currency !== null && typeof patch.currency !== "string") throw fail("currency");
      d.currency = patch.currency === null ? null : String(patch.currency).trim().toUpperCase();
    }
    const bad = validateServiceData(d);
    if (bad) throw fail(bad.field);
    return d;
  }

  const d: StaffItemData = { ...(item.data as StaffItemData) };
  for (const k of ["name", "nameAr", "role"] as const) {
    if (patch[k] !== undefined) {
      if (patch[k] !== null && typeof patch[k] !== "string") throw fail(k);
      (d as unknown as Record<string, unknown>)[k] = patch[k];
    }
  }
  if (patch.schedule !== undefined) {
    try {
      d.schedule = validateSchedule(patch.schedule);
    } catch {
      throw fail("schedule");
    }
  }
  if (patch.services !== undefined) {
    if (!Array.isArray(patch.services) || patch.services.some((s) => typeof s !== "string")) throw fail("services");
    d.services = (patch.services as string[]).map((s) => s.trim()).filter(Boolean).slice(0, 50);
  }
  const bad = validateStaffData(d);
  if (bad) throw fail(bad.field);
  return d;
}
