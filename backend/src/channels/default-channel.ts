import type { PrismaService } from "../prisma/prisma.service";
import { campaignError } from "../campaigns/campaign-errors";
import { channelError } from "./channel-errors";
import { whatsappLimit } from "./channel-limits";
import { ensureLegacyChannels } from "./legacy-mirror";

/**
 * SP-13 fix round 1 (M3): the one "connected" rule. A WhatsApp channel
 * counts as connected while it is `active` or `needs_attention` (Zernio
 * health warning, still sending). `pending`, `error` and `disconnected` do
 * not. Used by the default number (template submission and the campaign
 * launch gate) and by `connected` on GET /campaigns/senders and the preview,
 * so the banner and the gates always agree.
 */
export const CONNECTED_CHANNEL_STATUSES: readonly string[] = ["active", "needs_attention"];

/**
 * The Zernio account id of the workspace's default WhatsApp number: the
 * connected (not disconnected or pending) Zernio WhatsApp channel, default
 * first, then the most recently
 * updated. Falls back to the legacy Integration row only while that number
 * has no channel at all (exactly `main`'s behaviour); a disconnected channel
 * is honoured (R9). Templates (R8) and campaigns
 * with no sender use it.
 */
export async function defaultZernioWhatsappAccountId(
  prisma: PrismaService,
  workspaceId: string,
): Promise<string | null> {
  const ch = await prisma.channel.findFirst({
    where: { workspaceId, kind: "whatsapp", provider: "zernio", status: { in: [...CONNECTED_CHANNEL_STATUSES] } },
    orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
    select: { externalId: true },
  });
  if (ch?.externalId) return ch.externalId;
  const integ = await prisma.integration.findFirst({
    where: { workspaceId, provider: "zernio", platform: "whatsapp" },
  });
  if (!integ?.pageId) return null;
  // R9: once the number has a channel, the channel decides. A channel
  // disconnected in the hub must not keep sending through its Integration.
  const mirrored = await prisma.channel.findFirst({
    where: { workspaceId, OR: [{ integrationId: integ.id }, { provider: "zernio", externalId: integ.pageId }] },
    select: { id: true },
  });
  return mirrored ? null : integ.pageId;
}

/**
 * Campaign `senderChannelId` must be an active Zernio WhatsApp channel of this
 * workspace (campaigns run as Zernio broadcasts, ruling 6). Returns its
 * account id; 400 channels.sender_invalid otherwise. A foreign id is
 * indistinguishable from a missing one.
 */
export async function campaignSenderAccountId(
  prisma: PrismaService,
  workspaceId: string,
  senderChannelId: string,
): Promise<string> {
  const ch = await prisma.channel.findFirst({
    where: { id: senderChannelId, workspaceId },
    select: { kind: true, provider: true, status: true, externalId: true },
  });
  if (!ch || ch.kind !== "whatsapp" || ch.provider !== "zernio" || ch.status !== "active" || !ch.externalId) {
    throw channelError("channels.sender_invalid");
  }
  return ch.externalId;
}

/**
 * SP-12: the campaign's sender as `{accountId, channelId}`, so every
 * recipient row records the number it went out from.
 * - An explicit `senderChannelId` is validated exactly as
 *   `campaignSenderAccountId` (400 channels.sender_invalid).
 * - Otherwise the default Zernio WhatsApp channel. When only a legacy
 *   Integration exists, `ensureLegacyChannels` mirrors it first so
 *   `channelId` is real; it stays null only if mirroring could not produce
 *   a channel for that account.
 * Returns null when the workspace has no WhatsApp sender at all.
 */
export async function campaignSender(
  prisma: PrismaService,
  workspaceId: string,
  senderChannelId: string | null | undefined,
): Promise<{ accountId: string; channelId: string | null } | null> {
  if (senderChannelId) {
    const ch = await prisma.channel.findFirst({
      where: { id: senderChannelId, workspaceId },
      select: { id: true, kind: true, provider: true, status: true, externalId: true },
    });
    if (!ch || ch.kind !== "whatsapp" || ch.provider !== "zernio" || ch.status !== "active" || !ch.externalId) {
      throw channelError("channels.sender_invalid");
    }
    return { accountId: ch.externalId, channelId: ch.id };
  }
  const live = await prisma.channel.findFirst({
    where: { workspaceId, kind: "whatsapp", provider: "zernio", status: { in: [...CONNECTED_CHANNEL_STATUSES] } },
    orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
    select: { id: true, externalId: true },
  });
  if (live?.externalId) return { accountId: live.externalId, channelId: live.id };
  const accountId = await defaultZernioWhatsappAccountId(prisma, workspaceId);
  if (!accountId) return null;
  await ensureLegacyChannels(prisma, workspaceId);
  const mirrored = await prisma.channel.findFirst({
    where: { workspaceId, provider: "zernio", externalId: accountId, status: { in: [...CONNECTED_CHANNEL_STATUSES] } },
    select: { id: true },
  });
  return { accountId, channelId: mirrored?.id ?? null };
}

