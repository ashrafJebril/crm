import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AiReplyService } from "../ai/ai-reply.service";
import type { ConnectWhatsAppDto } from "./whatsapp.dto";

const GRAPH = "https://graph.facebook.com/v21.0";

interface WaPhoneInfo {
  id: string;
  display_phone_number?: string;
  verified_name?: string;
}

interface WebhookEntryChangeValue {
  messaging_product?: string;
  metadata?: {
    display_phone_number?: string;
    phone_number_id: string;
  };
  contacts?: Array<{
    wa_id: string;
    profile?: { name?: string };
  }>;
  messages?: Array<{
    from: string; // sender's wa_id (phone, digits only)
    id: string; // wamid.*
    timestamp: string;
    type: string; // "text" | "image" | "audio" | "document" | ...
    text?: { body: string };
    image?: { id: string; caption?: string; mime_type?: string };
    audio?: { id: string; mime_type?: string };
    document?: { id: string; filename?: string; mime_type?: string };
  }>;
  statuses?: Array<{
    id: string;
    status: "sent" | "delivered" | "read" | "failed";
    timestamp: string;
    recipient_id: string;
  }>;
}

// Meta sends a different `value` shape for template status updates than for
// inbound messages — typed separately so the webhook handler can dispatch on
// `change.field`.
interface TemplateStatusValue {
  event?: "APPROVED" | "REJECTED" | "FLAGGED" | "PAUSED" | "PENDING_DELETION" | "DISABLED" | string;
  message_template_id?: string | number;
  message_template_name?: string;
  message_template_language?: string;
  reason?: string;
}

interface WebhookPayload {
  object?: string;
  entry?: Array<{
    id: string;
    changes?: Array<{
      value?: WebhookEntryChangeValue | TemplateStatusValue;
      field?: string;
    }>;
  }>;
}

// ─── Outbound template payload (sent to Graph API) ─────────────────────────
export interface SubmitTemplateInput {
  name: string;
  lang: "en" | "ar";
  category: "TRANSACTIONAL" | "UTILITY" | "MARKETING" | "AUTHENTICATION";
  body: string;
  footer?: string;
  headerType?: "text" | "image" | "video" | "document";
  headerContent?: string;
  buttons?: TemplateButton[];
}

export type TemplateButton =
  | { type: "QUICK_REPLY"; text: string }
  | { type: "URL"; text: string; url: string }
  | { type: "PHONE_NUMBER"; text: string; phone_number: string };

// Meta-language code mapping. WhatsApp wants a BCP-47-ish code; we map our 2-letter
// language to Meta's expected variants. Customers can later override if needed.
const LANG_TO_META: Record<"en" | "ar", string> = {
  en: "en_US",
  ar: "ar",
};

@Injectable()
export class WhatsAppService {
  private readonly log = new Logger(WhatsAppService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiReply: AiReplyService,
  ) {}

  // ─── Public REST API ───────────────────────────────────────────────────
  async status(workspaceId: string) {
    const integ = await this.find(workspaceId);
    if (!integ) return { connected: false };
    const raw = this.parseRaw(integ.raw);
    return {
      connected: true,
      phoneNumberId: integ.pageId,
      displayPhoneNumber: raw.displayPhoneNumber ?? integ.pageName,
      wabaId: raw.wabaId,
      verifyToken: raw.verifyToken,
      expiresAt: integ.expiresAt,
      lastFetchedAt: integ.lastFetchedAt,
    };
  }

