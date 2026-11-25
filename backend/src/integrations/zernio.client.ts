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
    /** Publicly fetchable URL — Zernio's UNDOCUMENTED but SDK-typed and
     *  live-verified (2026-08-19) attachmentUrl/attachmentType pair. */
    attachment?: { url: string; type: "image" | "video" | "audio" | "file" },
  ): Promise<{ id: string | null }> {
    const res = await this.request<{
      id?: string;
      _id?: string;
      message?: { id?: string };
      data?: { messageId?: string };
    }>(
      "POST",
      `/inbox/conversations/${encodeURIComponent(conversationId)}/messages`,
      {
        body: {
          accountId,
          message: message || undefined,
          attachmentUrl: attachment?.url,
          attachmentType: attachment?.type,
        },
      },
    );
    // Live response shape is { success, data: { messageId } } — the older
    // fallbacks are kept for defensiveness.
    return { id: res.data?.messageId ?? res.id ?? res._id ?? res.message?.id ?? null };
  }

  /**
   * Send an APPROVED WhatsApp template into an existing conversation.
   *
   * Templates are the only message type WhatsApp accepts once the 24-hour
   * customer-service window has closed. Zernio carries them on the same
   * endpoint as free text via a `template.elements[0]` reference, and forwards
   * `components` to Meta's Cloud API verbatim (OpenAPI v1.0.4, live-probed
   * 2026-08-28). `message` is deliberately never set — Meta rejects a send
   * that carries both a template and free text.
   */
  async sendTemplateMessage(
    conversationId: string,
    accountId: string,
    template: {
      name: string;
      language: string;
      /** Meta Cloud API send-shape components, forwarded verbatim. */
      components?: Array<Record<string, unknown>>;
    },
  ): Promise<{ id: string | null }> {
    const element: Record<string, unknown> = {
      name: template.name,
      language: template.language,
    };
    // Absent, not present-and-empty: Meta 400s on an empty components array.
    if (template.components && template.components.length > 0) {
      element.components = template.components;
    }
    const res = await this.request<{
      id?: string;
      _id?: string;
      message?: { id?: string };
      data?: { messageId?: string };
    }>(
      "POST",
      `/inbox/conversations/${encodeURIComponent(conversationId)}/messages`,
      { body: { accountId, template: { elements: [element] } } },
    );
    return { id: res.data?.messageId ?? res.id ?? res._id ?? res.message?.id ?? null };
  }

  // ─── WhatsApp templates ──────────────────────────────────────────────────

  /**
   * List the WABA's message templates. Zernio proxies the WhatsApp Cloud API,
   * so `status` here is Meta's real verdict — not a local guess. A WABA with
   * no templates answers 200 with the key absent (live-probed 2026-08-28).
   */
  async whatsappTemplates(accountId: string): Promise<ZernioWhatsAppTemplate[]> {
    const res = await this.request<{ templates?: ZernioWhatsAppTemplate[] }>(
      "GET",
      "/whatsapp/templates",
      { query: { accountId } },
    );
    return res.templates ?? [];
  }

  /**
   * SP-14: the number's health as Zernio reports it
   * (`GET /whatsapp/number-info?accountId`). Documented: `phone.quality_rating`,
   * `messaging_limit_tier`, `name_status`, `status` and `health_status`
   * (Meta's object). `waba` is returned but its sub-fields are undocumented.
   * Typed defensively: every field optional, a `data` wrapper accepted.
   */
  async whatsappNumberInfo(accountId: string): Promise<ZernioNumberInfo> {
    const res = await this.request<Record<string, unknown> | undefined>("GET", "/whatsapp/number-info", {
      query: { accountId },
    });
    const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
    const body = isObj(res) && !isObj(res.phone) && isObj(res.data) ? res.data : res;
    if (!isObj(body)) return {};
    return {
      ...(isObj(body.phone) ? { phone: body.phone as ZernioNumberInfo["phone"] } : {}),
      ...(isObj(body.waba) ? { waba: body.waba as ZernioNumberInfo["waba"] } : {}),
    };
  }

  /**
   * Create a template. Two modes, per Zernio's spec:
   *  - custom: pass `components` → submitted to Meta, review can take 24h
   *  - library: pass `libraryTemplateName` → pre-approved by Meta, no wait
   *
   * The library field goes on the wire as Meta's snake_case
   * `library_template_name`; a camelCase key is ignored and the template comes
   * back needing review instead.
   */
  async createWhatsAppTemplate(body: {
    accountId: string;
    name: string;
    category: "AUTHENTICATION" | "MARKETING" | "UTILITY";
    language: string;
    components?: Array<Record<string, unknown>>;
    libraryTemplateName?: string;
    /** Button inputs a library template with URL/PHONE_NUMBER buttons requires. */
    libraryButtonInputs?: Array<Record<string, unknown>>;
  }): Promise<ZernioWhatsAppTemplate> {
    const payload: Record<string, unknown> = {
      accountId: body.accountId,
      name: body.name,
      category: body.category,
      language: body.language,
    };
    if (body.libraryTemplateName) {
      payload.library_template_name = body.libraryTemplateName;
      if (body.libraryButtonInputs && body.libraryButtonInputs.length > 0) {
        payload.library_template_button_inputs = body.libraryButtonInputs;
      }
    } else if (body.components) {
      payload.components = body.components;
    }
    const res = await this.request<{ template?: ZernioWhatsAppTemplate }>(
      "POST",
      "/whatsapp/templates",
      { body: payload },
    );
    return (
      res.template ?? {
        id: null,
        name: body.name,
        status: "PENDING",
        category: body.category,
        language: body.language,
      }
    );
  }

  /** Delete a template from the WABA. Meta deletes by name, not id. */
  async deleteWhatsAppTemplate(accountId: string, templateName: string): Promise<void> {
    await this.request("DELETE", `/whatsapp/templates/${encodeURIComponent(templateName)}`, {
      query: { accountId },
    });
  }

  /**
   * Update an approved template's components. Meta re-reviews it, so the
   * status comes back PENDING and the final verdict arrives later on the
   * `whatsapp.template.status_updated` webhook. A template already PENDING
   * cannot be edited until Meta finishes.
   */
  async updateWhatsAppTemplate(
    accountId: string,
    templateName: string,
    components: Array<Record<string, unknown>>,
  ): Promise<ZernioWhatsAppTemplate> {
    const res = await this.request<{ template?: ZernioWhatsAppTemplate }>(
      "PATCH",
      `/whatsapp/templates/${encodeURIComponent(templateName)}`,
      { body: { accountId, components } },
    );
    return (
      res.template ?? {
        id: null,
        name: templateName,
        status: "PENDING",
        category: "UTILITY",
        language: "",
      }
    );
  }

  /**
   * Look up one pre-approved Template Library template by exact name, to see
   * its body params and which buttons Meta will demand inputs for. Returns
   * null when nothing matches exactly.
   */
  async whatsappLibraryTemplate(
    accountId: string,
    name: string,
    language?: string,
  ): Promise<ZernioLibraryTemplate | null> {
    const res = await this.request<{ template?: ZernioLibraryTemplate | null }>(
      "GET",
      "/whatsapp/template-library",
      { query: { accountId, name, language } },
    );
    return res.template ?? null;
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

  // ─── Comment automations (comment → private DM) ──────────────────────────
  //
  // Zernio's "comment-to-DM" product. It owns the keyword matching, Meta's
  // Private Reply, the optional public reply, the 7-day window, dedupe and
  // retries — we only configure it. That is why there is no private-reply
  // method on this client: Meta's private reply is reachable (for Facebook,
  // ONLY reachable) through an automation, not as a direct call.
  //
  // The automation RUNS AT ZERNIO. Creating one starts sending DMs to real
  // people and it keeps going whether or not this app is up.

  /**
   * Create a comment automation and start it (`isActive: true`).
   *
   * Documented at https://docs.zernio.com/comment-automations/create-comment-automation.
   * Two behaviours of Zernio's that the caller must not forget:
   *  - it answers ONLY comments posted while the automation is active, so
   *    pre-existing comments on a post are never picked up;
   *  - omitting `platformPostId` makes it account-wide, which watches the 5
   *    newest posts rather than everything.
   */
  async createCommentAutomation(body: {
    profileId: string;
    accountId: string;
    name: string;
    keywords: string[];
    dmMessage: string;
    matchMode?: "contains" | "word" | "exact";
    platformPostId?: string;
    commentReply?: string;
    repeatPolicy?: { mode: "once" | "every_comment" };
    dmDelaySeconds?: number;
  }): Promise<{ id: string | null; isActive: boolean }> {
    const res = await this.request<{
      automation?: { _id?: string; id?: string; isActive?: boolean };
      _id?: string;
      id?: string;
    }>("POST", "/comment-automations", {
      body: {
        profileId: body.profileId,
        accountId: body.accountId,
        name: body.name,
        trigger: "comment",
        keywords: body.keywords,
        matchMode: body.matchMode ?? "contains",
        dmMessage: body.dmMessage,
        // Absent, not present-and-null: Zernio validates these when present.
        ...(body.platformPostId ? { platformPostId: body.platformPostId } : {}),
        ...(body.commentReply ? { commentReply: body.commentReply } : {}),
        ...(body.dmDelaySeconds ? { dmDelaySeconds: body.dmDelaySeconds } : {}),
        repeatPolicy: body.repeatPolicy ?? { mode: "once" },
        isActive: true,
      },
    });
    const id = res.automation?._id ?? res.automation?.id ?? res._id ?? res.id ?? null;
    return { id, isActive: res.automation?.isActive ?? true };
  }

  /** List this profile's automations, with Zernio's own counters. */
  async listCommentAutomations(profileId?: string): Promise<ZernioCommentAutomation[]> {
    const res = await this.request<{ automations?: ZernioCommentAutomation[] }>(
      "GET",
      "/comment-automations",
      { query: { profileId } },
    );
    return res.automations ?? [];
  }

  /**
   * Turn an automation on or off, or edit it.
   *
   * ⚠ UNDOCUMENTED. Zernio publishes only create and list. This endpoint was
   * found by probing the live API: Zernio answers a missing ROUTE with
   * `{"code":"endpoint_not_found"}` but a missing ROW with
   * `{"error":"Automation not found"}`, and `PATCH /comment-automations/{id}`
   * answers the latter — so the route is real, just unpublished. `DELETE` on
   * the same path behaves the same way; `/disable`, `/deactivate`, `/pause`
   * and `/status` do not exist at all. See
   * `spikes/zernio/spike.mjs ca:probe-disable` and the design doc.
   *
   * Undocumented means unversioned: if this ever starts 404ing with
   * `endpoint_not_found`, fall back to `deleteCommentAutomation` + re-create
   * (ZernioService.disableCommentRule already does this automatically).
   */
  async updateCommentAutomation(
    automationId: string,
    patch: { isActive?: boolean; keywords?: string[]; dmMessage?: string; commentReply?: string },
  ): Promise<{ isActive: boolean | null }> {
    const res = await this.request<{ automation?: { isActive?: boolean } }>(
      "PATCH",
      `/comment-automations/${encodeURIComponent(automationId)}`,
      { body: patch },
    );
    return { isActive: res.automation?.isActive ?? null };
  }

  /** Remove an automation outright. Also undocumented — see above. */
  async deleteCommentAutomation(automationId: string): Promise<void> {
    await this.request<unknown>(
      "DELETE",
      `/comment-automations/${encodeURIComponent(automationId)}`,
      {},
    );
  }

  // ─── WhatsApp ────────────────────────────────────────────────────────────

  async whatsappNumbers(profileId: string): Promise<ZernioWhatsAppNumbers> {
    return this.request<ZernioWhatsAppNumbers>("GET", "/whatsapp/phone-numbers", {
      query: { profileId },
    });
  }

  // ─── HTTP core ───────────────────────────────────────────────────────────

  // ─── WhatsApp broadcasts (Campaigns) ─────────────────────────────────────
  //
  // Flow: import the audience as contacts (so `{{1}} = name` personalises),
  // create a draft with the template + variable mapping, add recipients by
  // phone, then send or schedule. Paths per docs.zernio.com/broadcasts.

  /** Upsert up to 1,000 contacts with a WhatsApp channel. Duplicates are skipped. */
  async bulkCreateContacts(
    profileId: string,
    accountId: string,
    contacts: Array<{ name: string; platformIdentifier: string }>,
  ): Promise<{ created: number; skipped: number; errors: number }> {
    const res = await this.request<{ created?: number; skipped?: number; errors?: unknown[] }>(
      "POST",
      "/contacts/bulk",
      { body: { profileId, accountId, platform: "whatsapp", contacts } },
    );
    return { created: res.created ?? 0, skipped: res.skipped ?? 0, errors: res.errors?.length ?? 0 };
  }

  /**
   * Create a draft WhatsApp broadcast. `variables[i]` fills template
   * placeholder {{i+1}} for every recipient: a contact field Zernio resolves
   * per recipient, or one literal value for everyone.
   */
  async createWhatsAppBroadcast(input: {
    profileId: string;
    accountId: string;
    name: string;
    template: { name: string; language: string };
    variables: ZernioBroadcastVariable[];
    /**
     * SP-13: an optional Meta send-shape header component, placed before the
     * body. The launch runner does not pass one while ruling R8 forces direct
     * sends for a campaign header override.
     */
    headerComponent?: Record<string, unknown>;
  }): Promise<string> {
    const template: Record<string, unknown> = { name: input.template.name, language: input.template.language };
    const components: Array<Record<string, unknown>> = [];
    if (input.headerComponent) components.push(input.headerComponent);
    // Absent, not empty: Meta rejects an empty parameters list.
    if (input.variables.length > 0) {
      components.push({ type: "body", parameters: input.variables.map((_, i) => ({ type: "text", text: `{{${i + 1}}}` })) });
      template.variableMapping = Object.fromEntries(input.variables.map((v, i) => [String(i + 1), v]));
    }
    if (components.length > 0) template.components = components;
    const res = await this.request<{ broadcast?: { id?: string; _id?: string } }>("POST", "/broadcasts", {
      body: {
        profileId: input.profileId,
        accountId: input.accountId,
        platform: "whatsapp",
        name: input.name,
        template,
      },
    });
    const id = res.broadcast?.id ?? res.broadcast?._id;
    if (!id) throw new HttpException("Zernio did not return a broadcast id", 502);
    return id;
  }

  /** Add up to 100 E.164 phones; unseen numbers become contacts. */
  async addBroadcastRecipients(broadcastId: string, phones: string[]): Promise<{ added: number; skipped: number }> {
    const res = await this.request<{ added?: number; skipped?: number }>(
      "POST",
      `/broadcasts/${encodeURIComponent(broadcastId)}/recipients`,
      { body: { phones } },
    );
    return { added: res.added ?? 0, skipped: res.skipped ?? 0 };
  }

  async sendBroadcast(broadcastId: string): Promise<void> {
    await this.request("POST", `/broadcasts/${encodeURIComponent(broadcastId)}/send`, {});
  }

  async scheduleBroadcast(broadcastId: string, scheduledAt: string): Promise<void> {
    await this.request("POST", `/broadcasts/${encodeURIComponent(broadcastId)}/schedule`, { body: { scheduledAt } });
  }

  /** Stops a scheduled or in-progress broadcast; already-sent messages stay sent. */
  async cancelBroadcast(broadcastId: string): Promise<void> {
    await this.request("POST", `/broadcasts/${encodeURIComponent(broadcastId)}/cancel`, {});
  }

  /**
   * SP-13: a profile's broadcasts, optionally by status (read-only GET
   * /broadcasts?profileId&status&limit). The launch runner lists drafts to
   * adopt one it created before a crash (name marker ` · crm:<partitionId>`).
   */
  async listBroadcasts(opts: { profileId: string; status?: string; limit?: number }): Promise<ZernioBroadcastSummary[]> {
    const res = await this.request<{ broadcasts?: unknown; data?: unknown }>("GET", "/broadcasts", {
      query: { profileId: opts.profileId, status: opts.status, limit: opts.limit != null ? String(opts.limit) : undefined },
    });
    const list = Array.isArray(res?.broadcasts) ? res.broadcasts : Array.isArray(res?.data) ? res.data : [];
    return (list as Array<Record<string, unknown>>).flatMap((b) => {
      const id = typeof b.id === "string" ? b.id : typeof b._id === "string" ? b._id : null;
      if (!id) return [];
      return [{ id, name: typeof b.name === "string" ? b.name : "", status: typeof b.status === "string" ? b.status : "draft" }];
    });
  }

  /** SP-13: delete a draft broadcast (cancel during launch). */
  async deleteBroadcast(broadcastId: string): Promise<void> {
    await this.request("DELETE", `/broadcasts/${encodeURIComponent(broadcastId)}`, {});
  }

  /**
   * SP-13 direct transport: one approved template to one phone, with its own
   * parameters and optional header media (POST /inbox/conversations). The
   * `Idempotency-Key` (kept 24 h by Zernio) makes a retry replay the original
   * response instead of sending a second message.
   */
  async sendTemplateToPhone(input: {
    accountId: string;
    phone: string;
    templateName: string;
    templateLanguage: string;
    templateParams: string[];
    headerMedia?: { link: string };
    idempotencyKey: string;
  }): Promise<{ messageId: string | null; conversationId: string | null }> {
    const res = await this.request<{
      messageId?: string;
      conversationId?: string;
      data?: { messageId?: string; conversationId?: string };
      message?: { id?: string; _id?: string };
      conversation?: { id?: string; _id?: string };
    }>("POST", "/inbox/conversations", {
      headers: { "Idempotency-Key": input.idempotencyKey },
      body: {
        accountId: input.accountId,
        phone: input.phone,
        templateName: input.templateName,
        templateLanguage: input.templateLanguage,
        templateParams: input.templateParams,
        ...(input.headerMedia ? { headerMedia: input.headerMedia } : {}),
      },
    });
    return {
      messageId: res?.data?.messageId ?? res?.messageId ?? res?.message?.id ?? res?.message?._id ?? null,
      conversationId: res?.data?.conversationId ?? res?.conversationId ?? res?.conversation?.id ?? res?.conversation?._id ?? null,
    };
  }

  /**
   * SP-12: one page of a broadcast's per-recipient state (read-only GET
   * /broadcasts/{id}/recipients?skip&limit&status). Every field is typed
   * from Zernio's documentation and read defensively: the id scheme of
   * `messageId` (Zernio's or Meta's wamid), the maximum `limit` and the
   * ordering are unverified until the Task 4 probe (ruling 1).
   */
  async listBroadcastRecipients(
    broadcastId: string,
    opts: { skip: number; limit: number; status?: ZernioBroadcastRecipientStatus },
  ): Promise<ZernioBroadcastRecipientsPage> {
    const res = await this.request<{
      recipients?: Array<Record<string, unknown>>;
      pagination?: { total?: number; limit?: number; skip?: number; hasMore?: boolean };
      summary?: Record<string, unknown>;
    }>("GET", `/broadcasts/${encodeURIComponent(broadcastId)}/recipients`, {
      query: { skip: String(opts.skip), limit: String(opts.limit), status: opts.status },
    });
    const s = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
    const recipients: ZernioBroadcastRecipient[] = (Array.isArray(res?.recipients) ? res.recipients : []).map((r) => ({
      id: s(r.id) ?? s(r._id) ?? "",
      contactId: s(r.contactId),
      channelId: s(r.channelId),
      platformIdentifier: s(r.platformIdentifier) ?? s(r.phone),
      contactName: s(r.contactName),
      status: s(r.status) ?? "pending",
      messageId: s(r.messageId),
      error: s(r.error),
      errorCode: typeof r.errorCode === "number" || typeof r.errorCode === "string" ? r.errorCode : null,
      errorExplanation: s(r.errorExplanation),
      errorTraceId: s(r.errorTraceId),
      sentAt: s(r.sentAt),
      deliveredAt: s(r.deliveredAt),
      readAt: s(r.readAt),
    }));
    const p = res?.pagination ?? {};
    return {
      recipients,
      pagination: {
        total: typeof p.total === "number" ? p.total : null,
        limit: typeof p.limit === "number" ? p.limit : opts.limit,
        skip: typeof p.skip === "number" ? p.skip : opts.skip,
        hasMore: typeof p.hasMore === "boolean" ? p.hasMore : null,
      },
      summary: res?.summary && typeof res.summary === "object" ? res.summary : {},
    };
  }

  async getBroadcast(broadcastId: string): Promise<ZernioBroadcastStats> {
    const res = await this.request<{
      broadcast?: {
        status?: string;
        recipientCount?: number;
        sentCount?: number;
        deliveredCount?: number;
        readCount?: number;
        failedCount?: number;
      };
    }>("GET", `/broadcasts/${encodeURIComponent(broadcastId)}`, {});
    const b = res.broadcast ?? {};
    return {
      status: b.status ?? "draft",
      recipientCount: b.recipientCount ?? 0,
      sent: b.sentCount ?? 0,
      delivered: b.deliveredCount ?? 0,
      read: b.readCount ?? 0,
      failed: b.failedCount ?? 0,
    };
  }

  private async request<T>(
    method: string,
    path: string,
    opts: { query?: Record<string, string | undefined>; body?: unknown; headers?: Record<string, string> },
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
          ...(opts.headers ?? {}),
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
      // Zernio answers this when Meta has revoked the connected WhatsApp
      // number; say what to do instead of echoing its internal wording.
      if (/whatsapp account not found/i.test(errMsg)) {
        throw new HttpException(
          "Your WhatsApp connection was removed by Meta. Reconnect WhatsApp in Settings → Integrations, then try again.",
          400,
        );
      }
      // SP-13: a rate limit is typed, with Retry-After, so campaign launch
      // calls can wait it out and keep their lease (still an HTTP 429).
      if (res.status === 429) {
        throw new ZernioRateLimitError(errMsg, parseRetryAfter(res.headers?.get?.("retry-after") ?? null));
      }
      // Surface client errors (4xx) as-is; collapse upstream 5xx to 502.
      throw new HttpException(errMsg, res.status >= 500 ? 502 : res.status);
    }
    return parsed as T;
  }
}

