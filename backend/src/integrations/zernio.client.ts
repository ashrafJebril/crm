import { HttpException, Injectable, Logger } from "@nestjs/common";
import { redactUrl } from "../common/redact-url";

/**
 * Thin, typed HTTP wrapper over the Zernio API v1 (https://zernio.com/api/v1).
 *
 * Zernio is a Meta/TikTok/etc. Tech Provider that fronts each platform's API
 * with its OWN reviewed apps, so customers connect by "just authenticating" —
 * no per-tenant tokens, no Meta App Review, no Tester enrollment on our side.
 * Auth is a single global API key (ZERNIO_API_KEY); per-workspace isolation
 * rides on a Zernio "profile" id (see ZernioService.ensureProfile).
 *
 * Endpoint shapes were verified live against the API during the spike
 * (see spikes/zernio). Response parsers are defensive where the docs didn't
 * publish an exact schema (inbox messages, webhook payloads).
 */
@Injectable()
export class ZernioClient {
  private readonly log = new Logger(ZernioClient.name);

  private get baseUrl(): string {
    return (process.env.ZERNIO_BASE_URL ?? "https://zernio.com/api/v1").replace(/\/+$/, "");
  }

  isConfigured(): boolean {
    return !!process.env.ZERNIO_API_KEY;
  }

  private requireKey(): string {
    const key = process.env.ZERNIO_API_KEY;
    if (!key) {
      throw new HttpException(
        "Zernio is not configured — set ZERNIO_API_KEY in the environment",
        500,
      );
    }
    return key;
  }

  // ─── Profiles (one per workspace) ────────────────────────────────────────

  async createProfile(name: string, description?: string): Promise<{ id: string }> {
    const res = await this.request<{ profile?: { _id?: string }; _id?: string }>(
      "POST",
      "/profiles",
      { body: { name, description } },
    );
    const id = res.profile?._id ?? res._id;
    if (!id) throw new HttpException("Zernio did not return a profile id", 502);
    return { id };
  }

  // ─── Account connection ──────────────────────────────────────────────────

  /** Hosted OAuth connect: returns the authUrl to redirect the customer to. */
  async getConnectUrl(
    platform: string,
    profileId: string,
    redirectUrl: string,
  ): Promise<{ authUrl: string; state?: string }> {
    const res = await this.request<{ authUrl?: string; url?: string; state?: string }>(
      "GET",
      `/connect/${encodeURIComponent(platform)}`,
      { query: { profileId, redirect_url: redirectUrl } },
    );
    const authUrl = res.authUrl ?? res.url;
    if (!authUrl) throw new HttpException("Zernio did not return an authUrl", 502);
    return { authUrl, state: res.state };
  }

  async listAccounts(profileId: string): Promise<ZernioAccount[]> {
    const res = await this.request<{ accounts?: ZernioAccount[]; data?: ZernioAccount[] }>(
      "GET",
      "/accounts",
      { query: { profileId } },
    );
    return res.accounts ?? res.data ?? [];
  }

  // ─── Inbox ───────────────────────────────────────────────────────────────

  async listConversations(profileId: string, platform?: string): Promise<ZernioConversation[]> {
    const res = await this.request<{ data?: ZernioConversation[] }>(
      "GET",
      "/inbox/conversations",
      { query: { profileId, platform } },
    );
    return res.data ?? [];
  }

  /** Zernio requires `accountId` on this endpoint — without it the call 400s
   *  with "accountId query parameter is required" and the thread reads empty. */
  async getMessages(conversationId: string, accountId: string): Promise<ZernioMessage[]> {
    const res = await this.request<{ data?: ZernioMessage[]; messages?: ZernioMessage[] }>(
      "GET",
      `/inbox/conversations/${encodeURIComponent(conversationId)}/messages`,
      { query: { accountId } },
    );
    return res.data ?? res.messages ?? [];
  }

