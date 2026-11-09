import { Injectable, Logger } from "@nestjs/common";
import type { Channel, Conversation } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { channelError } from "./channel-errors";
import { alignLegacyChannel, ensureDefaultPerKind, ensureLegacyChannels } from "./legacy-mirror";

/** The conversation fields the resolver needs. */
export interface ConvRef {
  id: string;
  workspaceId: string;
  channel: string;
  channelId?: string | null;
}

/** The channel fields `pickEffectiveChannel` reads. */
export interface ChannelPick {
  id: string;
  workspaceId: string;
  kind: string;
  status: string;
  isDefault: boolean;
  integrationId: string | null;
}

/** Conversation kinds that never resolve to a Channel by fallback: `l` is the
 *  agent platform; pre-SP-19 webchat threads have no visitor to address. */
const NO_FALLBACK_KINDS = new Set(["l", "webchat"]);

/** mirrorLegacy runs its writes at most this often per Integration. */
const ALIGN_THROTTLE_MS = 60_000;

/** Legacy Integration.provider values that mean "our own Meta app". */
const NOT_META = ["zernio", "telegram", "native"];

/**
 * The effective channel of a conversation, from a preloaded channel list:
 *  1. its own `channelId`;
 *  2. else the channel linked to the workspace's legacy Integration for
 *     `conv.channel` — what `main` sends from. Deliberately regardless of
 *     status: if that channel was disconnected, sends must be refused rather
 *     than silently moved to another number (R9);
 *  3. else the active default channel of that kind;
 *  4. else none (reads still work; sends return channels.not_connected).
 */
export function pickEffectiveChannel<T extends ChannelPick>(conv: ConvRef, channels: T[]): T | null {
  if (conv.channelId) return channels.find((c) => c.id === conv.channelId) ?? null;
  const kind = (conv.channel ?? "").toLowerCase();
  if (NO_FALLBACK_KINDS.has(kind)) return null;
  const ofKind = channels.filter((c) => c.kind === kind && c.workspaceId === conv.workspaceId);
  return (
    ofKind.find((c) => c.integrationId) ??
    ofKind.find((c) => c.isDefault && c.status === "active") ??
    null
  );
}

/**
 * The single place that answers "which channel is this?" for inbound
 * webhooks, conversation reads and every outbound send.
 */