/** SP-13: Zernio answered 429. `retryAfterMs` is its Retry-After (null when absent). */
export class ZernioRateLimitError extends HttpException {
  constructor(
    message: string,
    readonly retryAfterMs: number | null,
  ) {
    super(message, 429);
  }
}

/** Retry-After as milliseconds: delta-seconds or an HTTP date; null when absent or unparseable. */
export function parseRetryAfter(raw: string | null, now = Date.now()): number | null {
  if (!raw) return null;
  const t = raw.trim();
  if (/^\d+$/.test(t)) return Number(t) * 1000;
  const at = Date.parse(t);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

// ─── Response shapes (partial — the fields we read) ──────────────────────────

/** SP-13: one row of GET /broadcasts. */
export interface ZernioBroadcastSummary {
  id: string;
  name: string;
  status: string;
}

export interface ZernioAccount {
  _id: string;
  platform: string;
  displayName?: string;
  username?: string;
  name?: string;
  platformStatus?: string;
  isActive?: boolean;
  /** Zernio's own flag that the account's sign-in has to be redone. */
  needsReconnection?: boolean;
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

/** A comment automation as `GET /comment-automations` returns it. The live
 *  response envelope is `{ success: true, automations: [...] }` (probed
 *  2026-11-25). `stats` is Zernio's own counter set — we never compute it. */
export interface ZernioCommentAutomation {
  _id?: string;
  id?: string;
  name?: string;
  accountId?: string;
  platform?: string;
  isActive?: boolean;
  keywords?: string[];
  matchMode?: string;
  platformPostId?: string;
  dmMessage?: string;
  commentReply?: string;
  createdAt?: string;
  stats?: {
    dmsSent?: number;
    dmsFailed?: number;
    linkClicks?: number;
    uniqueContacts?: number;
  };
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

/** A pre-approved Template Library entry, before it is imported to the WABA. */
export interface ZernioLibraryTemplate {
  name: string;
  language: string;
  category: string;
  body: string;
  /** Names of the body placeholders, in order. */
  body_params?: string[];
  availableLanguages?: string[];
  /** URL / PHONE_NUMBER buttons here need matching inputs at create time. */
  buttons?: Array<{ type: string; text?: string }>;
}

/** A template as Meta reports it, proxied through Zernio. */
export interface ZernioWhatsAppTemplate {
  id: string | null;
  name: string;
  /** Meta's real review verdict. */
  status: "APPROVED" | "PENDING" | "REJECTED" | string;
  category: "AUTHENTICATION" | "MARKETING" | "UTILITY" | string;
  language: string;
  /** Meta component definitions (HEADER / BODY / FOOTER / BUTTONS). */
  components?: Array<Record<string, unknown>>;
  /**
   * Why Meta rejected it, e.g. INVALID_FORMAT — which is what you get for a
   * template whose {{n}} variables carry no example values, or whose content
   * duplicates an already-rejected template (both verified live 2026-08-28).
   */
  rejected_reason?: string;
  /**
   * SP-14: Meta's template quality, read only when Zernio passes it through
   * (undocumented, ruling 1). Absent → unknown.
   */
  quality_score?: { score?: string };
}

/** SP-14: GET /whatsapp/number-info. Every field optional (shape unverified live). */
export interface ZernioNumberInfo {
  phone?: {
    id?: string;
    display_phone_number?: string;
    verified_name?: string;
    /** GREEN | YELLOW | RED | UNKNOWN */
    quality_rating?: string;
    /** e.g. TIER_250, TIER_1K, TIER_UNLIMITED */
    messaging_limit_tier?: string;
    name_status?: string;
    /** e.g. CONNECTED */
    status?: string;
    /** Meta's health_status object; we read `can_send_message` only. */
    health_status?: { can_send_message?: string; [k: string]: unknown };
    /** Undocumented; read only when present (ruling 1). */
    code_verification_status?: string;
    [k: string]: unknown;
  };
  /** Undocumented sub-fields; read only when present (ruling 1). */
  waba?: { business_verification_status?: string; account_review_status?: string; [k: string]: unknown };
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

/** One template placeholder's value in a broadcast. */
export type ZernioBroadcastVariable =
  | { field: "name" | "phone" | "email" | "company" }
  | { field: "custom"; customValue: string };

export type ZernioBroadcastRecipientStatus = "pending" | "sent" | "delivered" | "read" | "failed";

/** One row of GET /broadcasts/{id}/recipients (SP-12). Timestamps are ISO strings. */
export interface ZernioBroadcastRecipient {
  id: string;
  contactId: string | null;
  channelId: string | null;
  /** The phone (E.164 with or without '+'). */
  platformIdentifier: string | null;
  contactName: string | null;
  /** pending | sent | delivered | read | failed (unknown values are kept verbatim). */
  status: string;
  /** Zernio's id or Meta's wamid; unverified (ruling 1). */
  messageId: string | null;
  error: string | null;
  errorCode: number | string | null;
  errorExplanation: string | null;
  errorTraceId: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
}

export interface ZernioBroadcastRecipientsPage {
  recipients: ZernioBroadcastRecipient[];
  /** `total` and `hasMore` are null when Zernio does not report them (the sweep then pages until a short page). */
  pagination: { total: number | null; limit: number; skip: number; hasMore: boolean | null };
  summary: Record<string, unknown>;
}

export interface ZernioBroadcastStats {
  /** draft | scheduled | sending | completed | failed | cancelled */
  status: string;
  recipientCount: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
}
