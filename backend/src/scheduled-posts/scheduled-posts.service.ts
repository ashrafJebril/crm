import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { SocialService } from "../social/social.service";
import { CreateScheduledPostDto } from "./scheduled-posts.dto";

@Injectable()
export class ScheduledPostsService {
  private readonly log = new Logger(ScheduledPostsService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly social: SocialService,
  ) {}

  async create(workspaceId: string, userId: string | null, dto: CreateScheduledPostDto) {
    const scheduledFor = new Date(dto.scheduledFor);
    if (Number.isNaN(scheduledFor.getTime())) {
      throw new BadRequestException("Invalid scheduledFor");
    }
    return this.prisma.scheduledPost.create({
      data: {
        workspaceId,
        createdById: userId,
        content: dto.content,
        mediaIds: JSON.stringify(dto.mediaIds ?? []),
        channels: JSON.stringify(dto.channels),
        scheduledFor,
        status: "pending",
      },
    });
  }

  async list(workspaceId: string, status?: string) {
    return this.prisma.scheduledPost.findMany({
      where: { workspaceId, ...(status ? { status } : {}) },
      orderBy: { scheduledFor: "asc" },
      take: 200,
    });
  }

  async cancel(workspaceId: string, id: string) {
    const row = await this.prisma.scheduledPost.findFirst({
      where: { id, workspaceId },
    });
    if (!row) throw new NotFoundException("Scheduled post not found");
    if (row.status !== "pending") {
      throw new BadRequestException(`Cannot cancel a post in status "${row.status}"`);
    }
    return this.prisma.scheduledPost.update({
      where: { id: row.id },
      data: { status: "canceled" },
    });
  }

  /**
   * Run one tick: claim every pending post whose scheduledFor <= now,
   * mark it publishing, fan out via SocialService, write results.
   * Called by the scheduler cron AND exposed via an internal admin endpoint
   * for manual triggering during testing.
   */
  async runTick(publicBaseUrl: string): Promise<{ picked: number; published: number; failed: number }> {
    const due = await this.prisma.scheduledPost.findMany({
      where: {
        status: "pending",
        scheduledFor: { lte: new Date() },
      },
      take: 25, // batch cap per tick
    });
    let published = 0;
    let failed = 0;
    for (const post of due) {
      // Optimistic claim: only flip if still pending.
      const claimed = await this.prisma.scheduledPost.updateMany({
        where: { id: post.id, status: "pending" },
        data: { status: "publishing", attempts: { increment: 1 } },
      });
      if (claimed.count === 0) continue; // someone else got it

      const channels = JSON.parse(post.channels) as Array<"facebook" | "instagram">;
      const mediaIds = JSON.parse(post.mediaIds) as string[];
      const results = await this.social.publishNow(
        post.workspaceId,
        { content: post.content, mediaIds, channels },
        publicBaseUrl,
      );
      const anyOk = Object.values(results).some((r) => r.ok);
      await this.prisma.scheduledPost.update({
        where: { id: post.id },
        data: {
          status: anyOk ? "published" : "failed",
          results: JSON.stringify(results),
          publishedAt: anyOk ? new Date() : null,
          lastError: anyOk
            ? null
            : Object.entries(results)
                .filter(([, r]) => !r.ok)
                .map(([ch, r]) => `${ch}: ${r.error}`)
                .join("; "),
        },
      });
      if (anyOk) published += 1;
      else failed += 1;
    }
    if (due.length) {
      this.log.log(`Scheduled tick: picked=${due.length} published=${published} failed=${failed}`);
    }
    return { picked: due.length, published, failed };
  }
}