  /**
   * Fetch an inbound attachment. Zernio hands us an absolute media URL on the
   * webhook payload, but it's behind the same bearer auth as the rest of the
   * API — a browser can't load it directly, so we pull the bytes server-side
   * and re-host them through our own /media route.
   */
  async downloadMedia(url: string): Promise<{ buffer: Buffer; mimeType: string }> {
    const key = this.requireKey();
    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      const timedOut = (e as Error).name === "TimeoutError";
      throw new HttpException(
        timedOut ? "Zernio media download timed out" : "Zernio media unreachable",
        timedOut ? 504 : 502,
      );
    }
    if (!res.ok) {
      this.log.warn(`Zernio media GET ${redactUrl(url)} -> ${res.status}`);
      throw new HttpException(`Zernio media download failed (${res.status})`, 502);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    const mimeType = res.headers.get("content-type")?.split(";")[0]?.trim() || "";
    return { buffer, mimeType };
  }

  async sendMessage(
    conversationId: string,
    accountId: string,
    message: string,
  ): Promise<{ id: string | null }> {
    const res = await this.request<{ id?: string; _id?: string; message?: { id?: string } }>(
      "POST",
      `/inbox/conversations/${encodeURIComponent(conversationId)}/messages`,
      { body: { accountId, message } },
    );
    return { id: res.id ?? res._id ?? res.message?.id ?? null };
  }

  // ─── Publishing ──────────────────────────────────────────────────────────

  async createPost(body: {
    content: string;
    platforms: Array<{ platform: string; accountId: string; platformSpecificData?: unknown }>;
    mediaUrls?: string[];
    publishNow?: boolean;
    scheduledFor?: string; // ISO 8601 — when set, wins over publishNow
    timezone?: string;     // IANA name, e.g. "Asia/Riyadh"
  }): Promise<{ id: string | null; status: string | null }> {
    const { scheduledFor, timezone, ...rest } = body;
    const payload = scheduledFor
      ? { ...rest, publishNow: false, scheduledFor, timezone }
      : { publishNow: true, ...rest };
    const res = await this.request<{ post?: { _id?: string; status?: string } }>(
      "POST",
      "/posts",
      { body: payload },
    );
    return { id: res.post?._id ?? null, status: res.post?.status ?? null };
  }

  // ─── Reading published posts (feed) ──────────────────────────────────────

  /** List a profile's posts. Zernio serves a page's OWN (synced/external) posts
   *  under /analytics — the /posts endpoint only returns posts CREATED through
   *  Zernio. Hitting /analytics also triggers Zernio's external-post sync.
   *
   *  The window is explicit because /analytics defaults to ~90 days
   *  (spike-verified 2026-08-13; bit us live 2026-08-17 — the feed showed one
   *  post because everything older fell outside the silent default). 365 days
   *  is Zernio's documented maximum range; pages are walked like getAnalytics
   *  so a busy year isn't cut at the first 100 posts. */
  async listPosts(profileId: string, platform?: string): Promise<ZernioPost[]> {
    const to = new Date();
    const from = new Date(to.getTime() - 365 * 24 * 60 * 60 * 1000);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const posts: ZernioPost[] = [];
    let page = 1;
    for (;;) {
      const res = await this.request<{
        posts?: ZernioPost[];
        pagination?: { page?: number; pages?: number; total?: number };
      }>("GET", "/analytics", {
        query: {
          profileId,
          platform,
          fromDate: iso(from),
          toDate: iso(to),
          limit: "100",
          page: String(page),
        },
      });
      posts.push(...(res.posts ?? []));
      const pages = res.pagination?.pages ?? 1;
      if (page >= pages || page >= ZernioClient.ANALYTICS_MAX_PAGES) {
        if (pages > ZernioClient.ANALYTICS_MAX_PAGES) {
          this.log.warn(
            `listPosts: profile ${profileId} has ${pages} pages in the window; feed is best-effort over the first ${ZernioClient.ANALYTICS_MAX_PAGES * 100} posts`,
          );
        }
        return posts;
      }
      page += 1;
    }
  }

