import type { PrismaService } from "../prisma/prisma.service";
import { channelError } from "./channel-errors";

/**
 * The Zernio account id of the workspace's default WhatsApp number: the
 * active Zernio WhatsApp channel, default first, then the most recently
 * updated. Falls back to the legacy Integration row while nothing is
 * mirrored yet (exactly `main`'s behaviour). Templates (R8) and campaigns
 * with no sender use it.
 */
export async function defaultZernioWhatsappAccountId(
  prisma: PrismaService,
  workspaceId: string,
): Promise<string | null> {
  const ch = await prisma.channel.findFirst({
    where: { workspaceId, kind: "whatsapp", provider: "zernio", status: "active" },
    orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
    select: { externalId: true },
  });
  if (ch?.externalId) return ch.externalId;
  const integ = await prisma.integration.findFirst({
    where: { workspaceId, provider: "zernio", platform: "whatsapp" },
  });
  return integ?.pageId ?? null;
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
