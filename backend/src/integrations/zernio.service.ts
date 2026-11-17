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
import { randomBytes } from "crypto";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { PaymentLockService } from "../billing/payment-lock.service";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import { MediaService } from "../media/media.service";
import { agentImageDecision } from "../media/agent-photo";
import { ZernioClient, ZernioAccount, ZernioAnalyticsRow } from "./zernio.client";
import { accountHealth } from "./zernio-account-health";
import { AiBridgeService } from "./ai-bridge.service";
import { PipelineAutomationService } from "../tickets/pipeline-automation.service";
import { LAgentService } from "./l-agent.service";
import { WORKFLOW_TRIGGER_EVENT, WorkflowTriggerEvent } from "../workflows/workflow-events";
import { ChannelResolver } from "../channels/channel-resolver.service";
import { INTEGRATION_REMOVED, mirrorZernioAccounts, USER_DISCONNECTED } from "../channels/zernio-mirror";
import { ensureDefaultPerKind, ZERNIO_MISSING, type IntegrationLike } from "../channels/legacy-mirror";
import { credentialsFor } from "../channels/channel-credentials";
import { assertWhatsappCapacity } from "../channels/channel-limits";
import { channelError } from "../channels/channel-errors";
import type { Channel } from "@prisma/client";
import { RecipientTrackerService } from "../campaigns/tracking/recipient-tracker.service";
import { CampaignReplyAttributor } from "../campaigns/tracking/reply-attributor.service";
import { AdReferralService } from "../ad-attribution/ad-referral.service";
import { zernioReplyParts } from "../campaigns/tracking/inbound-reply";
import { HealthCheckTrigger } from "../channels/health/health-check-trigger";
import { defaultZernioWhatsappAccountId } from "../channels/default-channel";
import { applyTemplateProviderStatus } from "../templates/templates.service";
import { sentByData } from "../conversations/message-sender";
import { AgentReplyGate } from "../agent/agent-reply-gate";

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

/** WhatsApp participant ids ARE phone numbers (E.164 digits, no '+') — the
 *  other platforms use opaque user ids. Returns a display-ready +E.164 for
 *  WhatsApp contacts, null for everything else or malformed ids. */
export function phoneFromParticipantId(
  channel: string,
  participantId: string,
): string | null {
  if (channel !== "whatsapp") return null;
  const digits = participantId.replace(/^\+/, "");
  return /^[0-9]{8,15}$/.test(digits) ? `+${digits}` : null;
}

/** How long a workspace's live Zernio account list is reused by status(). */
const HEALTH_TTL_MS = 5 * 60_000;