  /** Posts CREATED through Zernio (drafts/scheduled/published) — unlike the
   *  /analytics feed, this is where the scheduled queue lives. */
  async listCreatedPosts(profileId: string): Promise<ZernioPost[]> {
    const res = await this.request<{ posts?: ZernioPost[]; data?: ZernioPost[] }>(
      "GET",
      "/posts",
      { query: { profileId, limit: "50" } },
    );
    return res.posts ?? res.data ?? [];
  }

  /** Cancels a scheduled post (deletes the Zernio post). */
  async cancelPost(postId: string): Promise<void> {
    await this.request<unknown>("DELETE", `/posts/${encodeURIComponent(postId)}`, {});
  }

  /** Update a Zernio-created post in place (spike-verified 2026-08-13). */
  async updatePost(
    postId: string,
    body: { scheduledFor: string; timezone?: string },
  ): Promise<{ id: string | null; status: string | null }> {
    const res = await this.request<{ post?: { _id?: string; status?: string } }>(
      "PUT",
      `/posts/${encodeURIComponent(postId)}`,
      { body },
    );
    return { id: res.post?._id ?? postId, status: res.post?.status ?? null };
  }

  /** Hard cap on pages walked by `getAnalytics` (400 posts at limit=100) — a
   *  busy account's full history could page indefinitely; past this bound we
   *  stop and log rather than keep fetching. */
  private static readonly ANALYTICS_MAX_PAGES = 4;

  /**
   * Per-post analytics rows for a date window (spike-verified 2026-08-13:
   * docs/superpowers/plans/2026-08-13-analytics-spike-findings.md). The
   * response key is `posts` (the page-level `overview` object next to it is
   * post-COUNT aggregates only — no summed engagement anywhere, so totals
   * must be summed client-side from these rows). Each row carries a
   * rolled-up `analytics` object AND a `platforms[]` per-account breakdown
   * with its own `analytics` — prefer the breakdown when attributing metrics
   * to a platform, since a cross-posted post's rolled-up object doesn't say
   * which platform contributed what.
   *
   * The response also carries `pagination: {page, limit, total, pages}`
   * (spike-verified) — at `limit=100` an account with more than 100 posts in
   * the window would otherwise have its later pages silently dropped and
   * totals under-counted with no signal. Walk pages until Zernio says there
   * are no more, capped at `ANALYTICS_MAX_PAGES` (400 posts) so a very busy
   * account can't turn one overview load into an unbounded fetch loop; past
   * the cap, totals are logged as best-effort rather than silently wrong.
   *
   * The response also carries a top-level `hasAnalyticsAccess: boolean`
   * (spike-verified: always present, `true` for our own workspace — see
   * docs/superpowers/plans/2026-08-13-analytics-spike-findings.md). It's the
   * API's own plan-gate signal, distinct from the 402/403 error responses
   * ZernioService already matches on — surfaced here rather than thrown so
   * the caller can fold both signals into one gate check.
   */
  async getAnalytics(
    profileId: string,
    opts: { fromDate: string; toDate: string },
  ): Promise<{ rows: ZernioAnalyticsRow[]; hasAnalyticsAccess: boolean }> {
    const rows: ZernioAnalyticsRow[] = [];
    let hasAnalyticsAccess = true;
    let page = 1;
    for (;;) {
      const res = await this.request<{
        posts?: ZernioAnalyticsRow[];
        pagination?: { page?: number; limit?: number; total?: number; pages?: number };
        hasAnalyticsAccess?: boolean;
      }>("GET", "/analytics", {
        query: {
          profileId,
          fromDate: opts.fromDate,
          toDate: opts.toDate,
          limit: "100",
          page: String(page),
        },
      });
      rows.push(...(res.posts ?? []));
      if (typeof res.hasAnalyticsAccess === "boolean") hasAnalyticsAccess = res.hasAnalyticsAccess;
      const pages = res.pagination?.pages ?? 1;
      if (page === 1 && pages > ZernioClient.ANALYTICS_MAX_PAGES) {
        this.log.warn(
          `Zernio /analytics has ${pages} pages for profile ${profileId} — totals are ` +
            `best-effort over the first ${ZernioClient.ANALYTICS_MAX_PAGES * 100} posts`,
        );
      }
      if (page >= pages || page >= ZernioClient.ANALYTICS_MAX_PAGES) break;
      page++;
    }
    return { rows, hasAnalyticsAccess };
  }

