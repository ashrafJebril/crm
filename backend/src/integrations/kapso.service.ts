import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import { redactUrl } from "../common/redact-url";

/**
 * Kapso BSP transport for WhatsApp.
 *
 * Kapso is a Meta Tech Provider that fronts the WhatsApp Cloud API, so we
 * never touch Meta App Review or per-customer tokens: auth is a single global
 * project API key (KAPSO_API_KEY), and customers connect their own WABA via
 * Kapso-hosted embedded signup ("setup links").
 *
 * Two Kapso surfaces are used:
 *  - Platform API  (https://api.kapso.ai/platform/v1)      — customers, setup links
 *  - Meta proxy    (https://api.kapso.ai/meta/whatsapp/v24.0) — Meta-shaped send
 *
 * Runs alongside the direct-Meta WhatsAppService; an Integration row with
 * provider="kapso" is served here, provider="meta" by WhatsAppService.
 */
@Injectable()
export class KapsoService {
  private readonly log = new Logger(KapsoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  private get baseUrl(): string {
    return process.env.KAPSO_BASE_URL ?? "https://api.kapso.ai";
  }
  private get platformBase(): string {
    return `${this.baseUrl}/platform/v1`;
  }
  private get metaBase(): string {
    return `${this.baseUrl}/meta/whatsapp/v24.0`;
  }

  isConfigured(): boolean {
    return !!process.env.KAPSO_API_KEY;
  }

  private requireKey(): string {
    const key = process.env.KAPSO_API_KEY;
    if (!key) {
      throw new BadRequestException(
        "Kapso is not configured — set KAPSO_API_KEY in the environment",
      );
    }
    return key;
  }

  // ─── Onboarding: embedded signup via setup links ─────────────────────────

  /**
   * Ensure the workspace has a Kapso customer, then mint an embedded-signup
   * setup link. Returns the URL to hand to the customer (or open in the
   * onboarding UI). The customer connects their own WABA; we learn the
   * phone_number_id via the success redirect and the
   * `whatsapp.phone_number.created` webhook.
   */
  async createSetupLink(workspaceId: string): Promise<{ url: string }> {
    this.requireKey();
    const customerId = await this.ensureCustomer(workspaceId);

    const appUrl =
      process.env.KAPSO_REDIRECT_BASE ??
      process.env.APP_PUBLIC_URL ??
      "http://localhost:5174";
    const body = {
      setup_link: {
        success_redirect_url: `${appUrl}/#/settings?kapso=connected`,
        failure_redirect_url: `${appUrl}/#/settings?kapso=failed`,
      },
    };
    const res = await this.platformFetch<{ url?: string; data?: { url?: string } }>(
      `/customers/${customerId}/setup_links`,
      { method: "POST", body: JSON.stringify(body) },
    );
    const url = res.url ?? res.data?.url;
    if (!url) {
      throw new HttpException("Kapso did not return a setup link URL", 502);
    }
    return { url };
  }

  /** Create (once) and cache the Kapso customer id for this workspace. */
  private async ensureCustomer(workspaceId: string): Promise<string> {
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
    });
    if (!ws) throw new NotFoundException("Workspace not found");
    if (ws.kapsoCustomerId) return ws.kapsoCustomerId;