@Injectable()
export class ZernioService {
  private readonly log = new Logger(ZernioService.name);
  /** profileId → Zernio's account list (null = Zernio unreachable), for status(). */
  private readonly healthCache = new Map<string, { at: number; accounts: ZernioAccount[] | null }>();
  /** SP-19: every inbound/outbound path resolves its Channel here. */
  private readonly channels: ChannelResolver;
  /** SP-12: per-recipient delivery state and reply attribution. */
  private readonly tracker: RecipientTrackerService;
  private readonly attributor: CampaignReplyAttributor;
  /** SP-15: click-to-WhatsApp referral capture. */
  private readonly adReferrals: AdReferralService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly media: MediaService,
    private readonly client: ZernioClient,
    private readonly pipelineAutomation: PipelineAutomationService,
    private readonly lAgent: LAgentService,
    private readonly aiBridge: AiBridgeService,
    @Optional() private readonly events?: EventEmitter2,
    @Optional() private readonly paymentLock?: PaymentLockService,
    // Provided by the global ChannelsCoreModule; unit specs that build the
    // service by hand get a resolver over the same Prisma double.
    @Optional() channelResolver?: ChannelResolver,
    // SP-12, from CampaignTrackingModule; hand-built specs get instances over
    // the same Prisma double.
    @Optional() tracker?: RecipientTrackerService,
    @Optional() attributor?: CampaignReplyAttributor,
    // SP-14: template webhooks ask for a number health check (global ChannelsCoreModule).
    @Optional() private readonly healthTrigger?: HealthCheckTrigger,
    // SP-15, from AdAttributionModule; hand-built specs get one over the same Prisma double.
    @Optional() adReferrals?: AdReferralService,
    // SP-20: every automatic reply asks the gate first (IntegrationsModule
    // provides it; hand-built specs that do not pass one keep today's rules).
    @Optional() private readonly replyGate?: AgentReplyGate,
  ) {
    this.channels = channelResolver ?? new ChannelResolver(prisma);
    this.tracker = tracker ?? new RecipientTrackerService(prisma);
    this.attributor = attributor ?? new CampaignReplyAttributor(prisma, this.tracker);
    this.adReferrals = adReferrals ?? new AdReferralService(prisma, media);
  }

  // ─── Profile (per-workspace tenant) ──────────────────────────────────────

  /** Create (once) and cache the Zernio profile id for this workspace. */
  async ensureProfile(workspaceId: string): Promise<string> {
    const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (!ws) throw new NotFoundException("Workspace not found");
    if (ws.zernioProfileId) return ws.zernioProfileId;

    // Zernio profile names are unique per API key (shared by every workspace
    // and environment), so derive a readable, unique name from the workspace id.
    const suffix = ` · ${ws.id.slice(-6)}`;
    const cleanName = (ws.name ?? "").trim();
    const fit = (reserve: number) =>
      cleanName.slice(0, 60 - reserve).trim() || "Workspace";
    const base = `${fit(suffix.length)}${suffix}`;
    const description = `tkana workspace ${ws.id}`;

    let id: string;
    try {
      ({ id } = await this.client.createProfile(base, description));
    } catch (e) {
      if (!ZernioService.isNameConflict(e)) throw e;
      // Retry once with a random suffix. Never look the profile up by name:
      // that could attach another tenant's social accounts.
      ({ id } = await this.client.createProfile(
        `${fit(suffix.length * 2)}${suffix} · ${randomBytes(3).toString("hex")}`,
        description,
      ));
    }

    // Only claim the slot if still empty, so a concurrent request can't be
    // overwritten by an orphan profile.
    const { count } = await this.prisma.workspace.updateMany({
      where: { id: workspaceId, zernioProfileId: null },
      data: { zernioProfileId: id },
    });
    if (count === 0) {
      const current = await this.prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { zernioProfileId: true },
      });
      // Edge: if the workspace was deleted mid-request there is no stored id,
      // so we fall through and return the unsaved id (nothing to attach it to).
      if (current?.zernioProfileId) {
        this.log.warn(`Zernio profile ${id} is orphaned (workspace profile was set concurrently)`);
        return current.zernioProfileId;
      }
    }
    return id;
  }

  private static isNameConflict(e: unknown): boolean {
    if (!(e instanceof HttpException)) return false;
    return e.getStatus() === 409 || /already exists/i.test(e.message);
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
  async getConnectUrl(
    workspaceId: string,
    platform: string,
    opts: { reconnectChannelId?: string } = {},
  ): Promise<{ authUrl: string }> {
    const p = platform.toLowerCase();
    if (!ZernioService.SUPPORTED.has(p)) {
      throw new BadRequestException(`Unsupported platform: ${platform}`);
    }
    if (p === "snapchat" && process.env.ZERNIO_SNAPCHAT_ENABLED !== "true") {
      throw new BadRequestException(
        "Snapchat via Zernio is not yet available (Zernio has it in beta).",
      );
    }
    // SP-19 T4: a WhatsApp connect link adds a number, so it needs a free
    // slot under the plan limit (409 channels.limit_reached). Re-authorising
    // the number the workspace already holds (sign-in expired, access
    // revoked, account dropped by Zernio) is a reconnect and is never gated.
    // Accounts that already exist at Zernio are still mirrored by every sync.
    // SP-19 T5 (I1): the hub's Reconnect on a held Zernio channel names it.
    // It must be this workspace's Zernio channel of the same platform (else
    // 404); the link then re-authorises a number already held, so it is not
    // gated either, even after a hub disconnect (`disconnected_by_user`).
    const reconnecting = opts.reconnectChannelId
      ? await this.assertReconnectTarget(workspaceId, p, opts.reconnectChannelId)
      : false;
    if (p === "whatsapp" && !reconnecting && !(await this.zernioWhatsappNeedsReconnect(workspaceId))) {
      await assertWhatsappCapacity(this.prisma, workspaceId);
    }
    const profileId = await this.ensureProfile(workspaceId);
    const base =
      process.env.ZERNIO_REDIRECT_BASE ??
      process.env.FRONTEND_PUBLIC_URL ??
      process.env.APP_PUBLIC_URL ??
      "http://localhost:5174";
    // SP-19 T5: land on the channels hub. ZernioRedirectCapture and the embed
    // callback still accept the old `#/settings?zernio=…` links in flight.
    const redirectUrl = `${base}/#/channels?zernio=connected&platform=${encodeURIComponent(p)}`;
    return this.client.getConnectUrl(p, profileId, redirectUrl);
  }

  private async assertReconnectTarget(workspaceId: string, platform: string, channelId: string): Promise<true> {
    const row = await this.prisma.channel.findFirst({
      where: { id: channelId, workspaceId, provider: "zernio", kind: platform },
      select: { id: true },
    });
    if (!row) throw channelError("channels.not_found");
    return true;
  }

  /**
   * SP-19 T5 (I1): the `zernio` transport's reconnect hook, behind
   * `POST /channels/:id/reconnect`. A hub disconnect never touches Zernio, so
   * the account usually still works: resync, and when Zernio lists the
   * channel's account as healthy, reactivate the row explicitly (a user's
   * explicit reconnect may revive `disconnected_by_user`). Reviving a
   * disconnected WhatsApp number takes a slot (409 limit_reached, like Meta).
   * Otherwise 409 `channels.zernio_reauth_required`: the hub falls back to
   * the OAuth link (`getConnectUrl` with `reconnectChannelId`).
   */
  async reconnectChannel(row: Channel): Promise<Channel> {
    const { workspaceId } = row;
    const reauth = () => channelError("channels.zernio_reauth_required", { platform: row.kind });
    const profileId = await this.getProfileId(workspaceId);
    if (!profileId || !row.externalId) throw reauth();
    await this.syncAccounts(workspaceId);
    const listed = (this.healthCache.get(profileId)?.accounts ?? []).find((a) => a._id === row.externalId);
    if (!listed || accountHealth(listed).health !== "ok") throw reauth();
    const fresh = await this.prisma.channel.findFirst({ where: { id: row.id, workspaceId } });
    if (!fresh) throw channelError("channels.not_found");
    if (fresh.status === "active" && !fresh.statusReason) return fresh;
    if (fresh.status === "disconnected" && fresh.kind === "whatsapp") {
      await assertWhatsappCapacity(this.prisma, workspaceId);
    }
    return this.prisma.channel.update({
      where: { id: fresh.id },
      data: { status: "active", statusReason: null, disconnectedAt: null },
    });
  }

  /** A held Zernio WhatsApp channel that is not healthy-active: the connect
   *  link is its re-auth, not a new number. A user's hub disconnect is not. */
  private async zernioWhatsappNeedsReconnect(workspaceId: string): Promise<boolean> {
    const row = await this.prisma.channel.findFirst({
      where: {
        workspaceId,
        kind: "whatsapp",
        provider: "zernio",
        OR: [
          { status: "needs_attention" },
          { status: "disconnected", statusReason: { in: [ZERNIO_MISSING, INTEGRATION_REMOVED] } },
        ],
      },
      select: { id: true },
    });
    return !!row;
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
    this.healthCache.set(profileId, { at: Date.now(), accounts });
    const byPlatform = new Map<string, ZernioAccount[]>();
    for (const a of accounts) {
      if (!a.platform || !a._id) continue;
      const list = byPlatform.get(a.platform) ?? [];
      list.push(a);
      byPlatform.set(a.platform, list);
    }

    const connected: Array<{ platform: string; accountId: string; name: string | null }> = [];
    const primaries: IntegrationLike[] = [];
    // SP-19: the primary is STICKY — the account the Integration already
    // points to stays primary while it is listed and healthy, whatever
    // Zernio's list order. Otherwise connecting a second number that Zernio
    // happens to list first would re-point number A's Integration (and, with
    // it, the account its threads reply from) to B.
    const current = new Map(
      (
        await this.prisma.integration.findMany({
          where: { workspaceId, provider: "zernio" },
          select: { platform: true, pageId: true },
        })
      ).map((r) => [r.platform, r.pageId]),
    );
    for (const [platform, list] of byPlatform) {
      const healthy = (a: ZernioAccount) => accountHealth(a).health === "ok";
      // After a reconnect Zernio can still list the revoked account first;
      // link the one that works.
      const primary =
        list.find((a) => a._id === current.get(platform) && healthy(a)) ?? list.find(healthy) ?? list[0];
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
      // the "replace Meta for FB/IG" behavior (one row per platform). The
      // single row stays for `main`; SP-19 Channels below hold every account.
      const integ = await this.prisma.integration.upsert({
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
      primaries.push(integ);
    }

    // SP-19 (ruling 2): one Channel per Zernio account, missing ones
    // disconnected. Each Integration's own channel follows it in place first
    // (re-auth onto a new account, Meta→Zernio switch), so existing threads
    // keep replying; a fresh link (reconnect) reactivates it.
    await mirrorZernioAccounts(this.prisma, workspaceId, accounts, primaries);

    this.realtime.emitToWorkspace(workspaceId, "inbox.activity", {});
    this.realtime.emitToWorkspace(workspaceId, "channels.updated", {});
    return { connected };
  }

  async status(workspaceId: string) {
    const rows = await this.prisma.integration.findMany({
      where: { workspaceId, provider: "zernio" },
    });
    const profileId = await this.getProfileId(workspaceId);
    // Our rows only say what was connected; Zernio says whether it still works.
    const live = profileId && this.client.isConfigured() ? await this.liveAccounts(profileId) : null;
    return {
      configured: this.client.isConfigured(),
      profileConnected: !!profileId,
      accounts: rows.map((r) => {
        const h = live ? accountHealth(live.find((a) => a._id === r.pageId)) : null;
        return {
          platform: r.platform,
          accountId: r.pageId,
          name: r.pageName,
          connectedAt: r.updatedAt,
          health: h?.health ?? ("unknown" as const),
          healthReason: h?.reason ?? null,
        };
      }),
    };
  }

  /** Zernio's account list, cached briefly; null when Zernio can't be reached. */
  private async liveAccounts(profileId: string): Promise<ZernioAccount[] | null> {
    const hit = this.healthCache.get(profileId);
    if (hit && Date.now() - hit.at < HEALTH_TTL_MS) return hit.accounts;
    let accounts: ZernioAccount[] | null;
    try {
      accounts = await this.client.listAccounts(profileId);
    } catch (e) {
      this.log.warn(`account health check failed for profile ${profileId}: ${(e as Error).message}`);
      accounts = null;
    }
    this.healthCache.set(profileId, { at: Date.now(), accounts });
    return accounts;
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

  /**
   * `GET /inbox/comments` returns POSTS with comment counts, not individual
   * comments (confirmed against https://docs.zernio.com/comments/list-inbox-comments
   * and a live probe — see task-4-report.md "Fix round 2"). Genuine comment
   * rows only exist per-post, so for every post that has any, fetch its real
   * comments and flatten. Posts with zero comments are skipped, saving the
   * extra round trip for the common case.
   */
  async listComments(workspaceId: string, platform?: string) {
    const profileId = await this.getProfileId(workspaceId);
    if (!profileId) return [];
    const posts = await this.client.listComments(profileId, platform?.toLowerCase());
    const withComments = posts.filter(
      (p) => (p.commentCount ?? 0) > 0 && (p.id ?? p._id) && p.accountId,
    );
    const rows = await Promise.all(
      withComments.map(async (post) => {
        const postId = (post.id ?? post._id)!;
        const accountId = post.accountId!;
        try {
          const comments = await this.client.getPostComments(postId, accountId);
          return comments
            .filter((c) => !!c.id)
            .map((c) => ({
              id: c.id!,
              postId,
              platform: post.platform ?? c.platform ?? null,
              author: c.from?.name ?? c.from?.username ?? "User",
              body: c.message ?? "",
              likes: c.likeCount ?? 0,
              at: c.createdTime ?? null,
              accountId,
            }));
        } catch (e) {
          this.log.warn(`Zernio getPostComments failed for post ${postId}: ${(e as Error).message}`);
          return [];
        }
      }),
    );
    return rows.flat();
  }

  /** Guard: an accountId sent by the client must be one of this workspace's
   *  own Zernio-connected accounts. */
  private async assertOwnAccount(workspaceId: string, accountId: string) {
    if (!(await this.ownAccount(workspaceId, accountId))) {
      throw new NotFoundException("Account not found in this workspace");
    }
  }

  /**
   * The workspace's own Zernio account: a non-disconnected Channel (SP-19:
   * one per account) or, before mirroring, the legacy Integration row.
   * Returns its platform.
   */
  private async ownAccount(workspaceId: string, accountId: string): Promise<{ platform: string } | null> {
    const ch = await this.prisma.channel.findFirst({
      where: { workspaceId, provider: "zernio", externalId: accountId },
      select: { kind: true, status: true },
    });
    // R9: a channel disconnected in the hub never sends, even though its
    // legacy Integration row is still there.
    if (ch) return ch.status === "disconnected" ? null : { platform: ch.kind };
    const integ = await this.prisma.integration.findFirst({
      where: { workspaceId, provider: "zernio", pageId: accountId },
    });
    if (!integ) return null;
    const slot = await this.prisma.channel.findFirst({
      where: { integrationId: integ.id },
      select: { status: true },
    });
    return slot?.status === "disconnected" ? null : { platform: integ.platform };
  }

  /**
   * Resolve a comment (by its own id) to the underlying post + owning
   * account it lives on. Required because Zernio's reply/delete endpoints
   * address the PARENT POST id in the path, not the comment id — our own
   * `/integrations/zernio/comments/:id/reply|delete` routes only carry the
   * comment id (see Task 5's frontend), so the post id has to be resolved
   * server-side. Scoping the lookup to this workspace's own live comment
   * feed doubles as the tenancy guard: a commentId from another workspace
   * simply won't be found here.
   */
  private async findCommentInWorkspace(workspaceId: string, commentId: string) {
    const comments = await this.listComments(workspaceId);
    const found = comments.find((c) => c.id === commentId);
    if (!found) throw new NotFoundException("Comment not found");
    return found;
  }

  async replyToComment(
    workspaceId: string,
    commentId: string,
    message: string,
    accountId?: string,
  ) {
    const profileId = await this.getProfileId(workspaceId);
    if (!profileId) throw new BadRequestException("Zernio is not connected");
    if (accountId) await this.assertOwnAccount(workspaceId, accountId);
    const comment = await this.findCommentInWorkspace(workspaceId, commentId);
    return this.client.replyToComment(
      comment.postId,
      accountId ?? comment.accountId,
      message,
      commentId,
    );
  }

  /**
   * Top-level comment on one of the workspace's own posts. Zernio's comment
   * endpoint addresses the POST id; omitting `commentId` creates a top-level
   * comment instead of a reply (live-verified 2026-08-12 during Tier 0
   * verification). Feed membership is the tenancy guard for the post id,
   * same pattern as cancelScheduledPost; accountId must be one of the
   * workspace's own connected accounts.
   */
  async commentOnPost(
    workspaceId: string,
    postId: string,
    message: string,
    accountId: string,
  ) {
    const profileId = await this.getProfileId(workspaceId);
    if (!profileId) throw new BadRequestException("Zernio is not connected");
    await this.assertOwnAccount(workspaceId, accountId);
    // The feed hands the frontend Zernio's internal _id, but the comments
    // endpoint addresses the platform's NATIVE post id (spike-verified:
    // platforms[].platformPostId). Resolve via the raw feed row — which
    // doubles as the own-feed tenancy check.
    const raw = (await this.client.listPosts(profileId)).find(
      (p) => (p._id ?? p.id) === postId,
    );
    if (!raw) throw new NotFoundException("Post not found");
    const entries = Array.isArray(raw.platforms)
      ? raw.platforms.filter(
          (pl): pl is { platform?: string; accountId?: string; platformPostId?: string } =>
            typeof pl !== "string",
        )
      : [];
    const nativeId =
      entries.find((pl) => pl.accountId === accountId)?.platformPostId ??
      entries.find((pl) => pl.platformPostId)?.platformPostId ??
      postId;
    return this.client.replyToComment(nativeId, accountId, message, undefined);
  }

  async deleteComment(workspaceId: string, commentId: string, accountId?: string) {
    const profileId = await this.getProfileId(workspaceId);
    if (!profileId) throw new BadRequestException("Zernio is not connected");
    if (accountId) await this.assertOwnAccount(workspaceId, accountId);
    const comment = await this.findCommentInWorkspace(workspaceId, commentId);
    await this.client.deleteComment(comment.postId, accountId ?? comment.accountId, commentId);
    return { ok: true as const };
  }

  // ─── Scheduled posts (created through Zernio) ─────────────────────────────

  async listScheduledPosts(workspaceId: string) {
    const profileId = await this.getProfileId(workspaceId);
    if (!profileId) return [];
    const posts = await this.client.listCreatedPosts(profileId);
    return posts
      .filter((p) => (p.status ?? "").toLowerCase() === "scheduled")
      .map((p) => ({
        id: p._id ?? p.id ?? "",
        content: p.content ?? p.caption ?? p.text ?? "",
        platforms: Array.isArray(p.platforms)
          ? p.platforms.map((pl) => (typeof pl === "string" ? pl : pl.platform ?? "")).filter(Boolean)
          : p.platform
            ? [p.platform]
            : [],
        mediaUrl: p.thumbnailUrl ?? p.mediaItems?.[0]?.url ?? p.mediaUrls?.[0] ?? null,
        scheduledFor: p.scheduledFor ?? null,
      }));
  }

  /** Guard: Zernio (and every platform behind it) needs real lead time to
   *  actually publish at the requested moment — enforce a 5-minute minimum
   *  here so the user gets a clear, immediate error instead of a confusing
   *  provider-side failure (or a "scheduled" post that silently never fires). */
  private assertFutureSchedule(scheduledFor: string) {
    if (new Date(scheduledFor).getTime() <= Date.now() + 5 * 60_000) {
      throw new BadRequestException(
        "Scheduled time must be at least 5 minutes in the future",
      );
    }
  }

  async cancelScheduledPost(workspaceId: string, postId: string) {
    // Ownership check: the id must be in this workspace's own queue.
    const mine = await this.listScheduledPosts(workspaceId);
    if (!mine.some((p) => p.id === postId)) {
      throw new NotFoundException("Scheduled post not found");
    }
    await this.client.cancelPost(postId);
    return { ok: true as const };
  }

  /**
   * Reschedule a scheduled post in place via `PUT /posts/{id}` (spike-verified
   * 2026-08-13: PUT_WORKS=yes — see docs/superpowers/plans/2026-08-13-spike-findings.md).
   * Same ownership guard as `cancelScheduledPost`: the id must be in this
   * workspace's own queue. The id is stable across the reschedule.
   */
  async reschedulePost(
    workspaceId: string,
    postId: string,
    scheduledFor: string,
    timezone: string,
  ) {
    const mine = await this.listScheduledPosts(workspaceId);
    if (!mine.some((p) => p.id === postId)) {
      throw new NotFoundException("Scheduled post not found");
    }
    this.assertFutureSchedule(scheduledFor);
    const res = await this.client.updatePost(postId, { scheduledFor, timezone });
    return { ok: true as const, id: res.id ?? postId };
  }

  // ─── Analytics overview ──────────────────────────────────────────────────

  /**
   * Per-platform analytics + follower stats for the social overview card,
   * with graceful degradation instead of ever throwing.
   *
   * `GET /analytics` only aggregates post COUNTS at the page level (spike,
   * 2026-08-13: docs/superpowers/plans/2026-08-13-analytics-spike-findings.md)
   * — there is no "total impressions this window" anywhere in the response,
   * so totals are summed here from `posts[]`. Each post's `platforms[]`
   * breakdown (the LIVE field name — docs wrongly call it
   * `platformAnalytics`) is preferred over the post's rolled-up `analytics`
   * object, because it's the only way to attribute metrics to the right
   * platform for a post that was cross-posted to more than one. A metric key
   * that never appears on any row for a platform stays `null` (the platform
   * genuinely doesn't report it — e.g. WhatsApp has no post-analytics
   * concept, and this account's Instagram rows never carry `impressions`);
   * it must never be reported as `0`. The output's `engagement` slot is
   * count-shaped (same as impressions/likes/etc.) but upstream has no
   * engagement COUNT at all — only `engagementRate`, a % — so it stays
   * `null` unconditionally rather than smuggling a rate into a count field.
   *
   * Follower history comes from a separate endpoint
   * (`GET /accounts/follower-stats`) which reports per-ACCOUNT, not
   * per-platform — its `accounts[]` array is the join back to a platform
   * name for `stats[accountId]`.
   *
   * Plan gating has two independent signals: the 402/403 error shapes
   * caught below, and `GET /analytics`'s own `hasAnalyticsAccess: false` —
   * a 200 response that isn't an error at all. Both collapse to
   * `{ available: false, reason: "plan" }`.
   */
  async analyticsOverview(workspaceId: string, days: 7 | 30) {
    const profileId = await this.getProfileId(workspaceId);
    if (!profileId) return { available: false as const, reason: "not_connected" as const };

    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const fromDate = iso(from);
    const toDate = iso(to);

    try {
      const [analyticsRes, followerStats] = await Promise.all([
        this.client.getAnalytics(profileId, { fromDate, toDate }),
        this.client.getFollowerStats(profileId, { fromDate, toDate, granularity: "daily" }),
      ]);

      // A second plan-gate signal alongside the 402/403 error shapes caught
      // below: `GET /analytics` can answer 200 with an explicit
      // `hasAnalyticsAccess: false` rather than erroring (spike-verified
      // shape — see ZernioClient.getAnalytics). Treat it the same as those.
      if (analyticsRes.hasAnalyticsAccess === false) {
        this.log.warn(`analyticsOverview ws=${workspaceId} unavailable (plan): hasAnalyticsAccess=false`);
        return { available: false as const, reason: "plan" as const };
      }
      const rows = analyticsRes.rows;

      const SUM_METRICS = ["impressions", "reach", "likes", "comments", "shares"] as const;
      type SumMetric = (typeof SUM_METRICS)[number];
      const sums = new Map<string, Record<SumMetric, number | null>>();
      // One analytics row summed for this platform == one post's contribution
      // (a cross-posted post contributes once per platform via its
      // `platforms[]` breakdown) — surfaced as `postCount` so the UI can be
      // honest about how thin a platform's totals are.
      const postCounts = new Map<string, number>();

      const addEntry = (platform: string, analytics?: ZernioAnalyticsRow["analytics"]) => {
        if (!analytics) return;
        postCounts.set(platform, (postCounts.get(platform) ?? 0) + 1);
        const acc =
          sums.get(platform) ??
          (Object.fromEntries(SUM_METRICS.map((m) => [m, null])) as Record<
            SumMetric,
            number | null
          >);
        for (const m of SUM_METRICS) {
          const v = analytics[m];
          if (typeof v === "number") acc[m] = (acc[m] ?? 0) + v;
        }
        sums.set(platform, acc);
      };

      for (const row of rows) {
        if (Array.isArray(row.platforms) && row.platforms.length > 0) {
          for (const p of row.platforms) {
            if (p.platform) addEntry(p.platform, p.analytics);
          }
        } else if (row.platform) {
          addEntry(row.platform, row.analytics);
        }
      }

      const accountPlatform = new Map<string, string>();
      for (const a of followerStats.accounts ?? []) {
        if (a._id && a.platform) accountPlatform.set(a._id, a.platform);
      }
      const followers = new Map<
        string,
        { current: number; delta: number; series: { date: string; count: number }[] }
      >();
      for (const [accountId, points] of Object.entries(followerStats.stats ?? {})) {
        const platform = accountPlatform.get(accountId);
        if (!platform) continue;
        const series = (points ?? [])
          .filter(
            (p): p is { date: string; followers: number } =>
              !!p?.date && typeof p.followers === "number" && p.date >= fromDate,
          )
          .map((p) => ({ date: p.date, count: p.followers }))
          .sort((a, b) => (a.date < b.date ? -1 : 1));
        if (!series.length) continue;
        followers.set(platform, {
          current: series[series.length - 1].count,
          delta: series[series.length - 1].count - series[0].count,
          series,
        });
      }

      // Only surface a platform card when it has posts, followers, or both —
      // never a hollow all-null/all-zero card for a platform we heard
      // nothing about this window.
      const names = new Set([...sums.keys(), ...followers.keys()]);
      const platforms = [...names].map((platform) => {
        const m = sums.get(platform);
        return {
          platform,
          followers: followers.get(platform) ?? { current: 0, delta: 0, series: [] },
          impressions: m?.impressions ?? null,
          reach: m?.reach ?? null,
          // Always null: upstream has no engagement COUNT, only
          // `engagementRate` (a %) — see the doc comment above. A future
          // slice that wants a rate-typed field should add a new one rather
          // than repurpose this count-shaped slot.
          engagement: null,
          likes: m?.likes ?? null,
          comments: m?.comments ?? null,
          shares: m?.shares ?? null,
          // Platforms surfaced only via follower data (no analytics rows at
          // all this window) report 0 here rather than being absent from
          // `postCounts` — lets the UI say "no posts in this window" instead
          // of implying a metric that just happens to be null.
          postCount: postCounts.get(platform) ?? 0,
        };
      });

      return { available: true as const, windowDays: days, platforms };
    } catch (e) {
      const status = (e as { getStatus?: () => number }).getStatus?.() ?? 0;
      const message = (e as Error).message ?? "";
      // The docs' gate shape is HTTP 403 with an "add-on" message; this
      // workspace itself is never gated (spike, 2026-08-13), so that shape
      // is unconfirmed live — matched defensively anyway. A 402 or a 403
      // that isn't about the add-on is treated as an ordinary upstream error.
      const reason: "plan" | "upstream" =
        status === 402 || (status === 403 && /add-on/i.test(message)) ? "plan" : "upstream";
      this.log.warn(`analyticsOverview ws=${workspaceId} unavailable (${reason}): ${message}`);
      return { available: false as const, reason };
    }
  }

  async disconnect(workspaceId: string, platform: string) {
    const integ = await this.prisma.integration.findFirst({
      where: { workspaceId, platform: platform.toLowerCase(), provider: "zernio" },
    });
    if (!integ) return { ok: true, removed: false };
    // SP-19: the platform's Zernio channels stop sending too (soft: history
    // and conversation.channelId stay). Reconnecting — any later sync that
    // lists the account, exactly as on `main` — reactivates them.
    await this.prisma.channel.updateMany({
      where: { workspaceId, provider: "zernio", kind: platform.toLowerCase(), status: { not: "disconnected" } },
      data: { status: "disconnected", statusReason: INTEGRATION_REMOVED, disconnectedAt: new Date(), isDefault: false },
    });
    await this.prisma.integration.delete({ where: { id: integ.id } });
    await ensureDefaultPerKind(this.prisma, workspaceId);
    this.realtime.emitToWorkspace(workspaceId, "channels.updated", {});
    this.healthCache.clear();
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

  /**
   * Zernio's messages endpoint requires the owning `accountId` alongside the
   * conversation id. The Inbox already holds it (the conversation list carries
   * it for sends) and passes it through; when it's absent we resolve it by
   * looking the conversation up in the live list, so the endpoint still works
   * on its own.
   */
  async getMessages(workspaceId: string, conversationId: string, accountId?: string) {
    let resolved = accountId;
    if (!resolved) {
      const convs = await this.listConversations(workspaceId);
      resolved = convs.find((c) => c.id === conversationId)?.accountId;
    }
    if (!resolved) {
      throw new NotFoundException("Zernio conversation not found for this workspace");
    }
    const msgs = await this.client.getMessages(conversationId, resolved);
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
    const own = await this.ownAccount(workspaceId, accountId);
    if (!own) {
      throw new NotFoundException("Zernio account not connected for this workspace");
    }
    const { id } = await this.client.sendMessage(conversationId, accountId, message);
    this.realtime.emitToWorkspace(workspaceId, "inbox.activity", { channel: own.platform });
    return { ok: true, id };
  }

  /**
   * Send into one of our own DB conversations via Zernio.
   *
   * Inbound webhooks create DB-backed Conversation rows (that's how WhatsApp,
   * FB and IG threads appear in the Inbox), but the transport is Zernio — so
   * replying can't go through the legacy Meta services, whose tokens Zernio's
   * sync replaced. We resolve the Zernio conversation from the contact's
   * platform id rather than storing it, which means this also works for
   * threads created before Zernio existed.
   */
  /**
   * Send an APPROVED WhatsApp template into a DB-backed conversation.
   *
   * This is the only way to reply once the 24-hour customer-service window has
   * closed. It deliberately mirrors `sendInDbConversation`'s target resolution
   * (integration row → Zernio conversation id) so both paths behave the same
   * on a thread the inbound webhook has not yet stamped with an externalId.
   */
  async sendTemplateInDbConversation(
    workspaceId: string,
    conversationId: string,
    name: string,
    language: string,
    variables: string[],
    header?: TemplateHeaderInput,
    viewer?: Viewer,
    /** SP-11: the member sending from the inbox (Message.sentById); workflows pass none. */
    actorId?: string,
  ) {
    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, workspaceId },
      include: { contact: true },
    });
    if (!conv) throw new NotFoundException("Conversation not found");

    const channel = conv.channel.toLowerCase();
    if (channel !== "whatsapp") {
      throw new BadRequestException(
        "Templates can only be sent into a WhatsApp thread",
      );
    }

    const { accountId, zernioConvId, channelId } = await this.resolveZernioTarget(
      workspaceId,
      conv,
      channel,
    );

    // Positional {{1}}, {{2}} … variables become Meta's body component. Left
    // absent when there are none — an empty parameters array is a 400 at Meta.
    // Header first (Meta's component order); validated before anything is sent.
    const resolvedHeader = await resolveTemplateHeader(
      { prisma: this.prisma, media: this.media },
      workspaceId,
      name,
      header,
      { language, viewer },
    );
    const componentList: Array<Record<string, unknown>> = [];
    if (resolvedHeader) componentList.push(resolvedHeader.component);
    if (variables.length > 0) {
      componentList.push({
        type: "body",
        parameters: variables.map((v) => ({ type: "text", text: v })),
      });
    }
    const components = componentList.length > 0 ? componentList : undefined;

    const { id } = await this.client.sendTemplateMessage(zernioConvId, accountId, {
      name,
      language,
      ...(components ? { components } : {}),
    });

    // Our DB only holds the template's raw body, so render a readable stand-in
    // rather than an empty bubble; Meta renders the real thing for the customer.
    const previewBody =
      variables.length > 0
        ? `[template: ${name}] ${variables.join(" · ")}`
        : `[template: ${name}]`;

    const now = new Date();
    const t = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    await this.prisma.message.create({
      data: {
        workspaceId,
        conversationId: conv.id,
        from: "human",
        body: previewBody,
        t,
        attach: resolvedHeader?.attach ?? null,
        metaMessageId: id,
        ...sentByData(actorId),
      },
    });
    await this.prisma.conversation.update({
      where: { id: conv.id },
      data: {
        preview: previewBody.slice(0, 140),
        lastAt: "now",
        lastFrom: "human",
        unread: 0,
      },
    });
    this.realtime.emitToWorkspace(workspaceId, "inbox.activity", {
      channel,
      channelId,
      conversationId: conv.id,
    });
    await this.pipelineAutomation.onOutboundReply(workspaceId, conv.contactId);
    return { ok: true, id };
  }

  /**
   * Resolve the Zernio send target for a DB conversation: the sending account
   * id and Zernio's own conversation id.
   *
   * The inbound webhook stamps Zernio's conversation id onto the row, letting
   * us send directly. Rows that predate the column fall back to the live
   * conversation list — and get backfilled so they only pay that ~0.5s once.
   */
  private async resolveZernioTarget(
    workspaceId: string,
    conv: {
      id: string;
      channel: string;
      channelId?: string | null;
      externalId: string | null;
      contact?: { externalId: string | null } | null;
    },
    channel: string,
  ): Promise<{ accountId: string; zernioConvId: string; channelId: string }> {
    // SP-19: send from the account the conversation belongs to (its channel),
    // never "the" platform integration. Disconnected → 409, never rerouted.
    const ch = await this.channels.forSend(workspaceId, conv);
    // An Integration-linked channel sends from the Integration's CURRENT
    // account (as `main` does), even before the channel is re-aligned.
    const creds = await credentialsFor(this.prisma, ch);
    if (creds.provider !== "zernio" || !creds.externalId) {
      throw new NotFoundException(`${channel} is not connected via Zernio`);
    }
    const accountId = creds.externalId;

    let zernioConvId = conv.externalId;
    if (!zernioConvId) {
      const participantId = conv.contact?.externalId;
      if (!participantId) {
        throw new BadRequestException("This contact has no platform id to reply to");
      }
      // Only this account's threads: with two numbers the same customer has
      // a Zernio conversation on each, and the other one must never match.
      const convs = await this.listConversations(workspaceId, channel);
      const match = convs.find((c) => c.participantId === participantId && c.accountId === accountId);
      if (!match) {
        throw new NotFoundException(
          "No Zernio conversation for this contact yet — they need to message you first",
        );
      }
      zernioConvId = match.id;
      await this.prisma.conversation.update({
        where: { id: conv.id },
        data: { externalId: zernioConvId },
      });
    }
    return { accountId, zernioConvId, channelId: ch.id };
  }

  async sendInDbConversation(
    workspaceId: string,
    conversationId: string,
    message: string,
    mediaId?: string,
    publicBaseUrl?: string,
    from: "human" | "ai" = "human",
    externalAttachment?: { url: string; type: "image" },
    /** SP-11: the member sending from the inbox (Message.sentById); none for AI replies. */
    actorId?: string,
  ) {
    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, workspaceId },
      include: { contact: true },
    });
    if (!conv) throw new NotFoundException("Conversation not found");

    // Media rides as a publicly fetchable URL with Zernio's attachmentUrl/
    // attachmentType contract. Spaces-stored media resolves to a signed
    // Spaces URL (fetchable from anywhere — no tunnel/PUBLIC_BASE_URL
    // dependency); only legacy local-disk media still needs publicBaseUrl.
    // An AI-sourced image already has a public URL of its own — it skips the
    // CRM Media store entirely rather than being re-hosted there.
    let attachment: { url: string; type: "image" | "video" | "audio" | "file" } | undefined =
      externalAttachment;
    if (!attachment && mediaId) {
      const row = await this.media.get(workspaceId, mediaId);
      let url: string;
      if (row.storageKind === "spaces") {
        url = await this.media.resolveExternalUrl(workspaceId, mediaId);
      } else {
        if (!publicBaseUrl) throw new BadRequestException("Media sends need a public base URL");
        const token = await this.media.mintPublicToken(workspaceId, mediaId);
        url = `${publicBaseUrl.replace(/\/+$/, "")}/api/media/${mediaId}/public?token=${token}`;
      }
      const type = row.mimeType.startsWith("image/")
        ? ("image" as const)
        : row.mimeType.startsWith("video/")
          ? ("video" as const)
          : ("file" as const);
      attachment = { url, type };
    }

    const channel = conv.channel.toLowerCase();
    const { accountId, zernioConvId, channelId } = await this.resolveZernioTarget(
      workspaceId,
      conv,
      channel,
    );

    // Instagram and Messenger DMs carry ONE body shape per message — text OR
    // an attachment, never both (there is no caption field; the legacy Meta
    // send path splits them for the same reason). Handing Zernio both in one
    // call delivers only the image and silently drops the text, so split it
    // into two sends: image first, then the text as its own message. WhatsApp
    // does support media captions, so it keeps the single call.
    const captionCapable = channel === "whatsapp";
    let id: string | null = null;
    if (attachment && message && !captionCapable) {
      await this.client.sendMessage(zernioConvId, accountId, "", attachment);
      ({ id } = await this.client.sendMessage(zernioConvId, accountId, message));
    } else {
      ({ id } = await this.client.sendMessage(
        zernioConvId,
        accountId,
        message,
        attachment,
      ));
    }

    const now = new Date();
    const t = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    await this.prisma.message.create({
      data: {
        workspaceId,
        conversationId: conv.id,
        from,
        body: message,
        t,
        // Frontend convention: attach carries either our Media id, or — for
        // an AI-sourced image — the external URL directly.
        attach: mediaId ?? externalAttachment?.url ?? null,
        metaMessageId: id,
        ...(from === "human" ? sentByData(actorId) : {}),
      },
    });
    await this.prisma.conversation.update({
      where: { id: conv.id },
      data: {
        preview: message ? message.slice(0, 140) : "📎",
        lastAt: "now",
        lastFrom: from,
        unread: 0,
      },
    });
    this.realtime.emitToWorkspace(workspaceId, "inbox.activity", {
      channel,
      channelId,
      conversationId: conv.id,
    });
    // Replying counts as making contact — moves the auto-created ticket
    // new → contacted (no-op when nothing sits in 'new'). Never throws.
    await this.pipelineAutomation.onOutboundReply(workspaceId, conv.contactId);
    return { ok: true, id };
  }

  /**
   * One-time import of Zernio's conversation history into our DB.
   *
   * The inbound webhook only persists messages from the moment it was set up;
   * everything older lives solely in Zernio. This walks every Zernio
   * conversation, upserts the contact + conversation (with externalId), and
   * inserts any message we don't already hold — after which the Inbox can be
   * served entirely from our own DB. Idempotent: re-running skips existing
   * rows via metaMessageId, with a body+timestamp fuzzy match covering the
   * webhook-era rows that were stored under Zernio's internal id scheme.
   */
  async backfillHistory(workspaceId: string) {
    const profileId = await this.getProfileId(workspaceId);
    if (!profileId) throw new NotFoundException("Zernio profile is not connected");

    const zConvs = await this.client.listConversations(profileId);
    const counts = {
      conversations: zConvs.length,
      conversationsCreated: 0,
      messagesInserted: 0,
      messagesSkipped: 0,
      attachmentsSaved: 0,
      /** Threads of an account with no channel in this workspace (SP-19). */
      conversationsSkipped: 0,
      errors: [] as string[],
    };

    for (const zc of zConvs) {
      try {
        const channel = (zc.platform ?? "").toLowerCase();
        const participantId = String(zc.participantId ?? "");
        if (!channel || !participantId) continue;

        // SP-19: resolve the thread's account exactly like the webhook does
        // (mirroring a legacy Integration on the fly). An account with no
        // channel in THIS workspace is skipped — never merged into another
        // number's thread.
        const ch = zc.accountId ? await this.channels.forInbound("zernio", zc.accountId) : null;
        if (!ch || ch.workspaceId !== workspaceId) {
          counts.conversationsSkipped++;
          continue;
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
            name: zc.participantName ?? `${channel} user`,
            phone: phoneFromParticipantId(channel, participantId),
            industry: channel,
            lifecycle: "lead",
            source: channel,
            lastSeen: "—",
            externalSource: channel,
            externalId: participantId,
          },
          update: {},
        });
        {
          // Older rows predate phone capture — fill it once, never overwrite.
          const phone = phoneFromParticipantId(channel, participantId);
          if (phone && !contact.phone) {
            await this.prisma.contact.update({ where: { id: contact.id }, data: { phone } });
          }
        }

        let conv = await this.channels.findOrAdoptConversation(workspaceId, contact.id, {
          id: ch.id,
          kind: channel,
        });
        if (!conv) {
          conv = await this.prisma.conversation.create({
            data: {
              workspaceId,
              contactId: contact.id,
              channelId: ch.id,
              unread: 0,
              pinned: false,
              lastAt: "—",
              lastFrom: "them",
              preview: zc.lastMessage ?? "—",
              channel,
              status: "human",
              intent: "—",
              confidence: 0,
              externalId: zc.id,
            },
          });
          counts.conversationsCreated++;
        } else if (conv.externalId !== zc.id) {
          await this.prisma.conversation.update({
            where: { id: conv.id },
            data: { externalId: zc.id },
          });
        }

        const zMsgs = await this.client.getMessages(zc.id, zc.accountId);
        const existing = await this.prisma.message.findMany({
          where: { workspaceId, conversationId: conv.id },
          select: { metaMessageId: true, body: true, from: true, createdAt: true },
        });
        const byMeta = new Set(existing.map((m) => m.metaMessageId).filter(Boolean));

        // Split into plain rows (batched in one createMany) and rows with an
        // attachment to download (created individually).
        const plain: Array<{
          workspaceId: string; conversationId: string; from: string; body: string;
          t: string; metaMessageId: string | null; createdAt: Date;
          deliveryStatus: string | null;
        }> = [];

        for (const m of zMsgs) {
          if (m.isDeleted) { counts.messagesSkipped++; continue; }
          const mid = m.id ?? m._id ?? null;
          if (mid && byMeta.has(mid)) { counts.messagesSkipped++; continue; }
          const from = m.direction === "incoming" ? "them" : "human";
          const attachment = m.attachments?.[0];
          const body =
            (m.message ?? m.text ?? m.body ?? "").trim() ||
            (attachment ? `[${attachment.type ?? "attachment"}]` : "");
          if (!body) { counts.messagesSkipped++; continue; }
          const at = new Date(m.sentAt ?? m.createdAt ?? Date.now());
          // Webhook-era rows carry Zernio-internal ids, so the id check above
          // misses them — same author + same text within 2 minutes is a dupe.
          const fuzzyDup = existing.some(
            (e) =>
              e.from === from &&
              e.body === body &&
              Math.abs(e.createdAt.getTime() - at.getTime()) < 120_000,
          );
          if (fuzzyDup) { counts.messagesSkipped++; continue; }

          const t = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
          const row = {
            workspaceId,
            conversationId: conv.id,
            from,
            body,
            t,
            metaMessageId: mid,
            createdAt: at,
            deliveryStatus: m.deliveryStatus ?? null,
          };

          if (attachment?.url) {
            let attach: string | null = null;
            try {
              const { buffer, mimeType } = await this.client.downloadMedia(attachment.url);
              const media = await this.media.ingestBuffer({
                workspaceId,
                buffer,
                mimeType: attachment.payload?.mimeType || mimeType || "image/jpeg",
                fileName: `${channel}-${attachment.payload?.id ?? mid ?? "media"}`,
              });
              attach = media.id;
              counts.attachmentsSaved++;
            } catch (e) {
              this.log.warn(`Backfill attachment failed: ${(e as Error).message}`);
            }
            await this.prisma.message.create({ data: { ...row, attach } });
            counts.messagesInserted++;
          } else {
            plain.push(row);
          }
        }

        if (plain.length > 0) {
          await this.prisma.message.createMany({ data: plain });
          counts.messagesInserted += plain.length;
        }

        // Refresh the thread summary from the newest message we now hold.
        const latest = await this.prisma.message.findFirst({
          where: { conversationId: conv.id },
          orderBy: { createdAt: "desc" },
        });
        if (latest) {
          await this.prisma.conversation.update({
            where: { id: conv.id },
            data: {
              preview: latest.body.slice(0, 140),
              lastFrom: latest.from,
              lastAt: compactAge(latest.createdAt),
              // Pin updatedAt to the real last-message time — the Inbox sorts
              // on it, and letting @updatedAt auto-bump here would order the
              // list by backfill-walk order instead of actual recency.
              updatedAt: latest.createdAt,
            },
          });
        } else {
          // Nothing storable in this thread (e.g. a story mention with no
          // text) — sink it to the bottom of the list instead of letting the
          // backfill's own write time float it to the top.
          await this.prisma.conversation.update({
            where: { id: conv.id },
            data: { updatedAt: new Date("2020-01-01T00:00:00Z") },
          });
        }
      } catch (e) {
        counts.errors.push(`${zc.platform}/${zc.id}: ${(e as Error).message}`);
      }
    }

    this.realtime.emitToWorkspace(workspaceId, "inbox.activity", {});
    return counts;
  }

  // ─── Publishing ──────────────────────────────────────────────────────────

  async publish(
    workspaceId: string,
    input: {
      content: string;
      platforms: string[];
      mediaIds?: string[];
      scheduledFor?: string;
      timezone?: string;
    },
    publicBaseUrl: string,
  ): Promise<{ id: string | null; status: string | null }> {
    const wanted = input.platforms.map((p) => p.toLowerCase());
    const rows = await this.prisma.integration.findMany({
      where: { workspaceId, provider: "zernio", platform: { in: wanted } },
    });
    // SP-19 m7 (R9): an account whose channel the user disconnected in the
    // hub is not posted to. Other disconnect reasons keep `main`'s behaviour.
    const pageIds = rows.map((r) => r.pageId).filter((id): id is string => !!id);
    const blocked = new Set(
      pageIds.length
        ? (
            await this.prisma.channel.findMany({
              where: {
                workspaceId,
                provider: "zernio",
                externalId: { in: pageIds },
                status: "disconnected",
                statusReason: USER_DISCONNECTED,
              },
              select: { externalId: true },
            })
          ).map((c) => c.externalId)
        : [],
    );
    const platforms = rows
      .filter((r) => r.pageId && !blocked.has(r.pageId))
      .map((r) => ({ platform: r.platform, accountId: r.pageId! }));
    if (platforms.length === 0) {
      throw new BadRequestException("No connected Zernio accounts for the requested platforms");
    }
    if (input.scheduledFor) {
      this.assertFutureSchedule(input.scheduledFor);
    }
    // Zernio fetches media by URL at post-creation time. Spaces media gets a
    // signed Spaces URL (reachable from anywhere); legacy local-disk media
    // keeps the short-lived token URL through publicBaseUrl.
    const mediaUrls: string[] = [];
    for (const mediaId of input.mediaIds ?? []) {
      const row = await this.media.get(workspaceId, mediaId);
      if (row.storageKind === "spaces") {
        mediaUrls.push(await this.media.resolveExternalUrl(workspaceId, mediaId));
      } else {
        const token = await this.media.mintPublicToken(workspaceId, mediaId);
        mediaUrls.push(
          `${publicBaseUrl.replace(/\/+$/, "")}/api/media/${mediaId}/public?token=${token}`,
        );
      }
    }
    return this.client.createPost({
      content: input.content,
      platforms,
      mediaUrls: mediaUrls.length ? mediaUrls : undefined,
      scheduledFor: input.scheduledFor,
      timezone: input.timezone,
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
      const profileId = payload.data?.profileId ?? payload.account?.profileId;
      if (profileId) {
        const ws = await this.prisma.workspace.findFirst({
          where: { zernioProfileId: profileId },
        });
        if (ws) await this.syncAccounts(ws.id);
      }
      return { ok: true };
    }
    if (type === "reaction.received") {
      await this.applyReaction(payload);
      return { ok: true };
    }
    if (
      type === "message.sent" ||
      type === "message.delivered" ||
      type === "message.read" ||
      type === "message.failed"
    ) {
      const { updated, channel } = await this.applyStatus(type, payload);
      // SP-12: the same event updates campaign recipient rows (and may stamp
      // a queued one by phone, ruling 2). Never throws.
      if (channel) await this.trackRecipientStatus(type, payload, channel, updated);
      // message.sent with no matching row = an outbound composed OUTSIDE the
      // platform (the business replying from the Instagram/WhatsApp app on
      // their phone). Persist it, or the thread shows a hole on our side.
      if (type === "message.sent" && updated === 0) {
        await this.ingestInbound(payload);
      }
      return { ok: true };
    }
    if (type === "whatsapp.template.status_updated") {
      await this.applyTemplateStatus(payload);
      return { ok: true };
    }
    if (type.startsWith("whatsapp.number.")) {
      // Provisioning/KYC lifecycle — surface for observability; a real number
      // becomes usable once `account.connected` / activation arrives.
      this.log.log(`Zernio WhatsApp number event: ${type} ${JSON.stringify(payload).slice(0, 400)}`);
      return { ok: true };
    }
    this.log.debug(`Unhandled Zernio event: ${type}`);
    return { ok: true, ignored: true };
  }

  /**
   * SP-14 (ruling 15): `whatsapp.template.status_updated`. The workspace is
   * the one owning the account: the most recent non-disconnected Zernio
   * channel with `externalId = account.accountId`. Unknown accounts are
   * logged and ignored. Template rows of that workspace only are updated,
   * by `metaTemplateId` first; the name + base-language fallback applies
   * only when the account is the workspace's default number, because the
   * rows are default-number rows (SP-19 R8) and another number's copy must
   * never rewrite them. Then a check of that number is requested
   * (`trigger: "webhook"`, cooldown respected), so a pause on any number
   * reaches its snapshot and the downgrade alerts. Never throws.
   */
  private async applyTemplateStatus(payload: ZernioWebhookEvent): Promise<void> {
    try {
      const accountId = payload.account?.accountId ?? payload.data?.accountId ?? payload.data?.account?.accountId;
      const t = payload.template ?? payload.data?.template;
      if (!accountId || !t) {
        this.log.warn("Zernio template status event without an account or a template; ignored");
        return;
      }
      const ch = await this.prisma.channel.findFirst({
        where: { kind: "whatsapp", provider: "zernio", externalId: accountId, status: { not: "disconnected" } },
        orderBy: [{ updatedAt: "desc" }],
        select: { id: true, workspaceId: true },
      });
      if (!ch) {
        this.log.log("Zernio template status event for an account no workspace holds; ignored");
        return;
      }
      const isDefault = (await defaultZernioWhatsappAccountId(this.prisma, ch.workspaceId)) === accountId;
      const n = await applyTemplateProviderStatus(
        this.prisma,
        ch.workspaceId,
        {
          templateId: t.templateId ?? t.id ?? null,
          name: t.name ?? null,
          language: t.language ?? null,
          status: t.status ?? null,
          reason: t.reason ?? t.rejectedReason ?? t.rejected_reason ?? null,
        },
        { allowNameMatch: isDefault },
      );
      this.log.log(`Zernio template status ${String(t.status ?? "")} applied to ${n} template row(s)`);
      this.healthTrigger?.request(ch.workspaceId, ch.id);
    } catch (e) {
      this.log.warn(`Zernio template status event failed: ${(e as Error)?.message ?? "error"}`);
    }
  }

  /**
   * Persist an inbound message into Contact/Conversation/Message + emit
   * realtime. Field names match the real webhook payload captured off the
   * tunnel — see ZernioWebhookEvent.
   */
  private async ingestInbound(evt: ZernioWebhookEvent) {
    const accountId = evt.account?.accountId ?? evt.account?.id;
    if (!accountId) {
      this.log.warn(`Zernio inbound with no account id: ${JSON.stringify(evt).slice(0, 300)}`);
      return;
    }

    // Outbound messages reach us too — either echoed on message.received or,
    // for replies the business types in the Instagram/WhatsApp APP directly,
    // via message.sent with no matching DB row. Both must be persisted, or the
    // thread shows only the customer's half.
    const isOutbound = evt.message?.direction === "outgoing";
    const from = isOutbound ? "human" : "them";

    // SP-19: the account's Channel decides the workspace AND the thread, so
    // number B's messages land in B's conversations. A legacy Integration
    // with no Channel yet is mirrored on the fly — nothing `main` connected
    // is dropped.
    const ch = await this.channels.forInbound("zernio", accountId);
    if (!ch) {
      this.log.warn(`Inbound for unknown zernio accountId=${accountId}`);
      return;
    }
    const workspaceId = ch.workspaceId;
    const channelId = ch.id;
    const channel = (evt.message?.platform ?? evt.account?.platform ?? ch.kind).toLowerCase();
    const externalMsgId = evt.message?.id ?? evt.message?.platformMessageId ?? null;
    const attachment = evt.message?.attachments?.[0];
    // Media-only messages arrive with text: null. Label by attachment type
    // rather than the old catch-all "[whatsapp message]" placeholder.
    const text =
      evt.message?.text?.trim() ||
      (attachment ? `[${attachment.type ?? "attachment"}]` : `[${channel} message]`);
    // On outbound messages `sender` is the BUSINESS account — the customer is
    // only identified by the conversation's participant fields.
    const participantId = String(
      evt.conversation?.participantId ??
        (isOutbound ? "" : evt.message?.sender?.id ?? ""),
    );
    const participantName =
      evt.conversation?.participantName ??
      evt.conversation?.participantUsername ??
      (isOutbound ? undefined : evt.message?.sender?.name ?? evt.message?.sender?.username);

    if (!participantId) {
      this.log.warn(`Zernio inbound with no participant id (conv=${evt.conversation?.id})`);
      return;
    }

    // Idempotency — Zernio delivers at-least-once; dedupe by external message id.
    if (externalMsgId) {
      const seen = await this.prisma.message.findFirst({
        where: { workspaceId, metaMessageId: externalMsgId },
        select: { id: true },
      });
      if (seen) return;
    }

    // Re-host the attachment. Zernio's media URL needs their bearer token, so
    // the browser can't render it directly — we pull the bytes here and store
    // a Media row, then hand the Inbox our own id. Deliberately after the
    // dedupe check so at-least-once redeliveries don't re-download.
    // A failure here must not lose the message: fall through with attach=null.
    let attachMediaId: string | null = null;
    if (attachment?.url) {
      try {
        const { buffer, mimeType } = await this.client.downloadMedia(attachment.url);
        const media = await this.media.ingestBuffer({
          workspaceId,
          buffer,
          mimeType: attachment.payload?.mimeType || mimeType || "image/jpeg",
          fileName: `${channel}-${attachment.payload?.id ?? Date.now()}`,
        });
        attachMediaId = media.id;
      } catch (e) {
        this.log.warn(
          `Zernio attachment download failed (${attachment.type}): ${(e as Error).message}`,
        );
      }
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
        phone: phoneFromParticipantId(channel, participantId),
        industry: channel,
        lifecycle: "lead",
        source: channel,
        lastSeen: isOutbound ? "—" : "now",
        externalSource: channel,
        externalId: participantId,
      },
      // lastSeen tracks the CUSTOMER's activity — our own replies don't move it.
      update: isOutbound ? {} : { lastSeen: "now" },
    });
    {
      // Older rows predate phone capture — fill it once, never overwrite.
      const phone = phoneFromParticipantId(channel, participantId);
      if (phone && !contact.phone) {
        await this.prisma.contact.update({ where: { id: contact.id }, data: { phone } });
      }
    }

    // Zernio's conversation id — persisted so replies can address the provider
    // conversation directly instead of re-listing on every send.
    const zernioConvId = evt.conversation?.id ?? evt.message?.conversationId ?? null;

    // Conversation key (SP-19): (workspace, contact, channelId). A legacy
    // null-channel thread is adopted only by the channel it resolves to.
    let conv = await this.channels.findOrAdoptConversation(workspaceId, contact.id, {
      id: channelId,
      kind: channel,
    });
    if (!conv) {
      conv = await this.prisma.conversation.create({
        data: {
          workspaceId,
          contactId: contact.id,
          channelId,
          unread: isOutbound ? 0 : 1,
          pinned: false,
          lastAt: "now",
          lastFrom: from,
          preview: text.slice(0, 140),
          channel,
          status: "human",
          intent: "—",
          confidence: 0,
          externalId: zernioConvId,
        },
      });
    } else {
      await this.prisma.conversation.update({
        where: { id: conv.id },
        data: {
          preview: text.slice(0, 140),
          lastAt: "now",
          lastFrom: from,
          // Our own replies don't add to the unread pile.
          ...(isOutbound ? {} : { unread: { increment: 1 } }),
          // Backfill rows that predate externalId (or repair a stale one).
          ...(zernioConvId && conv.externalId !== zernioConvId
            ? { externalId: zernioConvId }
            : {}),
        },
      });
    }

    const now = new Date();
    const t = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const created = await this.prisma.message.create({
      data: {
        workspaceId,
        conversationId: conv.id,
        from,
        body: text,
        t,
        attach: attachMediaId,
        metaMessageId: externalMsgId,
        // App-composed outbound arrives via message.sent, so it's sent by definition.
        ...(isOutbound ? { deliveryStatus: "sent", deliveryStatusAt: new Date() } : {}),
      },
    });
    this.realtime.emitToWorkspace(workspaceId, "inbox.activity", {
      channel,
      channelId,
      conversationId: conv.id,
    });
    if (!isOutbound) await this.channels.touchInbound(channelId);

    // SP-12: a customer message may be a reply to a campaign sent from this
    // number within 72 h. The attributor never throws.
    if (!isOutbound) {
      const parts = zernioReplyParts(evt);
      await this.attributor.onInbound({
        workspaceId,
        channelId,
        contactId: contact.id,
        phone: phoneFromParticipantId(channel, participantId) ?? contact.phone,
        text: parts.text.trim() || text,
        buttonPayload: parts.buttonPayload,
        inboundMessageId: created?.id ?? null,
        at: now,
      });
      // SP-15: a click-to-WhatsApp referral (WhatsApp only, ruling 4). After
      // the message row exists; capture never throws (Review Focus 2). Only a
      // customer event captures: an unmatched `message.sent` also reaches this
      // path and may lack `direction` (review M4).
      const eventType = evt.type ?? evt.event;
      if (
        channel === "whatsapp" &&
        created?.id &&
        (eventType === "message.received" || eventType === "conversation.started")
      ) {
        const touch = await this.adReferrals.captureZernio(evt, {
          workspaceId,
          channelId,
          conversationId: conv.id,
          contactId: contact.id,
          messageId: created.id,
          at: now,
        });
        // The message refresh above went out before capture (delivery is
        // never held for it): refresh again once the chip exists (review M2).
        if (touch?.firstTouch) {
          this.realtime.emitToWorkspace(workspaceId, "inbox.activity", { channel, channelId, conversationId: conv.id });
        }
      }
    }

    // Our own outbound echo is not something to answer, and a thread only
    // auto-replies once someone has switched it into AI mode — and stops while
    // a human has taken it over (aiPausedAt), same as the kewy-ai path below.
    // An escalated thread gets no auto-reply either (as on Telegram/web chat).
    if (!isOutbound && conv.aiEnabled && !conv.aiPausedAt && !conv.escalated && this.lAgent.enabled) {
      this.queueAgentReply(workspaceId, conv.id, text, contact.id);
    }
    // Lifecycle automation (never throws): a customer message opens a ticket
    // in 'new' unless one is already open; ANY outbound human message — from
    // the app or typed on the phone (this same path ingests message.sent) —
    // moves the 'new' ticket to 'contacted'.
    if (isOutbound) {
      await this.pipelineAutomation.onOutboundReply(workspaceId, contact.id);
    } else {
      await this.pipelineAutomation.onInboundMessage(
        workspaceId,
        contact.id,
        conv.id,
        channel,
        text || undefined,
      );
      this.events?.emit(WORKFLOW_TRIGGER_EVENT, {
        workspaceId,
        triggerType: "message_received",
        payload: {
          contact: { id: contact.id, name: contact.name },
          conversation: { id: conv.id, channel },
          message: { body: text },
        },
      } satisfies WorkflowTriggerEvent);

      // Hand the message to the AI service if this thread has it enabled.
      //
      // The Meta path (whatsapp.service.ts) has always done this; Zernio never
      // did — so with WhatsApp running on Zernio, the AI was wired up, enabled
      // and simply never called. Inbound arrived, was stored, and nothing asked
      // the agent to reply.
      //
      // Last and fire-and-forget on purpose: everything above is already
      // persisted, so a slow or dead AI service can never cost us the message
      // or the 200 that stops Zernio retrying.
      //
      // Skipped when the workspace's own l agent already took this message
      // (queueAgentReply above): both paths key off conv.aiEnabled, so with
      // both platforms configured the customer would get two AI replies.
      if (
        !isOutbound &&
        conv.aiEnabled &&
        !conv.aiPausedAt &&
        this.aiBridge.isConfigured() &&
        !(await this.lAgentAnswers(workspaceId)) &&
        // SP-20: the reply gate; never throws, fails closed.
        (!this.replyGate || (await this.replyGate.allows(workspaceId, { conversationId: conv.id, contactId: contact.id }, "zernio_bridge")))
      ) {
        void this.aiBridge.notifyInbound({
          workspaceId,
          conversationId: conv.id,
          contactId: contact.id,
          channel,
          messageId: externalMsgId,
          body: text,
          contactName: contact.name,
          contactPhone: contact.phone,
          // The customer just messaged us, so the 24h free-text window is open
          // by definition at this instant.
          windowOpen: true,
          receivedAt: new Date().toISOString(),
        });
      }
    }
  }

  /**
   * SP-31: a customer's emoji reaction. Updates only the reacted message (by
   * Zernio's or the platform's id, stored in metaMessageId) inside the
   * integration's workspace; unknown ids and oversize emoji are ignored, an
   * empty emoji removes the reaction. Only the latest reaction is kept.
   */
  private async applyReaction(payload: ZernioWebhookEvent): Promise<void> {
    const r = payload.reaction ?? {};
    const ids = [r.messageId, r.platformMessageId].filter((v): v is string => !!v);
    const accountId = payload.account?.accountId ?? payload.account?.id;
    if (ids.length === 0 || !accountId) return;
    // Only an explicit string counts; a missing emoji key is ignored, "" removes.
    if (typeof r.emoji !== "string") return;
    const emoji = normalizeReaction(r.emoji);
    if (emoji === undefined) return;
    const ch = await this.channels.forInbound("zernio", accountId);
    if (!ch) return;
    const updated = await this.prisma.message.updateMany({
      where: { workspaceId: ch.workspaceId, metaMessageId: { in: ids } },
      data: { reaction: emoji, reactionAt: emoji === null ? null : new Date() },
    });
    if (updated.count > 0) {
      this.realtime.emitToWorkspace(ch.workspaceId, "inbox.activity", { channel: ch.kind, channelId: ch.id });
    }
  }

  /** Returns how many rows matched — 0 tells the caller this message isn't
   *  ours (e.g. a reply typed in the platform's own mobile app) — and the
   *  channel the event resolved to (SP-12 scopes recipient updates by it). */
  private async applyStatus(
    type: string,
    payload: ZernioWebhookEvent,
  ): Promise<{ updated: number; channel: Channel | null }> {
    // Status events carry the same top-level shape as message.received. Match
    // either id scheme: sends store Zernio's internal id, backfilled rows the
    // platform's.
    const ids = [payload.message?.id, payload.message?.platformMessageId].filter(
      (v): v is string => !!v,
    );
    const accountId = payload.account?.accountId ?? payload.account?.id;
    if (ids.length === 0 || !accountId) return { updated: 0, channel: null };
    const status = type.split(".").pop(); // sent | delivered | read | failed
    const ch = await this.channels.forInbound("zernio", accountId);
    if (!ch) return { updated: 0, channel: null };
    const updated = await this.prisma.message.updateMany({
      where: { workspaceId: ch.workspaceId, metaMessageId: { in: ids } },
      data: { deliveryStatus: status, deliveryStatusAt: new Date() },
    });
    if (updated.count > 0) {
      this.realtime.emitToWorkspace(ch.workspaceId, "inbox.activity", {
        channel: ch.kind,
        channelId: ch.id,
      });
    }
    return { updated: updated.count, channel: ch };
  }

  /**
   * SP-12: apply a Zernio `message.*` status to campaign recipient rows in
   * the channel's workspace, matched on either id. `at` is the event's
   * `message.sentAt` for `sent`; for delivered/read/failed it is the arrival
   * time, because `message.sentAt` is the send time, not the event's. A
   * `message.sent` that matched no Message row and no recipient may stamp a
   * queued recipient by phone (ruling 2). Never throws.
   */
  private async trackRecipientStatus(
    type: string,
    payload: ZernioWebhookEvent,
    ch: Channel,
    messagesUpdated: number,
  ): Promise<void> {
    try {
      const kind = type.split(".").pop() as "sent" | "delivered" | "read" | "failed";
      const ids = [payload.message?.id, payload.message?.platformMessageId];
      const sentAt = payload.message?.sentAt ? new Date(payload.message.sentAt) : null;
      const at = kind === "sent" && sentAt && Number.isFinite(sentAt.getTime()) ? sentAt : new Date();
      const changed = await this.tracker.applyProviderStatus({ workspaceId: ch.workspaceId, ids, kind, at });
      if (
        kind === "sent" &&
        changed === 0 &&
        messagesUpdated === 0 &&
        payload.message?.direction === "outgoing" &&
        ch.kind === "whatsapp"
      ) {
        const participantId = String(payload.conversation?.participantId ?? "");
        await this.tracker.stampByPhone({
          workspaceId: ch.workspaceId,
          channelId: ch.id,
          phone: phoneFromParticipantId("whatsapp", participantId),
          messageId: payload.message?.id ?? payload.message?.platformMessageId ?? null,
          at,
        });
      }
    } catch (e) {
      this.log.warn(`campaign recipient tracking failed for ${type}: ${(e as Error).message}`);
    }
  }

  /**
   * Whether this workspace's inbound messages are answered by its own l agent.
   * Mirrors the precondition LAgentService.ask() applies before calling l, so
   * the kewy-ai bridge stands down exactly when an l reply can be produced.
   */
  private async lAgentAnswers(workspaceId: string): Promise<boolean> {
    if (!this.lAgent.enabled) return false;
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { lEndpointId: true, lEndpointSecret: true },
    });
    return Boolean(ws?.lEndpointId && ws.lEndpointSecret);
  }

  /**
   * Answer an inbound customer message with the workspace's l agent and send
   * that answer back out on the conversation's own channel.
   *
   * Fire-and-forget: the customer's message is already stored and the webhook
   * owes Zernio a prompt 200. An l turn takes seconds, and Zernio retries a
   * slow endpoint — blocking here would turn one message into several.
   */
  private queueAgentReply(
    workspaceId: string,
    conversationId: string,
    inbound: string,
    contactId: string | null = null,
  ): void {
    void (async () => {
      // Locked workspaces get no automatic replies. The inbound message is
      // already stored; a failed lookup rejects into the catch below (no send).
      if (await this.paymentLock?.isLocked(workspaceId)) return;
      // SP-20: the reply gate (emergency stop, conversation, excluded tag,
      // working hours). A gate failure means no reply (it logs once).
      if (this.replyGate && !(await this.replyGate.allows(workspaceId, { conversationId, contactId }, "l_auto_reply"))) return;
      const result = await this.lAgent.ask(workspaceId, {
        externalId: conversationId,
        message: inbound,
      });
      if (!result) return;

      // SP-17 (ruling 2): our own media URL is sent only while it is still an
      // approved agent photo of this workspace; a photo hidden after the
      // agent's list_photos call (or never approved, or another workspace's)
      // is dropped and the text goes alone. Other URLs are sent as before.
      let image: { url: string; type: "image" } | undefined = result.imageUrl
        ? { url: result.imageUrl, type: "image" }
        : undefined;
      if (image) {
        try {
          const { decision, mediaId } = await agentImageDecision(this.prisma, workspaceId, image.url);
          if (decision === "drop") {
            this.log.warn(
              `agent image dropped: not approved (media ${mediaId ?? "unknown"}, conversation ${conversationId})`,
            );
            image = undefined;
          }
        } catch (err) {
          // Fail closed on the image, never on the answer.
          this.log.warn(
            `agent image dropped: approval check failed for conversation ${conversationId}`,
            err instanceof Error ? err.stack : String(err),
          );
          image = undefined;
        }
      }

      // sendInDbConversation both delivers the reply and stores the single
      // Message row (with real delivery metadata) plus the conversation
      // preview update — tagged "ai" so the thread still reads as the
      // agent's own turn instead of a staff reply.
      try {
        await this.sendInDbConversation(
          workspaceId,
          conversationId,
          result.answer,
          undefined,
          undefined,
          "ai",
          image,
        );
      } catch (err) {
        // l validates the image URL before it ever reaches us, but the
        // channel itself can still reject it (hotlink-blocking CDN, expired
        // signed URL, a size/format l allows but the channel doesn't). A
        // bad image should only cost the image — never the text answer the
        // agent already produced — so retry once without the attachment.
        if (!image) throw err;
        this.log.warn(
          `l auto-reply image failed to send for conversation ${conversationId}, retrying text-only`,
          err instanceof Error ? err.stack : String(err),
        );
        await this.sendInDbConversation(
          workspaceId,
          conversationId,
          result.answer,
          undefined,
          undefined,
          "ai",
          undefined,
        );
      }
    })().catch((err) => {
      this.log.error(
        `l auto-reply failed for conversation ${conversationId}`,
        err instanceof Error ? err.stack : String(err),
      );
    });
  }
}

