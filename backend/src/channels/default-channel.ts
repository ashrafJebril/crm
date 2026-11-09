import type { PrismaService } from "../prisma/prisma.service";
import { channelError } from "./channel-errors";

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