@Injectable()
export class ChannelResolver {
  private readonly log = new Logger(ChannelResolver.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The channel an inbound provider event belongs to.
   * provider: "zernio" (externalId = account id), "meta" (phone_number_id;
   * matches any legacy non-Zernio provider such as "kapso"), "telegram",
   * "native". Ranking: live rows backed by a legacy Integration; else the
   * live Integration holding the account (mirrored/aligned on the fly, so a
   * number moved to another workspace routes there on its first webhook);
   * else other live rows; else a disconnected row as the last resort so
   * inbound is never dropped. Several workspaces in one tier: warn and pick
   * the most recently updated (today's `findFirst` behaviour, now logged).
   */
  async forInbound(provider: string, externalId: string, kind?: string): Promise<Channel | null> {
    if (!externalId) return null;
    const rows = await this.prisma.channel.findMany({
      where: {
        externalId,
        provider: provider === "meta" ? { notIn: NOT_META } : provider,
        ...(kind ? { kind } : {}),
      },
      orderBy: { updatedAt: "desc" },
    });
    const live = rows.filter((r) => r.status !== "disconnected");
    // 1. Rows backed by a live legacy Integration are the current owners.
    const backed = live.filter((r) => r.integrationId);
    if (backed.length) return this.pickNewest(provider, externalId, backed);
    // 2. Before trusting an orphan (no Integration) or a disconnected row —
    //    possibly another, former workspace's — mirror the live Integration
    //    that holds this account now, if any (a number moved W1 → W2, or one
    //    connected by `main` and not mirrored yet).
    //    A disconnected slot (hub-disconnected, Integration kept) never wins
    //    over a live channel elsewhere; it is used only when nothing is live.
    const mirrored = await this.mirrorLegacy(provider, externalId, kind);
    if (mirrored && (mirrored.status !== "disconnected" || !live.length)) return mirrored;
    // 3. Channel-only rows (Telegram, web chat, a second Meta number), then a
    //    disconnected row as the last resort so inbound is never dropped.
    if (live.length) return this.pickNewest(provider, externalId, live);
    return rows[0] ?? null;
  }

  private pickNewest(provider: string, externalId: string, rows: Channel[]): Channel {
    const workspaces = new Set(rows.map((r) => r.workspaceId)).size;
    if (workspaces > 1) {
      this.log.warn(
        `${provider} account ${externalId} is connected in ${workspaces} workspaces; routing to the most recently updated`,
      );
    }
    return rows[0];
  }

  private async mirrorLegacy(provider: string, externalId: string, kind?: string): Promise<Channel | null> {
    if (provider !== "zernio" && provider !== "meta") return null;
    const integ = await this.prisma.integration.findFirst({
      where:
        provider === "zernio"
          ? { provider: "zernio", pageId: externalId }
          : { pageId: externalId, provider: { notIn: NOT_META }, ...(kind ? { platform: kind } : {}) },
      orderBy: { updatedAt: "desc" },
    });
    if (!integ) return null;
    // Write work (align + default-per-kind) at most once a minute per
    // Integration: a repeat within the window just reads its slot.
    const last = this.alignedAt.get(integ.id) ?? 0;
    if (Date.now() - last < ALIGN_THROTTLE_MS) {
      return this.prisma.channel.findFirst({ where: { integrationId: integ.id } });
    }
    this.alignedAt.set(integ.id, Date.now());
    // The Integration's own slot follows it (in place when `main` re-pointed it).
    const ch = await alignLegacyChannel(this.prisma, integ);
    await ensureDefaultPerKind(this.prisma, integ.workspaceId);
    return ch ? ((await this.prisma.channel.findFirst({ where: { id: ch.id } })) ?? ch) : null;
  }

  /** integrationId → when mirrorLegacy last aligned it (N4 throttle). */
  private readonly alignedAt = new Map<string, number>();

  /** Effective channel (see pickEffectiveChannel); writes a resolved id back
   *  onto a null `channelId`, once, without reordering the inbox. */
  async effectiveChannel(conv: ConvRef): Promise<Channel | null> {
    if (conv.channelId) {
      const own = await this.prisma.channel.findFirst({
        where: { id: conv.channelId, workspaceId: conv.workspaceId },
      });
      if (own) return own;
    }
    const kind = (conv.channel ?? "").toLowerCase();
    if (NO_FALLBACK_KINDS.has(kind)) return null;
    const load = () =>
      this.prisma.channel.findMany({
        where: {
          workspaceId: conv.workspaceId,
          kind,
          OR: [{ integrationId: { not: null } }, { isDefault: true }],
        },
      });
    const ref = { ...conv, channelId: null };
    let pick = pickEffectiveChannel(ref, await load());
    if (!pick && (await ensureLegacyChannels(this.prisma, conv.workspaceId)) > 0) {
      pick = pickEffectiveChannel(ref, await load());
    }
    if (pick && !conv.channelId) await this.writeBack(conv, pick.id);
    return pick;
  }

  /** Load a conversation by id and resolve its effective channel. */
  async forConversation(workspaceId: string, conversationId: string): Promise<Channel | null> {
    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, workspaceId },
      select: { id: true, workspaceId: true, channel: true, channelId: true },
    });
    return conv ? this.effectiveChannel(conv) : null;
  }

  /**
   * The channel to send a conversation's reply through. Never falls back to
   * another number: 409 channels.disconnected for a disconnected channel,
   * 409 channels.not_connected when none resolves or it is still pending.
   */
  async forSend(workspaceId: string, conv: Omit<ConvRef, "workspaceId"> & { workspaceId?: string }): Promise<Channel> {
    const ch = await this.effectiveChannel({ ...conv, workspaceId });
    if (!ch) throw channelError("channels.not_connected");
    if (ch.status === "disconnected") throw channelError("channels.disconnected", { channelId: ch.id });
    if (ch.status === "pending") throw channelError("channels.not_connected", { channelId: ch.id });
    return ch;
  }

  /**
   * The conversation an inbound message on `channel` belongs to: the
   * contact's own conversation on that channel, else a legacy null-channel
   * thread of the same kind — adopted ONLY when that thread's effective
   * channel is this one (so number B never swallows A's history). Null means
   * "create a new conversation with channelId = channel.id".
   */
  async findOrAdoptConversation(
    workspaceId: string,
    contactId: string,
    channel: Pick<Channel, "id" | "kind">,
  ): Promise<Conversation | null> {
    const own = await this.prisma.conversation.findFirst({
      where: { workspaceId, contactId, channelId: channel.id },
      orderBy: { updatedAt: "desc" },
    });
    if (own) return own;
    const legacy = await this.prisma.conversation.findFirst({
      where: { workspaceId, contactId, channel: channel.kind, channelId: null },
      orderBy: { updatedAt: "desc" },
    });
    if (!legacy) return null;
    const eff = await this.effectiveChannel(legacy);
    return eff?.id === channel.id ? { ...legacy, channelId: channel.id } : null;
  }

  /** Best-effort `lastInboundAt` stamp; never fails an ingest. */
  async touchInbound(channelId: string): Promise<void> {
    try {
      await stampLastInbound(this.prisma, channelId);
    } catch (e) {
      this.log.warn(`lastInboundAt update failed for channel ${channelId}: ${(e as Error).message}`);
    }
  }

  /**
   * Raw UPDATE on purpose: the inbox orders by updatedAt, which Prisma bumps
   * on every model-level update. Only fills a null channelId.
   */
  private async writeBack(conv: ConvRef, channelId: string): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        UPDATE "Conversation" SET "channelId" = ${channelId}
        WHERE "id" = ${conv.id} AND "workspaceId" = ${conv.workspaceId} AND "channelId" IS NULL`;
    } catch (e) {
      this.log.warn(`channelId write-back failed for conversation ${conv.id}: ${(e as Error).message}`);
    }
  }
}

/**
 * Stamp `Channel.lastInboundAt` with raw SQL: a model update would bump
 * `updatedAt`, which forInbound uses to break multi-workspace ties, so busy
 * channels would win by traffic instead of by their last (re)connect.
 */
export async function stampLastInbound(prisma: PrismaService, channelId: string): Promise<void> {
  await prisma.$executeRaw`UPDATE "Channel" SET "lastInboundAt" = NOW() WHERE "id" = ${channelId}`;
}
