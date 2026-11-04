import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { WhatsAppService } from "../../integrations/whatsapp.service";
import { ZernioService } from "../../integrations/zernio.service";
import { SendWhatsappTemplateConfig } from "../workflow-steps";
import { resolveVariables, RunContext } from "../workflow-variables";

/**
 * Sends an approved WhatsApp template into the customer's WhatsApp chat.
 *
 * Target chat, in order: the trigger's own WhatsApp conversation, the
 * ticket's conversation, then the contact's most recent WhatsApp chat (sale
 * and appointment triggers carry only a contact). The transport follows the
 * workspace's WhatsApp integration, like the Inbox does: Zernio or our Meta
 * app. Neither can open a brand-new chat here, so a customer who has never
 * messaged the business fails with a reason the Runs tab can show.
 */
@Injectable()
export class SendWhatsappTemplateExecutor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly zernio: ZernioService,
    private readonly meta: WhatsAppService,
  ) {}

  async execute(
    workspaceId: string,
    config: SendWhatsappTemplateConfig,
    context: RunContext,
  ): Promise<{ ok: true; id: string | null; conversationId: string }> {
    // Meta rejects template parameters containing newlines or tabs.
    const variables = config.variables.map((v) =>
      resolveVariables(v, context)
        .replace(/\s*[\r\n]+\s*/g, " · ")
        .replace(/\t/g, " ")
        .trim(),
    );

    const conversationId = await this.resolveConversationId(workspaceId, context);
    if (!conversationId) {
      throw new Error(
        "This customer has no WhatsApp chat with the business yet, so the template can't be delivered. They need to message you first.",
      );
    }

    const integration = await this.prisma.integration.findFirst({
      where: { workspaceId, platform: "whatsapp" },
      select: { provider: true },
    });
    if (!integration) throw new Error("WhatsApp is not connected for this workspace");

    if (integration.provider === "zernio") {
      const res = await this.zernio.sendTemplateInDbConversation(
        workspaceId,
        conversationId,
        config.name,
        config.language,
        variables,
      );
      return { ok: true, id: res.id ?? null, conversationId };
    }
    const res = await this.meta.sendTemplateInConversation(
      workspaceId,
      conversationId,
      config.name,
      config.language,
      variables,
    );
    return { ok: true, id: res.wamid || null, conversationId };
  }

  private async resolveConversationId(workspaceId: string, context: RunContext): Promise<string | null> {
    const trigger = context.trigger;
    const conversation = trigger.conversation as { id?: string; channel?: string } | undefined;
    if (conversation?.id && (conversation.channel ?? "whatsapp").toLowerCase() === "whatsapp") return conversation.id;

    const ticket = trigger.ticket as { conversationId?: string | null; contactId?: string } | undefined;
    if (ticket?.conversationId) return ticket.conversationId;

    const contactId =
      (trigger.contact as { id?: string } | undefined)?.id ??
      ticket?.contactId ??
      (trigger.appointment as { contactId?: string } | undefined)?.contactId;
    if (!contactId) return null;

    const latest = await this.prisma.conversation.findFirst({
      where: { workspaceId, contactId, channel: "whatsapp" },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    });
    return latest?.id ?? null;
  }
}
