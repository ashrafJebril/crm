import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { redactUrl } from "../common/redact-url";
import { decryptSecret, encryptSecret } from "../common/token-crypto";
import { RealtimeService } from "../realtime/realtime.service";
import { MediaService } from "../media/media.service";
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
    private readonly realtime: RealtimeService,
    private readonly media: MediaService,
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

  /**
   * Complete WhatsApp Embedded Signup: exchange the `code` returned by Meta's
   * embedded signup popup for an access token, then store the credentials.
   * The popup gives us phoneNumberId + wabaId out-of-band via window.message.
   */
  async embeddedSignupExchange(
    workspaceId: string,
    code: string,
    phoneNumberId: string,
    wabaId: string,
  ) {
    const appId = process.env.META_APP_ID_WA ?? process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET_WA ?? process.env.META_APP_SECRET;
    if (!appId || !appSecret) {
      throw new BadRequestException(
        "META_APP_ID_WA / META_APP_SECRET_WA not configured for WhatsApp app",
      );
    }

    const tokenUrl =
      `${GRAPH}/oauth/access_token?client_id=${appId}` +
      `&client_secret=${appSecret}` +
      `&code=${encodeURIComponent(code)}`;
    const tokenRes = await this.fetchJson<{
      access_token: string;
      token_type?: string;
      expires_in?: number;
    }>(tokenUrl, { method: "GET" });
    if (!tokenRes.access_token) {
      throw new BadRequestException("Meta did not return an access token");
    }

    // Generate a verify token now — used when we configure webhooks later.
    const verifyToken = `aram-wa-${Math.random().toString(36).slice(2, 10)}`;

    return this.connect(workspaceId, {
      phoneNumberId,
      wabaId,
      accessToken: tokenRes.access_token,
      verifyToken,
    });
  }

  /**
   * Single-field connect: customer pastes ONE WhatsApp access token and we
   * discover their WABA + phone number ourselves via the Graph API. Works
   * for any token that carries `whatsapp_business_management` (Meta API
   * Setup page tokens already do).
   *
   * Strategy:
   *   1. Validate the token resolves to something (`/me`)
   *   2. List WhatsApp Business Accounts the user owns via /me/businesses
   *   3. If at least one WABA with at least one phone number → save the
   *      first pair. Multi-WABA / multi-number is rare in practice; we
   *      return the full list in the response so a future UI step can
   *      surface a picker, but the immediate save uses the first match.
   *   4. If nothing found → clear error pointing the customer to API Setup.
   */
  async connectByToken(workspaceId: string, accessToken: string) {
    const token = accessToken.trim();
    if (!token || token.length < 20) {
      throw new BadRequestException("Token looks too short to be a Meta access token");
    }

    // Step 1: prove the token is valid by hitting /me. We use the debug_token
    // endpoint instead to get the scopes back too — helps generate a useful
    // error if the token lacks the right permissions.
    let me: { id: string; name?: string } | null = null;
    try {
      me = await this.graphGet<{ id: string; name?: string }>(
        "/me?fields=id,name",
        token,
      );
    } catch (e) {
      throw new BadRequestException(
        `Token rejected by Meta: ${(e as Error).message}. Make sure you copied the WhatsApp temporary access token from WhatsApp Manager → API Setup, not a Facebook user token.`,
      );
    }
    if (!me?.id) {
      throw new BadRequestException("Token did not resolve to a Meta account");
    }

    interface DiscoveredPhone {
      id: string;
      display_phone_number?: string;
      verified_name?: string;
    }
    interface DiscoveredWaba {
      id: string;
      name?: string;
      phone_numbers?: { data: DiscoveredPhone[] };
    }
    interface DiscoveredBusiness {
      id: string;
      name?: string;
      owned_whatsapp_business_accounts?: { data: DiscoveredWaba[] };
    }

    const wabaIds = new Set<string>();

    // Strategy A: ask Meta's debug_token endpoint to decode the token. The
    // temporary access token on Meta's API Setup screen is a system-user
    // token scoped to a specific WABA — `/me/businesses` returns empty for
    // it. debug_token's granular_scopes carries the WABA id under
    // `whatsapp_business_management` / `whatsapp_business_messaging`'s
    // target_ids array.
    const appId = process.env.META_APP_ID_WA ?? process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET_WA ?? process.env.META_APP_SECRET;
    if (appId && appSecret) {
      interface GranularScope {
        scope: string;
        target_ids?: string[];
      }
      interface DebugTokenResp {
        data?: {
          app_id?: string;
          is_valid?: boolean;
          granular_scopes?: GranularScope[];
        };
      }
      try {
        const appToken = `${appId}|${appSecret}`;
        const debugRes = await this.fetchJson<DebugTokenResp>(
          `${GRAPH}/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(appToken)}`,
          { method: "GET" },
        );
        if (debugRes.data?.is_valid === false) {
          throw new BadRequestException(
            "Meta rejected this token (debug_token reports it as invalid). Make sure you copied the freshly generated temporary access token.",
          );
        }
        for (const scope of debugRes.data?.granular_scopes ?? []) {
          if (
            scope.scope === "whatsapp_business_management" ||
            scope.scope === "whatsapp_business_messaging"
          ) {
            for (const id of scope.target_ids ?? []) wabaIds.add(id);
          }
        }
      } catch (e) {
        this.log.warn(
          `debug_token failed (continuing to /me/businesses fallback): ${(e as Error).message}`,
        );
      }
    }

    // Strategy B fallback: User Access Tokens won't have granular_scopes;
    // discover via /me/businesses → owned_whatsapp_business_accounts. Only
    // tried if A didn't find anything.
    let businessFallback: { data: DiscoveredBusiness[] } = { data: [] };
    if (wabaIds.size === 0) {
      const fields =
        "id,name,owned_whatsapp_business_accounts{id,name,phone_numbers{id,display_phone_number,verified_name}}";
      try {
        businessFallback = await this.graphGet<{ data: DiscoveredBusiness[] }>(
          `/me/businesses?fields=${encodeURIComponent(fields)}`,
          token,
        );
      } catch (e) {
        this.log.warn(`/me/businesses failed: ${(e as Error).message}`);
      }
      for (const biz of businessFallback.data ?? []) {
        for (const waba of biz.owned_whatsapp_business_accounts?.data ?? []) {
          wabaIds.add(waba.id);
        }
      }
    }

    if (wabaIds.size === 0) {
      throw new BadRequestException(
        "No WhatsApp Business Account found on this token. Open Meta's WhatsApp Manager, go to API Setup, and copy the temporary access token shown there.",
      );
    }

    // For each discovered WABA, fetch its phone numbers from Graph.
    const wabas: DiscoveredWaba[] = [];
    for (const wabaId of wabaIds) {
      try {
        const meta = await this.graphGet<{ id: string; name?: string }>(
          `/${wabaId}?fields=id,name`,
          token,
        );
        const phones = await this.graphGet<{ data: DiscoveredPhone[] }>(
          `/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name`,
          token,
        );
        wabas.push({
          id: meta.id,
          name: meta.name,
          phone_numbers: { data: phones.data ?? [] },
        });
      } catch (e) {
        this.log.warn(
          `Failed to load WABA ${wabaId}: ${(e as Error).message}`,
        );
      }
    }
    if (wabas.length === 0) {
      throw new BadRequestException(
        "Found WhatsApp Business Account ids on the token but couldn't fetch details. Token may be missing the required permissions.",
      );
    }
    const waba = wabas[0];
    const phone = waba.phone_numbers?.data?.[0];
    if (!phone?.id) {
      throw new BadRequestException(
        `WhatsApp Business Account "${waba.name ?? waba.id}" has no registered phone number. Register a phone in Meta's WhatsApp Manager before connecting.`,
      );
    }

    // Generate a fresh verify token so webhooks can be wired later.
    const verifyToken = `aram-wa-${Math.random().toString(36).slice(2, 10)}`;

    // Step 3: reuse the existing connect() path so token validation,
    // webhook subscription, and Integration upsert all happen exactly the
    // same way as the manual-paste flow.
    const result = await this.connect(workspaceId, {
      phoneNumberId: phone.id,
      wabaId: waba.id,
      accessToken: token,
      verifyToken,
      displayPhoneNumber: phone.display_phone_number,
    });

    return {
      ...result,
      discovered: {
        wabas: wabas.map((w) => ({
          id: w.id,
          name: w.name,
          phones:
            w.phone_numbers?.data?.map((p) => ({
              id: p.id,
              displayPhoneNumber: p.display_phone_number,
              verifiedName: p.verified_name,
            })) ?? [],
        })),
        picked: { wabaId: waba.id, phoneNumberId: phone.id },
      },
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
      accessToken: encryptSecret(dto.accessToken),
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

  async sendImage(
    workspaceId: string,
    toWaId: string,
    imageUrl: string,
    caption?: string,
  ) {
    const { token, phoneNumberId } = await this.requireToken(workspaceId);
    const url = `${GRAPH}/${phoneNumberId}/messages`;
    // WA Cloud API accepts a public `link` here exactly like FB Messenger.
    // Caption is optional and goes inside the image object (NOT a separate
    // text message).
    const image: { link: string; caption?: string } = { link: imageUrl };
    if (caption && caption.trim().length > 0) image.caption = caption.trim();
    const payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: toWaId,
      type: "image",
      image,
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
   *
   * Image attachments: when mediaId is provided, we resolve it to a public URL
   * (signed Spaces URL if media is in Spaces) and use the image endpoint.
   * The text body becomes the image caption (a single Graph call covers both).
   */
  async sendInConversation(
    workspaceId: string,
    conversationId: string,
    body: string,
    mediaId?: string,
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
    if (!body && !mediaId) {
      throw new BadRequestException("Message body or mediaId required");
    }

    const recipient = this.normalizeWaId(waId);
    const sent = mediaId
      ? await this.sendImage(
          workspaceId,
          recipient,
          await this.media.resolveExternalUrl(workspaceId, mediaId, 60 * 60),
          body,
        )
      : await this.sendText(workspaceId, recipient, body);

    const now = new Date();
    const t = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const previewBody = body && body.trim().length > 0 ? body : "[image]";
    await this.prisma.message.create({
      data: {
        conversationId,
        workspaceId,
        from: "human",
        body: previewBody,
        t,
        attach: mediaId ?? null,
        metaMessageId: sent.wamid || null,
        deliveryStatus: sent.wamid ? "sent" : null,
        deliveryStatusAt: sent.wamid ? new Date() : null,
      },
    });
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        preview: previewBody.slice(0, 140),
        lastAt: "now",
        lastFrom: "human",
        unread: 0,
      },
    });
    this.realtime.emitToWorkspace(workspaceId, "inbox.activity", {
      channel: "whatsapp",
      conversationId,
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
  /**
   * Send an approved template into an existing WA conversation. This is the
   * only path that works *outside* the 24-hour customer-service window.
   * `name` + `language` must match an APPROVED template on the connected
   * WABA; `variables` is an ordered list filling the BODY component's
   * `{{1}}, {{2}}, …` placeholders (pass [] for templates without
   * variables).
   */
  async sendTemplateInConversation(
    workspaceId: string,
    conversationId: string,
    name: string,
    language: string,
    variables: string[],
  ) {
    const { token, phoneNumberId } = await this.requireToken(workspaceId);
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

    interface Component {
      type: "body";
      parameters: Array<{ type: "text"; text: string }>;
    }
    const components: Component[] = [];
    if (variables.length > 0) {
      components.push({
        type: "body",
        parameters: variables.map((v) => ({ type: "text", text: v })),
      });
    }

    const payload = {
      messaging_product: "whatsapp",
      to: this.normalizeWaId(waId),
      type: "template",
      template: {
        name,
        language: { code: language },
        ...(components.length > 0 ? { components } : {}),
      },
    };
    const url = `${GRAPH}/${phoneNumberId}/messages`;
    const res = await this.fetchJson<{ messages?: Array<{ id: string }> }>(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
    const wamid = res.messages?.[0]?.id ?? "";

    // Render a thread-friendly preview from the body variables; Meta itself
    // shows the recipient a formatted message but our local view only has
    // the raw body. Falls back to "[template: name]" when there's nothing
    // to interpolate.
    const previewBody =
      variables.length > 0
        ? `[template: ${name}] ${variables.join(" · ")}`
        : `[template: ${name}]`;

    const now = new Date();
    const t = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    await this.prisma.message.create({
      data: {
        conversationId,
        workspaceId,
        from: "human",
        body: previewBody,
        t,
        metaMessageId: wamid || null,
        deliveryStatus: wamid ? "sent" : null,
        deliveryStatusAt: wamid ? new Date() : null,
      },
    });
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        preview: previewBody.slice(0, 140),
        lastAt: "now",
        lastFrom: "human",
        unread: 0,
      },
    });
    this.realtime.emitToWorkspace(workspaceId, "inbox.activity", {
      channel: "whatsapp",
      conversationId,
    });
    return { wamid, ok: true };
  }

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
          // entry.id is the WABA id — lets us scope name-only status updates to
          // the owning workspace.
          await this.handleTemplateStatusUpdate(value as TemplateStatusValue, entry.id);
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
          // Match each status update to the Message row by Meta's wamid
          // (stored in metaMessageId on outbound send). Statuses can arrive
          // out of order — we always overwrite since later events are
          // authoritative (Meta only sends each status once per message).
          for (const s of v.statuses) {
            const at = new Date(Number(s.timestamp) * 1000);
            const updated = await this.prisma.message.updateMany({
              where: { workspaceId: integ.workspaceId, metaMessageId: s.id },
              data: {
                deliveryStatus: s.status,
                deliveryStatusAt: Number.isFinite(at.getTime()) ? at : new Date(),
              },
            });
            if (updated.count > 0) {
              // Nudge the Inbox so the new ✓/✓✓/blue ✓✓ shows up without a
              // manual refresh. Conversation lookup avoided to keep this
              // cheap on burst-status updates.
              this.realtime.emitToWorkspace(integ.workspaceId, "inbox.activity", {
                channel: "whatsapp",
              });
            }
          }
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
  private async handleTemplateStatusUpdate(
    value: TemplateStatusValue,
    wabaId?: string,
  ) {
    const event = (value.event ?? "").toUpperCase();
    const status = this.mapTemplateEvent(event);
    if (!status) {
      this.log.debug(`Ignoring template event=${event}`);
      return;
    }

    const metaId = value.message_template_id != null ? String(value.message_template_id) : null;

    // metaTemplateId is globally unique across Meta, so matching on it hits
    // exactly the right row regardless of tenant. The name+lang fallback is
    // NOT unique (two tenants can both have "order_confirmation"/"en"), so we
    // scope it to the workspace that owns this WABA — otherwise a status flip
    // for one tenant would clobber another's same-named template.
    let where: Record<string, unknown> | null;
    if (metaId) {
      where = { metaTemplateId: metaId };
    } else if (value.message_template_name) {
      const workspaceId = wabaId ? await this.workspaceIdForWaba(wabaId) : null;
      if (!workspaceId) {
        this.log.warn(
          `Template status by name without a resolvable workspace (waba=${wabaId}) — skipping to avoid cross-tenant update`,
        );
        return;
      }
      where = {
        workspaceId,
        name: value.message_template_name,
        lang: this.metaLangToLocal(value.message_template_language),
      };
    } else {
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

  /** Resolve the workspace that owns a given WABA id (stored in Integration.raw). */
  private async workspaceIdForWaba(wabaId: string): Promise<string | null> {
    const integs = await this.prisma.integration.findMany({
      where: { platform: "whatsapp" },
    });
    const match = integs.find((i) => this.parseRaw(i.raw).wabaId === wabaId);
    return match?.workspaceId ?? null;
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

    // Idempotency: Meta redelivers a webhook on any non-200 / timeout, so the
    // same wamid can arrive several times. If we've already stored this message
    // id, bail out before touching the contact/conversation — otherwise the
    // unread counter increments once per redelivery and the thread shows dupes.
    const wamid = msg.id;
    if (wamid) {
      const seen = await this.prisma.message.findFirst({
        where: { workspaceId, metaMessageId: wamid },
        select: { id: true },
      });
      if (seen) {
        this.log.debug(`Duplicate inbound wamid=${wamid} — skipping`);
        return;
      }
    }

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
    await this.prisma.message.create({
      data: {
        workspaceId,
        conversationId: conv.id,
        from: "them",
        body: body || `[${msg.type} message]`,
        t,
        metaMessageId: wamid ?? null,
      },
    });
    this.realtime.emitToWorkspace(workspaceId, "inbox.activity", {
      channel: "whatsapp",
      conversationId: conv.id,
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
    const integ = await this.prisma.integration.findFirst({
      where: { workspaceId, platform: "whatsapp" },
    });
    // Single decrypt point — every reader of integ.accessToken goes through
    // find(), so downstream code sees the plaintext token transparently.
    if (integ?.accessToken) integ.accessToken = decryptSecret(integ.accessToken);
    return integ;
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
      // Cap every Graph call at 15s so a hung socket can't stall a webhook or
      // request indefinitely. Respect a caller-supplied signal if present.
      res = await fetch(url, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(15_000),
      });
    } catch (e) {
      const msg =
        (e as Error).name === "TimeoutError"
          ? "Graph API timed out"
          : `Graph network error: ${(e as Error).message}`;
      this.log.error(msg);
      throw new HttpException(
        (e as Error).name === "TimeoutError" ? "Graph API timed out" : "Graph API unreachable",
        504,
      );
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
      this.log.warn(`Graph ${init.method ?? "GET"} ${redactUrl(url)} -> ${res.status} ${errMsg}`);
      throw new HttpException(errMsg, res.status >= 500 ? 502 : 400);
    }
    return parsed as T;
  }
}
