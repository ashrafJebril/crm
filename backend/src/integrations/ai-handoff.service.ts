import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

/**
 * A staff member replying in a conversation takes it over from the AI: the
 * agent stops answering (every reply path checks Conversation.aiPausedAt)
 * until someone hands the thread back with the Inbox AI toggle.
 *
 * Called from the HTTP send endpoints the Inbox uses — not from the shared
 * channel send functions, because the AI's own replies and workflow sends go
 * through those too and must not pause it. ConversationsService.addMessage
 * does the same for messages posted with from "human".
 */
@Injectable()
export class AiHandoffService {
  constructor(private readonly prisma: PrismaService) {}

  async humanReplied(workspaceId: string, conversationId: string): Promise<void> {
    await this.prisma.conversation.updateMany({
      where: { id: conversationId, workspaceId },
      data: { aiPausedAt: new Date() },
    });
  }
}
