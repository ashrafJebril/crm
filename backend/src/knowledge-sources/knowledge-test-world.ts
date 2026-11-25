/**
 * SP-21 spec helper (not a runtime file): the knowledge services over the
 * in-memory Prisma double, with in-memory file storage, a fake vision port,
 * a fake `pdf-parse` and a search runner that approximates Postgres FTS by
 * token match. No provider is ever called: an unexpected vision call throws.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as ExcelJS from "exceljs";
import { makeFakePrisma } from "../channels/test-prisma";
import { MediaService } from "../media/media.service";
import { KnowledgeProcessor } from "./knowledge-processor";
import { KnowledgeSearchService, type SearchParams, type SearchRow } from "./knowledge-search.service";
import { KnowledgeSourcesService, type UploadedFile } from "./knowledge-sources.service";
import { KnowledgeFailure } from "./knowledge-errors";
import type { KnowledgeVisionPort } from "./knowledge-vision";
import type { PdfTextFn } from "./knowledge-extract";

export const A = "wsA";
export const B = "wsB";

export const PDF_HEAD = "%PDF-1.7\n%\xe2\xe3\xcf\xd3\n";
export const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
export const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]);

export function fakeVision(reply?: string | Error): KnowledgeVisionPort & { transcribe: jest.Mock; available: jest.Mock } {
  return {
    available: jest.fn(() => true),
    transcribe: jest.fn(async () => {
      if (reply === undefined) throw new Error("unexpected vision call");
      if (reply instanceof Error) throw reply;
      return reply;
    }),
  };
}

/** In-memory approximation of the FTS statement: every query token must appear (case-folded). */
export function tokenSearchRunner(db: Record<string, any[]>) {
  return jest.fn(async (p: SearchParams): Promise<SearchRow[]> => {
    const tokens = p.q.toLowerCase().split(/\s+/).filter(Boolean);
    const hits: (SearchRow & { score: number; ord: number })[] = [];
    for (const c of db.knowledgeChunk ?? []) {
      if (c.workspaceId !== p.workspaceId) continue;
      const s = (db.knowledgeSource ?? []).find((x) => x.id === c.sourceId && x.workspaceId === p.workspaceId);
      if (!s || s.status !== "ready") continue;
      if (p.kind && (s.kind !== "typed_doc" || s.typedKind !== p.kind)) continue;
      if (c.validTo && c.validTo.toISOString().slice(0, 10) < p.today) continue;
      const text = String(c.text).toLowerCase();
      if (!tokens.every((t) => text.includes(t))) continue;
      const page = c.pageId ? (db.knowledgePage ?? []).find((x) => x.id === c.pageId) : null;
      hits.push({
        chunkId: c.id,
        sourceId: s.id,
        sourceTitle: s.title,
        kind: s.kind,
        heading: c.heading,
        text: c.text,
        pageUrl: page?.url ?? null,
        sourceUrl: s.url ?? null,
        score: tokens.reduce((n, t) => n + text.split(t).length - 1, 0),
        ord: c.ord,
      });
    }
    hits.sort((a, b) => b.score - a.score || a.ord - b.ord);
    return hits.slice(0, p.limit).map(({ score: _s, ord: _o, ...r }) => r);
  });
}

export function knowledgeWorld(opts: { vision?: KnowledgeVisionPort; pdfText?: PdfTextFn } = {}) {
  const prisma = makeFakePrisma({
    workspace: [
      { id: A, name: "A", timezone: "Asia/Riyadh" },
      { id: B, name: "B", timezone: "Europe/London" },
    ],
    user: [{ id: "uOwner", name: "Owner A" }, { id: "uOther", name: "Owner B" }],
    workspaceMember: [
      { id: "m1", workspaceId: A, userId: "uOwner", role: "owner" },
      { id: "m3", workspaceId: B, userId: "uOther", role: "owner" },
    ],
    media: [],
    knowledgeSource: [],
    knowledgePage: [],
    knowledgeChunk: [],
    template: [],
    campaign: [],
    ticketAttachment: [],
  });
  const objects = new Map<string, Buffer>();
  let seq = 0;
  const storage = {
    kind: "local" as const,
    put: jest.fn(async (i: { workspaceId: string; buffer?: Buffer; originalFilename: string }) => {
      const key = `${i.workspaceId}/k${++seq}-${i.originalFilename}`;
      objects.set(key, i.buffer ?? Buffer.alloc(0));
      return { key };
    }),
    delete: jest.fn(async (key: string) => {
      objects.delete(key);
    }),
    getSignedUrl: jest.fn(),
  };
  const media = new MediaService(prisma as any, storage as any);
  // Local storage reads from disk; the world keeps bytes in memory instead.
  jest.spyOn(media, "readBuffer").mockImplementation(async (ws: string, id: string) => {
    const row = (prisma.db.media as any[]).find((m) => m.id === id && m.workspaceId === ws);
    if (!row || !objects.has(row.storedPath)) throw new Error("missing object");
    return objects.get(row.storedPath) as Buffer;
  });
  jest.spyOn(media, "discardStored").mockImplementation(async (s: { storedPath: string }) => {
    objects.delete(s.storedPath);
  });
  const vision = (opts.vision ?? fakeVision()) as KnowledgeVisionPort & { transcribe: jest.Mock };
  const pdfText = jest.fn(
    opts.pdfText ??
      (async () => {
        throw new Error("unexpected pdf parse");
      }),
  );
  const processor = new KnowledgeProcessor(prisma as any, media, vision, pdfText);
  // Background work runs when the spec says so.
  const kick = jest.spyOn(processor, "kick").mockImplementation(() => undefined);
  const svc = new KnowledgeSourcesService(prisma as any, media, processor);
  const runner = tokenSearchRunner(prisma.db);
  const search = new KnowledgeSearchService(prisma as any, runner);
  return { prisma, db: prisma.db as Record<string, any[]>, storage, objects, media, vision, pdfText, processor, kick, svc, search, runner };
}

export function upload(name: string, buffer: Buffer, mimetype = "application/octet-stream"): UploadedFile {
  return { buffer, originalname: name, mimetype, size: buffer.length };
}

export function pdf(body = "text"): UploadedFile {
  return upload("menu.pdf", Buffer.from(PDF_HEAD + body, "latin1"), "application/pdf");
}

export async function xlsxFile(rows: (string | number)[][], name = "sheet.xlsx", sheet = "Sheet1"): Promise<UploadedFile> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet);
  for (const r of rows) ws.addRow(r);
  return upload(name, Buffer.from(await wb.xlsx.writeBuffer()), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
}

export function csvFile(rows: string[][], name = "sheet.csv"): UploadedFile {
  return upload(name, Buffer.from(rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\n")), "text/csv");
}

/** The body of a thrown HttpException. */
export async function failure(p: Promise<unknown>): Promise<{ status: number; body: any }> {
  try {
    await p;
  } catch (e: any) {
    if (typeof e?.getStatus === "function") return { status: e.getStatus(), body: e.getResponse() };
    throw e;
  }
  throw new Error("expected a rejection");
}

export { KnowledgeFailure };
