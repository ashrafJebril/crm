import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Asks a workspace's l agent a question and returns its answer.
 *
 * Nothing more: no persistence, no sending. Two callers need the same request
 * for different reasons — an inbox reply going back to an l-origin chat, and an
 * inbound social message being auto-answered — and they disagree about what to
 * do with the answer. Keeping this to the HTTP call is what lets them share it.
 *
 * Never throws. Every failure is a null answer plus a log line, because both
 * callers are on paths where the customer's message is already stored and a
 * struggling agent platform must not turn that into a failed request.
 */
@Injectable()
export class LAgentService {
  private readonly logger = new Logger(LAgentService.name);

  // An l turn invokes a model, and a turn that consults the knowledge base
  // costs a retrieval plus a second model round trip — measured at 8-10s, so
  // 30s was only ~3x headroom on a path nobody is waiting on synchronously.
  // Generous here is cheap: the caller already returned, so the only cost of
  // waiting is a held socket, while giving up early loses the customer's reply.
  private static readonly TIMEOUT_MS = 60_000;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Whether an l platform is configured at all. Callers check this before
   * doing any work of their own, so a deployment without l pays nothing —
   * not even a lookup — on every inbound message.
   */
  get enabled(): boolean {
    return Boolean(process.env.L_API_URL);
  }

  async ask(
    workspaceId: string,
    opts: { externalId: string; message: string; sessionId?: string | null },
  ): Promise<string | null> {
    const baseUrl = process.env.L_API_URL;
    if (!baseUrl) return null;

    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { lEndpointId: true, lEndpointSecret: true },
    });
    if (!workspace?.lEndpointId || !workspace.lEndpointSecret) {
      this.logger.warn(
        `Workspace ${workspaceId} has no l webhook endpoint configured; not asking the agent`,
      );
      return null;
    }

    const url =
      `${baseUrl.replace(/\/$/, "")}/api/v1/webhooks/` +
      `${encodeURIComponent(workspace.lEndpointId)}/messages`;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-secret": workspace.lEndpointSecret,
        },
        body: JSON.stringify({
          external_id: opts.externalId,
          message: opts.message,
          // Present only for threads that already exist on the l side. Absent,
          // l finds-or-creates its own conversation keyed by external_id —
          // which is what a social thread wants: one stable l conversation per
          // CRM thread, so the agent keeps its context across turns.
          ...(opts.sessionId ? { session_id: opts.sessionId } : {}),
        }),
        signal: AbortSignal.timeout(LAgentService.TIMEOUT_MS),
      });

      if (!res.ok) {
        this.logger.warn(`l returned ${res.status} for conversation ${opts.externalId}`);
        return null;
      }
      const payload = (await res.json()) as { answer?: unknown };
      if (typeof payload.answer !== "string" || payload.answer.length === 0) {
        this.logger.warn(`l returned no answer for conversation ${opts.externalId}`);
        return null;
      }
      return payload.answer;
    } catch (err) {
      this.logger.warn(
        `Could not reach l for conversation ${opts.externalId}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return null;
    }
  }
}
