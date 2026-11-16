/**
 * SP-10 Task 3 spec helper (not a runtime file): the catalog import services
 * over the in-memory Prisma double, with a fake extractor and page fetcher
 * (an unmocked provider call throws: no live calls).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as ExcelJS from "exceljs";
import { catalogWorld } from "../bookings/catalog-test-world";
import type { CatalogExtractor } from "./anthropic-extractor";
import type { Extraction } from "./extraction-schema";
import { CatalogImportRunner } from "./catalog-import.runner";
import { CatalogImportService } from "./catalog-import.service";
import { CatalogImportResumeScheduler } from "./catalog-import-resume.scheduler";

export { A, B, failure } from "../bookings/catalog-test-world";

export function fakeExtractor(reply?: Extraction | Error): CatalogExtractor & { extract: jest.Mock; available: jest.Mock } {
  return {
    available: jest.fn(() => true),
    extract: jest.fn(async () => {
      if (reply === undefined) throw new Error("unexpected extractor call");
      if (reply instanceof Error) throw reply;
      return reply;
    }),
  };
}

export function importWorld(opts: { extractor?: CatalogExtractor; page?: (url: string) => Promise<string>; locks?: boolean } = {}) {
  const w = catalogWorld({ locks: opts.locks });
  w.prisma.db.catalogImport = [];
  const extractor = (opts.extractor ?? fakeExtractor()) as CatalogExtractor & { extract: jest.Mock };
  const page = jest.fn(opts.page ?? (async () => {
    throw new Error("unexpected page fetch");
  }));
  const runner = new CatalogImportRunner(w.prisma as any);
  const svc = new CatalogImportService(w.prisma as any, extractor, runner, page);
  // Background work runs when the spec says so, not on setImmediate.
  jest.spyOn(svc, "kickExtraction").mockImplementation(() => undefined);
  jest.spyOn(runner, "kick").mockImplementation(() => undefined);
  const scheduler = new CatalogImportResumeScheduler(w.prisma as any, runner);
  return { ...w, svc, runner, extractor, page, scheduler };
}

/** An .xlsx (or a .csv) file as the multipart upload would hand it over. */
export async function xlsx(rows: (string | number)[][], name = "catalog.xlsx") {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  for (const r of rows) ws.addRow(r);
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), originalname: name };
}

export function csv(rows: string[][], name = "catalog.csv") {
  return { buffer: Buffer.from(rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\n")), originalname: name };
}
