import type { PrismaService } from "../prisma/prisma.service";
import { channelError } from "./channel-errors";
import { ensureLegacyChannels } from "./legacy-mirror";

/**
 * WhatsApp numbers per workspace, by `Workspace.plan` (ruling R3, values
 * pending user confirmation). `CHANNEL_WHATSAPP_LIMIT` overrides every plan.
 *
 * Counts non-disconnected WhatsApp channels (pending landline numbers
 * included). Gates only OUR add flows (T4: embedded signup, manual token
 * connect, the Zernio WhatsApp connect link, reviving a disconnected Meta
 * number). Accounts that
 * already exist at a provider are always mirrored and inbound is never
 * dropped because of the limit.
 */
export const CHANNEL_LIMITS: Readonly<Record<string, number>> = Object.freeze({
  free: 1,
  starter: 1,
  growth: 3,
  pro: 10,
});

/** A pending row (landline flow, parked signup) idle this long stops taking
 *  a slot, so an abandoned FINISH_ONLY_WABA row never blocks a plan (m5). */
export const STALE_PENDING_MS = 24 * 3600_000;

export function whatsappLimit(plan: string, env: Record<string, string | undefined> = process.env): number {
  const override = Number(env.CHANNEL_WHATSAPP_LIMIT);
  if (Number.isInteger(override) && override > 0) return override;
  return CHANNEL_LIMITS[plan] ?? CHANNEL_LIMITS.free;
}

export async function whatsappUsage(
  prisma: PrismaService,
  workspaceId: string,
): Promise<{ used: number; limit: number; plan: string }> {
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { plan: true } });
  const plan = ws?.plan ?? "free";
  const used = await prisma.channel.count({
    where: {
      workspaceId,
      kind: "whatsapp",
      status: { not: "disconnected" },
      NOT: { status: "pending", updatedAt: { lt: new Date(Date.now() - STALE_PENDING_MS) } },
    },
  });
  return { used, limit: whatsappLimit(plan), plan };
}

/** 409 channels.limit_reached {limit, plan} when no WhatsApp slot is left.
 *  A legacy Integration `main` wrote and nobody mirrored yet is mirrored
 *  first, so it counts (one query when there is nothing to mirror). */
export async function assertWhatsappCapacity(prisma: PrismaService, workspaceId: string): Promise<void> {
  await ensureLegacyChannels(prisma, workspaceId);
  const { used, limit, plan } = await whatsappUsage(prisma, workspaceId);
  if (used >= limit) throw channelError("channels.limit_reached", { limit, plan });
}