  async connect(workspaceId: string, dto: ConnectWhatsAppDto) {
    // Validate the credentials by fetching the phone-number record from Meta.
    const info = await this.graphGet<WaPhoneInfo>(
      `/${dto.phoneNumberId}?fields=id,display_phone_number,verified_name`,
      dto.accessToken,
    );
    if (info?.id !== dto.phoneNumberId) {
      throw new BadRequestException("Token did not resolve to this phone-number id");
    }
    const displayName =
      dto.displayPhoneNumber ??
      info.display_phone_number ??
      info.verified_name ??
      "WhatsApp number";

    const data = {
      platform: "whatsapp",
      pageId: dto.phoneNumberId,
      pageName: displayName,
      accessToken: dto.accessToken,
      scopes: null,
      expiresAt: null,
      raw: JSON.stringify({
        wabaId: dto.wabaId,
        verifyToken: dto.verifyToken,
        displayPhoneNumber: info.display_phone_number ?? null,
        verifiedName: info.verified_name ?? null,
      }),
    };

    const existing = await this.find(workspaceId);
    const row = existing
      ? await this.prisma.integration.update({ where: { id: existing.id }, data })
      : await this.prisma.integration.create({ data: { ...data, workspaceId } });

    // Subscribe our Meta app to this WABA so webhooks actually fire. Without
    // this call the customer would see "connected" in tkana but inbound
    // messages would silently never arrive — exactly the symptom we hit in
    // our own setup. Best-effort: log + return a soft flag instead of failing
    // the connect, so the customer can still retry from the UI.
    const subscribed = await this.subscribeAppToWaba(dto.wabaId, dto.accessToken);

    return {
      connected: true,
      phoneNumberId: row.pageId,
      displayPhoneNumber: displayName,
      wabaId: dto.wabaId,
      verifyToken: dto.verifyToken,
      webhookSubscribed: subscribed.ok,
      webhookError: subscribed.ok ? undefined : subscribed.error,
    };
  }

  async disconnect(workspaceId: string) {
    const integ = await this.find(workspaceId);
    if (!integ) return { ok: true };
    // Best-effort unsubscribe before deleting. Don't block delete on failure
    // — token may already be invalid, WABA may be removed, etc.
    const raw = this.parseRaw(integ.raw);
    if (raw.wabaId && integ.accessToken) {
      try {
        await this.unsubscribeAppFromWaba(raw.wabaId, integ.accessToken);
      } catch (e) {
        this.log.warn(`Unsubscribe failed (continuing delete): ${(e as Error).message}`);
      }
    }
    await this.prisma.integration.delete({ where: { id: integ.id } });
    return { ok: true };
  }

