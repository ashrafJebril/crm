import { HttpException, Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { WhatsAppService } from "../../integrations/whatsapp.service";
import { ZernioService } from "../../integrations/zernio.service";
import { ChannelResolver } from "../../channels/channel-resolver.service";
import { SendWhatsappTemplateConfig } from "../workflow-steps";
import { resolveVariables, RunContext } from "../workflow-variables";
import { chooseVariant, pickLanguage } from "../../lifecycle/lifecycle-language";
import type { LifecycleLang } from "../../lifecycle/lifecycle-catalog";

/** Why a template step sent nothing (recorded in the run result). */
export type TemplateSkipReason = "channel_disconnected" | "template_not_approved" | "template_not_found";

/**
 * Sends an approved WhatsApp template into the customer's WhatsApp chat.
 *
 * Target chat, in order: the trigger's own WhatsApp conversation, the
 * ticket's conversation, then the contact's most recent WhatsApp chat (sale
 * and appointment triggers carry only a contact). The transport follows the
 * chat's own channel (SP-19), like the Inbox does: Zernio or our Meta app.
 * Neither can open a brand-new chat here, so a customer who has never
 * messaged the business fails with a reason the Runs tab can show.
 *
 * SP-24:
 *  - the channel comes from `forSend` (ruling 8, SP-19 R9): a disconnected or
 *    unconnected number is a recorded skip `channel_disconnected`, never a
 *    reroute to another number. This applies to every workflow;
 *  - with `variants`, the language follows the conversation's last inbound
 *    message (else the workspace), and only an approved variant is sent,
 *    falling back to the other approved one, else skip `template_not_approved`
 *    (`template_not_found` when neither template exists here).
 */
@Injectable()
export class SendWhatsappTemplateExecutor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly zernio: ZernioService,
    private readonly meta: WhatsAppService,
    private readonly channels: ChannelResolver,
  ) {}

  async execute(workspaceId: string, config: SendWhatsappTemplateConfig, context: RunContext): Promise<Record<string, unknown>> {
    const conversationId = await this.resolveConversationId(workspaceId, context);
    if (!conversationId) {
      throw new Error(
        "This customer has no WhatsApp chat with the business yet, so the template can't be delivered. They need to message you first.",
      );
    }

    // SP-19 R9: the conversation's own number, or nothing.
    let channel: { provider: string };
    try {
      channel = await this.channels.forConversationSend(workspaceId, conversationId);
    } catch (e) {
      const key = e instanceof HttpException ? (e.getResponse() as { message?: string })?.message : undefined;
      if (key === "channels.disconnected" || key === "channels.not_connected") {
        return { skipped: true, reason: "channel_disconnected" satisfies TemplateSkipReason, conversationId };
      }
      throw e;
    }

    let name = config.name;
    let language = config.language;
    let rawVariables = config.variables;
    let chosen: LifecycleLang | null = null;
    if (config.variants && Object.keys(config.variants).length > 0) {
      const pick = await this.pickVariant(workspaceId, conversationId, config.variants);
      if ("skip" in pick) return { skipped: true, reason: pick.skip, conversationId };
      name = pick.variant.name;
      language = pick.variant.language;
      rawVariables = pick.variant.variables ?? config.variables;
      chosen = pick.lang;
    }

    // Meta rejects template parameters containing newlines or tabs.
    const variables = rawVariables.map((v) =>
      resolveVariables(v, context)
        .replace(/\s*[\r\n]+\s*/g, " · ")
        .replace(/\t/g, " ")
        .trim(),
    );

    const extra = chosen ? { language: chosen, template: name } : {};
    if (channel.provider === "zernio") {
      const res = await this.zernio.sendTemplateInDbConversation(workspaceId, conversationId, name, language, variables);
      return { ok: true, id: res.id ?? null, conversationId, ...extra };
    }
    const res = await this.meta.sendTemplateInConversation(workspaceId, conversationId, name, language, variables);
    return { ok: true, id: res.wamid || null, conversationId, ...extra };
  }

  /** Language from the last inbound message, then the approval gate. */
  private async pickVariant(
    workspaceId: string,
    conversationId: string,
    variants: NonNullable<SendWhatsappTemplateConfig["variants"]>,
  ): Promise<{ lang: LifecycleLang; variant: { name: string; language: string; variables?: string[] } } | { skip: TemplateSkipReason }> {
    const [last, ws, templates] = await Promise.all([
      this.prisma.message.findFirst({
        where: { workspaceId, conversationId, from: "them" },
        orderBy: { createdAt: "desc" },
        select: { body: true },
      }),
      this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { lang: true } }),
      this.prisma.template.findMany({
        where: { workspaceId, name: { in: Object.values(variants).map((v) => v!.name) } },
        select: { name: true, status: true },
      }),
    ]);
    const statusByName = new Map(templates.map((t) => [t.name, t.status]));
    const statuses: Partial<Record<LifecycleLang, string | null>> = {};
    for (const lang of ["ar", "en"] as const) {
      const v = variants[lang];
      if (v) statuses[lang] = statusByName.get(v.name) ?? null;
    }
    const preferred = pickLanguage({ lastInboundBody: last?.body ?? null, workspaceLang: ws?.lang ?? null });
    const choice = chooseVariant(variants, statuses, preferred);
    if (choice) return choice;
    return { skip: templates.length === 0 ? "template_not_found" : "template_not_approved" };
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
