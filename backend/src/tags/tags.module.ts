import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import { ArrayNotEmpty, ArrayUnique, IsArray, IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";
import { Transform } from "class-transformer";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { CurrentWorkspace } from "../common/current-workspace.decorator";

/** Deterministic 12-step hue for auto-colored tags (matches the absorb
 *  migration's hashtext formula in spirit; exact parity isn't required —
 *  colors are cosmetic — but determinism per name is). */
export function hueForName(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) | 0;
  return String((Math.abs(h) % 12) * 30);
}

/** Trim at the DTO boundary so `@IsNotEmpty` rejects whitespace-only names
 *  (global ValidationPipe runs with transform: true). The service re-checks —
 *  it's also called directly by the assign quick-create path. */
const TrimName = Transform(({ value }) =>
  typeof value === "string" ? value.trim() : value,
);

class CreateTagDto {
  @TrimName @IsString() @IsNotEmpty() @MaxLength(40) name!: string;
  @IsOptional() @IsString() @MaxLength(16) color?: string;
}

class UpdateTagDto {
  @TrimName @IsOptional() @IsString() @IsNotEmpty() @MaxLength(40) name?: string;
  @IsOptional() @IsString() @MaxLength(16) color?: string;
}

class MergeTagsDto {
  @IsArray() @ArrayNotEmpty() @ArrayUnique() @IsString({ each: true }) fromIds!: string[];
  @IsString() @IsNotEmpty() intoId!: string;
}

class AssignTagsDto {
  @IsArray() @IsString({ each: true }) contactIds!: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) add?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) remove?: string[];
}

/** Trim + reject empty. Tag names ARE the storage key — they live inside
 *  `Contact.tags` JSON and inside saved segment filters — so an empty or
 *  untrimmed name is unmatchable by every catalog operation. */
function normalizeName(raw: string): string {
  const name = raw.trim();
  if (!name) throw new BadRequestException("Tag name cannot be empty");
  return name;
}

/**
 * Replace an exact tag name inside a saved segment filter's `tagsAll`/`tagsAny`
 * arrays. Returns the re-serialized filter, or null when nothing changed (so
 * callers only write the segments they actually touched).
 * Exact-element match only: renaming "VIP" must not touch "VIPER".
 * Exported for unit tests.
 */
export function rewriteFilterTagName(
  raw: string,
  from: string,
  to: string,
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // malformed filter — leave it alone rather than clobber it
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const filter = parsed as Record<string, unknown>;
  let changed = false;
  for (const key of ["tagsAll", "tagsAny"] as const) {
    const arr = filter[key];
    if (!Array.isArray(arr) || !arr.includes(from)) continue;
    // Dedupe: a filter may already reference the target name.
    filter[key] = [...new Set(arr.map((n) => (n === from ? to : n)))];
    changed = true;
  }
  return changed ? JSON.stringify(filter) : null;
}

/** The transaction-client surface the shared rewrite helpers need (the app's
 *  extended Prisma client's tx isn't assignable to Prisma.TransactionClient). */
type TagTx = Pick<PrismaService, "$executeRaw" | "segment">;

@Injectable()
export class TagsService {
  constructor(private readonly prisma: PrismaService) {}