  /**
   * Follower history per connected account (spike-verified 2026-08-13).
   * Reports per-ACCOUNT, not per-platform — `accounts[]` is the join back to
   * a platform name for `stats[accountId]`. Always pass an explicit
   * `fromDate`/`toDate`: the doc's claimed "defaults to 30 days ago" is
   * wrong — the live default is `2025-01-01`, effectively unbounded history.
   */
  async getFollowerStats(
    profileId: string,
    opts: { fromDate: string; toDate: string; granularity?: "daily" | "weekly" | "monthly" },
  ): Promise<ZernioFollowerStatsResponse> {
    return this.request<ZernioFollowerStatsResponse>("GET", "/accounts/follower-stats", {
      query: {
        profileId,
        fromDate: opts.fromDate,
        toDate: opts.toDate,
        granularity: opts.granularity ?? "daily",
      },
    });
  }

  /**
   * Returns POSTS with comment counts aggregated across every connected
   * account — NOT individual comments (confirmed against
   * https://docs.zernio.com/comments/list-inbox-comments and a live probe:
   * rows carry `content`/`picture`/`permalink` — the POST's own caption/media —
   * plus a `commentCount`, no per-comment author or body). Fetch a post's
   * actual comments with `getPostComments`.
   */
  async listComments(profileId: string, platform?: string): Promise<ZernioCommentedPost[]> {
    const res = await this.request<{ data?: ZernioCommentedPost[] }>("GET", "/inbox/comments", {
      query: { profileId, platform },
    });
    return res.data ?? [];
  }

  /** The real per-post comment list (confirmed live: `GET /inbox/comments/{postId}`
   *  returns `{ status, comments: [...], pagination, meta }`). `accountId` is
   *  required — the endpoint 400s ("expected string, received undefined") without it.
   *
   *  Zernio nests replies under their parent comment's `replies` array — they are
   *  NEVER included as separate top-level rows. Confirmed live in Tier 0
   *  verification: replying via `replyToComment` succeeds and the new reply is
   *  visible nested under its parent here, but a follow-up `deleteComment` on
   *  that reply's own id 404s ("Comment not found") because the caller
   *  (`ZernioService.findCommentInWorkspace`) searches the flattened output of
   *  this method for a matching id — so an un-flattened reply is simply never
   *  found. Flatten every level so replies are individually addressable, same
   *  as top-level comments. */
  async getPostComments(postId: string, accountId: string): Promise<ZernioPostComment[]> {
    const res = await this.request<{ comments?: ZernioPostComment[] }>(
      "GET",
      `/inbox/comments/${encodeURIComponent(postId)}`,
      { query: { accountId } },
    );
    return flattenComments(res.comments ?? []);
  }

  /**
   * Reply to a post, or thread a reply under one of its comments. Confirmed
   * against https://docs.zernio.com/comments/reply-to-inbox-post and a live
   * 400-validation probe: the path parameter is the PARENT POST id, not a
   * comment id — `POST /inbox/comments/{commentId}/reply` (the round-1
   * assumption) 405s. `accountId` is required in the body; `commentId` is
   * optional — omit it to comment on the post itself, pass it to reply to
   * that specific comment.
   */
  async replyToComment(
    postId: string,
    accountId: string,
    message: string,
    commentId?: string,
  ): Promise<{ id: string | null }> {
    const res = await this.request<{ data?: { commentId?: string }; commentId?: string }>(
      "POST",
      `/inbox/comments/${encodeURIComponent(postId)}`,
      { body: { accountId, message, commentId } },
    );
    return { id: res.data?.commentId ?? res.commentId ?? null };
  }

