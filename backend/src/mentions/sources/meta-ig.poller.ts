import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { Poller, RawMention } from "./poller.types";

interface IgMedia {
  id: string;
  caption?: string;
  permalink?: string;
  timestamp?: string;
  username?: string;
  like_count?: number;
  comments_count?: number;
}

interface IgHashtagSearchResp {
  data?: Array<{ id: string }>;
}

interface IgMediaListResp {
  data?: IgMedia[];
}

@Injectable()
export class MetaIgPoller implements Poller {
  readonly source = "ig-hashtag";
  private readonly logger = new Logger(MetaIgPoller.name);

  constructor(private readonly prisma: PrismaService) {}

  async fetchFor(keyword: { id: string; value: string; kind: string }): Promise<RawMention[]> {
    if (keyword.kind !== "hashtag") return [];

    const integration = await this.prisma.integration.findUnique({
      where: { platform: "instagram" },
    });
    if (!integration?.accessToken || !integration.pageId) {
      this.logger.warn("Instagram integration not connected — skipping IG poller");
      return [];
    }

    const v = process.env.META_GRAPH_VERSION ?? "v21.0";
    const igUserId = integration.pageId;
    const token = integration.accessToken;
    const tag = keyword.value.replace(/^#/, "");

    // 1) Resolve hashtag id
    const searchUrl = `https://graph.facebook.com/${v}/ig_hashtag_search?user_id=${igUserId}&q=${encodeURIComponent(tag)}&access_token=${token}`;
    let hashtagId: string | undefined;
    try {
      const resp = await fetch(searchUrl);
      if (!resp.ok) {
        this.logger.warn(`IG hashtag search ${resp.status} for #${tag}`);
        return [];
      }
      const body = (await resp.json()) as IgHashtagSearchResp;
      hashtagId = body.data?.[0]?.id;
    } catch (err) {
      this.logger.warn(`IG hashtag search failed: ${(err as Error).message}`);
      return [];
    }
    if (!hashtagId) return [];

    // 2) Pull recent media for that hashtag
    const fields = "id,caption,permalink,timestamp,username,like_count,comments_count";
    const mediaUrl = `https://graph.facebook.com/${v}/${hashtagId}/recent_media?user_id=${igUserId}&fields=${fields}&access_token=${token}`;
    try {
      const resp = await fetch(mediaUrl);
      if (!resp.ok) {
        this.logger.warn(`IG recent_media ${resp.status} for #${tag}`);
        return [];
      }
      const body = (await resp.json()) as IgMediaListResp;
      return (body.data ?? []).flatMap<RawMention>((m) => {
        if (!m.id) return [];
        return [
          {
            source: this.source,
            externalId: m.id,
            sourceUrl: m.permalink ?? null,
            author: m.username ?? "instagram_user",
            authorHandle: m.username ? `@${m.username}` : null,
            authorReach: m.like_count ?? null,
            body: m.caption ?? "",
            postedAt: m.timestamp ? new Date(m.timestamp) : null,
            raw: m,
          },
        ];
      });
    } catch (err) {
      this.logger.warn(`IG recent_media failed: ${(err as Error).message}`);
      return [];
    }
  }
}
