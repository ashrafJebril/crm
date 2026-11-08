import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import {
  MarkReadDto,
  NOTIFICATION_TYPES,
  NotifyInput,
  UpdatePreferencesDto,
} from "./notifications.dto";

const DEFAULT_LIMIT = 20;

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * Persist and push one notification per recipient. Dedupes ids, drops the
   * actor, honours inApp=false preferences. Never throws: a failed
   * notification must not fail the action that produced it.
   */
  async notify(
    workspaceId: string,
    userIds: string[],
    n: NotifyInput,
  ): Promise<number> {
    try {
      const ids = [...new Set(userIds)].filter((u) => !!u && u !== n.actorId);
      if (ids.length === 0) return 0;

      const prefs = await this.prisma.notificationPreference.findMany({
        where: { workspaceId, userId: { in: ids }, type: n.type },
      });
      const prefBy = new Map(prefs.map((p) => [p.userId, p]));
      const recipients = ids.filter((u) => prefBy.get(u)?.inApp !== false);
      if (recipients.length === 0) return 0;

      const createdAt = new Date();
      const rows = recipients.map((userId) => ({
        id: randomUUID(),
        workspaceId,
        userId,
        type: n.type,
        title: n.title,
        body: n.body ?? null,
        recordKind: n.recordKind ?? null,
        recordId: n.recordId ?? null,
        actorId: n.actorId ?? null,
        createdAt,
      }));
      const res = await this.prisma.notification.createMany({ data: rows });

      for (const r of rows) {
        this.realtime.emitToUser(workspaceId, r.userId, "notification:new", {
          id: r.id,
          type: r.type,
          title: r.title,
          body: r.body,
          recordKind: r.recordKind,
          recordId: r.recordId,
          createdAt: r.createdAt,
          sound: prefBy.get(r.userId)?.sound ?? true,
        });
      }
      return res.count;
    } catch (err) {
      this.logger.error(
        `notify failed ws=${workspaceId} type=${n?.type}: ${(err as Error)?.message}`,
      );
      return 0;
    }
  }

  async list(
    workspaceId: string,
    userId: string,
    cursor?: string,
    limit = DEFAULT_LIMIT,
  ) {
    const take = Math.min(Math.max(limit || DEFAULT_LIMIT, 1), 100);
    const rows = await this.prisma.notification.findMany({
      where: { workspaceId, userId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;
    return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
  }

  async unreadCount(workspaceId: string, userId: string) {
    const count = await this.prisma.notification.count({
      where: { workspaceId, userId, readAt: null },
    });
    return { count };
  }

  async markRead(workspaceId: string, userId: string, dto: MarkReadDto) {
    if (dto.all) {
      const res = await this.prisma.notification.updateMany({
        where: { workspaceId, userId, readAt: null },
        data: { readAt: new Date() },
      });
      return { updated: res.count };
    }
    const ids = [...new Set(dto.ids ?? [])];
    if (ids.length === 0) {
      throw new BadRequestException("ids or all is required");
    }
    // Every id must be the caller's own row in this workspace; someone else's
    // (or another workspace's) is indistinguishable from missing.
    const owned = await this.prisma.notification.findMany({
      where: { workspaceId, userId, id: { in: ids } },
      select: { id: true },
    });
    if (owned.length !== ids.length) {
      throw new NotFoundException("Notification not found");
    }
    const res = await this.prisma.notification.updateMany({
      where: { workspaceId, userId, id: { in: ids }, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: res.count };
  }

  async getPreferences(workspaceId: string, userId: string) {
    const rows = await this.prisma.notificationPreference.findMany({
      where: { workspaceId, userId },
    });
    const by = new Map(rows.map((r) => [r.type, r]));
    return NOTIFICATION_TYPES.map((type) => ({
      type,
      inApp: by.get(type)?.inApp ?? true,
      sound: by.get(type)?.sound ?? true,
    }));
  }

  async updatePreferences(
    workspaceId: string,
    userId: string,
    dto: UpdatePreferencesDto,
  ) {
    // Dedupe by type (last wins), then apply atomically.
    const byType = new Map(dto.items.map((it) => [it.type, it]));
    await this.prisma.$transaction(
      [...byType.values()].map((it) =>
        this.prisma.notificationPreference.upsert({
          where: { workspaceId_userId_type: { workspaceId, userId, type: it.type } },
          create: {
            workspaceId,
            userId,
            type: it.type,
            inApp: it.inApp,
            sound: it.sound,
          },
          update: { inApp: it.inApp, sound: it.sound },
        }),
      ),
    );
    return this.getPreferences(workspaceId, userId);
  }
}
