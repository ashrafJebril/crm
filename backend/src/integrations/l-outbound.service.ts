import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeService } from "../realtime/realtime.service";

/**
 * The CRM half of the round trip: a human's reply going back to the l agent.
 *
 * l already pushes agent turns here (see l-webhooks.service). This is the
 * return leg — without it a reply typed in the inbox reaches nobody, and the
 * person waiting in the l chat never hears back.
 *
 * Delivery runs off the response path on purpose. The reply is already
 * persisted by the time we are called, and the l side runs a model turn that
 * takes seconds; blocking the inbox's POST on that would stall the UI for
 * every message. The answer is written when it arrives and the inbox is
 * nudged over the realtime channel, the same way an inbound webhook does it.
 */
@Injectable()
export class LOutboundService {
  private readonly logger = new Logger(LOutboundService.name);

  // An l turn invokes a model, so this is a model's latency, not an HTTP hop's.
  private static readonly TIMEOUT_MS = 30_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * Schedules delivery and returns immediately. Never throws: a failure here
   * must not turn a saved reply into a failed request.
   */
  queueReply(workspaceId: string, conversationId: string, body: string): void {
    void this.forwardReply(workspaceId, conversationId, body).catch((err) => {
      this.logger.error(
        `Unhandled failure forwarding reply for conversation ${conversationId}`,
        err instanceof Error ? err.stack : String(err),
      );
    });
  }

  async forwardReply(
    workspaceId: string,
    conversationId: string,
    body: string,
  ): Promise<void> {
    const baseUrl = process.env.L_API_URL;
    if (!baseUrl) return;

    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, workspaceId },
      select: { id: true, channel: true, lConversationId: true },
    });
    // Only conversations that came from l have somewhere to go back to.
    if (!conversation?.lConversationId) return;

    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { lEndpointId: true, lEndpointSecret: true },
    });
    if (!workspace?.lEndpointId || !workspace.lEndpointSecret) {
      this.logger.warn(
        `Conversation ${conversationId} came from l but workspace ${workspaceId} ` +
          `has no l webhook endpoint configured; reply not forwarded`,
      );
      return;
    }

    const url =
      `${baseUrl.replace(/\/$/, "")}/api/v1/webhooks/` +
      `${encodeURIComponent(workspace.lEndpointId)}/messages`;

    let answer: string;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-secret": workspace.lEndpointSecret,
        },
        body: JSON.stringify({
          // Our conversation id is the caller's own handle on the l side.
          external_id: conversation.id,
          message: body,
          // The whole point: continue the chat the person is already in
          // rather than opening a second, parallel one.
          session_id: conversation.lConversationId,
        }),
        signal: AbortSignal.timeout(LOutboundService.TIMEOUT_MS),
      });

      if (!res.ok) {
        this.logger.warn(
          `l returned ${res.status} for conversation ${conversationId}; reply not delivered`,
        );
        return;
      }
      const payload = (await res.json()) as { answer?: unknown };
      if (typeof payload.answer !== "string" || payload.answer.length === 0) {
        this.logger.warn(
          `l returned no answer for conversation ${conversationId}`,
        );
        return;
      }
      answer = payload.answer;
    } catch (err) {
      this.logger.warn(
        `Could not reach l for conversation ${conversationId}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return;
    }

    const now = new Date();
    const t = `${String(now.getHours()).padStart(2, "0")}:${String(
      now.getMinutes(),
    ).padStart(2, "0")}`;

    await this.prisma.message.create({
      data: {
        conversationId: conversation.id,
        workspaceId,
        from: "ai",
        t,
        body: answer,
      },
    });
    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: { preview: answer.slice(0, 140), lastAt: "now", lastFrom: "ai" },
    });

    // The inbox is already rendered by the time this lands, so it has to be
    // told; otherwise the answer sits in the database unseen until a refresh.
    this.realtime.emitToWorkspace(workspaceId, "inbox.activity", {
      channel: conversation.channel,
      conversationId: conversation.id,
    });
  }
}
