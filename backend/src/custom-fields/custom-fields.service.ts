import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { normalizeDigits } from "../contacts/contact-name";
import { CreateCustomFieldDto, UpdateCustomFieldDto } from "./custom-fields.dto";

export type FieldOp = "eq" | "contains" | "gt" | "lt" | "set" | "unset";

export function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function cleanOptions(options: unknown): string[] {
  if (!Array.isArray(options)) throw new BadRequestException("options required");
  const out = options.map((o) => (typeof o === "string" ? o.trim() : ""));
  if (out.some((o) => !o)) throw new BadRequestException("options must be non-empty strings");
  if (out.length < 1 || out.length > 50) throw new BadRequestException("options must have 1-50 items");
  if (new Set(out).size !== out.length) throw new BadRequestException("options must be unique");
  return out;
}

/**
 * Contact filter on a custom field (consumed by the contact list filter).
 * Values are stored as JSON scalars: text/select -> string, number -> number,
 * date -> "YYYY-MM-DD" string, boolean -> boolean.
 * Operators per type:
 *  - set / unset (all types): fieldValues some / none for the defId.
 *  - text:    eq (Json equals), contains (Json string_contains; CASE-SENSITIVE, Prisma
 *             has no `mode` for Json filters).
 *  - select:  eq only.      - boolean: eq only ("true"/"false").
 *  - number:  eq, gt, lt (Json comparison; value parsed after normalizeDigits).
 *  - date:    eq, gt, lt (jsonb string comparison; ISO dates sort lexically).
 * An unsupported operator for the type throws BadRequestException.
 * Root-scalar Json filters are used without `path` (a Json path of [] is not valid in Prisma).
 */
export function fieldWhere(
  def: { id: string; type: string },
  op: FieldOp,
  value?: string,
): Prisma.ContactWhereInput {
  const defId = def.id;
  if (op === "set") return { fieldValues: { some: { defId } } };
  if (op === "unset") return { fieldValues: { none: { defId } } };
  if (value === undefined) throw new BadRequestException("value required");
  const bad = () => new BadRequestException(`operator ${op} not supported for ${def.type}`);
  const some = (v: Prisma.JsonNullableFilter): Prisma.ContactWhereInput => ({
    fieldValues: { some: { defId, value: v as Prisma.JsonFilter } },
  });
  switch (def.type) {
    case "text":
      if (op === "eq") return some({ equals: value });
      if (op === "contains") return some({ string_contains: value });
      throw bad();
    case "select":
      if (op === "eq") return some({ equals: value });
      throw bad();
    case "boolean":
      if (op === "eq") return some({ equals: value === "true" });
      throw bad();
    case "number": {
      const n = Number(normalizeDigits(value));
      if (!Number.isFinite(n)) throw new BadRequestException("invalid number");
      if (op === "eq") return some({ equals: n });
      if (op === "gt") return some({ gt: n });
      if (op === "lt") return some({ lt: n });
      throw bad();
    }
    case "date":
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new BadRequestException("invalid date");
      if (op === "eq") return some({ equals: value });
      if (op === "gt") return some({ gt: value });
      if (op === "lt") return some({ lt: value });
      throw bad();
    default:
      throw bad();
  }
}

function validateValue(
  def: { type: string; options: unknown; key: string },
  v: unknown,
): Prisma.InputJsonValue {
  const fail = (m: string) => new BadRequestException(`${def.key}: ${m}`);
  switch (def.type) {
    case "text":
      if (typeof v !== "string") throw fail("must be a string");
      if (v.length > 2000) throw fail("too long (max 2000)");
      return v;
    case "number": {
      const n =
        typeof v === "number"
          ? v
          : typeof v === "string" && v.trim()
            ? Number(normalizeDigits(v.trim()))
            : NaN;
      if (!Number.isFinite(n)) throw fail("must be a finite number");
      return n;
    }
    case "date": {
      if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw fail("must be YYYY-MM-DD");
      const d = new Date(`${v}T00:00:00Z`);
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw fail("invalid date");
      return v;
    }
    case "select":
      if (typeof v !== "string" || !Array.isArray(def.options) || !(def.options as string[]).includes(v))
        throw fail("not one of the options");
      return v;
    case "boolean":
      if (typeof v !== "boolean") throw fail("must be a boolean");
      return v;
    default:
      throw fail("unknown type");
  }
}

@Injectable()
export class CustomFieldsService {
  constructor(private readonly prisma: PrismaService) {}

  list(workspaceId: string, includeArchived = false) {
    return this.prisma.customFieldDef.findMany({
      where: { workspaceId, entity: "contact", ...(includeArchived ? {} : { archivedAt: null }) },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    });
  }

