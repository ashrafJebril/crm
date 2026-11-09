import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import type { Viewer } from "../permissions/visibility";
import { resolveTemplateHeader, type TemplateHeaderInput } from "./template-header";
import { normalizeReaction } from "./message-reaction";
import { PrismaService } from "../prisma/prisma.service";
import { redactUrl } from "../common/redact-url";
import { decryptSecret } from "../common/token-crypto";
import { RealtimeService } from "../realtime/realtime.service";
import { MediaService } from "../media/media.service";
import { PipelineAutomationService } from "../tickets/pipeline-automation.service";
import { AiBridgeService } from "./ai-bridge.service";
import type { ConnectWhatsAppDto } from "./whatsapp.dto";
import { randomBytes, timingSafeEqual } from "crypto";
import type { Channel } from "@prisma/client";
import { ChannelResolver } from "../channels/channel-resolver.service";
import { credentialsFor } from "../channels/channel-credentials";
import { ensureDefaultPerKind, ensureLegacyChannels } from "../channels/legacy-mirror";
import { INTEGRATION_REMOVED } from "../channels/zernio-mirror";
import { channelError, type ChannelErrorKey } from "../channels/channel-errors";
import { assertWhatsappCapacity } from "../channels/channel-limits";
import { EmbeddedSignupService } from "../channels/whatsapp/embedded-signup.service";
import { MetaGraphClient } from "../channels/whatsapp/meta-graph.client";
import { addsWhatsappSlot, assertSecretsStorable, attachMetaNumber, NOT_META } from "../channels/whatsapp/meta-number";

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
    // type "reaction": the reacted message's wamid and the emoji ("" = removed).
    reaction?: { message_id?: string; emoji?: string };
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

/**
 * How connect errors are reported. "legacy" keeps the English messages the
 * old Settings card shows; "keys" (the channels hub, `POST
 * /channels/whatsapp/manual`) throws `channels.*` keys the frontend maps
 * through `tx`.
 */
export type ConnectErrorStyle = "legacy" | "keys";
export interface ConnectOptions {
  errorStyle?: ConnectErrorStyle;
}

