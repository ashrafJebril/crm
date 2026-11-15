import { HttpException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { fieldWhere } from "../custom-fields/custom-fields.service";
import { compileAudience, type CompileResult } from "./audience-compiler";
import { assertExpansionWithinLimit, assertNoCycle, assertReferenceDepth } from "./audience-cycles";
import {
  countTimeoutMs,
  countTtlMs,
  countWithTimeout,
  listDeadlineMs,
  mapLimit,
  withStatementTimeout,
  writeCountCache,
  type TimedPrisma,
} from "./audience-count";
import { toAudienceRow, type AudienceRow } from "./audience-dto";
import { audienceError, audienceNotFound } from "./audience-errors";
import { assertReferencesExist, emptyLookups, loadLookups, type AudienceLookups, type LookupsPrisma } from "./audience-lookups";
import { audienceRefs, findReferencingAudiences, writeMarkedAudiences, type MarkingClient } from "./audience-marking";
import {
  LEGACY_SENTINEL,
  legacyProjection,
  legacyToTree,
  parseLegacyFilter,
  readRules,
  referencedIds,
  validateRules,
  walkRules,
  type AudienceRules,
  type RuleIssue,
  type SegmentFilter,
} from "./audience-rules";

export type { SegmentFilter } from "./audience-rules";

/** Concurrency of stale-count recomputes on `GET /segments` (ruling 10). */
export const LIST_COUNT_CONCURRENCY = 3;
/** `GET /segments/:id/count` recomputes when the cached count is older than this. */
export const COUNT_ROUTE_FRESH_MS = 10_000;
export const PAGE_LIMIT_DEFAULT = 50;
export const PAGE_LIMIT_MAX = 100;
export const PREVIEW_SAMPLE = 5;

/**
 * Ruling 7: a campaign in one of these states may still read its audience,
 * so the audience cannot be deleted at all (no `confirm` override):
 * `scheduled`, `launching` (the SP-13 background job) or `running`, or a
 * launch stage of `planning` / `sending`.
 */
export const LIVE_CAMPAIGN_STATUSES = ["scheduled", "launching", "running"];
export const LIVE_LAUNCH_STAGES = ["planning", "sending"];

export function isLiveCampaign(c: { status: string; launchStage?: string | null }): boolean {
  return LIVE_CAMPAIGN_STATUSES.includes(c.status) || (!!c.launchStage && LIVE_LAUNCH_STAGES.includes(c.launchStage));
}

export interface SaveAudienceInput {
  name?: string;
  nameAr?: string | null;
  color?: string | null;
  origin?: "crm" | "manual";
  filter?: SegmentFilter;
  rules?: unknown;
}

export interface PreviewInput {
  filter?: SegmentFilter;
  rules?: unknown;
  excludeId?: string;
}

export interface PageQuery {
  after?: string;
  q?: string;
  limit?: number | string;
}

export interface ContactPage {
  items: { id: string; name: string; phone: string | null; email: string | null; lifecycle: string }[];
  nextCursor: string | null;
  timedOut: boolean;
}

type SegmentRow = {
  id: string;
  workspaceId: string;
  name: string;
  nameAr: string | null;
  color: string | null;
  origin: string;
  filter: string;
  rules: unknown;
  version: number;
  memberCount: number | null;
  countedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function pageLimit(raw: number | string | undefined): number {
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : raw;
  if (n === undefined || !Number.isFinite(n)) return PAGE_LIMIT_DEFAULT;
  return Math.min(PAGE_LIMIT_MAX, Math.max(1, Math.floor(n)));
}

/** The contacts-list search (name, phone, email), as `buildContactWhere` does it. */
function searchClause(q: string | undefined): Prisma.ContactWhereInput | null {
  const t = typeof q === "string" ? q.trim() : "";
  if (!t) return null;
  return {
    OR: [
      { name: { contains: t, mode: "insensitive" } },
      { phone: { contains: t } },
      { email: { contains: t, mode: "insensitive" } },
    ],
  };
}

@Injectable()
export class SegmentsService {
  constructor(private readonly prisma: PrismaService) {}

  private get lookupsPrisma(): LookupsPrisma {
    return this.prisma as unknown as LookupsPrisma;
  }

  private get timed(): TimedPrisma {
    return this.prisma as unknown as TimedPrisma;
  }

  // ─── Legacy surface (kept for existing callers) ──────────────────────

  /**
   * Legacy filter → Prisma where. A thin wrapper over the SP-16 compiler
   * (`compileAudience(legacyToTree(f))`); legacy keys reference nothing, so no
   * lookups are needed.
   */
  buildWhere(workspaceId: string, f: SegmentFilter): Prisma.ContactWhereInput {
    return compileAudience(workspaceId, legacyToTree(f), { now: new Date(), tz: "UTC", lookups: emptyLookups() }).where;
  }

  async countByFilter(workspaceId: string, filter: SegmentFilter): Promise<number> {
    return this.prisma.contact.count({ where: this.buildWhere(workspaceId, filter) });
  }

  parseFilter(raw: string): SegmentFilter {
    return parseLegacyFilter(raw);
  }

  async getFilter(workspaceId: string, segmentId: string): Promise<SegmentFilter> {
    const row = await this.prisma.segment.findFirst({ where: { id: segmentId, workspaceId } });
    if (!row) throw audienceNotFound();
    return this.parseFilter(row.filter);
  }

  // ─── Resolution ──────────────────────────────────────────────────────

  /**
   * Resolve a saved segment to the Prisma `where` that selects its audience.
   *
   * Origin decides the resolution strategy and it is NOT optional:
   *  - `crm`    → its rule tree (`rules`, or the legacy `filter` read as one
   *               `and` group), compiled live with relative windows anchored
   *               at `opts.now` (one `now` per request or per launch).
   *  - `manual` → materialized membership (SegmentMember rows the user picked).
   *  - `hjz`    → materialized membership (HJZ ships the resolved client list).
   * Non-crm segments carry an inert `filter` ("{}"), and an empty filter means
   * "the entire workspace", so they must never be compiled. Every audience
   * consumer (contacts list, bulk, export, HJZ outbound, campaigns) goes through here.
   * Unknown or foreign id: 404 `audiences.not_found` (a NotFoundException).
   */
  async resolveContactWhere(
    workspaceId: string,
    segmentId: string,
    opts: { now?: Date } = {},
  ): Promise<Prisma.ContactWhereInput> {
    const row = await this.prisma.segment.findFirst({ where: { id: segmentId, workspaceId } });
    if (!row) throw audienceNotFound();
    if (row.origin !== "crm") {
      return { workspaceId, segmentMembers: { some: { segmentId } } };
    }
    const { tree } = readRules(row);
    return (await this.compile(workspaceId, tree, { now: opts.now, selfId: row.id })).where;
  }

  /** Load lookups for `tree` (and the audiences it references) and compile it. */
  async compile(
    workspaceId: string,
    tree: AudienceRules,
    opts: { now?: Date; selfId?: string | null; lookups?: AudienceLookups } = {},
  ): Promise<CompileResult & { lookups: AudienceLookups }> {
    const lookups = opts.lookups ?? (await loadLookups(this.lookupsPrisma, workspaceId, [tree]));
    const res = compileAudience(workspaceId, tree, {
      now: opts.now ?? new Date(),
      tz: lookups.timezone,
      lookups,
      visited: new Set(opts.selfId ? [opts.selfId] : []),
      depth: 0,
    });
    return { ...res, lookups };
  }

  // ─── Reads ───────────────────────────────────────────────────────────

  private async findRow(workspaceId: string, id: string): Promise<SegmentRow> {
    const row = (await this.prisma.segment.findFirst({ where: { id, workspaceId } })) as SegmentRow | null;
    if (!row) throw audienceNotFound();
    return row;
  }

  /**
   * `GET /segments`: every row. Counts are served from the cache when
   * `countedAt` is fresh (a cached `null` is a recent timeout: "too large to
   * count right now"); stale ones are recomputed 3 at a time under ONE
   * overall deadline (fix I1). After the deadline a row keeps its stale count
   * or answers `count: null, timedOut: true`; `GET /segments/:id/count` fills it in.
   */
  async listRows(workspaceId: string, opts: { now?: Date } = {}): Promise<AudienceRow[]> {
    const now = opts.now ?? new Date();
    const rows = (await this.prisma.segment.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "asc" },
    })) as SegmentRow[];
    const smart = rows.filter((r) => r.origin === "crm");
    const trees = new Map(smart.map((r) => [r.id, readRules(r).tree]));
    const lookups = smart.length ? await loadLookups(this.lookupsPrisma, workspaceId, [...trees.values()]) : emptyLookups();
    const ttl = countTtlMs();
    const ms = countTimeoutMs();
    const deadline = Date.now() + listDeadlineMs();

    return mapLimit(rows, LIST_COUNT_CONCURRENCY, async (row) => {
      if (row.origin !== "crm") {
        const count = await this.prisma.segmentMember.count({ where: { segmentId: row.id } });
        return toAudienceRow(row, { count });
      }
      const compiled = await this.compile(workspaceId, trees.get(row.id)!, { now, selfId: row.id, lookups });
      const fresh = row.countedAt && now.getTime() - new Date(row.countedAt).getTime() < ttl;
      if (fresh) {
        return toAudienceRow(row, {
          count: row.memberCount,
          countedAt: row.countedAt,
          timedOut: row.memberCount === null,
          issues: compiled.issues,
        });
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        // Out of time for this request: keep a stale count if there is one, never block.
        return row.memberCount !== null
          ? toAudienceRow(row, { count: row.memberCount, countedAt: row.countedAt, issues: compiled.issues })
          : toAudienceRow(row, { count: null, timedOut: true, issues: compiled.issues });
      }
      const budget = Math.min(ms, remaining);
      const r = await countWithTimeout(this.timed, compiled.where, budget);
      // A full-length timeout is cached as null (retried after the TTL); one cut short by the deadline is not.
      if (r.count !== null || budget === ms) await writeCountCache(this.prisma, workspaceId, row.id, r.count, now);
      return toAudienceRow(row, {
        count: r.count,
        countedAt: r.count !== null || budget === ms ? now : null,
        timedOut: r.timedOut,
        issues: compiled.issues,
      });
    });
  }

  /** The smart audiences whose (non-missing) `group` rules name `id`, and the campaigns that use it. */
  async references(workspaceId: string, id: string) {
    const [smart, campaigns] = await Promise.all([
      this.prisma.segment.findMany({
        where: { workspaceId, origin: "crm" },
        select: { id: true, name: true, nameAr: true, rules: true, filter: true },
        orderBy: { createdAt: "asc" },
      }),
      this.prisma.campaign.findMany({
        where: { workspaceId, segmentId: id },
        select: { id: true, name: true, status: true },
        orderBy: { createdAt: "asc" },
      }),
    ]);
    const audiences = smart
      .filter((s) => s.id !== id && referencedIds(readRules(s).tree).segmentIds.includes(id))
      .map((s) => ({ id: s.id, name: s.name, nameAr: s.nameAr }));
    return { audiences, campaigns };
  }

  /**
   * `DELETE /segments/:id` (ruling 7), ONE transaction:
   * 1. the workspace audience lock (as `save`), then the row (404; an hjz
   *    row keeps its pre-SP-16 404 text);
   * 2. a campaign that may still read the audience (`isLiveCampaign`) → 409
   *    `audiences.in_use_by_campaigns {campaigns}`, even with `confirm`;
   * 3. other references (smart audiences with a `group` rule naming it, any
   *    other campaign) without `confirm` → 409 `audiences.in_use {audiences, campaigns}`;
   * 4. the referencing `group` rules are marked `missing` (issue
   *    `group_missing`, nobody, for `in` and `not_in`), and the row is deleted.
   * Draft campaigns keep their dangling `segmentId`; their preview and launch
   * then refuse with `campaigns.audience_missing`. Nothing is written on a 409.
   */
  async remove(workspaceId: string, id: string, opts: { confirm?: boolean } = {}): Promise<{ ok: true; audiencesMarked: number }> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"sp16:audiences:" + workspaceId}))`;
        const row = (await tx.segment.findFirst({ where: { id, workspaceId } })) as SegmentRow | null;
        if (!row) throw audienceNotFound();
        if (row.origin === "hjz") throw new NotFoundException("Segment is managed by HJZ and read-only here");
        const campaignRows = (await tx.campaign.findMany({
          where: { workspaceId, segmentId: id },
          select: { id: true, name: true, status: true, launchStage: true },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        })) as Array<{ id: string; name: string; status: string; launchStage: string | null }>;
        const campaigns = campaignRows.map((c) => ({ id: c.id, name: c.name, status: c.status }));
        const live = campaignRows.filter(isLiveCampaign).map((c) => ({ id: c.id, name: c.name, status: c.status }));
        if (live.length) throw audienceError("audiences.in_use_by_campaigns", { campaigns: live });
        const client = tx as unknown as MarkingClient;
        const refs = await findReferencingAudiences(client, workspaceId, (r) => r.field === "group" && r.segmentId === id, { excludeId: id });
        if ((refs.length || campaigns.length) && !opts.confirm) {
          throw audienceError("audiences.in_use", { audiences: audienceRefs(refs), campaigns });
        }
        const audiencesMarked = await writeMarkedAudiences(client, workspaceId, refs);
        await tx.segment.delete({ where: { id } });
        return { ok: true as const, audiencesMarked };
      },
      { timeout: 20_000, maxWait: 10_000 },
    );
  }

  /** `GET /segments/:id`: the row (with a fresh-or-cached count) plus what uses it. */
  async detail(workspaceId: string, id: string, opts: { now?: Date } = {}) {
    const row = await this.findRow(workspaceId, id);
    const now = opts.now ?? new Date();
    const [counted, references] = await Promise.all([
      this.countRow(workspaceId, row, now, countTtlMs()),
      this.references(workspaceId, id),
    ]);
    return { ...toAudienceRow(row, counted), references };
  }

  /** `GET /segments/:id/count`: recompute when the cache is older than 10 s. */
  async count(workspaceId: string, id: string, opts: { now?: Date } = {}) {
    const row = await this.findRow(workspaceId, id);
    const c = await this.countRow(workspaceId, row, opts.now ?? new Date(), COUNT_ROUTE_FRESH_MS);
    return { count: c.count, countedAt: c.countedAt ? c.countedAt.toISOString() : null, timedOut: c.timedOut };
  }

  private async countRow(
    workspaceId: string,
    row: SegmentRow,
    now: Date,
    freshMs: number,
  ): Promise<{ count: number | null; countedAt: Date | null; timedOut: boolean; issues: RuleIssue[] }> {
    if (row.origin !== "crm") {
      const count = await this.prisma.segmentMember.count({ where: { segmentId: row.id } });
      return { count, countedAt: now, timedOut: false, issues: [] };
    }
    const compiled = await this.compile(workspaceId, readRules(row).tree, { now, selfId: row.id });
    if (row.countedAt && now.getTime() - new Date(row.countedAt).getTime() < freshMs) {
      // A cached null is a recent timeout (fix I1).
      return { count: row.memberCount, countedAt: new Date(row.countedAt), timedOut: row.memberCount === null, issues: compiled.issues };
    }
    const r = await countWithTimeout(this.timed, compiled.where);
    await writeCountCache(this.prisma, workspaceId, row.id, r.count, now);
    return { count: r.count, countedAt: now, timedOut: r.timedOut, issues: compiled.issues };
  }

  /** Keyset page over `audienceWhere` (never `skip`), under the statement timeout. */
  private async keysetPage(workspaceId: string, audienceWhere: Prisma.ContactWhereInput, query: PageQuery): Promise<ContactPage> {
    const limit = pageLimit(query.limit);
    const and: Prisma.ContactWhereInput[] = [audienceWhere];
    const after = typeof query.after === "string" && query.after ? query.after : null;
    if (after) and.push({ id: { gt: after } });
    const q = searchClause(query.q);
    if (q) and.push(q);
    const r = await withStatementTimeout(this.timed, countTimeoutMs(), (tx) =>
      tx.contact.findMany({
        where: { workspaceId, AND: and },
        orderBy: { id: "asc" },
        take: limit + 1,
        select: { id: true, name: true, phone: true, email: true, lifecycle: true },
      }),
    );
    if (r.timedOut) return { items: [], nextCursor: null, timedOut: true };
    const rows = r.value as ContactPage["items"];
    const items = rows.slice(0, limit);
    return { items, nextCursor: rows.length > limit ? items[items.length - 1].id : null, timedOut: false };
  }

  /** `GET /segments/:id/contacts`: members of any origin, keyset by id. */
  async pageContacts(workspaceId: string, id: string, query: PageQuery = {}, opts: { now?: Date } = {}): Promise<ContactPage> {
    const where = await this.resolveContactWhere(workspaceId, id, opts);
    return this.keysetPage(workspaceId, where, query);
  }

  /** `GET /segments/:id/candidates`: workspace contacts not yet in a manual group. */
  async candidates(workspaceId: string, id: string, query: PageQuery = {}): Promise<ContactPage> {
    const row = await this.findRow(workspaceId, id);
    if (row.origin !== "manual") throw audienceError("audiences.not_manual");
    return this.keysetPage(workspaceId, { workspaceId, segmentMembers: { none: { segmentId: id } } }, query);
  }

  // ─── Preview and save ────────────────────────────────────────────────

  /**
   * Validate a client tree against the workspace: references (404), custom
   * field values (SP-02's 400), cycles through `selfId` (400), the reference
   * chain depth (400 `invalid_rules` / `too_deep`, fix I2) and the expansion cap (400). Returns the lookups for compiling it.
   */
  private async checkTree(
    client: LookupsPrisma,
    workspaceId: string,
    tree: AudienceRules,
    selfId: string | null,
  ): Promise<AudienceLookups> {
    const lookups = await loadLookups(client, workspaceId, [tree]);
    assertReferencesExist(lookups, referencedIds(tree));
    walkRules(tree, (r) => {
      if (r.field !== "custom_field" || r.missing) return;
      const def = lookups.defs.get(r.defId);
      if (def && !def.archivedAt) fieldWhere(def, r.op, r.value); // throws SP-02's 400 for a bad op or value
    });
    const loadSmart = async (ids: string[]) => {
      const rows = (await client.segment.findMany({
        where: { workspaceId, id: { in: ids }, origin: "crm" },
        select: { id: true, origin: true, rules: true, filter: true },
      })) as Array<{ id: string; rules: unknown; filter: string }>;
      return new Map(rows.map((r) => [r.id, readRules(r).tree]));
    };
    const walk = await assertNoCycle(workspaceId, selfId, tree, loadSmart, lookups.segments);
    assertReferenceDepth(tree, walk);
    assertExpansionWithinLimit(tree, walk.trees);
    return lookups;
  }

  /** `POST /segments/preview`: count, up to 5 newest contacts and the issues. Writes nothing. */
  async preview(workspaceId: string, body: PreviewInput, opts: { now?: Date } = {}) {
    if (body.filter !== undefined && body.rules !== undefined) {
      throw audienceError("audiences.invalid_rules", { path: [], reason: "filter_and_rules" });
    }
    const now = opts.now ?? new Date();
    let selfId: string | null = null;
    if (body.excludeId) selfId = (await this.findRow(workspaceId, body.excludeId)).id;
    let compiled: CompileResult;
    if (body.rules !== undefined) {
      const tree = validateRules(body.rules);
      const lookups = await this.checkTree(this.lookupsPrisma, workspaceId, tree, selfId);
      compiled = await this.compile(workspaceId, tree, { now, selfId, lookups });
    } else {
      compiled = await this.compile(workspaceId, legacyToTree(body.filter ?? {}), { now, selfId });
    }
    const r = await withStatementTimeout(this.timed, countTimeoutMs(), async (tx) => {
      const count = await tx.contact.count({ where: compiled.where });
      const sample = await tx.contact.findMany({
        where: compiled.where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: PREVIEW_SAMPLE,
        select: { id: true, name: true, phone: true },
      });
      return { count, sample: sample as { id: string; name: string; phone: string | null }[] };
    });
    if (r.timedOut) return { count: null, timedOut: true, sample: [], issues: compiled.issues };
    return { count: r.value.count, timedOut: false, sample: r.value.sample, issues: compiled.issues };
  }

  /**
   * Create (`id` absent) or update an audience in ONE transaction:
   * workspace advisory lock (first statement) → load row → validate →
   * references (404) → custom-field values (400) → cycles and expansion
   * (400) → version (409) → write `rules`, `filter` (projection or
   * sentinel) and `version + 1`.
   *
   * A legacy `filter` (older clients) is written only to rows without
   * `rules`; on a v2 row it is ignored (ruling 2: rules win, never widen).
   */
  async save(
    workspaceId: string,
    input: SaveAudienceInput,
    opts: { id?: string; version?: number; now?: Date } = {},
  ): Promise<AudienceRow> {
    if (input.filter !== undefined && input.rules !== undefined) {
      throw audienceError("audiences.invalid_rules", { path: [], reason: "filter_and_rules" });
    }
    const now = opts.now ?? new Date();
    const result = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"sp16:audiences:" + workspaceId}))`;
        let existing: SegmentRow | null = null;
        if (opts.id) {
          existing = (await tx.segment.findFirst({ where: { id: opts.id, workspaceId } })) as SegmentRow | null;
          if (!existing) throw audienceNotFound();
          if (existing.origin === "hjz") throw new NotFoundException("Segment is managed by HJZ and read-only here");
        }
        const origin = existing ? existing.origin : (input.origin ?? "crm");
        if (input.rules !== undefined && origin !== "crm") throw audienceError("audiences.not_smart");

        let tree: AudienceRules | null = null;
        let lookups: AudienceLookups | null = null;
        if (input.rules !== undefined) {
          tree = validateRules(input.rules);
          lookups = await this.checkTree(tx as unknown as LookupsPrisma, workspaceId, tree, opts.id ?? null);
        }

        if (existing && opts.version !== undefined && opts.version !== existing.version) {
          const current = toAudienceRow(existing, { count: existing.memberCount, countedAt: existing.countedAt });
          throw audienceError("audiences.version_conflict", { current });
        }

        const data: Record<string, unknown> = {};
        if (input.name !== undefined) data.name = input.name;
        if (input.nameAr !== undefined) data.nameAr = input.nameAr ?? null;
        if (input.color !== undefined) data.color = input.color ?? null;
        if (tree) {
          data.rules = tree as unknown as Prisma.InputJsonValue;
          data.filter = JSON.stringify(legacyProjection(tree) ?? LEGACY_SENTINEL);
          data.memberCount = null;
          data.countedAt = null;
        } else if (input.filter !== undefined) {
          // Ruling 2: on a row that already has `rules`, the rules win and `filter`
          // keeps their projection or the sentinel. An older client's form (which
          // cannot show a v2 tree) must never turn it into `{}`, the whole workspace.
          const hasRules = !!existing && origin === "crm" && readRules(existing).source === "rules";
          if (!hasRules) {
            data.filter = JSON.stringify(input.filter);
            if (origin === "crm") {
              data.memberCount = null;
              data.countedAt = null;
            }
          }
        }

        let row: SegmentRow;
        if (existing) {
          row = (await tx.segment.update({
            where: { id: existing.id },
            data: { ...data, version: { increment: 1 } } as Prisma.SegmentUpdateInput,
          })) as SegmentRow;
        } else {
          row = (await tx.segment.create({
            data: {
              workspaceId,
              name: input.name ?? "",
              nameAr: input.nameAr ?? null,
              color: input.color ?? null,
              origin,
              filter: (data.filter as string | undefined) ?? "{}",
              ...(tree ? { rules: tree as unknown as Prisma.InputJsonValue } : {}),
            },
          })) as SegmentRow;
        }
        return { row, tree, lookups };
      },
      { timeout: 20_000, maxWait: 10_000 },
    );

    let issues: RuleIssue[] = [];
    if (result.row.origin === "crm") {
      const tree = result.tree ?? readRules(result.row).tree;
      issues = (await this.compile(workspaceId, tree, { now, selfId: result.row.id, lookups: result.lookups ?? undefined })).issues;
    }
    return toAudienceRow(result.row, { issues });
  }
}

/** True when `e` is an audience HttpException carrying `key`. */
export function isAudienceError(e: unknown, key: string): boolean {
  if (!(e instanceof HttpException)) return false;
  const r = e.getResponse() as { message?: unknown };
  return typeof r === "object" && r !== null && r.message === key;
}