  /**
   * Subscribe our Meta app to a WhatsApp Business Account. Required so the
   * WABA actually fires webhooks for messages sent to its phone numbers —
   * Meta does not infer the subscription from configuring the app's webhook
   * callback URL alone.
   */
  private async subscribeAppToWaba(
    wabaId: string,
    token: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const url = `${GRAPH}/${wabaId}/subscribed_apps`;
      const res = await this.fetchJson<{ success: boolean }>(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.success !== true) {
        return { ok: false, error: "Subscribe returned success=false" };
      }
      return { ok: true };
    } catch (e) {
      const msg = (e as Error).message;
      this.log.warn(`subscribe_apps failed for waba=${wabaId}: ${msg}`);
      return { ok: false, error: msg };
    }
  }

  private async unsubscribeAppFromWaba(wabaId: string, token: string): Promise<void> {
    const url = `${GRAPH}/${wabaId}/subscribed_apps`;
    await this.fetchJson(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  // ─── Outbound sends ────────────────────────────────────────────────────
  async sendText(workspaceId: string, toWaId: string, body: string) {
    const { token, phoneNumberId } = await this.requireToken(workspaceId);
    const url = `${GRAPH}/${phoneNumberId}/messages`;
    const payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: toWaId,
      type: "text",
      text: { preview_url: false, body },
    };
    const res = await this.fetchJson<{ messages?: Array<{ id: string }> }>(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
    return { wamid: res.messages?.[0]?.id ?? "", ok: true };
  }

  /**
   * Send via an existing internal Conversation (channel=whatsapp). Resolves the
   * recipient wa_id from the linked Contact's externalId, sends to Meta, then
   * appends a Message(from=human) so the thread updates immediately.
   */
  async sendInConversation(
    workspaceId: string,
    conversationId: string,
    body: string,
  ) {
    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, workspaceId },
      include: { contact: true },
    });
    if (!conv) throw new NotFoundException("Conversation not found");
    if (conv.channel !== "whatsapp") {
      throw new BadRequestException("Conversation is not a WhatsApp thread");
    }
    const waId = conv.contact.externalId ?? conv.contact.phone ?? null;
    if (!waId) {
      throw new BadRequestException(
        "Contact has no WhatsApp id (externalId/phone) — cannot deliver",
      );
    }

    const sent = await this.sendText(workspaceId, this.normalizeWaId(waId), body);

    const now = new Date();
    const t = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    await this.prisma.message.create({
      data: {
        conversationId,
        workspaceId,
        from: "human",
        body,
        t,
      },
    });
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        preview: body.slice(0, 140),
        lastAt: "now",
        lastFrom: "human",
        unread: 0,
      },
    });
    return sent;
  }

  // ─── Templates (submit to Meta) ────────────────────────────────────────
  /**
   * Submit a template to Meta for review. Stores the returned `metaTemplateId`
   * on the local row so subsequent status-update webhooks can locate it.
   *
   * Returns the created Template row. Throws if WhatsApp isn't connected or if
   * Meta rejects the request synchronously (validation errors).
   */
  async submitTemplate(workspaceId: string, dto: SubmitTemplateInput) {
    const { token, wabaId } = await this.requireWaba(workspaceId);

    // Build the components array Meta expects. Order matters per their docs:
    // HEADER → BODY → FOOTER → BUTTONS. BODY is the only required component.
    type Component =
      | { type: "HEADER"; format: "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT"; text?: string; example?: { header_handle?: string[]; header_text?: string[] } }
      | { type: "BODY"; text: string; example?: { body_text?: string[][] } }
      | { type: "FOOTER"; text: string }
      | { type: "BUTTONS"; buttons: TemplateButton[] };

    const components: Component[] = [];

    if (dto.headerType && dto.headerContent) {
      if (dto.headerType === "text") {
        components.push({ type: "HEADER", format: "TEXT", text: dto.headerContent });
      } else {
        components.push({
          type: "HEADER",
          format: dto.headerType.toUpperCase() as "IMAGE" | "VIDEO" | "DOCUMENT",
          example: { header_handle: [dto.headerContent] },
        });
      }
    }

    components.push({ type: "BODY", text: dto.body });

    if (dto.footer) {
      components.push({ type: "FOOTER", text: dto.footer });
    }

    if (dto.buttons && dto.buttons.length > 0) {
      components.push({ type: "BUTTONS", buttons: dto.buttons });
    }

    const payload = {
      name: dto.name,
      language: LANG_TO_META[dto.lang],
      category: dto.category,
      components,
    };

    let metaTemplateId: string | null = null;
    let submitStatus: "submitted" | "failed" = "submitted";
    let rejectionReason: string | null = null;

    try {
      const res = await this.graphPost<{ id: string; status?: string; category?: string }>(
        `/${wabaId}/message_templates`,
        token,
        payload,
      );
      metaTemplateId = res.id;
    } catch (e) {
      // Meta returns 400 for validation failures with a useful error message.
      // Persist the row anyway so the customer can see what went wrong in the UI,
      // marked status=failed with the reason.
      submitStatus = "failed";
      rejectionReason = (e as Error).message;
      this.log.warn(
        `Template submit failed for waba=${wabaId} name=${dto.name}: ${rejectionReason}`,
      );
    }

    const buttonsJson = dto.buttons && dto.buttons.length > 0 ? JSON.stringify(dto.buttons) : null;
    const row = await this.prisma.template.create({
      data: {
        workspaceId,
        name: dto.name,
        lang: dto.lang,
        category: dto.category,
        status: submitStatus,
        uses: 0,
        body: dto.body,
        footer: dto.footer ?? null,
        headerType: dto.headerType ?? null,
        headerContent: dto.headerContent ?? null,
        buttons: buttonsJson,
        metaTemplateId,
        metaRejectionReason: rejectionReason,
        submittedAt: new Date(),
      },
    });
    return row;
  }

  // ─── Webhook (public) ──────────────────────────────────────────────────
  /**
   * Meta's verification handshake — GET with hub.mode / hub.verify_token /
   * hub.challenge. We echo the challenge iff token matches *any* connected
   * workspace's verifyToken (we don't know which workspace the GET is for).
   */
  async verifyWebhook(mode: string, token: string, challenge: string) {
    if (mode !== "subscribe") throw new BadRequestException("Bad mode");
    const rows = await this.prisma.integration.findMany({
      where: { platform: "whatsapp" },
    });
    const ok = rows.some((r) => this.parseRaw(r.raw).verifyToken === token);
    if (!ok) throw new BadRequestException("Verify token mismatch");
    return challenge;
  }

  async handleWebhook(payload: WebhookPayload) {
    if (payload.object !== "whatsapp_business_account") return { ok: true, skipped: true };
    const entries = payload.entry ?? [];
    let processed = 0;
    for (const entry of entries) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        if (!value) continue;

        // Template lifecycle webhooks (APPROVED / REJECTED / FLAGGED / DISABLED).
        // Meta sets `field: "message_template_status_update"` and a `value` shape
        // unrelated to inbound messages.
        if (change.field === "message_template_status_update") {
          await this.handleTemplateStatusUpdate(value as TemplateStatusValue);
          processed += 1;
          continue;
        }

        // Inbound messages / delivery statuses (field: "messages").
        const v = value as WebhookEntryChangeValue;
        const phoneNumberId = v.metadata?.phone_number_id;
        if (!phoneNumberId) continue;
        const integ = await this.prisma.integration.findFirst({
          where: { platform: "whatsapp", pageId: phoneNumberId },
        });
        if (!integ) {
          this.log.warn(
            `Webhook for unknown phone_number_id=${phoneNumberId} — no integration matched`,
          );
          continue;
        }
        const messages = v.messages ?? [];
        const profileByWaId = new Map<string, string | undefined>();
        for (const c of v.contacts ?? []) {
          profileByWaId.set(c.wa_id, c.profile?.name);
        }
        for (const msg of messages) {
          await this.ingestInbound(integ.workspaceId, msg, profileByWaId.get(msg.from));
          processed += 1;
        }
        if (v.statuses?.length) {
          // Statuses (sent/delivered/read/failed) — no Message.status field in
          // schema today; log only. Wire to a Message.deliveryStatus follow-up.
          this.log.debug(
            `WA statuses for workspace=${integ.workspaceId}: ${v.statuses
              .map((s) => `${s.id}:${s.status}`)
              .join(",")}`,
          );
        }
        await this.prisma.integration.update({
          where: { id: integ.id },
          data: { lastFetchedAt: new Date() },
        });
      }
    }
    return { ok: true, processed };
  }

  /**
   * Apply a Meta `message_template_status_update` webhook. Meta references the
   * template by id (and sometimes only by name+language), so we look up by id
   * first and fall back to name+lang. We don't know the workspace, but the
   * (name, lang) pair is workspace-unique in practice; if a collision occurs
   * across tenants it's harmless — both rows get the same Meta-driven status.
   */
  private async handleTemplateStatusUpdate(value: TemplateStatusValue) {
    const event = (value.event ?? "").toUpperCase();
    const status = this.mapTemplateEvent(event);
    if (!status) {
      this.log.debug(`Ignoring template event=${event}`);
      return;
    }

    const metaId = value.message_template_id != null ? String(value.message_template_id) : null;
    const where = metaId
      ? { metaTemplateId: metaId }
      : value.message_template_name
        ? { name: value.message_template_name, lang: this.metaLangToLocal(value.message_template_language) }
        : null;
    if (!where) {
      this.log.warn("Template status update with no id or name — skipping");
      return;
    }

    const rows = await this.prisma.template.findMany({ where });
    if (rows.length === 0) {
      this.log.warn(
        `Template status update for unknown template id=${metaId} name=${value.message_template_name}`,
      );
      return;
    }
    for (const row of rows) {
      await this.prisma.template.update({
        where: { id: row.id },
        data: {
          status,
          metaRejectionReason: status === "rejected" ? value.reason ?? null : null,
          reviewedAt: new Date(),
        },
      });
    }
  }

  private mapTemplateEvent(event: string): string | null {
    switch (event) {
      case "APPROVED":
        return "approved";
      case "REJECTED":
        return "rejected";
      case "FLAGGED":
      case "PAUSED":
      case "DISABLED":
        return "paused";
      case "PENDING_DELETION":
        return "pending";
      default:
        return null;
    }
  }

  private metaLangToLocal(meta: string | undefined): string {
    if (!meta) return "en";
    if (meta.startsWith("ar")) return "ar";
    return "en";
  }

  private async ingestInbound(
    workspaceId: string,
    msg: NonNullable<WebhookEntryChangeValue["messages"]>[number],
    profileName: string | undefined,
  ) {
    const waId = msg.from;
    const contactName = profileName?.trim() || `WhatsApp ${this.maskPhone(waId)}`;

    const contact = await this.prisma.contact.upsert({
      where: {
        workspaceId_externalSource_externalId: {
          workspaceId,
          externalSource: "whatsapp",
          externalId: waId,
        },
      },
      create: {
        workspaceId,
        name: contactName,
        phone: `+${waId}`,
        industry: "whatsapp",
        lifecycle: "lead",
        source: "whatsapp",
        lastSeen: "now",
        externalSource: "whatsapp",
        externalId: waId,
      },
      update: {
        name: profileName?.trim() ? profileName.trim() : undefined,
        lastSeen: "now",
      },
    });

    let conv = await this.prisma.conversation.findFirst({
      where: { workspaceId, contactId: contact.id, channel: "whatsapp" },
    });
    const body = this.extractBody(msg);
    const previewBase = body || `[${msg.type}]`;
    if (!conv) {
      conv = await this.prisma.conversation.create({
        data: {
          workspaceId,
          contactId: contact.id,
          agent: "",
          unread: 1,
          pinned: false,
          lastAt: "now",
          lastFrom: "them",
          preview: previewBase.slice(0, 140),
          channel: "whatsapp",
          status: "human",
          intent: "—",
          confidence: 0,
        },
      });
    } else {
      await this.prisma.conversation.update({
        where: { id: conv.id },
        data: {
          preview: previewBase.slice(0, 140),
          lastAt: "now",
          lastFrom: "them",
          unread: { increment: 1 },
        },
      });
    }

    const ts = Number(msg.timestamp) * 1000;
    const d = Number.isFinite(ts) ? new Date(ts) : new Date();
    const t = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const inboundRow = await this.prisma.message.create({
      data: {
        workspaceId,
        conversationId: conv.id,
        from: "them",
        body: body || `[${msg.type} message]`,
        t,
      },
    });

    if (body) {
      try {
        await this.maybeAutoReply({
          workspaceId,
          conversationId: conv.id,
          contactName: contact.name,
          waId,
          inboundMessageId: inboundRow.id,
          inboundText: body,
        });
      } catch (e) {
        this.log.warn(
          `AI auto-reply failed for conv=${conv.id}: ${(e as Error).message}`,
        );
      }
    }
  }

  private async maybeAutoReply(ctx: {
    workspaceId: string;
    conversationId: string;
    contactName: string;
    waId: string;
    inboundMessageId: string;
    inboundText: string;
  }) {
    const ws = await this.prisma.workspace.findUnique({
      where: { id: ctx.workspaceId },
      select: { aiAutoReplyEnabled: true, aiConfidenceThreshold: true },
    });
    if (!ws?.aiAutoReplyEnabled) return;

    const outcome = await this.aiReply.generate({
      workspaceId: ctx.workspaceId,
      conversationId: ctx.conversationId,
      inboundMessageId: ctx.inboundMessageId,
      inboundText: ctx.inboundText,
      contactName: ctx.contactName,
    });

    const threshold =
      ws.aiConfidenceThreshold ??
      Number(process.env.AI_REPLY_CONFIDENCE_THRESHOLD ?? 0.75);
    const escalate = this.aiReply.shouldEscalate(outcome, threshold);

    if (escalate) {
      await this.prisma.conversation.update({
        where: { id: ctx.conversationId },
        data: {
          escalated: true,
          status: "human",
          intent: outcome.escalationReason ?? "ai-escalated",
          confidence: outcome.confidence,
        },
      });
      await this.prisma.aiReply.create({
        data: {
          workspaceId: ctx.workspaceId,
          conversationId: ctx.conversationId,
          inboundMessageId: ctx.inboundMessageId,
          outboundMessageId: null,
          action: "escalate",
          replyText: null,
          confidence: outcome.confidence,
          needsEscalation: true,
          escalationReason: outcome.escalationReason,
          usedKnowledge: outcome.usedKnowledge,
          missingInformation: outcome.missingInformation,
          modelName: outcome.modelName,
          promptTokens: outcome.promptTokens,
          completionTokens: outcome.completionTokens,
          sources: JSON.stringify(outcome.sources),
        },
      });
      return;
    }

    // Send the AI reply via Meta.
    const { token, phoneNumberId } = await this.requireToken(ctx.workspaceId);
    await this.graphPost<{ messages?: Array<{ id: string }> }>(
      `/${phoneNumberId}/messages`,
      token,
      {
        messaging_product: "whatsapp",
        to: ctx.waId,
        type: "text",
        text: { body: outcome.reply },
      },
    );

    const now = new Date();
    const tOut = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const outboundRow = await this.prisma.message.create({
      data: {
        workspaceId: ctx.workspaceId,
        conversationId: ctx.conversationId,
        from: "ai",
        body: outcome.reply!,
        t: tOut,
        agent: "ai",
      },
    });
    await this.prisma.conversation.update({
      where: { id: ctx.conversationId },
      data: {
        lastAt: "now",
        lastFrom: "ai",
        preview: outcome.reply!.slice(0, 140),
        status: "ai",
        intent: "ai-reply",
        confidence: outcome.confidence,
      },
    });
    await this.prisma.aiReply.create({
      data: {
        workspaceId: ctx.workspaceId,
        conversationId: ctx.conversationId,
        inboundMessageId: ctx.inboundMessageId,
        outboundMessageId: outboundRow.id,
        action: "reply",
        replyText: outcome.reply,
        confidence: outcome.confidence,
        needsEscalation: false,
        escalationReason: null,
        usedKnowledge: outcome.usedKnowledge,
        missingInformation: outcome.missingInformation,
        modelName: outcome.modelName,
        promptTokens: outcome.promptTokens,
        completionTokens: outcome.completionTokens,
        sources: JSON.stringify(outcome.sources),
      },
    });
  }

  private extractBody(msg: NonNullable<WebhookEntryChangeValue["messages"]>[number]): string {
    if (msg.type === "text") return msg.text?.body ?? "";
    if (msg.type === "image") return msg.image?.caption ?? "";
    if (msg.type === "document") return msg.document?.filename ?? "";
    return "";
  }

  private maskPhone(waId: string): string {
    if (waId.length <= 4) return waId;
    return `…${waId.slice(-4)}`;
  }

  private normalizeWaId(input: string): string {
    return input.replace(/[^\d]/g, "");
  }

  // ─── Internals ─────────────────────────────────────────────────────────
  private async find(workspaceId: string) {
    return this.prisma.integration.findFirst({
      where: { workspaceId, platform: "whatsapp" },
    });
  }

  private async requireToken(
    workspaceId: string,
  ): Promise<{ token: string; phoneNumberId: string }> {
    const integ = await this.find(workspaceId);
    if (!integ?.accessToken || !integ.pageId) {
      throw new NotFoundException("WhatsApp is not connected");
    }
    return { token: integ.accessToken, phoneNumberId: integ.pageId };
  }

  /** Like `requireToken` but also requires a `wabaId` (for template management). */
  private async requireWaba(
    workspaceId: string,
  ): Promise<{ token: string; wabaId: string; phoneNumberId: string }> {
    const integ = await this.find(workspaceId);
    if (!integ?.accessToken || !integ.pageId) {
      throw new NotFoundException("WhatsApp is not connected");
    }
    const raw = this.parseRaw(integ.raw);
    if (!raw.wabaId) {
      throw new BadRequestException(
        "WhatsApp Business Account id missing — reconnect with a WABA id",
      );
    }
    return { token: integ.accessToken, wabaId: raw.wabaId, phoneNumberId: integ.pageId };
  }

  private parseRaw(raw: string | null): {
    wabaId?: string;
    verifyToken?: string;
    displayPhoneNumber?: string | null;
    verifiedName?: string | null;
  } {
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  private async graphGet<T>(pathAndQuery: string, token: string): Promise<T> {
    const url = `${GRAPH}${pathAndQuery}`;
    return this.fetchJson<T>(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  private async graphPost<T>(path: string, token: string, body: unknown): Promise<T> {
    const url = `${GRAPH}${path}`;
    return this.fetchJson<T>(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  }

  private async fetchJson<T>(url: string, init: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (e) {
      this.log.error(`Graph network error: ${(e as Error).message}`);
      throw new HttpException("Graph API unreachable", 502);
    }
    const text = await res.text();
    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    if (!res.ok) {
      const errMsg =
        typeof parsed === "object" && parsed !== null && "error" in parsed
          ? // @ts-expect-error - shape from Graph API
            (parsed.error?.message as string) || `Graph error ${res.status}`
          : `Graph error ${res.status}`;
      this.log.warn(`Graph ${init.method ?? "GET"} ${url} -> ${res.status} ${errMsg}`);
      throw new HttpException(errMsg, res.status >= 500 ? 502 : 400);
    }
    return parsed as T;
  }
}
