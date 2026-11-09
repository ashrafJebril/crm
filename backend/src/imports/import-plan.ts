import { BadRequestException, ConflictException } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { PrismaService } from "../prisma/prisma.service";
import { requireManualGroup } from "../segments/segment-members";
import { countryCodeForTimezone } from "./phone";
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

export function importConflict(key: string): ConflictException {
  return new ConflictException({ message: key, messageKey: key });
}

/** Deterministic id of the contact a job creates for a source row (exactly-once resume). */
export function importContactId(jobId: string, rowNumber: number): string {
  return "imp" + createHash("sha256").update(`${jobId}:${rowNumber}`).digest("hex").slice(0, 22);
}

/** Deterministic id of the group an audience job creates. */
export function importGroupId(jobId: string): string {
  return "impg" + createHash("sha256").update(`group:${jobId}`).digest("hex").slice(0, 21);
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
    if (m.user.name) {
      const key = m.user.name.trim().toLowerCase();
      // "" marks a name shared by several members (ambiguous: needs the email).
      ownersByName.set(key, ownersByName.has(key) ? "" : m.userId);
    }
  }
  if (options.ownerId && !members.some((m) => m.userId === options.ownerId)) {
    throw importError("imports.owner_invalid");
  }
  if (options.groupId) {
    try {
      await requireManualGroup(prisma, workspaceId, options.groupId);
    } catch {
      throw importError("imports.group_invalid");
    }
  }

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

/** Stored name columns of a matched contact (so updates can merge name parts). */
export interface StoredName {
  name: string;
  firstName: string | null;
  lastName: string | null;
}

export interface BatchPlan {
  invalid: { row: number; errors: RowError[] }[];
  duplicates: number;
  /** Rows to create, with their deterministic contact ids. */
  news: { id: string; rec: NormalizedRow }[];
  /** Rows whose contact this same job already created (a resumed batch). */
  resumed: { id: string; rec: NormalizedRow }[];
  /** Existing contacts matched when updateExisting is true. */
  updates: { id: string; rec: NormalizedRow; stored: StoredName }[];
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
  /** Set when running a job: rows already created by it are recognised by id. */
  resumeJobId?: string,
): Promise<BatchPlan> {
  const plan: BatchPlan = { invalid: [], duplicates: 0, news: [], resumed: [], updates: [], unchanged: [] };
  let candidates: { row: number; rec: NormalizedRow }[] = [];
  rows.forEach((cells, i) => {
    const r = normalizeRow(cells, ctx);
    if (!r.ok) plan.invalid.push({ row: rowNumbers[i], errors: r.errors });
    else if (tracker.isDuplicate(r.rec)) plan.duplicates += 1;
    else candidates.push({ row: rowNumbers[i], rec: r.rec });
  });
  if (!candidates.length) return plan;

  if (resumeJobId) {
    const ids = candidates.map((c) => importContactId(resumeJobId, c.row));
    const found = (await prisma.contact.findMany({
      where: { workspaceId, id: { in: ids } },
      select: { id: true },
    })) as { id: string }[];
    const have = new Set(found.map((f) => f.id));
    const rest: typeof candidates = [];
    candidates.forEach((c, i) => (have.has(ids[i]) ? plan.resumed.push({ id: ids[i], rec: c.rec }) : rest.push(c)));
    candidates = rest;
    if (!candidates.length) return plan;
  }

  const { matchBy, updateExisting } = ctx.options;
  const digits = new Set<string>();
  const emails = new Set<string>();
  for (const { rec: c } of candidates) {
    if (c.phone && matchBy !== "email") {
      for (const v of phoneVariants(c.phone, ctx.cc)) digits.add(v.replace(/\D/g, ""));
    }
    if (c.email && matchBy !== "phone") emails.add(c.email.toLowerCase());
  }
  // Phones are compared digits-only (stored forms vary: "+971 50 123 4567",
  // "050-123-4567"), emails case-insensitively; one query per batch.
  const existing =
    digits.size || emails.size
      ? await prisma.$queryRaw<
          { id: string; phone: string | null; email: string | null; name: string; firstName: string | null; lastName: string | null }[]
        >`
          SELECT "id", "phone", "email", "name", "firstName", "lastName" FROM "Contact"
          WHERE "workspaceId" = ${workspaceId}
            AND (
              regexp_replace(COALESCE("phone", ''), '[^0-9]', '', 'g') = ANY(${[...digits]}::text[])
              OR lower("email") = ANY(${[...emails]}::text[])
            )
          ORDER BY "createdAt" ASC, "id" ASC`
      : [];
  // Keyed by the stored digits (not re-normalized: stored values may be bare
  // digits such as "971501234567"); the oldest contact wins.
  const byPhone = new Map<string, (typeof existing)[number]>();
  const byEmail = new Map<string, (typeof existing)[number]>();
  for (const e of existing) {
    const p = e.phone ? e.phone.replace(/\D/g, "") : "";
    if (p && !byPhone.has(p)) byPhone.set(p, e);
    const em = e.email?.toLowerCase();
    if (em && !byEmail.has(em)) byEmail.set(em, e);
  }
  const findByPhone = (phone: string) => {
    for (const v of phoneVariants(phone, ctx.cc)) {
      const hit = byPhone.get(v.replace(/\D/g, ""));
      if (hit) return hit;
    }
    return undefined;
  };
  for (const { row, rec } of candidates) {
    const hit =
      (rec.phone && matchBy !== "email" ? findByPhone(rec.phone) : undefined) ??
      (rec.email && matchBy !== "phone" ? byEmail.get(rec.email) : undefined);
    if (!hit) plan.news.push({ id: importContactId(resumeJobId ?? "preview", row), rec });
    else if (updateExisting) {
      plan.updates.push({
        id: hit.id,
        rec,
        stored: { name: hit.name ?? "", firstName: hit.firstName ?? null, lastName: hit.lastName ?? null },
      });
    } else plan.unchanged.push({ id: hit.id });
  }
  return plan;
}

export { rowKeys };