    const created = await this.platformFetch<{
      id?: string;
      data?: { id?: string };
    }>("/customers", {
      method: "POST",
      body: JSON.stringify({
        customer: { name: ws.name, external_id: ws.id },
      }),
    });
    const customerId = created.id ?? created.data?.id;
    if (!customerId) {
      throw new HttpException("Kapso did not return a customer id", 502);
    }
    await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: { kapsoCustomerId: customerId },
    });
    return customerId;
  }

  // ─── Connection record ───────────────────────────────────────────────────

  /**
   * Persist a connected number as a provider="kapso" WhatsApp integration.
   * Idempotent — called from the success-redirect callback and/or the
   * `whatsapp.phone_number.created` webhook (whichever arrives first).
   */
  async recordConnection(
    workspaceId: string,
    input: {
      phoneNumberId: string;
      wabaId?: string | null;
      displayPhoneNumber?: string | null;
    },
  ) {
    const raw = JSON.stringify({
      wabaId: input.wabaId ?? null,
      displayPhoneNumber: input.displayPhoneNumber ?? null,
    });
    await this.prisma.integration.upsert({
      where: { workspaceId_platform: { workspaceId, platform: "whatsapp" } },
      create: {
        workspaceId,
        platform: "whatsapp",
        provider: "kapso",
        pageId: input.phoneNumberId,
        pageName: input.displayPhoneNumber ?? null,
        accessToken: null,
        raw,
        lastFetchedAt: new Date(),
      },
      update: {
        provider: "kapso",
        pageId: input.phoneNumberId,
        pageName: input.displayPhoneNumber ?? null,
        accessToken: null,
        raw,
        lastFetchedAt: new Date(),
      },
    });
    this.realtime.emitToWorkspace(workspaceId, "inbox.activity", {
      channel: "whatsapp",
    });
  }

  async status(workspaceId: string) {
    const integ = await this.prisma.integration.findFirst({
      where: { workspaceId, platform: "whatsapp", provider: "kapso" },
    });
    if (!integ) return { connected: false, provider: "kapso" as const };
    const raw = this.parseRaw(integ.raw);
    return {
      connected: true,
      provider: "kapso" as const,
      phoneNumberId: integ.pageId,
      displayPhoneNumber: raw.displayPhoneNumber ?? integ.pageName,
      wabaId: raw.wabaId,
      lastFetchedAt: integ.lastFetchedAt,
    };
  }

  async disconnect(workspaceId: string) {
    const integ = await this.prisma.integration.findFirst({
      where: { workspaceId, platform: "whatsapp", provider: "kapso" },
    });
    if (!integ) return { ok: true };
    await this.prisma.integration.delete({ where: { id: integ.id } });
    return { ok: true };
  }

  // ─── Sending ──────────────────────────────────────────────────────────────

  async sendInConversation(
    workspaceId: string,
    conversationId: string,
    message: string,
  ) {
    const integ = await this.requireConnected(workspaceId);
    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, workspaceId },
      include: { contact: true },
    });
    if (!conv) throw new NotFoundException("Conversation not found");
    const to = this.recipientOf(conv.contact);
    if (!to) {
      throw new BadRequestException("Contact has no WhatsApp number to send to");
    }

    const { wamid } = await this.sendText(integ.pageId!, to, message);

    const now = new Date();
    const t = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    await this.prisma.message.create({
      data: {
        workspaceId,
        conversationId,
        from: "human",
        body: message,
        t,
        metaMessageId: wamid ?? null,
        deliveryStatus: "sent",
      },
    });
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { preview: message.slice(0, 140), lastAt: "now", lastFrom: "human" },
    });
    this.realtime.emitToWorkspace(workspaceId, "inbox.activity", {
      channel: "whatsapp",
      conversationId,
    });
    return { ok: true, wamid };
  }

  /** POST a text message through the Meta-compatible proxy. */
  async sendText(phoneNumberId: string, to: string, body: string) {
    const res = await this.metaFetch<{ messages?: Array<{ id: string }> }>(
      `/${phoneNumberId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to,
          type: "text",
          text: { body },
        }),
      },
    );
    return { wamid: res.messages?.[0]?.id ?? null };
  }

  // ─── Inbound webhook ────────────────────────────────────────────────────

  /**
   * Dispatch a single Kapso webhook event. The event name may arrive in a
   * header or the body depending on config, so we resolve it defensively and
   * fall back to shape detection. `event` is the resolved name when known.
   */
  async handleEvent(event: string | undefined, payload: KapsoWebhookPayload) {
    const name = (event ?? payload.event ?? this.detectEvent(payload)) as string;

    if (name === "whatsapp.phone_number.created") {
      const phoneNumberId = payload.phone_number_id ?? payload.phone_number?.id;
      const customerId = payload.customer?.id;
      if (!phoneNumberId || !customerId) return { ok: true, skipped: true };
      const ws = await this.prisma.workspace.findFirst({
        where: { kapsoCustomerId: customerId },
      });
      if (!ws) {
        this.log.warn(`phone_number.created for unknown customer=${customerId}`);
        return { ok: true, skipped: true };
      }
      await this.recordConnection(ws.id, {
        phoneNumberId,
        wabaId: payload.business_account_id ?? null,
        displayPhoneNumber: payload.display_phone_number ?? null,
      });
      return { ok: true };
    }

    if (name === "whatsapp.message.received") {
      await this.ingestInbound(payload);
      return { ok: true };
    }

    if (
      name === "whatsapp.message.sent" ||
      name === "whatsapp.message.delivered" ||
      name === "whatsapp.message.read" ||
      name === "whatsapp.message.failed"
    ) {
      await this.applyStatus(name, payload);
      return { ok: true };
    }

    this.log.debug(`Unhandled Kapso event: ${name}`);
    return { ok: true, ignored: true };
  }

  private async ingestInbound(payload: KapsoWebhookPayload) {
    const msg = payload.message;
    const phoneNumberId = payload.phone_number_id ?? payload.conversation?.phone_number_id;
    if (!msg || !phoneNumberId) return;

    const integ = await this.prisma.integration.findFirst({
      where: { platform: "whatsapp", provider: "kapso", pageId: phoneNumberId },
    });
    if (!integ) {
      this.log.warn(`Inbound for unknown kapso phone_number_id=${phoneNumberId}`);
      return;
    }
    const workspaceId = integ.workspaceId;

    // Idempotency — Kapso may redeliver; dedupe by wamid (same as the Meta path).
    const wamid = msg.id;
    if (wamid) {
      const seen = await this.prisma.message.findFirst({
        where: { workspaceId, metaMessageId: wamid },
        select: { id: true },
      });
      if (seen) return;
    }

    const waId = msg.from ?? payload.conversation?.phone_number ?? "";
    const body = msg.text?.body ?? msg.kapso?.content ?? `[${msg.type ?? "message"}]`;

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
        name: `WhatsApp ${this.maskPhone(waId)}`,
        phone: waId ? `+${waId}` : null,
        industry: "whatsapp",
        lifecycle: "lead",
        source: "whatsapp",
        lastSeen: "now",
        externalSource: "whatsapp",
        externalId: waId,
      },
      update: { lastSeen: "now" },
    });

    let conv = await this.prisma.conversation.findFirst({
      where: { workspaceId, contactId: contact.id, channel: "whatsapp" },
    });
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
          preview: body.slice(0, 140),
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
          preview: body.slice(0, 140),
          lastAt: "now",
          lastFrom: "them",
          unread: { increment: 1 },
        },
      });
    }

    const ts = Number(msg.timestamp) * 1000;
    const d = Number.isFinite(ts) && ts > 0 ? new Date(ts) : new Date();
    const t = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    await this.prisma.message.create({
      data: {
        workspaceId,
        conversationId: conv.id,
        from: "them",
        body,
        t,
        metaMessageId: wamid ?? null,
      },
    });
    this.realtime.emitToWorkspace(workspaceId, "inbox.activity", {
      channel: "whatsapp",
      conversationId: conv.id,
    });
  }

  private async applyStatus(event: string, payload: KapsoWebhookPayload) {
    const wamid = payload.message?.id;
    const phoneNumberId = payload.phone_number_id;
    if (!wamid || !phoneNumberId) return;
    const status = event.split(".").pop(); // sent | delivered | read | failed
    const integ = await this.prisma.integration.findFirst({
      where: { platform: "whatsapp", provider: "kapso", pageId: phoneNumberId },
    });
    if (!integ) return;
    const updated = await this.prisma.message.updateMany({
      where: { workspaceId: integ.workspaceId, metaMessageId: wamid },
      data: { deliveryStatus: status, deliveryStatusAt: new Date() },
    });
    if (updated.count > 0) {
      this.realtime.emitToWorkspace(integ.workspaceId, "inbox.activity", {
        channel: "whatsapp",
      });
    }
  }

  private detectEvent(p: KapsoWebhookPayload): string {
    if (p.message && (p.message.from || p.message.text)) return "whatsapp.message.received";
    if (p.phone_number?.id || p.business_account_id) return "whatsapp.phone_number.created";
    return "unknown";
  }

  // ─── HTTP helpers ─────────────────────────────────────────────────────────

  private async platformFetch<T>(path: string, init: RequestInit): Promise<T> {
    return this.kapsoFetch<T>(`${this.platformBase}${path}`, init);
  }
  private async metaFetch<T>(path: string, init: RequestInit): Promise<T> {
    return this.kapsoFetch<T>(`${this.metaBase}${path}`, init);
  }

  private async kapsoFetch<T>(url: string, init: RequestInit): Promise<T> {
    const key = this.requireKey();
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": key,
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      const timedOut = (e as Error).name === "TimeoutError";
      this.log.error(
        timedOut ? "Kapso API timed out" : `Kapso network error: ${(e as Error).message}`,
      );
      throw new HttpException(timedOut ? "Kapso API timed out" : "Kapso API unreachable", timedOut ? 504 : 502);
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    if (!res.ok) {
      const errMsg =
        typeof parsed === "object" && parsed !== null && "error" in parsed
          ? String((parsed as { error?: unknown }).error) || `Kapso error ${res.status}`
          : `Kapso error ${res.status}`;
      this.log.warn(`Kapso ${init.method ?? "GET"} ${redactUrl(url)} -> ${res.status} ${errMsg}`);
      throw new HttpException(errMsg, res.status >= 500 ? 502 : 400);
    }
    return parsed as T;
  }

  private async requireConnected(workspaceId: string) {
    const integ = await this.prisma.integration.findFirst({
      where: { workspaceId, platform: "whatsapp", provider: "kapso" },
    });
    if (!integ?.pageId) {
      throw new NotFoundException("WhatsApp (Kapso) is not connected");
    }
    return integ;
  }

  private recipientOf(contact: { externalId: string | null; phone: string | null }): string | null {
    if (contact.externalId) return contact.externalId;
    if (contact.phone) return contact.phone.replace(/[^\d]/g, "");
    return null;
  }

  private maskPhone(waId: string): string {
    if (!waId || waId.length < 4) return waId || "unknown";
    return `••${waId.slice(-4)}`;
  }

  private parseRaw(raw: string | null): {
    wabaId?: string | null;
    displayPhoneNumber?: string | null;
  } {
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
}

// ─── Webhook payload (partial — the fields we read) ──────────────────────────
interface KapsoWebhookPayload {
  event?: string;
  phone_number_id?: string;
  business_account_id?: string | null;
  display_phone_number?: string | null;
  customer?: { id?: string };
  phone_number?: { id?: string };
  message?: {
    id?: string;
    from?: string;
    type?: string;
    timestamp?: string;
    text?: { body?: string };
    kapso?: { content?: string };
  };
  conversation?: {
    id?: string;
    phone_number?: string;
    phone_number_id?: string;
  };
}