/** SP-13: one validated campaign sender. */
export interface CampaignSenderInfo {
  channelId: string;
  accountId: string;
  displayName: string;
  phoneNumber: string | null;
}

/** SP-13: at most this many senders per campaign, whatever the plan. */
export const CAMPAIGN_SENDERS_MAX = 10;

/** Senders a campaign of this workspace may name: `min(10, whatsappLimit(plan))`. */
export async function campaignSenderLimit(prisma: PrismaService, workspaceId: string): Promise<number> {
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { plan: true } });
  return Math.min(CAMPAIGN_SENDERS_MAX, whatsappLimit(ws?.plan ?? "free"));
}

const isEligibleSender = (ch: { kind: string; provider: string; status: string; externalId: string | null }) =>
  ch.kind === "whatsapp" && ch.provider === "zernio" && ch.status === "active" && !!ch.externalId;

/**
 * SP-13: validates a campaign's sender list, in order. Duplicates are
 * removed (first kept). More than `campaignSenderLimit` → 400
 * `campaigns.too_many_senders {limit}` (checked before any lookup). Every id
 * must be an active Zernio WhatsApp channel of this workspace, else 400
 * `channels.sender_invalid {channelId}`: a foreign id answers exactly like a
 * missing one (ruling 11), and Meta-direct numbers are refused (SP-19 R6).
 * One query for all ids. `[]` stays `[]` (the default number).
 */
export async function campaignSenders(
  prisma: PrismaService,
  workspaceId: string,
  ids: readonly string[],
): Promise<CampaignSenderInfo[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const limit = await campaignSenderLimit(prisma, workspaceId);
  if (unique.length > limit) throw campaignError("campaigns.too_many_senders", { limit });
  const rows = (await prisma.channel.findMany({
    where: { workspaceId, id: { in: unique } },
    select: { id: true, kind: true, provider: true, status: true, externalId: true, displayName: true, phoneNumber: true },
  })) as Array<{
    id: string;
    kind: string;
    provider: string;
    status: string;
    externalId: string | null;
    displayName: string;
    phoneNumber: string | null;
  }>;
  const byId = new Map(rows.map((r) => [r.id, r]));
  return unique.map((id) => {
    const ch = byId.get(id);
    if (!ch || !isEligibleSender(ch)) throw channelError("channels.sender_invalid", { channelId: id });
    return { channelId: ch.id, accountId: ch.externalId as string, displayName: ch.displayName, phoneNumber: ch.phoneNumber ?? null };
  });
}

export type SenderIneligibleReason = "provider_meta" | "not_active";

export interface CampaignSenderOption {
  channelId: string;
  displayName: string;
  phoneNumber: string | null;
  isDefault: boolean;
  provider: string;
  eligible: boolean;
  reason: SenderIneligibleReason | null;
}

/**
 * SP-13 `GET /campaigns/senders`: the workspace's WhatsApp numbers (not
 * disconnected), default first, each with whether it can send campaigns.
 * `connected` holds when the workspace has its Zernio profile and a Zernio
 * WhatsApp number that is connected (`CONNECTED_CHANNEL_STATUSES`): the
 * same rule as the launch gate and template submission. A `needs_attention`
 * number connects but is not offered as an explicit sender (`not_active`).
 * A legacy Integration-only number is mirrored first, as at launch.
 */
export async function campaignSenderOptions(
  prisma: PrismaService,
  workspaceId: string,
): Promise<{ connected: boolean; limit: number; senders: CampaignSenderOption[] }> {
  await ensureLegacyChannels(prisma, workspaceId);
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { plan: true, zernioProfileId: true } });
  const rows = (await prisma.channel.findMany({
    where: { workspaceId, kind: "whatsapp", status: { not: "disconnected" } },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    select: { id: true, kind: true, provider: true, status: true, externalId: true, displayName: true, phoneNumber: true, isDefault: true },
  })) as Array<{
    id: string;
    kind: string;
    provider: string;
    status: string;
    externalId: string | null;
    displayName: string;
    phoneNumber: string | null;
    isDefault: boolean;
  }>;
  const senders = rows.map((r) => {
    const reason: SenderIneligibleReason | null = r.provider !== "zernio" ? "provider_meta" : isEligibleSender(r) ? null : "not_active";
    return {
      channelId: r.id,
      displayName: r.displayName,
      phoneNumber: r.phoneNumber ?? null,
      isDefault: r.isDefault === true,
      provider: r.provider,
      eligible: reason === null,
      reason,
    };
  });
  return {
    connected:
      !!ws?.zernioProfileId &&
      rows.some((r) => r.provider === "zernio" && !!r.externalId && CONNECTED_CHANNEL_STATUSES.includes(r.status)),
    limit: Math.min(CAMPAIGN_SENDERS_MAX, whatsappLimit(ws?.plan ?? "free")),
    senders,
  };
}
