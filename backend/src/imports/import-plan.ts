import { BadRequestException } from "@nestjs/common";
import type { PrismaService } from "../prisma/prisma.service";
import { requireManualGroup } from "../segments/segment-members";
import { countryCodeForTimezone, normalizeImportPhone } from "./phone";
import {
  DupTracker,
  IMPORT_PIPELINE_CAP,
  SIMPLE_TARGETS,
  normalizeRow,
  phoneVariants,
  rowKeys,
  type FieldDef,
  type ImportContext,
  type ImportMapping,
  type ImportOptions,
  type NormalizedRow,
  type RowError,
} from "./import-rows";

export function importError(key: string): BadRequestException {
  return new BadRequestException({ message: key, messageKey: key });
}

/** Coerce and validate the raw options object (shape only; ids are checked in loadContext). */
export function parseOptions(raw: unknown, kind: string): ImportOptions {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const matchBy = o.matchBy ?? "phone_then_email";
  if (matchBy !== "phone_then_email" && matchBy !== "phone" && matchBy !== "email") {
    throw importError("imports.options_invalid");
  }
  const str = (v: unknown): string | undefined => {
    if (v === undefined || v === null || v === "") return undefined;
    if (typeof v !== "string") throw importError("imports.options_invalid");
    return v.trim() || undefined;
  };
  let tags: string[] | undefined;
  if (o.tags !== undefined && o.tags !== null) {
    if (!Array.isArray(o.tags) || o.tags.some((t) => typeof t !== "string")) {
      throw importError("imports.options_invalid");
    }
    tags = [...new Set((o.tags as string[]).map((t) => t.trim().slice(0, 40)).filter(Boolean))];
  }
  let pipeline: ImportOptions["pipeline"];
  if (o.pipeline !== undefined && o.pipeline !== null) {
    const p = o.pipeline as Record<string, unknown>;
    const pipelineId = str(p?.pipelineId);
    if (!pipelineId) throw importError("imports.options_invalid");
    pipeline = { pipelineId, stageId: str(p.stageId) };
  }
  const opts: ImportOptions = {
    matchBy,
    updateExisting: o.updateExisting === true,
    tags,
    ownerId: str(o.ownerId),
    groupId: str(o.groupId),
    newGroupName: str(o.newGroupName),
    pipeline,
  };
  if (kind === "audience" && !opts.groupId && !opts.newGroupName) {
    throw importError("imports.group_required");
  }
  if (kind !== "audience") {
    // Contacts imports may still target an existing group, never create one.
    opts.newGroupName = undefined;
  }
  return opts;
}

/**
 * Load the workspace data a job needs and validate mapping + options against
 * it (tenancy: owner, custom field, group and pipeline ids must belong to the
 * workspace). Throws 400/404 with message keys.
 */
export async function loadContext(
  prisma: PrismaService,
  workspaceId: string,
  headers: string[],
  mapping: ImportMapping,
  options: ImportOptions,
  totalRows: number,
): Promise<ImportContext> {
  if (!mapping || typeof mapping !== "object") throw importError("imports.mapping_invalid");
  const known = new Set(headers);
  const used = new Set<string>();
  const defIds = new Set<string>();
  for (const [header, target] of Object.entries(mapping)) {
    if (!known.has(header) || typeof target !== "string") throw importError("imports.mapping_invalid");
    if (target === "ignore") continue;
    if (target.startsWith("custom:")) {
      const id = target.slice(7);
      if (!id || defIds.has(id)) throw importError("imports.mapping_duplicate");
      defIds.add(id);
      continue;
    }
    if (!(SIMPLE_TARGETS as readonly string[]).includes(target)) throw importError("imports.mapping_invalid");
    if (target !== "tags" && used.has(target)) throw importError("imports.mapping_duplicate");
    used.add(target);
  }
  if (!used.has("name") && !used.has("firstName") && !used.has("phone")) {
    throw importError("imports.mapping_required");
  }

  const defRows = (await prisma.customFieldDef.findMany({
    where: { workspaceId, entity: "contact", archivedAt: null },
  })) as unknown as FieldDef[];
  const defs = new Map(defRows.map((d) => [d.id, d]));
  for (const id of defIds) if (!defs.has(id)) throw importError("imports.custom_field_invalid");

  const members = (await prisma.workspaceMember.findMany({
    where: { workspaceId },
    include: { user: { select: { id: true, name: true, email: true } } },
  })) as unknown as { userId: string; user: { id: string; name: string; email: string } }[];
  const ownersByEmail = new Map<string, string>();
  const ownersByName = new Map<string, string>();
  for (const m of members) {
    ownersByEmail.set(m.user.email.toLowerCase(), m.userId);
    if (m.user.name) ownersByName.set(m.user.name.trim().toLowerCase(), m.userId);
  }
  if (options.ownerId && !members.some((m) => m.userId === options.ownerId)) {
    throw importError("imports.owner_invalid");
  }
  if (options.groupId) await requireManualGroup(prisma, workspaceId, options.groupId);

  if (options.pipeline) {
    const p = await prisma.pipeline.findFirst({ where: { id: options.pipeline.pipelineId, workspaceId } });
    if (!p) throw importError("imports.pipeline_invalid");
    if (options.pipeline.stageId) {
      const st = await prisma.ticketStage.findFirst({
        where: { id: options.pipeline.stageId, workspaceId, pipelineId: options.pipeline.pipelineId },
      });
      if (!st) throw importError("imports.pipeline_invalid");
    }
    if (totalRows > IMPORT_PIPELINE_CAP) throw importError("imports.pipeline_too_large");
  }

  const ws = (await prisma.workspace.findFirst({ where: { id: workspaceId }, select: { timezone: true } })) as {
    timezone?: string;
  } | null;
  return {
    cc: countryCodeForTimezone(ws?.timezone),
    headers,
    mapping,
    options,
    defs,
    ownersByEmail,
    ownersByName,
  };
}

