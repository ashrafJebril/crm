import { Prisma } from "@prisma/client";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { PermissionService } from "../permissions/permission.service";
import type { Viewer } from "../permissions/visibility";
import { NotificationsService } from "../notifications/notifications.service";
import { RealtimeService } from "../realtime/realtime.service";
import { applyConversationAssignment } from "./assign-conversation";
import { LOutboundService } from "../integrations/l-outbound.service";
import { ChannelResolver, pickEffectiveChannel } from "../channels/channel-resolver.service";
import { ChannelTransportRegistry, type TransportConversation } from "../channels/channel-transport";
import { channelError } from "../channels/channel-errors";
import { deliverViaTransport } from "../channels/deliver-via-transport";
import { ensureLegacyChannels } from "../channels/legacy-mirror";
import {
  CreateConversationDto,
  CreateMessageDto,
  UpdateConversationDto,
} from "./conversations.dto";
import { AD_SOURCE_CHIP_SELECT, toAdSourceChip } from "../ad-attribution/ad-source-chip";
import { sentByData, staffSenderId } from "./message-sender";

@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly lOutbound: LOutboundService,
    @Optional() private readonly notifications?: NotificationsService,
    // Absent only in unit tests; the module is @Global in the app.
    @Optional() private readonly perm?: PermissionService,
    // SP-19, from the global ChannelsCoreModule (unit specs may omit them).
    @Optional() channelResolver?: ChannelResolver,
    @Optional() transports?: ChannelTransportRegistry,
  ) {
    this.channels = channelResolver ?? new ChannelResolver(prisma);
    this.transports = transports ?? new ChannelTransportRegistry();
  }

  private readonly channels: ChannelResolver;
  private readonly transports: ChannelTransportRegistry;
  /** workspaceId → when the inbox list last ran the legacy mirror (M4). */
  private readonly mirroredAt = new Map<string, number>();

  /** The legacy Integration mirror, at most once a minute per workspace: the
   *  inbound, send and /channels paths mirror on their own, so the list only
   *  needs to catch rows `main` wrote recently. */
  private async mirrorLegacyThrottled(workspaceId: string): Promise<void> {
    const now = Date.now();
    if (now - (this.mirroredAt.get(workspaceId) ?? 0) < 60_000) return;
    this.mirroredAt.set(workspaceId, now);
    await ensureLegacyChannels(this.prisma, workspaceId);
  }

  /** Which conversations `viewer` may see. No viewer = internal caller. */
  private scope(workspaceId: string, viewer?: Viewer): Promise<Prisma.ConversationWhereInput> {
    return this.perm ? this.perm.conversationScope(workspaceId, viewer) : Promise.resolve({});
  }

  private emitActivity(
    workspaceId: string,
    channel: string,
    conversationId?: string,
  ): void {
    this.realtime.emitToWorkspace(workspaceId, "inbox.activity", {
      channel,
      conversationId,
    });
  }

  /**
   * SP-19: `filter.channelIds` keeps conversations whose EFFECTIVE channel is
   * one of them (legacy null-channel rows included). It is ANDed with the
   * viewer's scope, never replacing it. Every row carries its effective
   * `channelId` and `channelProvider` (null when none resolves, e.g. `l`).
   */
  async list(workspaceId: string, viewer?: Viewer, filter: { channelIds?: string[] } = {}) {
    const scope = await this.scope(workspaceId, viewer);
    const channelIds = (filter.channelIds ?? []).filter(Boolean);
    await this.mirrorLegacyThrottled(workspaceId);
    const where: Prisma.ConversationWhereInput = channelIds.length
      ? { AND: [{ workspaceId }, scope, { OR: [{ channelId: { in: channelIds } }, { channelId: null }] }] }
      : { workspaceId, ...scope };
    const [rows, channels] = await Promise.all([
      this.prisma.conversation.findMany({
        where,
        orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
        include: { labels: { select: { labelId: true } }, adSource: { select: AD_SOURCE_CHIP_SELECT } },
      }),
      this.prisma.channel.findMany({
        where: { workspaceId },
        select: { id: true, workspaceId: true, kind: true, provider: true, status: true, isDefault: true, integrationId: true },
      }),
    ]);
    const wanted = new Set(channelIds);
    const convs = rows
      .map((c) => {
        const eff = pickEffectiveChannel(c, channels);
        return { ...c, channelId: eff?.id ?? null, channelProvider: eff?.provider ?? null };
      })
      .filter((c) => wanted.size === 0 || (c.channelId !== null && wanted.has(c.channelId)));

    // 24-hour customer-service window state for WhatsApp conversations only.
    // Inbox uses it to flip the composer to a template picker when the window
    // closes. Other channels have different (or no) restrictions — skip the
    // extra query for them.
    const waConvIds = convs
      .filter((c) => c.channel === "whatsapp")
      .map((c) => c.id);
    const lastInboundByConv = new Map<string, Date>();
    if (waConvIds.length > 0) {
      const grouped = await this.prisma.message.groupBy({
        by: ["conversationId"],
        where: {
          workspaceId,
          conversationId: { in: waConvIds },
          from: "them",
        },
        _max: { createdAt: true },
      });
      for (const g of grouped) {
        if (g._max.createdAt) lastInboundByConv.set(g.conversationId, g._max.createdAt);
      }
    }

    const WA_WINDOW_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    return convs.map(({ labels, adSource, ...rest }) => {
      const c = { ...rest, labelIds: labels.map((l) => l.labelId), adSource: toAdSourceChip(adSource) };
      if (c.channel !== "whatsapp") return c;
      const lastInboundAt = lastInboundByConv.get(c.id) ?? null;
      const waWindowOpen = lastInboundAt
        ? now - lastInboundAt.getTime() < WA_WINDOW_MS
        : false;
      return { ...c, lastInboundAt, waWindowOpen };
    });
  }

  async get(workspaceId: string, id: string, viewer?: Viewer) {
    const scope = await this.scope(workspaceId, viewer);
    const conv = await this.prisma.conversation.findFirst({
      where: { id, workspaceId, ...scope },
      include: {
        messages: { orderBy: { createdAt: "asc" } },
        labels: { select: { labelId: true } },
        adSource: { select: AD_SOURCE_CHIP_SELECT },
      },
    });
    if (!conv) throw new NotFoundException("Conversation not found");
    const { adSource, ...full } = conv;
    return { ...this.withWindow(full), adSource: toAdSourceChip(adSource) };
  }

  private withWindow<
    T extends {
      channel: string;
      messages: { from: string; createdAt: Date }[];
      labels: { labelId: string }[];
    },
  >(full: T) {
    const { labels, ...rest } = full;
    const conv = { ...rest, labelIds: labels.map((l) => l.labelId) };

    if (conv.channel === "whatsapp") {
      // Walk messages backwards for the most recent inbound. Avoids a second
      // query since we already have the full thread loaded.
      let lastInboundAt: Date | null = null;
      for (let i = conv.messages.length - 1; i >= 0; i--) {
        if (conv.messages[i].from === "them") {
          lastInboundAt = conv.messages[i].createdAt;
          break;
        }
      }
      const WA_WINDOW_MS = 24 * 60 * 60 * 1000;
      const waWindowOpen = lastInboundAt
        ? Date.now() - lastInboundAt.getTime() < WA_WINDOW_MS
        : false;
      return { ...conv, lastInboundAt, waWindowOpen };
    }

    return conv;
  }

  async create(workspaceId: string, dto: CreateConversationDto) {
    const conv = await this.prisma.conversation.create({
      data: {
        ...dto,
        workspaceId,
        unread: 0,
        pinned: dto.pinned ?? false,
        escalated: dto.escalated ?? false,
      },
    });
    this.emitActivity(workspaceId, conv.channel, conv.id);
    return conv;
  }

  async update(
    workspaceId: string,
    id: string,
    dto: UpdateConversationDto,
    actorId?: string,
    viewer?: Viewer,
  ) {
    const scope = await this.scope(workspaceId, viewer);
    const row = await this.prisma.conversation.findFirst({
      where: { id, workspaceId, ...scope },
      include: { labels: { select: { labelId: true } } },
    });
    if (!row) throw new NotFoundException("Conversation not found");
    // Pure input validation first: no lookups or version checks before it.
    const data: Prisma.ConversationUncheckedUpdateManyInput = {};
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.pinned !== undefined) data.pinned = dto.pinned;
    if (dto.unread !== undefined) data.unread = dto.unread;
    if (dto.aiEnabled !== undefined) data.aiEnabled = dto.aiEnabled;
    if (dto.escalated === true) {
      const given = dto.escalateReason?.trim();
      const kept = row.escalated ? row.escalateReason?.trim() : undefined;
      const reason = given || kept;
      if (!reason) {
        throw new BadRequestException("escalateReason is required to escalate");
      }
      data.escalated = true;
      data.escalateReason = reason;
    } else if (dto.escalated === false) {
      data.escalated = false;
      data.escalateReason = null;
    }
    if (dto.status !== undefined && dto.status !== row.status) {
      data.statusChangedAt = new Date();
    }
    // version bump + updatedAt preservation (ownership actions must not reorder
    // the inbox) are applied by applyConversationAssignment.

    if (dto.version !== undefined && dto.version !== row.version) {
      throw this.conflict(row);
    }
    if (typeof dto.assigneeId === "string") {
      const member = await this.prisma.workspaceMember.findFirst({
        where: { workspaceId, userId: dto.assigneeId },
      });
      if (!member) throw new BadRequestException("assignee is not a member");
    }

    const { count, fresh } = await applyConversationAssignment(
      { prisma: this.prisma, realtime: this.realtime, notifications: this.notifications },
      {
        workspaceId,
        conversationId: id,
        assigneeId: dto.assigneeId,
        actorId,
        extraData: data,
        enforceVersion: row.version,
        preserveUpdatedAt: true,
        current: { assigneeId: row.assigneeId, updatedAt: row.updatedAt, version: row.version },
      },
    );
    if (!fresh) throw new NotFoundException("Conversation not found");
    if (count === 0) throw this.conflict(fresh);
    return this.mapLabels(fresh);
  }

  private mapLabels<T extends { labels: { labelId: string }[] }>(c: T) {
    const { labels, ...rest } = c;
    return { ...rest, labelIds: labels.map((l) => l.labelId) };
  }

  private conflict(current: { labels: { labelId: string }[] }) {
    return new ConflictException({
      message: "Conversation changed",
      current: this.mapLabels(current),
    });
  }

  async markRead(workspaceId: string, id: string, viewer?: Viewer) {
    const conv = await this.get(workspaceId, id, viewer);
    // Raw UPDATE on purpose: the list orders by updatedAt, and Prisma's
    // @updatedAt bumps on every model-level update — so opening a thread
    // (mark-read) would hoist it to the top. Reading must not reorder.
    await this.prisma.$executeRaw`
      UPDATE "Conversation" SET "unread" = 0
      WHERE "id" = ${id} AND "workspaceId" = ${workspaceId}`;
    this.emitActivity(workspaceId, conv.channel, conv.id);
    return { ...conv, unread: 0 };
  }

  async remove(workspaceId: string, id: string, viewer?: Viewer) {
    const existing = await this.get(workspaceId, id, viewer);
    await this.prisma.conversation.delete({ where: { id } });
    this.emitActivity(workspaceId, existing.channel, id);
    return { ok: true };
  }

  async listMessages(workspaceId: string, conversationId: string, viewer?: Viewer) {
    await this.get(workspaceId, conversationId, viewer);
    return this.prisma.message.findMany({
      where: { conversationId, workspaceId },
      orderBy: { createdAt: "asc" },
    });
  }

  /**
   * Turn the AI on or off for one thread, and hand a paused thread back.
   *
   * Enabling always clears `aiPausedAt`: the operator flipping it on IS the
   * decision to let the agent speak again, so leaving a stale pause would make
   * the toggle look broken.
   */
  async setAi(
    workspaceId: string,
    conversationId: string,
    enabled: boolean,
    viewer?: Viewer,
  ) {
    await this.get(workspaceId, conversationId, viewer); // 404s if not in this workspace
    return await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { aiEnabled: enabled, aiPausedAt: null },
      select: { id: true, aiEnabled: true, aiPausedAt: true },
    });
  }

  async addMessage(
    workspaceId: string,
    conversationId: string,
    dto: CreateMessageDto,
    viewer?: Viewer,
  ) {
    const conv = await this.get(workspaceId, conversationId, viewer);
    const now = new Date();
    const t = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const message = await this.prisma.message.create({
      // SP-11: a staff message records its sender (the Team tab).
      data: { ...dto, conversationId, workspaceId, t, ...(dto.from === "human" ? sentByData(staffSenderId(viewer)) : {}) },
    });
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        preview: dto.body.slice(0, 140),
        lastAt: "now",
        lastFrom: dto.from,
        unread: dto.from === "them" ? { increment: 1 } : 0,
        // A human sending into an AI-handled thread takes it over: the agent
        // stops answering until someone clears the pause. Without this, staff
        // and the bot talk over each other in front of the customer — the
        // fastest way to destroy trust in the feature.
        //
        // 'ai' is excluded deliberately: the agent's own replies arrive through
        // this path too and must not pause itself.
        ...(dto.from === "human" ? { aiPausedAt: now } : {}),
      },
    });
    this.emitActivity(workspaceId, conv.channel, conversationId);

    // A reply typed here has to reach the l agent, or the person waiting in
    // that chat never hears back. "them" is the contact's own message arriving
    // by some other path and is not ours to forward. The call returns at once;
    // the agent's answer is written when it arrives.
    if (dto.from === "human") {
      this.lOutbound.queueReply(workspaceId, conversationId, dto.body);
    }
    return message;
  }

  /**
   * SP-19 `POST /conversations/:id/send`: deliver a text reply through the
   * conversation's channel transport (Telegram — T2, web chat — T3), then
   * record it once. Hidden conversation → 404 before anything is sent;
   * disconnected channel → 409 channels.disconnected (never another number).
   * Zernio and Meta threads keep their dedicated routes: 400
   * channels.transport_unavailable.
   */
  async sendViaChannel(workspaceId: string, conversationId: string, body: string, viewer?: Viewer) {
    const text = (body ?? "").trim();
    if (!text) throw new BadRequestException("body is required");
    const scope = await this.scope(workspaceId, viewer);
    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, workspaceId, ...scope },
      include: { contact: { select: { id: true, externalId: true, phone: true, name: true } } },
    });
    if (!conv) throw new NotFoundException("Conversation not found");

    // SP-22: the transport write is shared with the AI auto-reply.
    const { message } = await deliverViaTransport(
      { prisma: this.prisma, realtime: this.realtime, channels: this.channels, transports: this.transports, logger: this.logger },
      workspaceId,
      conv,
      text,
      { from: "human", extra: sentByData(staffSenderId(viewer)) },
    );
    return { ok: true as const, message };
  }
}
