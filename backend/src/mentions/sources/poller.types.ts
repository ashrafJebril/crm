export interface RawMention {
  source: string;        // "google" | "ig-hashtag" | "fb-page"
  externalId: string;    // unique within source
  sourceUrl: string | null;
  author: string;
  authorHandle: string | null;
  authorReach: number | null;
  body: string;
  postedAt: Date | null;
  raw: unknown;
}

export interface Poller {
  readonly source: string;
  /** Fetch new mentions for one keyword. Returns RawMentions; dedup happens upstream. */
  fetchFor(keyword: { id: string; value: string; kind: string }): Promise<RawMention[]>;
}
