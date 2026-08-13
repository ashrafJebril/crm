import { Injectable, Logger } from "@nestjs/common";
import { ZernioService } from "../integrations/zernio.service";
import { PublishDto, PublishChannel, RescheduleDto } from "./social.dto";

export interface ChannelResult {
  ok: boolean;
  postId?: string;
  error?: string;
}

@Injectable()
export class SocialService {
  private readonly log = new Logger(SocialService.name);
  constructor(private readonly zernio: ZernioService) {}

  async publish(
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
        {
          content: dto.content,
          platforms: dto.channels,
          mediaIds: dto.mediaIds,
          scheduledFor: dto.scheduledFor,
          timezone: dto.timezone,
        },
        publicBaseUrl,
      );
      for (const ch of dto.channels) {
        results[ch] = { ok: true, postId: r.id ?? undefined };
      }
    } catch (e) {
      const msg = (e as { message?: string }).message ?? String(e);
      this.log.warn(`publish for ws=${workspaceId} failed: ${msg}`);
      for (const ch of dto.channels) {
        results[ch] = { ok: false, error: msg };
      }
    }
    return results;
  }

  listScheduled(workspaceId: string) {
    return this.zernio.listScheduledPosts(workspaceId);
  }

  cancelScheduled(workspaceId: string, postId: string) {
    return this.zernio.cancelScheduledPost(workspaceId, postId);
  }

  reschedule(workspaceId: string, postId: string, dto: RescheduleDto) {
    return this.zernio.reschedulePost(workspaceId, postId, dto.scheduledFor, dto.timezone);
  }
}
