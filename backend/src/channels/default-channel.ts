import type { PrismaService } from "../prisma/prisma.service";
import { channelError } from "./channel-errors";
import { ensureLegacyChannels } from "./legacy-mirror";

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
    where: { workspaceId, kind: "whatsapp", provider: "zernio", status: { notIn: ["disconnected", "pending"] } },
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
    where: { workspaceId, kind: "whatsapp", provider: "zernio", status: { notIn: ["disconnected", "pending"] } },
    orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
    select: { id: true, externalId: true },
  });
  if (live?.externalId) return { accountId: live.externalId, channelId: live.id };
  const accountId = await defaultZernioWhatsappAccountId(prisma, workspaceId);
  if (!accountId) return null;
  await ensureLegacyChannels(prisma, workspaceId);
  const mirrored = await prisma.channel.findFirst({
    where: { workspaceId, provider: "zernio", externalId: accountId, status: { notIn: ["disconnected", "pending"] } },
    select: { id: true },
  });
  return { accountId, channelId: mirrored?.id ?? null };
}
