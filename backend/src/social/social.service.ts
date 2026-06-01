import { Injectable, Logger } from "@nestjs/common";
import { FacebookService } from "../integrations/facebook.service";
import { InstagramService } from "../integrations/instagram.service";
import { PublishDto, PublishChannel } from "./social.dto";

export interface ChannelResult {
  ok: boolean;
  postId?: string;
  error?: string;
}

@Injectable()
export class SocialService {
  private readonly log = new Logger(SocialService.name);
  constructor(
    private readonly fb: FacebookService,
    private readonly ig: InstagramService,
  ) {}

  async publishNow(
    workspaceId: string,
    dto: PublishDto,
    publicBaseUrl: string,
  ): Promise<Record<PublishChannel, ChannelResult>> {
    // Fan out to each channel concurrently. Each channel's failure is
    // captured per-channel; we never short-circuit the others.
    const tasks = dto.channels.map(async (ch): Promise<[PublishChannel, ChannelResult]> => {
      try {
        if (ch === "facebook") {
          const r = await this.fb.publishToPage(workspaceId, {
            content: dto.content,
            mediaIds: dto.mediaIds,
          });
          return [ch, { ok: true, postId: r.id }];
        }
        if (ch === "instagram") {
          const r = await this.ig.publish(
            workspaceId,
            { content: dto.content, mediaIds: dto.mediaIds },
            publicBaseUrl,
          );
          return [ch, { ok: true, postId: r.id }];
        }
        return [ch, { ok: false, error: `Unknown channel: ${ch as string}` }];
      } catch (e) {
        const msg = (e as { message?: string }).message ?? String(e);
        this.log.warn(`publishNow ${ch} for ws=${workspaceId} failed: ${msg}`);
        return [ch, { ok: false, error: msg }];
      }
    });

    const settled = await Promise.all(tasks);
    return Object.fromEntries(settled) as Record<PublishChannel, ChannelResult>;
  }
}
