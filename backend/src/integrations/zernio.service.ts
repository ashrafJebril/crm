import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import { MediaService } from "../media/media.service";
import { ZernioClient, ZernioAccount } from "./zernio.client";

/**
 * Zernio integration — one provider for Facebook, Instagram, WhatsApp, TikTok
 * and (when Zernio ships it) Snapchat. Customers connect via Zernio's hosted
 * OAuth ("just authenticate"), so we drop Meta App Review / Tester enrollment.
 *
 * Rides on the existing Integration.provider seam: connected accounts are
 * stored as provider="zernio" rows (one per platform per workspace, matching
 * the @@unique([workspaceId, platform])). Per-workspace isolation is a Zernio
 * "profile" cached on Workspace.zernioProfileId.
 *
 * FB/IG inbox is served live (listConversations proxies Zernio, like the old
 * Graph live-fetch); webhooks additionally persist messages + emit realtime so
 * DB-backed views and delivery status stay in sync.
 */
@Injectable()
export class ZernioService {
  private readonly log = new Logger(ZernioService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly media: MediaService,
    private readonly client: ZernioClient,
  ) {}

  // ─── Profile (per-workspace tenant) ──────────────────────────────────────

  /** Create (once) and cache the Zernio profile id for this workspace. */
  async ensureProfile(workspaceId: string): Promise<string> {
    const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (!ws) throw new NotFoundException("Workspace not found");
    if (ws.zernioProfileId) return ws.zernioProfileId;

    const { id } = await this.client.createProfile(ws.name, `tkana workspace ${ws.id}`);
    await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: { zernioProfileId: id },
    });
    return id;
  }

  private async getProfileId(workspaceId: string): Promise<string | null> {
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { zernioProfileId: true },
    });
    return ws?.zernioProfileId ?? null;
  }

  // ─── Connect ─────────────────────────────────────────────────────────────

  private static readonly SUPPORTED = new Set([
    "facebook",
    "instagram",
    "whatsapp",
    "tiktok",
    "snapchat",
  ]);

  /** Build the hosted connect URL for the customer to authenticate through. */
  async getConnectUrl(workspaceId: string, platform: string): Promise<{ authUrl: string }> {
    const p = platform.toLowerCase();
    if (!ZernioService.SUPPORTED.has(p)) {
      throw new BadRequestException(`Unsupported platform: ${platform}`);
    }
    if (p === "snapchat" && process.env.ZERNIO_SNAPCHAT_ENABLED !== "true") {
      throw new BadRequestException(
        "Snapchat via Zernio is not yet available (Zernio has it in beta).",
      );
    }
    const profileId = await this.ensureProfile(workspaceId);
    const base =
      process.env.ZERNIO_REDIRECT_BASE ??
      process.env.FRONTEND_PUBLIC_URL ??
      process.env.APP_PUBLIC_URL ??
      "http://localhost:5174";
    const redirectUrl = `${base}/#/settings?zernio=connected&platform=${encodeURIComponent(p)}`;
    return this.client.getConnectUrl(p, profileId, redirectUrl);
  }

  /**
   * Reconcile connected accounts from Zernio into Integration rows. Called
   * from the post-connect redirect (frontend POSTs /sync) and the
   * `account.connected` webhook — idempotent either way. Zernio is the source
   * of truth; we upsert one provider="zernio" row per platform.
   */
  async syncAccounts(
    workspaceId: string,
  ): Promise<{ connected: Array<{ platform: string; accountId: string; name: string | null }> }> {
    const profileId = await this.getProfileId(workspaceId);
    if (!profileId) return { connected: [] };

    const accounts = await this.client.listAccounts(profileId);
    const byPlatform = new Map<string, ZernioAccount[]>();
    for (const a of accounts) {
      if (!a.platform || !a._id) continue;
      const list = byPlatform.get(a.platform) ?? [];
      list.push(a);
      byPlatform.set(a.platform, list);
    }

    const connected: Array<{ platform: string; accountId: string; name: string | null }> = [];
    for (const [platform, list] of byPlatform) {
      const primary = list[0];
      const name = primary.displayName ?? primary.username ?? primary.name ?? null;
      const raw = JSON.stringify({
        zernioAccountId: primary._id,
        accounts: list.map((a) => ({
          id: a._id,
          name: a.displayName ?? a.username ?? a.name ?? null,
          status: a.platformStatus ?? null,
        })),
      });
      // Upserting over any prior provider="meta" row is intentional: this is
      // the "replace Meta for FB/IG" behavior (one row per platform).
      await this.prisma.integration.upsert({
        where: { workspaceId_platform: { workspaceId, platform } },
        create: {
          workspaceId,
          platform,
          provider: "zernio",
          pageId: primary._id,
          pageName: name,
          accessToken: null,
          raw,
          lastFetchedAt: new Date(),
        },
        update: {
          provider: "zernio",
          pageId: primary._id,
          pageName: name,
          accessToken: null,
          raw,
          lastFetchedAt: new Date(),
        },
      });
      connected.push({ platform, accountId: primary._id, name });
    }

    this.realtime.emitToWorkspace(workspaceId, "inbox.activity", {});
    return { connected };
  }

  async status(workspaceId: string) {
    const rows = await this.prisma.integration.findMany({
      where: { workspaceId, provider: "zernio" },
    });
    return {
      configured: this.client.isConfigured(),
      profileConnected: !!(await this.getProfileId(workspaceId)),
      accounts: rows.map((r) => ({
        platform: r.platform,
        accountId: r.pageId,
        name: r.pageName,
        connectedAt: r.updatedAt,
      })),
    };
  }

  async whatsappNumbers(workspaceId: string) {
    const profileId = await this.getProfileId(workspaceId);
    if (!profileId) return { numbers: [], connected: [] };
    return this.client.whatsappNumbers(profileId);
  }

  // ─── Reading posts + comments (Social feed) ──────────────────────────────

  async listPosts(workspaceId: string, platform?: string) {
    const profileId = await this.getProfileId(workspaceId);
    if (!profileId) return [];
    const p = platform?.toLowerCase();
    const posts = await this.client.listPosts(profileId, p);
    return posts
      .filter((post) => {
        if (!p) return true;
        if (post.platform) return post.platform.toLowerCase() === p;
        if (Array.isArray(post.platforms)) {
          return post.platforms.some(
            (pl) => (typeof pl === "string" ? pl : pl.platform ?? "").toLowerCase() === p,
          );
        }
        return true;
      })
      .map((post) => ({
        id: post._id ?? post.id ?? "",
        platform: p ?? post.platform ?? "",
        body: post.content ?? post.caption ?? post.text ?? "",
        mediaUrl:
          post.thumbnailUrl ?? post.mediaItems?.[0]?.url ?? post.mediaUrls?.[0] ?? null,
        attachmentTitle: post.mediaType ?? post.title ?? null,
        createdAt: post.publishedAt ?? post.scheduledFor ?? post.createdAt ?? null,
        likes: post.analytics?.likes ?? post.likeCount ?? 0,
        comments: post.analytics?.comments ?? post.commentCount ?? 0,
        shares: post.analytics?.shares ?? post.shareCount ?? 0,
        permalink: post.platformPostUrl ?? post.permalink ?? post.url ?? null,
      }));
  }

  async listComments(workspaceId: string, platform?: string) {
    const profileId = await this.getProfileId(workspaceId);
    if (!profileId) return [];
    const comments = await this.client.listComments(profileId, platform?.toLowerCase());
    return comments.map((c) => ({
      id: c.id ?? c._id ?? "",
      postId: c.postId ?? null,
      platform: c.platform ?? null,
      author: c.author ?? c.authorName ?? c.from?.name ?? "User",
      body: c.content ?? c.text ?? "",
      likes: c.likeCount ?? 0,
      at: c.createdTime ?? c.createdAt ?? null,
    }));
  }

  async disconnect(workspaceId: string, platform: string) {
    const integ = await this.prisma.integration.findFirst({
      where: { workspaceId, platform: platform.toLowerCase(), provider: "zernio" },
    });
    if (!integ) return { ok: true, removed: false };
    await this.prisma.integration.delete({ where: { id: integ.id } });
    this.realtime.emitToWorkspace(workspaceId, "inbox.activity", {});
    return { ok: true, removed: true };
  }

  // ─── Inbox (live) ────────────────────────────────────────────────────────

  async listConversations(workspaceId: string, platform?: string) {
    const profileId = await this.getProfileId(workspaceId);
    if (!profileId) return [];
    const convs = await this.client.listConversations(profileId, platform?.toLowerCase());
    return convs.map((c) => ({
      id: c.id,
      channel: c.platform,
      accountId: c.accountId,
      participantId: c.participantId,
      name: c.participantName ?? c.participantId,
      avatar: c.participantPicture ?? null,
      preview: c.lastMessage ?? "",
      lastAt: c.updatedTime ?? null,
      url: c.url ?? null,
      status: c.status ?? "active",
    }));
  }

  async getMessages(_workspaceId: string, conversationId: string) {
    const msgs = await this.client.getMessages(conversationId);
    return msgs.map((m) => ({
      id: m.id ?? m._id ?? null,
      from: m.direction === "incoming" || m.from === "them" ? "them" : "human",
      body: m.text ?? m.message ?? m.body ?? m.content ?? "",
      at: m.createdAt ?? (m.timestamp != null ? String(m.timestamp) : null),
    }));
  }

  async sendInConversation(
    workspaceId: string,
    conversationId: string,
    accountId: string,
    message: string,
  ) {
    const integ = await this.prisma.integration.findFirst({
      where: { workspaceId, provider: "zernio", pageId: accountId },
    });
    if (!integ) {
      throw new NotFoundException("Zernio account not connected for this workspace");
    }
    const { id } = await this.client.sendMessage(conversationId, accountId, message);
    this.realtime.emitToWorkspace(workspaceId, "inbox.activity", { channel: integ.platform });
    return { ok: true, id };
  }

  // ─── Publishing ──────────────────────────────────────────────────────────

  async publish(
    workspaceId: string,
    input: { content: string; platforms: string[]; mediaIds?: string[] },
    publicBaseUrl: string,
  ): Promise<{ id: string | null; status: string | null }> {
    const wanted = input.platforms.map((p) => p.toLowerCase());
    const rows = await this.prisma.integration.findMany({
      where: { workspaceId, provider: "zernio", platform: { in: wanted } },
    });
    const platforms = rows
      .filter((r) => r.pageId)
      .map((r) => ({ platform: r.platform, accountId: r.pageId! }));
    if (platforms.length === 0) {
      throw new BadRequestException("No connected Zernio accounts for the requested platforms");
    }
    // Zernio fetches media by URL — mint short-lived public URLs per asset,
    // the same mechanism Instagram publishing uses.
    const mediaUrls: string[] = [];
    for (const mediaId of input.mediaIds ?? []) {
      const token = await this.media.mintPublicToken(workspaceId, mediaId);
      mediaUrls.push(
        `${publicBaseUrl.replace(/\/+$/, "")}/api/media/${mediaId}/public?token=${token}`,
      );
    }
    return this.client.createPost({
      content: input.content,
      platforms,
      mediaUrls: mediaUrls.length ? mediaUrls : undefined,
      publishNow: true,
    });
  }

  // ─── Inbound webhook ─────────────────────────────────────────────────────

  async handleEvent(payload: ZernioWebhookEvent) {
    const type = payload?.type ?? payload?.event ?? "";
    if (type === "message.received" || type === "conversation.started") {
      await this.ingestInbound(payload);
      return { ok: true };
    }
    if (type === "account.connected" || type === "account.disconnected") {
      const profileId = payload.data?.profileId;
      if (profileId) {
        const ws = await this.prisma.workspace.findFirst({
          where: { zernioProfileId: profileId },
        });
        if (ws) await this.syncAccounts(ws.id);
      }
      return { ok: true };
    }
    if (
      type === "message.sent" ||
      type === "message.delivered" ||
      type === "message.read" ||
      type === "message.failed"
    ) {
      await this.applyStatus(type, payload);
      return { ok: true };
    }
    if (type.startsWith("whatsapp.number.")) {
      // Provisioning/KYC lifecycle — surface for observability; a real number
      // becomes usable once `account.connected` / activation arrives.
      this.log.log(`Zernio WhatsApp number event: ${type} ${JSON.stringify(payload.data ?? {})}`);
      return { ok: true };
    }
    this.log.debug(`Unhandled Zernio event: ${type}`);
    return { ok: true, ignored: true };
  }

  /**
   * Persist an inbound message into Contact/Conversation/Message + emit
   * realtime. Payload field names are best-effort (Zernio didn't publish the
   * exact inbox-webhook schema); the parser falls back across likely keys and
   * should be tightened against the first real payload captured via the tunnel.
   */
  private async ingestInbound(evt: ZernioWebhookEvent) {
    const d = evt.data ?? {};
    const accountId = d.accountId ?? d.account?._id;
    if (!accountId) return;

    const integ = await this.prisma.integration.findFirst({
      where: { provider: "zernio", pageId: accountId },
    });
    if (!integ) {
      this.log.warn(`Inbound for unknown zernio accountId=${accountId}`);
      return;
    }
    const workspaceId = integ.workspaceId;
    const channel = (d.platform ?? integ.platform).toLowerCase();
    const externalMsgId = d.messageId ?? d.id ?? d._id ?? null;
    const text = d.text ?? d.message ?? d.body ?? d.content ?? `[${channel} message]`;
    const participantId = String(d.participantId ?? d.sender?.id ?? d.from ?? "");
    const participantName = d.participantName ?? d.sender?.name ?? d.sender?.username;

    // Idempotency — Zernio delivers at-least-once; dedupe by external message id.
    if (externalMsgId) {
      const seen = await this.prisma.message.findFirst({
        where: { workspaceId, metaMessageId: externalMsgId },
        select: { id: true },
      });
      if (seen) return;
    }

    const contact = await this.prisma.contact.upsert({
      where: {
        workspaceId_externalSource_externalId: {
          workspaceId,
          externalSource: channel,
          externalId: participantId,
        },
      },
      create: {
        workspaceId,
        name: participantName ?? `${channel} user`,
        industry: channel,
        lifecycle: "lead",
        source: channel,
        lastSeen: "now",
        externalSource: channel,
        externalId: participantId,
      },
      update: { lastSeen: "now" },
    });

    let conv = await this.prisma.conversation.findFirst({
      where: { workspaceId, contactId: contact.id, channel },
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
          preview: text.slice(0, 140),
          channel,
          status: "human",
          intent: "—",
          confidence: 0,
        },
      });
    } else {
      await this.prisma.conversation.update({
        where: { id: conv.id },
        data: {
          preview: text.slice(0, 140),
          lastAt: "now",
          lastFrom: "them",
          unread: { increment: 1 },
        },
      });
    }

    const now = new Date();
    const t = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    await this.prisma.message.create({
      data: {
        workspaceId,
        conversationId: conv.id,
        from: "them",
        body: text,
        t,
        metaMessageId: externalMsgId,
      },
    });
    this.realtime.emitToWorkspace(workspaceId, "inbox.activity", {
      channel,
      conversationId: conv.id,
    });
  }

  private async applyStatus(type: string, payload: ZernioWebhookEvent) {
    const d = payload.data ?? {};
    const msgId = d.messageId ?? d.id ?? d._id;
    const accountId = d.accountId ?? d.account?._id;
    if (!msgId || !accountId) return;
    const status = type.split(".").pop(); // sent | delivered | read | failed
    const integ = await this.prisma.integration.findFirst({
      where: { provider: "zernio", pageId: accountId },
    });
    if (!integ) return;
    const updated = await this.prisma.message.updateMany({
      where: { workspaceId: integ.workspaceId, metaMessageId: msgId },
      data: { deliveryStatus: status, deliveryStatusAt: new Date() },
    });
    if (updated.count > 0) {
      this.realtime.emitToWorkspace(integ.workspaceId, "inbox.activity", {
        channel: integ.platform,
      });
    }
  }
}

// ─── Webhook payload (partial — the fields we read) ──────────────────────────
export interface ZernioWebhookEvent {
  type?: string;
  event?: string;
  data?: {
    profileId?: string;
    accountId?: string;
    account?: { _id?: string };
    platform?: string;
    conversationId?: string;
    messageId?: string;
    id?: string;
    _id?: string;
    participantId?: string;
    participantName?: string;
    sender?: { id?: string; name?: string; username?: string };
    from?: string;
    text?: string;
    message?: string;
    body?: string;
    content?: string;
    direction?: string;
  };
}
