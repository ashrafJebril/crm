import { Injectable } from "@nestjs/common";
import { ZernioService } from "../../integrations/zernio.service";
import { SendWhatsappConfig } from "../workflow-steps";
import { resolveVariables, RunContext } from "../workflow-variables";

@Injectable()
export class SendWhatsappExecutor {
  constructor(private readonly zernio: ZernioService) {}

  async execute(
    workspaceId: string,
    config: SendWhatsappConfig,
    context: RunContext,
  ): Promise<{ ok: true; id: string | null }> {
    const message = resolveVariables(config.message, context);
    const conversationId = this.resolveConversationId(context);
    if (!conversationId) {
      throw new Error("Send WhatsApp step needs a conversation in the trigger context");
    }
    return this.zernio.sendInDbConversation(workspaceId, conversationId, message) as Promise<
      { ok: true; id: string | null }
    >;
  }

  private resolveConversationId(context: RunContext): string | undefined {
    const conversation = context.trigger.conversation as { id?: string } | undefined;
    if (conversation?.id) return conversation.id;
    const ticket = context.trigger.ticket as { conversationId?: string } | undefined;
    return ticket?.conversationId ?? undefined;
  }
}