  /** All catalog tags with live usage counts (one grouped jsonb pass). */
  async list(workspaceId: string) {
    const tags = await this.prisma.tag.findMany({
      where: { workspaceId },
      orderBy: { name: "asc" },
    });
    // DISTINCT contacts, not element occurrences: the UI labels this "N
    // contacts", and a row that carries the same name twice must count once.
    const counts = await this.prisma.$queryRaw<{ name: string; count: bigint }[]>`
      SELECT e AS name, count(DISTINCT c."id")::bigint AS count
      FROM "Contact" c, jsonb_array_elements_text(c."tags"::jsonb) e
      WHERE c."workspaceId" = ${workspaceId}
      GROUP BY e
    `;
    const byName = new Map(counts.map((r) => [r.name, Number(r.count)]));
    return tags.map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color,
      usageCount: byName.get(t.name) ?? 0,
    }));
  }

  /** Idempotent create — quick-create callers shouldn't 409 on races. */
  async create(workspaceId: string, rawName: string, color?: string) {
    const name = normalizeName(rawName);
    const existing = await this.prisma.tag.findFirst({ where: { workspaceId, name } });
    if (existing) return existing;
    try {
      return await this.prisma.tag.create({
        data: { workspaceId, name, color: color ?? hueForName(name) },
      });
    } catch (e) {
      // Unique race: someone created it between the check and the insert.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        const row = await this.prisma.tag.findFirst({ where: { workspaceId, name } });
        if (row) return row;
      }
      throw e;
    }
  }

  async update(workspaceId: string, id: string, dto: { name?: string; color?: string }) {
    const tag = await this.prisma.tag.findFirst({ where: { id, workspaceId } });
    if (!tag) throw new NotFoundException("Tag not found");
    const newName = dto.name === undefined ? undefined : normalizeName(dto.name);
    const renaming = newName !== undefined && newName !== tag.name;

    if (renaming) {
      // Pre-check the catalog BEFORE any propagation: the rename rewrites every
      // contact and every saved filter that mentions the old name, so letting
      // the catalog's unique index be the gate would 500 *after* the data was
      // already rewritten to another tag's name.
      const clash = await this.prisma.tag.findFirst({
        where: { workspaceId, name: newName },
      });
      if (clash) {
        throw new ConflictException(
          `A tag named "${newName}" already exists — يوجد وسم بهذا الاسم بالفعل`,
        );
      }
    }

    // One transaction for contacts + saved filters + the catalog row: a failure
    // anywhere must not leave contacts renamed against a stale catalog.
    return this.prisma.$transaction(async (tx) => {
      let contactsUpdated = 0;
      let segmentsUpdated = 0;
      if (renaming) {
        contactsUpdated = await this.renameOnContacts(tx, workspaceId, tag.name, newName);
        segmentsUpdated = await this.renameInSegments(tx, workspaceId, [
          [tag.name, newName],
        ]);
      }
      const updated = await tx.tag.update({
        where: { id },
        data: { name: newName, color: dto.color ?? undefined },
      });
      return { tag: updated, contactsUpdated, segmentsUpdated };
    });
  }

  /** Exact-element rename inside the JSON string arrays — "VIP" must never
   *  touch "VIPER" (jsonb element equality, not substring). DISTINCT dedupes the
   *  legitimate case where a contact carried BOTH names (names enter
   *  Contact.tags outside the catalog too, e.g. the Inbox tag editor); element
   *  order in the array is not contractual. */
  private renameOnContacts(
    tx: TagTx,
    workspaceId: string,
    from: string,
    to: string,
  ): Promise<number> {
    return tx.$executeRaw`
      UPDATE "Contact"
      SET "tags" = (
        SELECT COALESCE(jsonb_agg(DISTINCT CASE WHEN e = ${from} THEN ${to} ELSE e END), '[]'::jsonb)::text
        FROM jsonb_array_elements_text("tags"::jsonb) e
      )
      WHERE "workspaceId" = ${workspaceId} AND "tags"::jsonb ? ${from}
    `;
  }

  /** Saved crm segments store tag NAMES in their filter JSON; without this a
   *  renamed/merged tag silently makes every smart segment match nothing.
   *  Applies the (from, to) pairs in order; returns segments actually written. */
  private async renameInSegments(
    tx: TagTx,
    workspaceId: string,
    pairs: [string, string][],
  ): Promise<number> {
    const segments = await tx.segment.findMany({
      where: { workspaceId, origin: "crm" },
      select: { id: true, filter: true },
    });
    let updated = 0;
    for (const s of segments) {
      let filter = s.filter;
      let changed = false;
      for (const [from, to] of pairs) {
        const next = rewriteFilterTagName(filter, from, to);
        if (next === null) continue;
        filter = next;
        changed = true;
      }
      if (!changed) continue;
      await tx.segment.update({ where: { id: s.id }, data: { filter } });
      updated += 1;
    }
    return updated;
  }

  /** Fold `fromIds` into `intoId`: contacts and saved filters are rewritten to
   *  the target name, then the source catalog rows are deleted — one transaction. */
  async merge(workspaceId: string, fromIds: string[], intoId: string) {
    const from = [...new Set(fromIds)];
    if (from.length === 0) throw new BadRequestException("fromIds cannot be empty");
    if (from.includes(intoId)) {
      throw new BadRequestException("Target tag cannot be one of the merged tags");
    }
    const rows = await this.prisma.tag.findMany({
      where: { workspaceId, id: { in: [...from, intoId] } },
    });
    const byId = new Map(rows.map((t) => [t.id, t]));
    const into = byId.get(intoId);
    if (!into || from.some((id) => !byId.has(id))) {
      throw new NotFoundException("Tag not found");
    }
    const sources = from.map((id) => byId.get(id)!);
    return this.prisma.$transaction(async (tx) => {
      let contactsUpdated = 0;
      for (const src of sources) {
        contactsUpdated += await this.renameOnContacts(tx, workspaceId, src.name, into.name);
      }
      const segmentsUpdated = await this.renameInSegments(
        tx,
        workspaceId,
        sources.map((src): [string, string] => [src.name, into.name]),
      );
      const { count } = await tx.tag.deleteMany({
        where: { id: { in: from }, workspaceId },
      });
      return { contactsUpdated, segmentsUpdated, removed: count };
    });
  }

  async remove(workspaceId: string, id: string) {
    const tag = await this.prisma.tag.findFirst({ where: { id, workspaceId } });
    if (!tag) throw new NotFoundException("Tag not found");
    return this.prisma.$transaction(async (tx) => {
      const contactsUpdated = await tx.$executeRaw`
        UPDATE "Contact"
        SET "tags" = (
          SELECT COALESCE(jsonb_agg(e) FILTER (WHERE e <> ${tag.name}), '[]'::jsonb)::text
          FROM jsonb_array_elements_text("tags"::jsonb) e
        )
        WHERE "workspaceId" = ${workspaceId} AND "tags"::jsonb ? ${tag.name}
      `;
      await tx.tag.delete({ where: { id } });
      return { ok: true as const, contactsUpdated };
    });
  }

  /**
   * Bulk add/remove tag names on contacts; unknown names quick-create.
   *
   * Set-based so select-all (up to 10 000 contacts) stays a handful of
   * statements: one UPDATE per removed name, then one per added name, all in
   * one transaction (all-or-nothing, spec §4). `contactsUpdated` counts
   * DISTINCT contacts whose tags changed (RETURNING ids, unioned).
   *
   * Malformed rows: `tags` is TEXT, and `"tags"::jsonb` throws on invalid JSON,
   * which would 500 the whole batch. The ids are classified in JS from the
   * validation read we already do: only rows whose tags parse as a JSON array
   * ever reach the jsonb SQL, and that SQL guards the cast with a CASE on the
   * id so Postgres cannot evaluate it for any other row. Malformed rows are
   * treated as an empty list, as before: an add resets them to the added names
   * (one updateMany), a remove leaves them untouched.
   */
  async assign(
    workspaceId: string,
    input: { contactIds: string[]; add?: string[]; remove?: string[] },
  ) {
    const ids = [...new Set(input.contactIds)];
    const found = await this.prisma.contact.findMany({
      where: { workspaceId, id: { in: ids } },
      select: { id: true, tags: true },
    });
    if (found.length !== ids.length) {
      throw new NotFoundException("One or more contacts not found in this workspace");
    }
    const add = [...new Set((input.add ?? []).map((n) => n.trim()).filter(Boolean))];
    const remove = [...new Set((input.remove ?? []).map((n) => n.trim()).filter(Boolean))];
    for (const name of add) await this.create(workspaceId, name);

    const valid: string[] = [];
    const malformed: string[] = [];
    for (const c of found) {
      let ok = false;
      try {
        ok = Array.isArray(JSON.parse(c.tags));
      } catch {
        ok = false;
      }
      (ok ? valid : malformed).push(c.id);
    }

    const changed = await this.prisma.$transaction(
      async (tx) => {
        const touched = new Set<string>();
        const collect = (rows: { id: string }[]) => rows.forEach((r) => touched.add(r.id));
        if (valid.length) {
          for (const name of remove) {
            collect(
              await tx.$queryRaw<{ id: string }[]>`
                UPDATE "Contact"
                SET "tags" = (
                  SELECT COALESCE(jsonb_agg(t.e ORDER BY t.i), '[]'::jsonb)::text
                  FROM jsonb_array_elements("tags"::jsonb) WITH ORDINALITY AS t(e, i)
                  WHERE t.e <> to_jsonb(${name}::text)
                )
                WHERE "id" = ANY(${valid}::text[]) AND "workspaceId" = ${workspaceId}
                  AND CASE WHEN "id" = ANY(${valid}::text[]) THEN ("tags"::jsonb ? ${name}) ELSE false END
                RETURNING "id"
              `,
            );
          }
          for (const name of add) {
            collect(
              await tx.$queryRaw<{ id: string }[]>`
                UPDATE "Contact"
                SET "tags" = ("tags"::jsonb || jsonb_build_array(${name}::text))::text
                WHERE "id" = ANY(${valid}::text[]) AND "workspaceId" = ${workspaceId}
                  AND CASE WHEN "id" = ANY(${valid}::text[]) THEN NOT ("tags"::jsonb ? ${name}) ELSE false END
                RETURNING "id"
              `,
            );
          }
        }
        let resetCount = 0;
        if (malformed.length && add.length) {
          const r = await tx.contact.updateMany({
            where: { workspaceId, id: { in: malformed } },
            data: { tags: JSON.stringify(add) },
          });
          resetCount = r.count;
        }
        return touched.size + resetCount;
      },
      { timeout: 30000 },
    );
    return { contactsUpdated: changed };
  }
}

@Controller("tags")
class TagsController {
  constructor(private readonly svc: TagsService) {}

  @Get()
  list(@CurrentWorkspace() workspaceId: string) {
    return this.svc.list(workspaceId);
  }

  @Post()
  create(@CurrentWorkspace() workspaceId: string, @Body() dto: CreateTagDto) {
    return this.svc.create(workspaceId, dto.name, dto.color);
  }

  @Patch(":id")
  update(
    @CurrentWorkspace() workspaceId: string,
    @Param("id") id: string,
    @Body() dto: UpdateTagDto,
  ) {
    return this.svc.update(workspaceId, id, dto);
  }

  @Delete(":id")
  remove(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) {
    return this.svc.remove(workspaceId, id);
  }

  @Post("merge")
  merge(@CurrentWorkspace() workspaceId: string, @Body() dto: MergeTagsDto) {
    return this.svc.merge(workspaceId, dto.fromIds, dto.intoId);
  }

  @Post("assign")
  assign(@CurrentWorkspace() workspaceId: string, @Body() dto: AssignTagsDto) {
    return this.svc.assign(workspaceId, dto);
  }
}

@Module({
  controllers: [TagsController],
  providers: [TagsService],
  exports: [TagsService],
})
export class TagsModule {}