export interface ExistingMatch {
  id: string;
}

export interface BatchPlan {
  invalid: { row: number; errors: RowError[] }[];
  duplicates: number;
  news: NormalizedRow[];
  /** Existing contacts matched when updateExisting is true. */
  updates: { id: string; rec: NormalizedRow }[];
  /** Existing contacts matched but left alone (updateExisting false). */
  unchanged: { id: string }[];
}

/**
 * Classify one batch of source rows. Rows already seen in the file (tracker)
 * are counted as duplicates; the rest are matched to existing contacts with a
 * single query. Safe to re-run for the same rows (resume): already-created
 * contacts simply match.
 */
export async function planBatch(
  prisma: PrismaService,
  workspaceId: string,
  ctx: ImportContext,
  rows: string[][],
  rowNumbers: number[],
  tracker: DupTracker,
): Promise<BatchPlan> {
  const plan: BatchPlan = { invalid: [], duplicates: 0, news: [], updates: [], unchanged: [] };
  const candidates: NormalizedRow[] = [];
  rows.forEach((cells, i) => {
    const r = normalizeRow(cells, ctx);
    if (!r.ok) plan.invalid.push({ row: rowNumbers[i], errors: r.errors });
    else if (tracker.isDuplicate(r.rec)) plan.duplicates += 1;
    else candidates.push(r.rec);
  });
  if (!candidates.length) return plan;

  const { matchBy, updateExisting } = ctx.options;
  const phones = new Set<string>();
  const emails = new Set<string>();
  for (const c of candidates) {
    if (c.phone && matchBy !== "email") phoneVariants(c.phone, ctx.cc).forEach((v) => phones.add(v));
    if (c.email && matchBy !== "phone") emails.add(c.email);
  }
  const or: Record<string, unknown>[] = [];
  if (phones.size) or.push({ phone: { in: [...phones] } });
  if (emails.size) or.push({ email: { in: [...emails] } });
  const existing = or.length
    ? ((await prisma.contact.findMany({
        where: { workspaceId, OR: or },
        select: { id: true, phone: true, email: true },
      })) as { id: string; phone: string | null; email: string | null }[])
    : [];
  const byPhone = new Map<string, string>();
  const byEmail = new Map<string, string>();
  for (const e of existing) {
    const p = normalizeImportPhone(e.phone, ctx.cc);
    if (p && !byPhone.has(p)) byPhone.set(p, e.id);
    if (e.email) byEmail.set(e.email.toLowerCase(), e.id);
  }
  for (const rec of candidates) {
    const id =
      (rec.phone && matchBy !== "email" ? byPhone.get(rec.phone) : undefined) ??
      (rec.email && matchBy !== "phone" ? byEmail.get(rec.email) : undefined);
    if (!id) plan.news.push(rec);
    else if (updateExisting) plan.updates.push({ id, rec });
    else plan.unchanged.push({ id });
  }
  return plan;
}

export { rowKeys };
