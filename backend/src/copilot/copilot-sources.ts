/**
 * SP-18 source cards: the records and knowledge sources an answer used.
 * Tools add a record only after it was read through RecordsService as the
 * member (so a card never names a record the member cannot open); knowledge
 * sources come from `search_knowledge` results. Deduped, ≤ SOURCES_MAX,
 * emitted once before `done`. Only http(s) URLs are kept.
 */
import { SOURCES_MAX } from "./copilot-constants";

export type SourceCard =
  | { kind: "record"; recordKind: string; id: string; title: string }
  | { kind: "knowledge"; sourceId: string; title: string; url?: string };

function httpUrl(u: unknown): string | undefined {
  if (typeof u !== "string") return undefined;
  try {
    const p = new URL(u);
    return p.protocol === "https:" || p.protocol === "http:" ? p.toString() : undefined;
  } catch {
    return undefined;
  }
}

export class SourceCollector {
  private readonly items = new Map<string, SourceCard>();

  /** A record the member just opened through RecordsService. */
  record(recordKind: string, id: string, title: string): void {
    this.add(`record:${recordKind}:${id}`, { kind: "record", recordKind, id, title: String(title ?? "").slice(0, 200) });
  }

  knowledge(sourceId: string, title: string, url?: unknown): void {
    const u = httpUrl(url);
    this.add(`knowledge:${sourceId}`, { kind: "knowledge", sourceId, title: String(title ?? "").slice(0, 200), ...(u ? { url: u } : {}) });
  }

  private add(key: string, card: SourceCard): void {
    if (this.items.has(key) || this.items.size >= SOURCES_MAX) return;
    this.items.set(key, card);
  }

  list(): SourceCard[] {
    return [...this.items.values()];
  }
}
