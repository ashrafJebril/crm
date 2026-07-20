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

  async getMessages(conversationId: string): Promise<ZernioMessage[]> {
    const res = await this.request<{ data?: ZernioMessage[]; messages?: ZernioMessage[] }>(
      "GET",
      `/inbox/conversations/${encodeURIComponent(conversationId)}/messages`,
      {},
    );
    return res.data ?? res.messages ?? [];
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
  }): Promise<{ id: string | null; status: string | null }> {
    const res = await this.request<{ post?: { _id?: string; status?: string } }>(
      "POST",
      "/posts",
      { body: { publishNow: true, ...body } },
    );
    return { id: res.post?._id ?? null, status: res.post?.status ?? null };
  }

  // ─── Reading published posts (feed) ──────────────────────────────────────

  /** List a profile's posts. Zernio serves a page's OWN (synced/external) posts
   *  under /analytics — the /posts endpoint only returns posts CREATED through
   *  Zernio. Hitting /analytics also triggers Zernio's external-post sync. */
  async listPosts(profileId: string, platform?: string): Promise<ZernioPost[]> {
    const res = await this.request<{ posts?: ZernioPost[] }>("GET", "/analytics", {
      query: { profileId, platform, limit: "50" },
    });
    return res.posts ?? [];
  }

  async listComments(profileId: string, platform?: string): Promise<ZernioComment[]> {
    const res = await this.request<{ data?: ZernioComment[] }>("GET", "/inbox/comments", {
      query: { profileId, platform },
    });
    return res.data ?? [];
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
  id?: string;
  _id?: string;
  direction?: string; // "incoming" | "outgoing"
  from?: string;
  text?: string;
  message?: string;
  body?: string;
  content?: string;
  timestamp?: string | number;
  createdAt?: string;
  senderName?: string;
}

export interface ZernioPost {
  _id?: string;
  id?: string;
  platform?: string;
  platforms?: Array<{ platform?: string; accountId?: string } | string>;
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

export interface ZernioComment {
  id?: string;
  _id?: string;
  accountId?: string;
  platform?: string;
  postId?: string;
  content?: string;
  text?: string;
  author?: string;
  authorName?: string;
  from?: { name?: string };
  createdTime?: string;
  createdAt?: string;
  likeCount?: number;
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