@Injectable()
export class WhatsAppService {
  private readonly log = new Logger(WhatsAppService.name);
  /** SP-19: inbound routing and outbound credentials go through channels. */
  private readonly channels: ChannelResolver;
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly media: MediaService,
    private readonly pipelineAutomation: PipelineAutomationService,
    private readonly aiBridge: AiBridgeService,
    // Provided by the global ChannelsCoreModule; hand-built specs get a
    // resolver over the same Prisma double.
    @Optional() channelResolver?: ChannelResolver,
    // SP-19 T4: the embedded signup lives in channels/whatsapp; the old
    // exchange route delegates to it.
    @Optional() embeddedSignup?: EmbeddedSignupService,
  ) {
    this.channels = channelResolver ?? new ChannelResolver(prisma);
    this.embeddedSignup = embeddedSignup ?? new EmbeddedSignupService(prisma, new MetaGraphClient(), realtime);
  }
  private readonly embeddedSignup: EmbeddedSignupService;

  // ─── Public REST API ───────────────────────────────────────────────────
  /**
   * `verifyToken` is a webhook credential: only callers holding
   * channels.update get it (the controller decides). Agents and viewers can
   * read this route through channels.view (SP-19 R10).
   */
  async status(workspaceId: string, opts: { includeVerifyToken?: boolean } = {}) {
    const integ = await this.find(workspaceId);
    if (!integ) return { connected: false };
    const raw = this.parseRaw(integ.raw);
    return {
      connected: true,
      phoneNumberId: integ.pageId,
      displayPhoneNumber: raw.displayPhoneNumber ?? integ.pageName,
      wabaId: raw.wabaId,
      ...(opts.includeVerifyToken ? { verifyToken: raw.verifyToken } : {}),
      expiresAt: integ.expiresAt,
      lastFetchedAt: integ.lastFetchedAt,
    };
  }

  /**
   * The old embedded-signup route (`POST /integrations/whatsapp/oauth/exchange`).
   * SP-19 T4: delegates to `EmbeddedSignupService` (config check, plan limit,
   * code exchange, WABA subscribe, register, channel-aware attach) and
   * returns its ChannelDto. The popup's `phoneNumberId` + `wabaId` arrive
   * out-of-band via window.message.
   */
  async embeddedSignupExchange(
    workspaceId: string,
    code: string,
    phoneNumberId: string,
    wabaId: string,
  ) {
    return this.embeddedSignup.signup(workspaceId, {
      code,
      phoneNumberId,
      wabaId,
      signupEvent: phoneNumberId ? "FINISH" : "FINISH_ONLY_WABA",
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
  async connectByToken(
    workspaceId: string,
    accessToken: string,
    opts: ConnectOptions & { phoneNumberId?: string; add?: boolean } = {},
  ) {
    const bad = (key: ChannelErrorKey, english: string) =>
      opts.errorStyle === "keys" ? channelError(key) : new BadRequestException(english);
    const token = (accessToken ?? "").trim();
    if (!token || token.length < 20) {
      throw bad("channels.meta_token_invalid", "Token looks too short to be a Meta access token");
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
      throw bad(
        "channels.meta_token_invalid",
        `Token rejected by Meta: ${(e as Error).message}. Make sure you copied the WhatsApp temporary access token from WhatsApp Manager → API Setup, not a Facebook user token.`,
      );
    }
    if (!me?.id) {
      throw bad("channels.meta_token_invalid", "Token did not resolve to a Meta account");
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
          throw bad(
            "channels.meta_token_invalid",
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
      throw bad(
        "channels.meta_no_waba",
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
      throw bad(
        "channels.meta_no_waba",
        "Found WhatsApp Business Account ids on the token but couldn't fetch details. Token may be missing the required permissions.",
      );
    }

    // SP-19 T4: which number this token connects.
    //  - an explicit `phoneNumberId`: that one;
    //  - otherwise a number this workspace already holds that the token can
    //    reach (live first): the usual reason to paste a token is to refresh
    //    an expired one, so it is refreshed in place and reactivated (I1);
    //  - an explicit add (`add`, the hub's manual route): the first number the
    //    workspace does not hold yet, else a held one;
    //  - a workspace with no Meta number yet: the token's first number;
    //  - otherwise nothing is added: 400 (keys: channels.meta_no_number).
    const candidates = wabas.flatMap((w) =>
      (w.phone_numbers?.data ?? []).filter((p) => p?.id).map((p) => ({ waba: w, phone: p })),
    );
    let pick: { waba: DiscoveredWaba; phone: DiscoveredPhone } | undefined;
    if (opts.phoneNumberId) {
      pick = candidates.find((c) => c.phone.id === opts.phoneNumberId);
      if (!pick) {
        throw bad("channels.meta_no_number", "This token cannot access the requested WhatsApp phone number.");
      }
    } else {
      const rows = await this.prisma.channel.findMany({
        where: { workspaceId, kind: "whatsapp", provider: { notIn: NOT_META } },
        select: { externalId: true, status: true },
      });
      const held = new Set(rows.map((c) => c.externalId));
      const live = new Set(rows.filter((c) => c.status !== "disconnected").map((c) => c.externalId));
      const heldPick = candidates.find((c) => live.has(c.phone.id)) ?? candidates.find((c) => held.has(c.phone.id));
      if (opts.add) {
        pick = candidates.find((c) => !held.has(c.phone.id)) ?? heldPick;
      } else if (heldPick) {
        pick = heldPick;
      } else if (held.size === 0) {
        pick = candidates[0];
      } else if (candidates.length) {
        throw bad(
          "channels.meta_no_number",
          "This token cannot access the WhatsApp number connected to this workspace. To connect another number, use Add number in Channels.",
        );
      }
    }
    if (!pick) {
      const first = wabas[0];
      throw bad(
        "channels.meta_no_number",
        `WhatsApp Business Account "${first.name ?? first.id}" has no registered phone number. Register a phone in Meta's WhatsApp Manager before connecting.`,
      );
    }
    const { waba, phone } = pick;

    // Generate a fresh verify token so webhooks can be wired later.
    const verifyToken = `aram-wa-${randomBytes(6).toString("hex")}`;

    // Step 3: reuse the connect() path so token validation, webhook
    // subscription and the channel-aware attach happen exactly the same way
    // as the manual-paste flow.
    const result = await this.connect(
      workspaceId,
      {
        phoneNumberId: phone.id,
        wabaId: waba.id,
        accessToken: token,
        verifyToken,
        displayPhoneNumber: phone.display_phone_number,
      },
      { errorStyle: opts.errorStyle },
    );

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

  /**
   * Connect one Meta number (phone number id + WABA + token).
   *
   * SP-19 T4 (ruling 4): channel-aware and limit-checked. The first number
   * becomes the legacy Integration as before, the same number again refreshes
   * it in place, and a DIFFERENT number is added as its own channel (token in
   * `secretsEnc`) instead of overwriting the first. A number that takes a new
   * slot needs room under the plan limit (409 channels.limit_reached, checked
   * before Meta is called).
   */
  async connect(workspaceId: string, dto: ConnectWhatsAppDto, opts: ConnectOptions = {}) {
    await ensureLegacyChannels(this.prisma, workspaceId);
    if (await addsWhatsappSlot(this.prisma, workspaceId, dto.phoneNumberId)) {
      await assertWhatsappCapacity(this.prisma, workspaceId);
    }
    assertSecretsStorable();

    // Validate the credentials by fetching the phone-number record from Meta.
    let info: WaPhoneInfo;
    try {
      info = await this.graphGet<WaPhoneInfo>(
        `/${encodeURIComponent(dto.phoneNumberId)}?fields=id,display_phone_number,verified_name`,
        dto.accessToken,
      );
    } catch (e) {
      if (opts.errorStyle === "keys") throw channelError("channels.meta_token_invalid");
      throw e;
    }
    if (info?.id !== dto.phoneNumberId) {
      if (opts.errorStyle === "keys") throw channelError("channels.meta_token_invalid");
      throw new BadRequestException("Token did not resolve to this phone-number id");
    }
    const displayName =
      dto.displayPhoneNumber ??
      info.display_phone_number ??
      info.verified_name ??
      "WhatsApp number";

    const { channel, legacy } = await attachMetaNumber(this.prisma, workspaceId, {
      phoneNumberId: dto.phoneNumberId,
      wabaId: dto.wabaId,
      accessToken: dto.accessToken,
      displayName,
      displayPhoneNumber: info.display_phone_number ?? dto.displayPhoneNumber ?? null,
      verifiedName: info.verified_name ?? null,
      status: "active",
      statusReason: null,
      verification: null,
      verifyToken: dto.verifyToken,
    });
    this.realtime.emitToWorkspace?.(workspaceId, "channels.updated", { channelId: channel.id });

    // Subscribe our Meta app to this WABA so webhooks actually fire. Without
    // this call the customer would see "connected" in tkana but inbound
    // messages would silently never arrive — exactly the symptom we hit in
    // our own setup. Best-effort: log + return a soft flag instead of failing
    // the connect, so the customer can still retry from the UI.
    const subscribed = await this.subscribeAppToWaba(dto.wabaId, dto.accessToken);

    return {
      connected: true,
      channelId: channel.id,
      phoneNumberId: dto.phoneNumberId,
      displayPhoneNumber: displayName,
      wabaId: dto.wabaId,
      // The Integration's webhook verify token; a channel-only number has none.
      ...(legacy ? { verifyToken: dto.verifyToken } : {}),
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
    // SP-19: the mirrored channel stops sending (soft: history stays). A
    // later connect of the same number reactivates it.
    await this.prisma.channel.updateMany({
      where: { integrationId: integ.id, status: { not: "disconnected" } },
      data: { status: "disconnected", statusReason: INTEGRATION_REMOVED, disconnectedAt: new Date(), isDefault: false },
    });
    await this.prisma.integration.delete({ where: { id: integ.id } });
    await ensureDefaultPerKind(this.prisma, workspaceId);
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
  /** Test-send from the workspace's legacy number (Settings). Conversation
   *  replies use the conversation's own channel (sendInConversation). */
  async sendText(workspaceId: string, toWaId: string, body: string) {
    return this.postText(await this.requireToken(workspaceId), toWaId, body);
  }

  /**
   * SP-19: the Meta credentials of the number a conversation belongs to.
   * `channel.externalId` is the phone_number_id (an Integration-linked
   * channel follows its Integration), the token is that channel's. A
   * disconnected number is 409, never replaced by another one.
   */
  private async sendTarget(
    workspaceId: string,
    conv: { id: string; channel: string; channelId?: string | null },
  ): Promise<{ token: string; phoneNumberId: string; channel: Channel }> {
    const channel = await this.channels.forSend(workspaceId, conv);
    const creds = await credentialsFor(this.prisma, channel);
    if (creds.provider === "zernio" || !creds.accessToken || !creds.externalId) {
      throw new NotFoundException("WhatsApp is not connected");
    }
    return { token: creds.accessToken, phoneNumberId: creds.externalId, channel };
  }

  private async postText(target: { token: string; phoneNumberId: string }, toWaId: string, body: string) {
    const { token, phoneNumberId } = target;
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

  private async postImage(
    target: { token: string; phoneNumberId: string },
    toWaId: string,
    imageUrl: string,
    caption?: string,
  ) {
    const { token, phoneNumberId } = target;
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

    const target = await this.sendTarget(workspaceId, conv);
    const recipient = this.normalizeWaId(waId);
    const sent = mediaId
      ? await this.postImage(
          target,
          recipient,
          await this.media.resolveExternalUrl(workspaceId, mediaId, 60 * 60),
          body,
        )
      : await this.postText(target, recipient, body);

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
      channelId: target.channel.id,
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
    header?: TemplateHeaderInput,
    viewer?: Viewer,
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
    // SP-19: the conversation's own number and token (templates are listed on
    // the default number — R8; a missing template surfaces as Meta's error).
    const target = await this.sendTarget(workspaceId, conv);
    const { token, phoneNumberId } = target;

    // Header first (Meta's component order); validated before anything is sent.
    const resolvedHeader = await resolveTemplateHeader(
      { prisma: this.prisma, media: this.media },
      workspaceId,
      name,
      header,
      { language, viewer },
    );
    type Component = { type: "header" | "body"; parameters: Array<Record<string, unknown>> };
    const components: Component[] = [];
    if (resolvedHeader) components.push(resolvedHeader.component);
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
        attach: resolvedHeader?.attach ?? null,
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
      channelId: target.channel.id,
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
    // SP-19: the app-level META_VERIFY_TOKEN also verifies, so the app's
    // single callback works for numbers that have no Integration row.
    const appToken = process.env.META_VERIFY_TOKEN;
    if (appToken && token && WhatsAppService.sameSecret(token, appToken)) return challenge;
    const rows = await this.prisma.integration.findMany({
      where: { platform: "whatsapp" },
    });
    const ok = !!token && rows.some((r) => this.parseRaw(r.raw).verifyToken === token);
    if (!ok) throw new BadRequestException("Verify token mismatch");
    return challenge;
  }

  private static sameSecret(a: string, b: string): boolean {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
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
        // SP-19: the number (phone_number_id) picks the Channel — and so the
        // workspace and the thread. A legacy Integration with no Channel yet
        // is mirrored on the fly, so nothing `main` connected is dropped.
        const ch = await this.channels.forInbound("meta", phoneNumberId, "whatsapp");
        if (!ch) {
          this.log.warn(
            `Webhook for unknown phone_number_id=${phoneNumberId} — no channel matched`,
          );
          continue;
        }
        const workspaceId = ch.workspaceId;
        const messages = v.messages ?? [];
        const profileByWaId = new Map<string, string | undefined>();
        for (const c of v.contacts ?? []) {
          profileByWaId.set(c.wa_id, c.profile?.name);
        }
        for (const msg of messages) {
          if (msg.type === "reaction") {
            await this.applyReaction(workspaceId, msg.reaction);
            processed += 1;
            continue;
          }
          await this.ingestInbound(workspaceId, ch, msg, profileByWaId.get(msg.from));
          processed += 1;
        }
        if (messages.length > 0) await this.channels.touchInbound(ch.id);
        if (v.statuses?.length) {
          // Match each status update to the Message row by Meta's wamid
          // (stored in metaMessageId on outbound send). Statuses can arrive
          // out of order — we always overwrite since later events are
          // authoritative (Meta only sends each status once per message).
          for (const s of v.statuses) {
            const at = new Date(Number(s.timestamp) * 1000);
            const updated = await this.prisma.message.updateMany({
              where: { workspaceId, metaMessageId: s.id },
              data: {
                deliveryStatus: s.status,
                deliveryStatusAt: Number.isFinite(at.getTime()) ? at : new Date(),
              },
            });
            if (updated.count > 0) {
              // Nudge the Inbox so the new ✓/✓✓/blue ✓✓ shows up without a
              // manual refresh. Conversation lookup avoided to keep this
              // cheap on burst-status updates.
              this.realtime.emitToWorkspace(workspaceId, "inbox.activity", {
                channel: "whatsapp",
                channelId: ch.id,
              });
            }
          }
        }
        // `main` reads this on the legacy row; channel-only numbers have none.
        if (ch.integrationId) {
          await this.prisma.integration.update({
            where: { id: ch.integrationId },
            data: { lastFetchedAt: new Date() },
          });
        }
      }
    }
    return { ok: true, processed };
  }

  /** SP-31: a customer's emoji reaction to one of our (or their) messages. */
  private async applyReaction(workspaceId: string, r: { message_id?: string; emoji?: string } | undefined) {
    if (!r?.message_id) return;
    const emoji = normalizeReaction(r.emoji);
    if (emoji === undefined) return;
    const updated = await this.prisma.message.updateMany({
      where: { workspaceId, metaMessageId: r.message_id },
      data: { reaction: emoji, reactionAt: emoji === null ? null : new Date() },
    });
    if (updated.count > 0) {
      this.realtime.emitToWorkspace(workspaceId, "inbox.activity", { channel: "whatsapp" });
    }
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
    channel: Pick<Channel, "id">,
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

    // Conversation key (SP-19): (workspace, contact, channelId). A legacy
    // null-channel thread is adopted only by the channel it resolves to.
    let conv = await this.channels.findOrAdoptConversation(workspaceId, contact.id, {
      id: channel.id,
      kind: "whatsapp",
    });
    const body = this.extractBody(msg);
    const previewBase = body || `[${msg.type}]`;
    if (!conv) {
      conv = await this.prisma.conversation.create({
        data: {
          workspaceId,
          contactId: contact.id,
          channelId: channel.id,
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
      channelId: channel.id,
      conversationId: conv.id,
    });

    // Open a pipeline ticket for the lead. The Zernio transport has always done
    // this (zernio.service.ts:1258) but the Meta path never did, so WhatsApp
    // conversations arriving through our own Meta app were invisible to the
    // pipeline. Swallows its own failures — see PipelineAutomationService.
    await this.pipelineAutomation.onInboundMessage(
      workspaceId,
      contact.id,
      conv.id,
      "whatsapp",
      previewBase,
    );

    // Hand the message to the AI service if this thread has it enabled. Kept
    // last and awaited only for its own bounded timeout: everything above is
    // already persisted, so a slow or dead AI service cannot cost us the
    // message or the 200 Meta needs.
    if (conv.aiEnabled && !conv.aiPausedAt && this.aiBridge.isConfigured()) {
      await this.aiBridge.notifyInbound({
        workspaceId,
        conversationId: conv.id,
        contactId: contact.id,
        channel: "whatsapp",
        messageId: wamid ?? null,
        body: body || `[${msg.type} message]`,
        contactName: contact.name,
        contactPhone: contact.phone,
        // The customer just messaged us, so the 24h free-text window is open
        // by definition at this instant.
        windowOpen: true,
        receivedAt: d.toISOString(),
      });
    }
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
