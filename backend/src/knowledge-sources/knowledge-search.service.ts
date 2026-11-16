/**
 * SP-21 knowledge search (ruling 2/4): Postgres full-text search over
 * KnowledgeChunk, `simple` configuration (no stemming, so Arabic works as
 * typed). The text expression is exactly `to_tsvector('simple', c."text")`
 * so the migration's GIN index "KnowledgeChunk_fts_idx" is used. A one-word
 * Arabic query shorter than 3 letters (too short for useful FTS tokens) uses
 * an ILIKE fallback.
 *
 * Only `ready` sources of the given workspace are searched; offers whose
 * `validTo` is before today in the workspace's timezone are filtered out.
 * Results are reference data (Review Focus 3): callers wrap them in a notice.
 */
import { Inject, Injectable, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX, TYPED_KINDS, type KnowledgeKind, type TypedKind } from "./knowledge-constants";

export const SEARCH_QUERY_MAX = 200;

export interface KnowledgeSearchResult {
  chunkId: string;
  sourceId: string;
  sourceTitle: string;
  kind: KnowledgeKind;
  heading: string | null;
  text: string;
  /** Website pages (or the website source) only. */
  url?: string;
}

export interface SearchParams {
  workspaceId: string;
  q: string;
  kind?: TypedKind;
  limit: number;
  /** `YYYY-MM-DD`, today in the workspace timezone. */
  today: string;
  mode: "fts" | "ilike";
}

export interface SearchRow {
  chunkId: string;
  sourceId: string;
  sourceTitle: string;
  kind: string;
  heading: string | null;
  text: string;
  pageUrl: string | null;
  sourceUrl: string | null;
}

export type SearchRunner = (p: SearchParams) => Promise<SearchRow[]>;
/** Specs inject an in-memory runner (the test world approximates FTS by token match). */
export const KNOWLEDGE_SEARCH_RUNNER = Symbol("KNOWLEDGE_SEARCH_RUNNER");

const ARABIC_RE = /[؀-ۿ]/;

/** `YYYY-MM-DD` of `now` in `timeZone` (UTC when the zone is unknown). */
export function todayIn(timeZone: string | null | undefined, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** Collapse whitespace, cut to SEARCH_QUERY_MAX; FTS unless it is one Arabic word under 3 letters. */
export function normalizeQuery(q: string): { q: string; mode: "fts" | "ilike" } {
  const clean = String(q ?? "").replace(/\s+/g, " ").trim().slice(0, SEARCH_QUERY_MAX);
  const oneShortArabicWord = !clean.includes(" ") && ARABIC_RE.test(clean) && [...clean].length < 3;
  return { q: clean, mode: oneShortArabicWord ? "ilike" : "fts" };
}

/** `%`, `_` and `\` are literal in the ILIKE fallback. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** The search statement. Pure: the unit spec checks its text and values. */
export function buildSearchQuery(p: SearchParams): Prisma.Sql {
  const match =
    p.mode === "fts"
      ? Prisma.sql`to_tsvector('simple', c."text") @@ websearch_to_tsquery('simple', ${p.q})`
      : Prisma.sql`c."text" ILIKE ${`%${escapeLike(p.q)}%`}`;
  const rank =
    p.mode === "fts"
      ? Prisma.sql`ts_rank(to_tsvector('simple', c."text"), websearch_to_tsquery('simple', ${p.q}))`
      : Prisma.sql`0`;
  const kind = p.kind ? Prisma.sql`AND s."kind" = 'typed_doc' AND s."typedKind" = ${p.kind}` : Prisma.empty;
  return Prisma.sql`
    SELECT c."id" AS "chunkId", c."sourceId" AS "sourceId", s."title" AS "sourceTitle", s."kind" AS "kind",
           c."heading" AS "heading", c."text" AS "text", pg."url" AS "pageUrl", s."url" AS "sourceUrl"
    FROM "KnowledgeChunk" c
    JOIN "KnowledgeSource" s ON s."id" = c."sourceId" AND s."workspaceId" = ${p.workspaceId}
    LEFT JOIN "KnowledgePage" pg ON pg."id" = c."pageId"
    WHERE c."workspaceId" = ${p.workspaceId}
      AND s."status" = 'ready'
      AND ${match}
      AND (c."validTo" IS NULL OR c."validTo" >= ${p.today}::date)
      ${kind}
    ORDER BY ${rank} DESC, c."sourceId" ASC, c."ord" ASC
    LIMIT ${p.limit}`;
}

@Injectable()
export class KnowledgeSearchService {
  private readonly runner: SearchRunner;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(KNOWLEDGE_SEARCH_RUNNER) runner?: SearchRunner,
  ) {
    this.runner = runner ?? ((p) => this.prisma.$queryRaw<SearchRow[]>(buildSearchQuery(p)));
  }

  /**
   * Search the workspace's ready knowledge. `limit` 1..10 (default 5); `kind`
   * narrows to one typed-document kind. An empty query returns nothing.
   */
  async search(
    workspaceId: string,
    query: string,
    opts: { kind?: TypedKind; limit?: number; now?: Date } = {},
  ): Promise<KnowledgeSearchResult[]> {
    const { q, mode } = normalizeQuery(query);
    if (!q) return [];
    const kind = opts.kind && (TYPED_KINDS as readonly string[]).includes(opts.kind) ? opts.kind : undefined;
    const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? SEARCH_LIMIT_DEFAULT)), SEARCH_LIMIT_MAX);
    const ws = await this.prisma.workspace.findFirst({ where: { id: workspaceId }, select: { timezone: true } });
    if (!ws) return [];
    const rows = await this.runner({ workspaceId, q, kind, limit, today: todayIn(ws.timezone, opts.now), mode });
    return rows.slice(0, limit).map((r) => ({
      chunkId: r.chunkId,
      sourceId: r.sourceId,
      sourceTitle: r.sourceTitle,
      kind: r.kind as KnowledgeKind,
      heading: r.heading ?? null,
      text: r.text,
      ...(r.pageUrl || r.sourceUrl ? { url: (r.pageUrl ?? r.sourceUrl) as string } : {}),
    }));
  }
}