  /**
   * Delete a comment. Confirmed against
   * https://docs.zernio.com/comments/delete-inbox-comment and a live
   * 400-validation probe: `DELETE /inbox/comments/{postId}` (parent post id
   * in the path) with BOTH `accountId` and `commentId` as required query
   * params — the round-1 assumption (`DELETE /inbox/comments/{commentId}`
   * with only `accountId`) 400s with "commentId" reported missing.
   */
  async deleteComment(postId: string, accountId: string, commentId: string): Promise<void> {
    await this.request<unknown>(
      "DELETE",
      `/inbox/comments/${encodeURIComponent(postId)}`,
      { query: { accountId, commentId } },
    );
  }

  // ─── WhatsApp ────────────────────────────────────────────────────────────

  async whatsappNumbers(profileId: string): Promise<ZernioWhatsAppNumbers> {
    return this.request<ZernioWhatsAppNumbers>("GET", "/whatsapp/phone-numbers", {
      query: { profileId },
    });
  }

  // ─── HTTP core ───────────────────────────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    opts: { query?: Record<string, string | undefined>; body?: unknown },
  ): Promise<T> {
    const key = this.requireKey();
    const url = new URL(this.baseUrl + path);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v != null && v !== "") url.searchParams.set(k, v);
      }
    }
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      const timedOut = (e as Error).name === "TimeoutError";
      this.log.error(
        timedOut ? "Zernio API timed out" : `Zernio network error: ${(e as Error).message}`,
      );
      throw new HttpException(
        timedOut ? "Zernio API timed out" : "Zernio API unreachable",
        timedOut ? 504 : 502,
      );
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    if (!res.ok) {
      const errObj =
        typeof parsed === "object" && parsed !== null
          ? (parsed as { error?: unknown; message?: unknown })
          : {};
      const errMsg = String(errObj.error ?? errObj.message ?? `Zernio error ${res.status}`);
      this.log.warn(`Zernio ${method} ${redactUrl(url.toString())} -> ${res.status} ${errMsg}`);
      // Surface client errors (4xx) as-is; collapse upstream 5xx to 502.
      throw new HttpException(errMsg, res.status >= 500 ? 502 : res.status);
    }
    return parsed as T;
  }
}

// ─── Response shapes (partial — the fields we read) ──────────────────────────

export interface ZernioAccount {
  _id: string;
  platform: string;
  displayName?: string;
  username?: string;
  name?: string;
  platformStatus?: string;
  isActive?: boolean;
  metadata?: unknown;
}

export interface ZernioConversation {
  id: string;
  accountId: string;
  accountUsername?: string;
  platform: string;
  participantId: string;
  participantName?: string;
  participantPicture?: string;
  lastMessage?: string;
  updatedTime?: string;
  status?: string;
  url?: string;
}

export interface ZernioMessage {
  id?: string;               // platform message id (Meta's), NOT Zernio's internal id
  _id?: string;
  direction?: string; // "incoming" | "outgoing"
  from?: string;
  text?: string;
  message?: string;
  body?: string;
  content?: string;
  timestamp?: string | number;
  createdAt?: string;
  sentAt?: string;
  senderName?: string;
  deliveryStatus?: string;
  isDeleted?: boolean;
  attachments?: Array<{
    type?: string;
    url?: string;
    payload?: { id?: string; mimeType?: string };
  }>;
}

export interface ZernioPost {
  _id?: string;
  id?: string;
  platform?: string;
  platforms?: Array<
    { platform?: string; accountId?: string; platformPostId?: string } | string
  >;
  content?: string;
  caption?: string;
  text?: string;
  mediaUrls?: string[];
  thumbnailUrl?: string;
  mediaItems?: Array<{ url?: string }>;
  mediaType?: string;
  title?: string;
  status?: string;
  isExternal?: boolean;
  permalink?: string;
  platformPostUrl?: string;
  url?: string;
  publishedAt?: string;
  scheduledFor?: string;
  createdAt?: string;
  analytics?: { likes?: number; comments?: number; shares?: number };
  likeCount?: number;
  commentCount?: number;
  shareCount?: number;
}

