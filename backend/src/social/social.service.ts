import { Injectable, Logger } from "@nestjs/common";
import { ZernioService } from "../integrations/zernio.service";
import { PublishDto, PublishChannel } from "./social.dto";

export interface ChannelResult {
  ok: boolean;
  postId?: string;
  error?: string;
}

@Injectable()
export class SocialService {
  private readonly log = new Logger(SocialService.name);
  constructor(private readonly zernio: ZernioService) {}

  async publishNow(
    workspaceId: string,
    dto: PublishDto,
    publicBaseUrl: string,
  ): Promise<Record<PublishChannel, ChannelResult>> {
    // Publishing now goes through Zernio (which fronts FB/IG/TikTok with its own
    // reviewed apps). One createPost call targets all requested platforms; we map
    // its outcome onto each channel so the frontend's per-channel result shape
    // is preserved. Per-platform delivery status arrives later via the
    // post.platform.* webhooks.
    const results = {} as Record<PublishChannel, ChannelResult>;
    try {
      const r = await this.zernio.publish(
        workspaceId,
        { content: dto.content, platforms: dto.channels, mediaIds: dto.mediaIds },
        publicBaseUrl,
      );
      for (const ch of dto.channels) {
        results[ch] = { ok: true, postId: r.id ?? undefined };
      }
    } catch (e) {
      const msg = (e as { message?: string }).message ?? String(e);
      this.log.warn(`publishNow for ws=${workspaceId} failed: ${msg}`);
      for (const ch of dto.channels) {
        results[ch] = { ok: false, error: msg };
      }
    }
    return results;
  }
}
