import { Injectable } from "@nestjs/common";
import { LAgentService } from "../../integrations/l-agent.service";
import { AskAgentConfig } from "../workflow-steps";
import { resolveVariables, RunContext } from "../workflow-variables";

@Injectable()
export class AskAgentExecutor {
  constructor(private readonly lAgent: LAgentService) {}

  async execute(
    workspaceId: string,
    config: AskAgentConfig,
    context: RunContext,
  ): Promise<{ answer: string | null }> {
    const prompt = resolveVariables(config.prompt, context);
    const externalId = this.resolveExternalId(context);
    const answer = await this.lAgent.ask(workspaceId, { externalId, message: prompt });
    return { answer };
  }

  private resolveExternalId(context: RunContext): string {
    const conversation = context.trigger.conversation as { id?: string } | undefined;
    if (conversation?.id) return conversation.id;
    const ticket = context.trigger.ticket as { conversationId?: string } | undefined;
    if (ticket?.conversationId) return ticket.conversationId;
    const contact = context.trigger.contact as { id?: string } | undefined;
    if (contact?.id) return `workflow-${contact.id}`;
    throw new Error("Ask AI Agent step needs a conversation or contact in the trigger context");
  }
}