  async create(workspaceId: string, dto: CreateCustomFieldDto) {
    let options: string[] | undefined;
    if (dto.type === "select") options = cleanOptions(dto.options);
    else if (dto.options?.length) throw new BadRequestException("options only for select");

    const existing = await this.prisma.customFieldDef.findMany({
      where: { workspaceId, entity: "contact" },
      select: { key: true },
    });
    const keys = new Set(existing.map((e: { key: string }) => e.key));
    const base = slugify(dto.label) || `field_${existing.length + 1}`;
    let key = base;
    for (let i = 2; keys.has(key); i++) key = `${base}_${i}`;

    return this.prisma.customFieldDef.create({
      data: {
        workspaceId,
        entity: "contact",
        key,
        label: dto.label.trim(),
        labelAr: dto.labelAr.trim(),
        type: dto.type,
        options: options ?? Prisma.JsonNull,
        order: existing.length,
      },
    });
  }

  private async getDef(workspaceId: string, id: string) {
    const def = await this.prisma.customFieldDef.findFirst({ where: { id, workspaceId } });
    if (!def) throw new NotFoundException("field not found");
    return def;
  }

  async update(workspaceId: string, id: string, dto: UpdateCustomFieldDto) {
    const def = await this.getDef(workspaceId, id);
    if (dto.type !== undefined && dto.type !== def.type) throw new BadRequestException("type is immutable");
    const data: Prisma.CustomFieldDefUpdateManyMutationInput = {};
    if (dto.label !== undefined) data.label = dto.label;
    if (dto.labelAr !== undefined) data.labelAr = dto.labelAr;
    if (dto.order !== undefined) data.order = dto.order;
    if (dto.options !== undefined) {
      if (def.type !== "select") throw new BadRequestException("options only for select");
      data.options = cleanOptions(dto.options);
    }
    await this.prisma.customFieldDef.updateMany({ where: { id, workspaceId }, data });
    return this.getDef(workspaceId, id);
  }

  async deletePreview(workspaceId: string, id: string) {
    await this.getDef(workspaceId, id);
    return { valueCount: await this.prisma.customFieldValue.count({ where: { defId: id } }) };
  }

  /** Soft delete: archives the def and keeps all stored values. */
  async remove(workspaceId: string, id: string) {
    await this.getDef(workspaceId, id);
    const valueCount = await this.prisma.customFieldValue.count({ where: { defId: id } });
    await this.prisma.customFieldDef.updateMany({
      where: { id, workspaceId },
      data: { archivedAt: new Date() },
    });
    return { ok: true, valueCount };
  }

  private async assertContact(workspaceId: string, contactId: string) {
    const c = await this.prisma.contact.findFirst({
      where: { id: contactId, workspaceId },
      select: { id: true },
    });
    if (!c) throw new NotFoundException("contact not found");
  }

  async getForContact(workspaceId: string, contactId: string) {
    await this.assertContact(workspaceId, contactId);
    return this.readList(workspaceId, contactId);
  }

  private async readList(workspaceId: string, contactId: string) {
    const defs = await this.list(workspaceId, false);
    const vals = await this.prisma.customFieldValue.findMany({
      where: { contactId, defId: { in: defs.map((d: { id: string }) => d.id) } },
    });
    const byDef = new Map<string, unknown>(
      vals.map((v: { defId: string; value: unknown }) => [v.defId, v.value]),
    );
    return defs.map((d: any) => ({
      defId: d.id,
      key: d.key,
      label: d.label,
      labelAr: d.labelAr,
      type: d.type,
      options: d.options ?? null,
      value: byDef.has(d.id) ? byDef.get(d.id) : null,
    }));
  }

  async setForContact(workspaceId: string, contactId: string, values: Record<string, unknown>) {
    await this.assertContact(workspaceId, contactId);
    const ids = Object.keys(values ?? {});
    const defs = ids.length
      ? await this.prisma.customFieldDef.findMany({
          where: { workspaceId, id: { in: ids }, archivedAt: null },
        })
      : [];
    const defMap = new Map<string, any>(defs.map((d: any) => [d.id, d]));
    const ops: Prisma.PrismaPromise<unknown>[] = [];
    for (const id of ids) {
      const def = defMap.get(id);
      if (!def) throw new NotFoundException(`field ${id} not found`);
      const v = values[id];
      if (v === null) {
        ops.push(this.prisma.customFieldValue.deleteMany({ where: { defId: id, contactId } }));
      } else {
        const value = validateValue(def, v);
        ops.push(
          this.prisma.customFieldValue.upsert({
            where: { defId_contactId: { defId: id, contactId } },
            create: { defId: id, contactId, value },
            update: { value },
          }),
        );
      }
    }
    if (ops.length) await this.prisma.$transaction(ops);
    return this.readList(workspaceId, contactId);
  }
}
