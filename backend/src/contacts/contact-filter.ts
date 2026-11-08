import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";
import type { SegmentsService } from "../segments/segments.service";
import { fieldWhere, type FieldOp } from "../custom-fields/custom-fields.service";

export interface ContactFieldFilter {
  defId: string;
  op: FieldOp;
  value?: string;
}

export interface ContactListFilter {
  q?: string;
  segmentId?: string;
  lifecycle?: string[];
  tags?: string[];
  tagMode?: "any" | "all";
  /** A user id, or "none" for unassigned contacts. */
  ownerId?: string | "none";
  pipelineId?: string;
  stageId?: string;
  optOut?: boolean;
  notALead?: boolean;
  fields?: ContactFieldFilter[];
}

const OPS: FieldOp[] = ["eq", "contains", "gt", "lt", "set", "unset"];

function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new BadRequestException("filter values must be strings");
  const t = v.trim();
  return t ? t : undefined;
}

function list(v: unknown): string[] | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const arr = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : null;
  if (!arr || arr.some((x) => typeof x !== "string")) throw new BadRequestException("expected a list of strings");
  const out = arr.map((x: string) => x.trim()).filter(Boolean);
  return out.length ? out : undefined;
}

/**
 * Tags may contain commas, so the UI sends them as a JSON array string
 * (`["Riyadh, KSA","VIP"]`). A value not starting with "[" is the legacy
 * comma-separated form.
 */
function tagList(v: unknown): string[] | undefined {
  if (typeof v === "string" && v.trimStart().startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(v);
    } catch {
      throw new BadRequestException("tags must be a JSON array of strings");
    }
    if (!Array.isArray(parsed)) throw new BadRequestException("tags must be a JSON array of strings");
    return list(parsed);
  }
  return list(v);
}

function bool(v: unknown, key: string): boolean | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (v === true || v === "true") return true;
  if (v === false || v === "false") return false;
  throw new BadRequestException(`${key} must be true or false`);
}

function fieldFilters(v: unknown): ContactFieldFilter[] | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  let arr: unknown = v;
  if (typeof v === "string") {
    let text = v;
    // The query value is URL-encoded JSON; Express has usually decoded it
    // already, so only decode when it does not already look like JSON.
    if (!text.trimStart().startsWith("[") && !text.trimStart().startsWith("{")) {
      try {
        text = decodeURIComponent(text);
      } catch {
        throw new BadRequestException("fields must be a JSON array");
      }
    }
    try {
      arr = JSON.parse(text);
    } catch {
      throw new BadRequestException("fields must be a JSON array");
    }
  }
  if (!Array.isArray(arr)) throw new BadRequestException("fields must be a JSON array");
  return arr.map((raw) => {
    const o = raw as Record<string, unknown>;
    if (!o || typeof o !== "object" || typeof o.defId !== "string" || !o.defId) {
      throw new BadRequestException("each field filter needs a defId");
    }
    if (typeof o.op !== "string" || !OPS.includes(o.op as FieldOp)) {
      throw new BadRequestException("invalid field filter op");
    }
    if (o.value !== undefined && o.value !== null && typeof o.value !== "string") {
      throw new BadRequestException("field filter value must be a string");
    }
    const out: ContactFieldFilter = { defId: o.defId, op: o.op as FieldOp };
    if (typeof o.value === "string") out.value = o.value;
    return out;
  });
}

/**
 * Normalise a raw filter (query params or a JSON body) into ContactListFilter.
 * Query format: lifecycle comma-separated; tags a JSON array string (or the
 * legacy comma-separated form); `fields` is a
 * URL-encoded JSON array; booleans "true"/"false". Invalid -> 400.
 */
export function parseContactFilter(raw: Record<string, unknown> | undefined | null): ContactListFilter {
  const r = raw ?? {};
  const f: ContactListFilter = {};
  const q = str(r.q);
  if (q) f.q = q;
  const segmentId = str(r.segmentId);
  if (segmentId) f.segmentId = segmentId;
  const lifecycle = list(r.lifecycle);
  if (lifecycle) f.lifecycle = lifecycle;
  const tags = tagList(r.tags);
  if (tags) f.tags = tags;
  if (r.tagMode !== undefined && r.tagMode !== "") {
    if (r.tagMode !== "any" && r.tagMode !== "all") throw new BadRequestException("tagMode must be any or all");
    f.tagMode = r.tagMode;
  }
  const ownerId = str(r.ownerId);
  if (ownerId) f.ownerId = ownerId;
  const pipelineId = str(r.pipelineId);
  if (pipelineId) f.pipelineId = pipelineId;
  const stageId = str(r.stageId);
  if (stageId) f.stageId = stageId;
  const optOut = bool(r.optOut, "optOut");
  if (optOut !== undefined) f.optOut = optOut;
  const notALead = bool(r.notALead, "notALead");
  if (notALead !== undefined) f.notALead = notALead;
  const fields = fieldFilters(r.fields);
  if (fields) f.fields = fields;
  return f;
}

export interface ContactFilterDeps {
  prisma: PrismaService;
  segments: Pick<SegmentsService, "resolveContactWhere">;
}

/**
 * Tags is a JSON-encoded string array in a TEXT column; matching the quoted
 * JSON element (`"VIP"`) keeps "VIP" distinct from "VIPER".
 */
const tagNeedle = (name: string): Prisma.ContactWhereInput => ({
  tags: { contains: JSON.stringify(name) },
});

export async function buildContactWhere(
  workspaceId: string,
  f: ContactListFilter,
  deps: ContactFilterDeps,
): Promise<Prisma.ContactWhereInput> {
  const where: Prisma.ContactWhereInput = { workspaceId };
  const and: Prisma.ContactWhereInput[] = [];

  if (f.segmentId) and.push(await deps.segments.resolveContactWhere(workspaceId, f.segmentId));

  const q = f.q?.trim();
  if (q) {
    and.push({
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { phone: { contains: q } },
        { email: { contains: q, mode: "insensitive" } },
      ],
    });
  }
  if (f.lifecycle?.length) {
    // Stored values are lowercase, but legacy rows may be capitalised.
    and.push({ OR: f.lifecycle.map((v) => ({ lifecycle: { equals: v, mode: "insensitive" as const } })) });
  }
  if (f.tags?.length) {
    const needles = f.tags.map(tagNeedle);
    and.push(f.tagMode === "all" ? { AND: needles } : { OR: needles });
  }
  if (f.ownerId === "none") where.ownerId = null;
  else if (f.ownerId) where.ownerId = f.ownerId;
  if (f.pipelineId) {
    and.push({
      tickets: {
        some: { pipelineId: f.pipelineId, ...(f.stageId ? { stageId: f.stageId } : {}), closedAt: null },
      },
    });
  }
  if (f.optOut !== undefined) where.marketingOptOut = f.optOut;
  if (f.notALead !== undefined) where.notALead = f.notALead;

  if (f.fields?.length) {
    const ids = [...new Set(f.fields.map((x) => x.defId))];
    const defs = await deps.prisma.customFieldDef.findMany({
      where: { workspaceId, id: { in: ids }, archivedAt: null },
      select: { id: true, type: true },
    });
    const byId = new Map(defs.map((d) => [d.id, d]));
    for (const x of f.fields) {
      const def = byId.get(x.defId);
      if (!def) throw new NotFoundException("Custom field not found");
      and.push(fieldWhere(def, x.op, x.value));
    }
  }

  if (and.length) where.AND = and;
  return where;
}
