import { Injectable } from "@nestjs/common";
import { SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX, type KnowledgeKind, type TypedKind } from "./knowledge-constants";
import { isTypedKind, LKnowledge, toCrmKind } from "./l-knowledge";

/** The longest query sent to search. */
export const SEARCH_QUERY_MAX = 200;

export interface KnowledgeSearchResult {
  chunkId: string;
  sourceId: string;
  sourceTitle: string;
  kind: KnowledgeKind;
  heading: string | null;
  text: string;
  /** Website results: the page it came from. */
  url?: string;
}

interface LHit {
  chunkId: string;
  sourceId: string;
  sourceTitle: string;
  kind: string;
  heading: string | null;
  text: string;
  url?: string;
}

/**
 * Search the workspace's knowledge on l (ready sources, never guidelines,
 * expired offer rows left out). A workspace whose AI agent is off, or an
 * empty query, finds nothing.
 */
@Injectable()
export class KnowledgeSearchService {
  constructor(private readonly l: LKnowledge) {}

  async search(
    workspaceId: string,
    query: string,
    opts: { kind?: TypedKind; limit?: number } = {},
  ): Promise<KnowledgeSearchResult[]> {
    const q = String(query ?? "").trim().slice(0, SEARCH_QUERY_MAX);
    if (!q) return [];
    const t = await this.l.target(workspaceId);
    if (!t) return [];
    const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? SEARCH_LIMIT_DEFAULT)), SEARCH_LIMIT_MAX);
    const res = await this.l.call<{ items: LHit[] }>(t, "/search", {
      method: "POST",
      body: { q, limit, ...(isTypedKind(opts.kind) ? { template: opts.kind } : {}) },
      timeoutMs: 20_000,
    });
    return res.items.slice(0, limit).map((h) => ({
      chunkId: h.chunkId,
      sourceId: h.sourceId,
      sourceTitle: h.sourceTitle,
      kind: toCrmKind(h.kind),
      heading: h.heading ?? null,
      text: h.text,
      ...(h.url ? { url: h.url } : {}),
    }));
  }
}