/** "now" / "5m" / "3h" / "26d" — matches the strings the Inbox list renders. */
function compactAge(d: Date): string {
  const diffMin = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (diffMin < 1) return "now";
  if (diffMin < 60) return `${diffMin}m`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h`;
  return `${Math.floor(diffH / 24)}d`;
}

// ─── Webhook payload (partial — the fields we read) ──────────────────────────
//
// Captured from real deliveries via the tunnel (message.received / .sent /
// .read / reaction.received). Everything sits at the TOP LEVEL — there is no
// `data` envelope, which is what the original best-effort parser assumed and
// why every inbound message was silently dropped.
export interface ZernioWebhookEvent {
  type?: string;
  event?: string;
  message?: {
    id?: string;                 // Zernio's message id — what status events reference
    conversationId?: string;
    platform?: string;
    platformMessageId?: string;  // Meta's id
    direction?: "incoming" | "outgoing" | string;
    text?: string | null;        // null on media-only messages
    attachments?: Array<{
      type?: string;             // image | video | audio | document
      url?: string;              // absolute, behind Zernio's bearer auth
      payload?: { id?: string; mimeType?: string; sha256?: string };
    }>;
    sender?: { id?: string; name?: string; username?: string; contactId?: string };
    sentAt?: string;
    isRead?: boolean;
    /** SP-12 (ruling 7): a tapped button's payload, only when Zernio sends it. */
    metadata?: {
      buttonPayload?: string;
      postbackPayload?: string;
      /** SP-15: Meta's verbatim CTWA referral (location unverified, ruling 13). */
      referral?: unknown;
      /** SP-15: Zernio's ad attribution `{adId, name, synced, …}`. */
      ad?: unknown;
    } | null;
  };
  /** SP-15: CTWA attribution at the payload root (as Zernio's docs place it). */
  metadata?: { referral?: unknown; ad?: unknown; [k: string]: unknown } | null;
  /** reaction.received: the emoji and the message it targets (empty emoji = removed). */
  reaction?: {
    emoji?: string | null;
    messageId?: string;          // Zernio's id of the reacted message
    platformMessageId?: string;  // the platform's (Meta) id of the reacted message
  };
  conversation?: {
    id?: string;
    platformConversationId?: string;
    participantId?: string;
    participantName?: string;
    participantUsername?: string;
    status?: string;
  };
  account?: {
    id?: string;
    accountId?: string;
    platform?: string;
    username?: string;
    displayName?: string;
    profileId?: string;
  };
  // account.connected / account.disconnected still carry a `data` envelope.
  data?: {
    profileId?: string;
    /** SP-14: tolerated envelope for the template status event (unverified, R19). */
    accountId?: string;
    account?: { accountId?: string };
    template?: ZernioTemplateStatusPayload;
  };
  /**
   * SP-14 `whatsapp.template.status_updated` (docs.zernio.com webhooks;
   * delivery and exact shape unverified live, ruling 19). Status is one of
   * APPROVED, REJECTED, PENDING, PAUSED, DISABLED, IN_APPEAL, PENDING_DELETION.
   */
  template?: ZernioTemplateStatusPayload;

}

/** SP-14: the template of a `whatsapp.template.status_updated` event. */
export interface ZernioTemplateStatusPayload {
  /** Meta's template id. */
  templateId?: string;
  id?: string;
  name?: string;
  language?: string;
  status?: string;
  reason?: string | null;
  rejectedReason?: string | null;
  rejected_reason?: string | null;
}
