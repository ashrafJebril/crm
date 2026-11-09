import { BadRequestException, Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { SegmentsService } from "../segments/segments.service";
import { buildContactWhere, type ContactListFilter } from "./contact-filter";
import { effectiveNameParts } from "./contact-name";
import { escapeFormulaCell } from "./csv-formula";

export { escapeFormulaCell, unescapeFormulaCell } from "./csv-formula";

export const EXPORT_PAGE_SIZE = 1000;
export const EXPORT_IDS_CAP = 10_000;
const BOM = "﻿";

export const BASE_COLUMNS = [
  "id",
  "firstName",
  "lastName",
  "name",
  "phone",
  "email",
  "lifecycle",
  "tags",
  "owner",
  "source",
  "industry",
  "value",
  "marketingOptOut",
  "notALead",
  "createdAt",
] as const;

export interface ExportSink {
  /** Awaited so the caller can apply backpressure. */
  write(chunk: string): Promise<void> | void;
  /** True once the client went away; the cursor loop stops. */
  aborted(): boolean;
}

export interface PreparedExport {
  filename: string;
  run(sink: ExportSink): Promise<{ rows: number }>;
}

/** RFC4180: quote when the cell holds a comma, quote, CR or LF. */
export function csvCell(v: unknown): string {
  const s = escapeFormulaCell(v === null || v === undefined ? "" : String(v));
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvLine(cells: unknown[]): string {
  return cells.map(csvCell).join(",") + "\r\n";
}

function parseTags(raw: string): string[] {
  try {
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

function customCell(type: string, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (type === "boolean") return value === true || value === "true" ? "true" : "false";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
}

/**
 * Custom-field column headers: the label, or `Label (key)` when the label
 * collides with a base column or another field's label (case-insensitive),
 * so an exported file maps back unambiguously on import.
 */
export function customHeaders(defs: { key: string; label: string }[]): string[] {
  const norm = (h: string) => h.trim().toLowerCase();
  const taken = new Map<string, number>();
  for (const b of BASE_COLUMNS) taken.set(norm(b), (taken.get(norm(b)) ?? 0) + 1);
  for (const d of defs) taken.set(norm(d.label), (taken.get(norm(d.label)) ?? 0) + 1);
  const used = new Set<string>(BASE_COLUMNS.map(norm));
  return defs.map((d) => {
    let h = d.label;
    if ((taken.get(norm(d.label)) ?? 0) > 1) h = `${d.label} (${d.key})`;
    let n = 1;
    while (used.has(norm(h))) h = `${d.label} (${d.key}) ${++n}`;
    used.add(norm(h));
    return h;
  });
}

@Injectable()
export class ContactsExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly segments: SegmentsService,
  ) {}

  /**
   * Validates and resolves everything that can fail (filter, ids, custom
   * fields) BEFORE any byte is written, so errors are ordinary JSON responses.
   */
  async prepare(workspaceId: string, filter: ContactListFilter, ids?: string[]): Promise<PreparedExport> {
    if (ids && ids.length > EXPORT_IDS_CAP) {
      throw new BadRequestException(`ids is limited to ${EXPORT_IDS_CAP}`);
    }
    // Same where as GET /contacts/page; `ids` only narrows it (and the
    // workspaceId in the base where keeps foreign ids out).
    const base = await buildContactWhere(workspaceId, filter, { prisma: this.prisma, segments: this.segments });
    const where: Prisma.ContactWhereInput = ids?.length ? { AND: [base, { id: { in: ids } }] } : base;

    const defs = await this.prisma.customFieldDef.findMany({
      where: { workspaceId, entity: "contact", archivedAt: null },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
      select: { id: true, key: true, label: true, type: true },
    });

    const members = await this.prisma.workspaceMember.findMany({
      where: { workspaceId },
      select: { userId: true, user: { select: { email: true } } },
    });
    const owners = new Map(members.map((m) => [m.userId, m.user?.email ?? ""]));

    const header = csvLine([...BASE_COLUMNS, ...customHeaders(defs)]);
    const filename = `contacts-${new Date().toISOString().slice(0, 10)}.csv`;

    const run = async (sink: ExportSink) => {
      await sink.write(BOM + header);
      let last: { id: string; createdAt: Date } | undefined;
      let rows = 0;
      while (!sink.aborted()) {
        // Keyset paging: unlike a Prisma cursor it survives the last row of a
        // page being deleted while the export is streaming.
        const pageWhere: Prisma.ContactWhereInput = last
          ? {
              AND: [
                where,
                {
                  OR: [
                    { createdAt: { lt: last.createdAt } },
                    { createdAt: last.createdAt, id: { lt: last.id } },
                  ],
                },
              ],
            }
          : where;
        const page = await this.prisma.contact.findMany({
          where: pageWhere,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: EXPORT_PAGE_SIZE,
        });
        if (!page.length) break;

        const values = new Map<string, Map<string, unknown>>();
        if (defs.length) {
          // Only workspace-verified contacts and defs reach this unscoped model.
          const vals = await this.prisma.customFieldValue.findMany({
            where: { contactId: { in: page.map((c) => c.id) }, defId: { in: defs.map((d) => d.id) } },
            select: { contactId: true, defId: true, value: true },
          });
          for (const v of vals) {
            let m = values.get(v.contactId);
            if (!m) values.set(v.contactId, (m = new Map()));
            m.set(v.defId, v.value);
          }
        }

        let chunk = "";
        for (const c of page) {
          const parts = effectiveNameParts(c);
          const cv = values.get(c.id);
          chunk += csvLine([
            c.id,
            parts.firstName ?? "",
            parts.lastName ?? "",
            c.name,
            c.phone ?? "",
            c.email ?? "",
            c.lifecycle,
            parseTags(c.tags).join(", "),
            c.ownerId ? (owners.get(c.ownerId) ?? "") : "",
            c.source,
            c.industry,
            c.value ?? "",
            c.marketingOptOut ? "true" : "false",
            c.notALead ? "true" : "false",
            c.createdAt.toISOString(),
            ...defs.map((d) => customCell(d.type, cv?.get(d.id))),
          ]);
        }
        rows += page.length;
        await sink.write(chunk);
        if (page.length < EXPORT_PAGE_SIZE) break;
        last = page[page.length - 1];
      }
      return { rows };
    };

    return { filename, run };
  }
}
