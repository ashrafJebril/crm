import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import { MediaService } from "../media/media.service";
import { ZernioClient, ZernioAccount, ZernioAnalyticsRow } from "./zernio.client";
import { PipelineAutomationService } from "../tickets/pipeline-automation.service";

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

@Injectable()
export class ZernioService {
  private readonly log = new Logger(ZernioService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly media: MediaService,
    private readonly client: ZernioClient,
    private readonly pipelineAutomation: PipelineAutomationService,
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
    const row = await this.prisma.integration.findFirst({
      where: { workspaceId, provider: "zernio", pageId: accountId },
    });
    if (!row) throw new NotFoundException("Account not found in this workspace");
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
  async sendInDbConversation(
    workspaceId: string,
    conversationId: string,
    message: string,
    mediaId?: string,
    publicBaseUrl?: string,
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
    let attachment: { url: string; type: "image" | "video" | "audio" | "file" } | undefined;
    if (mediaId) {
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
    const integ = await this.prisma.integration.findFirst({
      where: { workspaceId, provider: "zernio", platform: channel },
    });
    if (!integ?.pageId) {
      throw new NotFoundException(`${channel} is not connected via Zernio`);
    }

    // Fast path: the inbound webhook stores Zernio's conversation id on the
    // row, letting us send directly. Rows that predate the column fall back to
    // resolving via the live conversation list — and get backfilled so they
    // only ever pay that ~0.5s once.
    let zernioConvId = conv.externalId;
    if (!zernioConvId) {
      const participantId = conv.contact?.externalId;
      if (!participantId) {
        throw new BadRequestException("This contact has no platform id to reply to");
      }
      const convs = await this.listConversations(workspaceId, channel);
      const match = convs.find((c) => c.participantId === participantId);
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

    // Instagram and Messenger DMs carry ONE body shape per message — text OR
    // an attachment, never both (there is no caption field; the legacy Meta
    // send path splits them for the same reason). Handing Zernio both in one
    // call delivers only the image and silently drops the text, so split it
    // into two sends: image first, then the text as its own message. WhatsApp
    // does support media captions, so it keeps the single call.
    const captionCapable = channel === "whatsapp";
    let id: string | null = null;
    if (attachment && message && !captionCapable) {
      await this.client.sendMessage(zernioConvId, integ.pageId, "", attachment);
      ({ id } = await this.client.sendMessage(zernioConvId, integ.pageId, message));
    } else {
      ({ id } = await this.client.sendMessage(
        zernioConvId,
        integ.pageId,
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
        from: "human",
        body: message,
        t,
        // Frontend convention: attach carries our Media id for outbound sends.
        attach: mediaId ?? null,
        metaMessageId: id,
      },
    });
    await this.prisma.conversation.update({
      where: { id: conv.id },
      data: {
        preview: message ? message.slice(0, 140) : "📎",
        lastAt: "now",
        lastFrom: "human",
        unread: 0,
      },
    });
    this.realtime.emitToWorkspace(workspaceId, "inbox.activity", {
      channel,
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
      errors: [] as string[],
    };

    for (const zc of zConvs) {
      try {
        const channel = (zc.platform ?? "").toLowerCase();
        const participantId = String(zc.participantId ?? "");
        if (!channel || !participantId) continue;

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

        let conv = await this.prisma.conversation.findFirst({
          where: { workspaceId, contactId: contact.id, channel },
        });
        if (!conv) {
          conv = await this.prisma.conversation.create({
            data: {
              workspaceId,
              contactId: contact.id,
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
    const platforms = rows
      .filter((r) => r.pageId)
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
    if (
      type === "message.sent" ||
      type === "message.delivered" ||
      type === "message.read" ||
      type === "message.failed"
    ) {
      const updated = await this.applyStatus(type, payload);
      // message.sent with no matching row = an outbound composed OUTSIDE the
      // platform (the business replying from the Instagram/WhatsApp app on
      // their phone). Persist it, or the thread shows a hole on our side.
      if (type === "message.sent" && updated === 0) {
        await this.ingestInbound(payload);
      }
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

    const integ = await this.prisma.integration.findFirst({
      where: { provider: "zernio", pageId: accountId },
    });
    if (!integ) {
      this.log.warn(`Inbound for unknown zernio accountId=${accountId}`);
      return;
    }
    const workspaceId = integ.workspaceId;
    const channel = (evt.message?.platform ?? evt.account?.platform ?? integ.platform).toLowerCase();
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

    let conv = await this.prisma.conversation.findFirst({
      where: { workspaceId, contactId: contact.id, channel },
    });
    if (!conv) {
      conv = await this.prisma.conversation.create({
        data: {
          workspaceId,
          contactId: contact.id,
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
    await this.prisma.message.create({
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
      conversationId: conv.id,
    });
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
    }
  }

  /** Returns how many rows matched — 0 tells the caller this message isn't
   *  ours (e.g. a reply typed in the platform's own mobile app). */
  private async applyStatus(type: string, payload: ZernioWebhookEvent): Promise<number> {
    // Status events carry the same top-level shape as message.received. Match
    // either id scheme: sends store Zernio's internal id, backfilled rows the
    // platform's.
    const ids = [payload.message?.id, payload.message?.platformMessageId].filter(
      (v): v is string => !!v,
    );
    const accountId = payload.account?.accountId ?? payload.account?.id;
    if (ids.length === 0 || !accountId) return 0;
    const status = type.split(".").pop(); // sent | delivered | read | failed
    const integ = await this.prisma.integration.findFirst({
      where: { provider: "zernio", pageId: accountId },
    });
    if (!integ) return 0;
    const updated = await this.prisma.message.updateMany({
      where: { workspaceId: integ.workspaceId, metaMessageId: { in: ids } },
      data: { deliveryStatus: status, deliveryStatusAt: new Date() },
    });
    if (updated.count > 0) {
      this.realtime.emitToWorkspace(integ.workspaceId, "inbox.activity", {
        channel: integ.platform,
      });
    }
    return updated.count;
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
  data?: { profileId?: string };
}