/** Metric set shared by a post's rolled-up `analytics` and every entry in
 *  its `platforms[]` breakdown (spike-verified 2026-08-13, identical schema
 *  on facebook and instagram rows). `engagementRate` is already a rate/%,
 *  not a count — it has no meaningful "sum", unlike the others. */
export interface ZernioAnalyticsMetrics {
  impressions?: number;
  reach?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  clicks?: number;
  views?: number;
  follows?: number;
  engagementRate?: number;
}

/** A row from `GET /analytics` (see `ZernioClient.getAnalytics`). Field
 *  names are the LIVE ones: `_id` (not the docs' `postId`) and `platforms`
 *  (not the docs' `platformAnalytics`). */
export interface ZernioAnalyticsRow {
  _id?: string;
  platform?: string;
  analytics?: ZernioAnalyticsMetrics;
  platforms?: Array<{
    platform?: string;
    accountId?: string;
    analytics?: ZernioAnalyticsMetrics;
  }>;
}

/** One row of `GET /accounts/follower-stats`'s `accounts[]` — the join
 *  table from an accountId (as used in `stats{}`) back to its platform. */
export interface ZernioFollowerStatsAccount {
  _id?: string;
  platform?: string;
  currentFollowers?: number | null;
  growth?: number;
}

/** `GET /accounts/follower-stats` response (spike-verified 2026-08-13):
 *  `stats[accountId]` is a list of `{date, followers}` points — the field is
 *  `followers`, not `count`. */
export interface ZernioFollowerStatsResponse {
  accounts?: ZernioFollowerStatsAccount[];
  stats?: Record<string, Array<{ date?: string; followers?: number }>>;
  dateRange?: { from?: string; to?: string };
  granularity?: string;
}

/** A POST, with its aggregate comment count — the actual shape returned by
 *  `GET /inbox/comments` (see `ZernioClient.listComments`'s doc comment). */
export interface ZernioCommentedPost {
  id?: string;
  _id?: string;
  accountId?: string;
  accountUsername?: string;
  platform?: string;
  content?: string;
  picture?: string;
  permalink?: string;
  createdTime?: string;
  commentCount?: number;
  likeCount?: number;
  cid?: string;
  subreddit?: string;
  isAd?: boolean;
  adId?: string;
  placement?: string;
}

/** A genuine comment, as returned nested under a post by `getPostComments`. */
export interface ZernioPostComment {
  id?: string;
  message?: string;
  createdTime?: string;
  from?: { id?: string; name?: string; username?: string; isOwner?: boolean };
  likeCount?: number;
  replyCount?: number;
  platform?: string;
  url?: string | null;
  parentId?: string;
  canReply?: boolean;
  canDelete?: boolean;
  canHide?: boolean;
  isHidden?: boolean;
  /** Nested replies, as Zernio returns them — flattened by `getPostComments`. */
  replies?: ZernioPostComment[];
}

/** Recursively flatten Zernio's nested comment/reply tree into one list, each
 *  row tagging its own `parentId` — see `getPostComments`'s doc comment. */
function flattenComments(
  comments: ZernioPostComment[],
  parentId?: string,
): ZernioPostComment[] {
  const out: ZernioPostComment[] = [];
  for (const c of comments) {
    const { replies, ...rest } = c;
    out.push({ ...rest, parentId: c.parentId ?? parentId });
    if (replies?.length) out.push(...flattenComments(replies, c.id));
  }
  return out;
}

export interface ZernioWhatsAppNumbers {
  numbers: unknown[];
  connected: unknown[];
  sandbox?: {
    phoneNumber?: string;
    accountId?: string;
    template?: { name?: string };
    isSandbox?: boolean;
  };
}
