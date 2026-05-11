import { Injectable, Logger } from "@nestjs/common";
import { Poller, RawMention } from "./poller.types";

interface CseItem {
  link?: string;
  title?: string;
  snippet?: string;
  displayLink?: string;
  cacheId?: string;
}

interface CseResponse {
  items?: CseItem[];
}

@Injectable()
export class GoogleCsePoller implements Poller {
  readonly source = "google";
  private readonly logger = new Logger(GoogleCsePoller.name);

  async fetchFor(keyword: { id: string; value: string; kind: string }): Promise<RawMention[]> {
    const key = process.env.GOOGLE_CSE_KEY;
    const cx = process.env.GOOGLE_CSE_CX;
    if (!key || !cx) {
      this.logger.warn("GOOGLE_CSE_KEY or GOOGLE_CSE_CX not set — skipping Google poller");
      return [];
    }
    if (keyword.kind === "hashtag") return []; // hashtags belong to IG poller

    const query = encodeURIComponent(`"${keyword.value}"`);
    const url = `https://www.googleapis.com/customsearch/v1?key=${key}&cx=${cx}&q=${query}&num=10&dateRestrict=d7`;
    let body: CseResponse;
    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        this.logger.warn(`Google CSE returned ${resp.status} for "${keyword.value}"`);
        return [];
      }
      body = (await resp.json()) as CseResponse;
    } catch (err) {
      this.logger.warn(`Google CSE fetch failed: ${(err as Error).message}`);
      return [];
    }
    return (body.items ?? []).flatMap<RawMention>((it) => {
      if (!it.link) return [];
      return [
        {
          source: this.source,
          externalId: it.cacheId ?? it.link,
          sourceUrl: it.link,
          author: it.displayLink ?? "web",
          authorHandle: null,
          authorReach: null,
          body: `${it.title ?? ""} — ${it.snippet ?? ""}`.trim(),
          postedAt: null,
          raw: it,
        },
      ];
    });
  }
}
