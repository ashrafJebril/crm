/**
 * SP-20 emergency stop (ruling 3), CRM side. `AgentSettings.stoppedAt` is
 * checked first by the reply gate on every automatic reply path; the existing
 * `POST /ai/settings/toggle` writes it (and kewy-ai's kill switch when that is
 * configured), so the owner keeps one switch.
 *
 * Not a settings card: it does not bump `version`, so an open settings form
 * is not made stale by a stop. The gate cache is cleared at once.
 */
import type { PrismaService } from "../prisma/prisma.service";
import { STOP_REASON_MAX } from "./agent-constants";
import { invalidateAgentGate } from "./agent-reply-gate";

export async function writeAgentStop(
  prisma: PrismaService,
  workspaceId: string,
  input: { stopped: boolean; reason?: string | null; userId?: string | null },
): Promise<void> {
  const data = input.stopped
    ? {
        stoppedAt: new Date(),
        stoppedReason: (input.reason ?? "").trim().slice(0, STOP_REASON_MAX) || null,
        stoppedById: input.userId ?? null,
      }
    : { stoppedAt: null, stoppedReason: null, stoppedById: null };
  try {
    await prisma.agentSettings.upsert({
      where: { workspaceId },
      create: { workspaceId, ...data },
      update: data,
    });
  } finally {
    invalidateAgentGate(workspaceId);
  }
}

/** Whether the CRM-side stop is set for the workspace. */
export async function readAgentStop(prisma: PrismaService, workspaceId: string): Promise<boolean> {
  const row = await prisma.agentSettings.findUnique({ where: { workspaceId }, select: { stoppedAt: true } });
  return Boolean(row?.stoppedAt);
}
