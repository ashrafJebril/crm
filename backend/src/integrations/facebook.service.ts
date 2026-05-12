import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { MediaService } from "../media/media.service";

const GRAPH = "https://graph.facebook.com/v21.0";

interface FbMe {
  id: string;
  name: string;
  category?: string; // present on Pages, absent on Users
}

interface FbAccount {
  id: string;
  name: string;
  access_token: string;
  category?: string;
  tasks?: string[];
}

interface FbAccountsResponse {
  data: FbAccount[];
}

interface LongLivedTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
}

interface FbPagePost {
  id: string;
  message?: string;
  created_time: string;
  permalink_url?: string;
  full_picture?: string;
  reactions?: { summary: { total_count: number } };
  comments?: { summary: { total_count: number } };
  shares?: { count: number };
  attachments?: {
    data: Array<{
      type?: string;
      title?: string;
      description?: string;
      media?: { image?: { src: string } };
    }>;
  };
}

interface FbPostsResponse {
  data: FbPagePost[];
  paging?: { cursors?: { before: string; after: string }; next?: string };
}

interface FbComment {
  id: string;
  message?: string;
  created_time: string;
  from?: { id: string; name: string };
  like_count?: number;
  user_likes?: boolean;
  parent?: { id: string };
  comment_count?: number;
}

interface FbCommentsResponse {
  data: FbComment[];
  paging?: { cursors?: { before: string; after: string }; next?: string };
}

@Injectable()
export class FacebookService {
  private readonly log = new Logger(FacebookService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
  ) {}

  // ─── Public API ─────────────────────────────────────────────────────────
  async status(workspaceId: string) {
    const integ = await this.find(workspaceId);
    if (!integ) return { connected: false };
    return {
      connected: true,
      pageId: integ.pageId,
      pageName: integ.pageName,
      lastFetchedAt: integ.lastFetchedAt,
      expiresAt: integ.expiresAt,
    };
  }

  async connect(workspaceId: string, rawToken: string) {
    // Validate the token + get a label.  /me works for both User and Page tokens.
    const me = await this.graphGet<FbMe>("/me?fields=id,name", rawToken);
    if (!me?.id) throw new BadRequestException("Token did not resolve to anything");

    let pageId: string;
    let pageName: string;
    let pageToken: string;
    const candidates: Array<{ id: string; name: string; access_token: string }> = [];

    // Try /me/accounts — works only on User tokens. If it returns pages, this
    // is a User token; pick the first/best page. If it 400s or returns empty,
    // assume the raw token is already a Page token.
    let userAccounts: FbAccountsResponse | null = null;
    try {
      userAccounts = await this.graphGet<FbAccountsResponse>(
        "/me/accounts?fields=id,name,access_token,tasks",
        rawToken,
      );
    } catch {
      userAccounts = null;
    }

    if (userAccounts?.data?.length) {
      // User Access Token — pick the highest-privilege page.
      const ranked = [...userAccounts.data].sort((a, b) => {
        const score = (p: FbAccount) =>
          (p.tasks?.includes("MANAGE") ? 2 : 0) +
          (p.tasks?.includes("CREATE_CONTENT") ? 1 : 0);
        return score(b) - score(a);
      });
      const pick = ranked[0];
      pageId = pick.id;
      pageName = pick.name;
      pageToken = pick.access_token;
      ranked.forEach((p) =>
        candidates.push({ id: p.id, name: p.name, access_token: p.access_token }),
      );
    } else {
      // Page Access Token (or User with no admin Pages) — use as-is.
      pageId = me.id;
      pageName = me.name;
      pageToken = rawToken;
    }

    // Step 2: try to upgrade to a long-lived (60-day) Page Access Token.
    let finalToken = pageToken;
    let expiresAt: Date | null = null;
    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;
    if (appId && appSecret) {
      try {
        const longLived = await this.exchangeForLongLived(pageToken, appId, appSecret);
        if (longLived?.access_token) {
          finalToken = longLived.access_token;
          if (longLived.expires_in) {
            expiresAt = new Date(Date.now() + longLived.expires_in * 1000);
          }
        }
      } catch (e) {
        this.log.warn(`Long-lived exchange failed (will use short-lived token): ${(e as Error).message}`);
      }
    }

    const data = {
      platform: "facebook",
      pageId,
      pageName,
      accessToken: finalToken,
      scopes: null,
      expiresAt,
      raw: JSON.stringify({ me, candidates: candidates.map((c) => ({ id: c.id, name: c.name })) }),
    };

    const existing = await this.find(workspaceId);
    const row = existing
      ? await this.prisma.integration.update({ where: { id: existing.id }, data })
      : await this.prisma.integration.create({ data: { ...data, workspaceId } });

    // Best-effort IG discovery — never fails the FB connect even if IG is missing.
    const ig = await this.maybeDiscoverIg(workspaceId, pageId, finalToken, expiresAt);

    return {
      connected: true,
      pageId: row.pageId,
      pageName: row.pageName,
      expiresAt: row.expiresAt,
      candidates: candidates.length > 1 ? candidates.map((c) => ({ id: c.id, name: c.name })) : undefined,
      instagram: ig
        ? { connected: true, userId: ig.igUserId, username: ig.igUsername }
        : { connected: false },
    };
  }

  private async exchangeForLongLived(
    shortToken: string,
    appId: string,
    appSecret: string,
  ): Promise<LongLivedTokenResponse> {
    const url =
      `${GRAPH}/oauth/access_token?grant_type=fb_exchange_token` +
      `&client_id=${appId}` +
      `&client_secret=${appSecret}` +
      `&fb_exchange_token=${shortToken}`;
    return this.fetchJson<LongLivedTokenResponse>(url, { method: "GET" });
  }

  async disconnect(workspaceId: string) {
    const integ = await this.find(workspaceId);
    if (!integ) return { ok: true };
    await this.prisma.integration.delete({ where: { id: integ.id } });
    // IG is derived from the FB Page Access Token, so disconnect it too.
    const ig = await this.prisma.integration.findFirst({
      where: { workspaceId, platform: "instagram" },
    });
    if (ig) await this.prisma.integration.delete({ where: { id: ig.id } });
    return { ok: true };
  }

  /** List every Page the currently-stored token can access. Lets the UI switch. */
  async listPages(workspaceId: string) {
    const { token } = await this.requireToken(workspaceId);
    // Try /me/accounts. If the stored token is a Page Access Token (no
    // /me/accounts), return just the connected page as a single entry.
    let res: FbAccountsResponse | null = null;
    try {
      res = await this.graphGet<FbAccountsResponse>(
        "/me/accounts?fields=id,name,access_token,tasks",
        token,
      );
    } catch {
      res = null;
    }
    const integ = await this.find(workspaceId);
    if (!res?.data?.length) {
      // Single-page mode (token is already a Page token)
      return integ
        ? [{ id: integ.pageId ?? "", name: integ.pageName ?? "Unknown", active: true }]
        : [];
    }
    return res.data.map((p) => ({
      id: p.id,
      name: p.name,
      active: integ?.pageId === p.id,
    }));
  }

  /** Switch the active Page. Re-derives the long-lived token for that page. */
  async selectPage(workspaceId: string, pageId: string) {
    const integ = await this.find(workspaceId);
    if (!integ) throw new NotFoundException("Facebook is not connected");
    // Try to get the page's access_token from the stored user-level token.
    let pageToken = integ.accessToken;
    let pageName = integ.pageName ?? "";
    let res: FbAccountsResponse | null = null;
    try {
      res = await this.graphGet<FbAccountsResponse>(
        "/me/accounts?fields=id,name,access_token,tasks",
        integ.accessToken,
      );
    } catch {
      res = null;
    }
    if (res?.data?.length) {
      const match = res.data.find((p) => p.id === pageId);
      if (!match) throw new BadRequestException("Page not found in your accessible pages");
      pageToken = match.access_token;
      pageName = match.name;
    }
    // Try long-lived exchange (ignored on failure)
    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;
    let finalToken = pageToken;
    let expiresAt: Date | null = integ.expiresAt;
    if (appId && appSecret) {
      try {
        const ll = await this.exchangeForLongLived(pageToken, appId, appSecret);
        if (ll?.access_token) {
          finalToken = ll.access_token;
          if (ll.expires_in) expiresAt = new Date(Date.now() + ll.expires_in * 1000);
        }
      } catch {
        /* keep short-lived */
      }
    }
    const updated = await this.prisma.integration.update({
      where: { id: integ.id },
      data: { pageId, pageName, accessToken: finalToken, expiresAt },
    });
    return {
      connected: true,
      pageId: updated.pageId,
      pageName: updated.pageName,
      expiresAt: updated.expiresAt,
    };
  }

  async listPosts(workspaceId: string, limit = 25) {
    const { token, pageId } = await this.requireToken(workspaceId);
    const fields = [
      "id",
      "message",
      "created_time",
      "permalink_url",
      "full_picture",
      "reactions.summary(true)",
      "comments.summary(true)",
      "shares",
      "attachments{type,title,description,media}",
    ].join(",");
    const res = await this.graphGet<FbPostsResponse>(
      `/${pageId}/posts?fields=${encodeURIComponent(fields)}&limit=${limit}`,
      token,
    );
    await this.touchFetched(workspaceId);
    return (res.data ?? []).map((p) => this.shapePost(p));
  }

  async publishToPage(
    workspaceId: string,
    dto: { content: string; mediaIds?: string[] },
  ) {
    const { token, pageId } = await this.requireToken(workspaceId);
    const firstMediaId = dto.mediaIds?.[0];

    if (!firstMediaId) {
      // Text-only post — /feed with form-encoded body.
      const url = `${GRAPH}/${pageId}/feed`;
      const params = new URLSearchParams({
        message: dto.content,
        access_token: token,
      });
      const res = await this.fetchJson<{ id: string }>(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });
      return { id: res.id, kind: "feed" as const };
    }

    // Single-photo post — /photos with multipart upload.
    const mediaRow = await this.media.get(workspaceId, firstMediaId);
    const absolutePath = await this.media.resolvePath(workspaceId, firstMediaId);

    const fs = await import("node:fs/promises");
    const buffer = await fs.readFile(absolutePath);
    const blob = new Blob([buffer], { type: mediaRow.mimeType });
    const form = new FormData();
    form.append("source", blob, mediaRow.fileName);
    form.append("message", dto.content);
    form.append("access_token", token);

    const url = `${GRAPH}/${pageId}/photos`;
    // Native fetch handles multipart FormData encoding for us; do NOT set
    // Content-Type manually — fetch will inject the correct boundary.
    let response: Response;
    try {
      response = await fetch(url, { method: "POST", body: form });
    } catch (e) {
      this.log.error(`Graph network error: ${(e as Error).message}`);
      throw new HttpException("Graph API unreachable", 502);
    }
    const text = await response.text();
    let parsed: unknown = undefined;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
    if (!response.ok) {
      const errMsg =
        typeof parsed === "object" && parsed !== null && "error" in parsed
          // @ts-expect-error - shape from Graph API
          ? ((parsed.error?.message as string) ?? `Graph error ${response.status}`)
          : `Graph error ${response.status}`;
      this.log.warn(`Graph POST ${url} -> ${response.status} ${errMsg}`);
      throw new HttpException(errMsg, response.status >= 500 ? 502 : 400);
    }
    const data = parsed as { id?: string; post_id?: string };
    return { id: data.post_id ?? data.id ?? "", kind: "photo" as const };
  }

  async listComments(workspaceId: string, postId: string, limit = 25) {
    const { token } = await this.requireToken(workspaceId);
    const fields = "id,message,created_time,from,like_count,parent,comment_count";
    const res = await this.graphGet<FbCommentsResponse>(
      `/${postId}/comments?fields=${encodeURIComponent(fields)}&order=reverse_chronological&limit=${limit}`,
      token,
    );
    return (res.data ?? []).map((c) => ({
      id: c.id,
      author: c.from?.name ?? "Anonymous",
      authorId: c.from?.id,
      body: c.message ?? "",
      likes: c.like_count ?? 0,
      at: c.created_time,
      replyCount: c.comment_count ?? 0,
    }));
  }

  async replyToComment(workspaceId: string, commentId: string, message: string) {
    const { token } = await this.requireToken(workspaceId);
    const res = await this.graphPost<{ id: string }>(`/${commentId}/comments`, token, { message });
    return { id: res.id, ok: true };
  }

  // ─── Page Messenger conversations (DMs) ─────────────────────────────────
  async listConversations(workspaceId: string, limit = 25) {
    const { token, pageId } = await this.requireToken(workspaceId);
    const fields = "id,updated_time,snippet,unread_count,message_count,participants";
    const res = await this.graphGet<{
      data: Array<{
        id: string;
        updated_time: string;
        snippet?: string;
        unread_count?: number;
        message_count?: number;
        participants?: { data: Array<{ id: string; name?: string }> };
      }>;
    }>(`/${pageId}/conversations?fields=${encodeURIComponent(fields)}&limit=${limit}`, token);

    const rows = res.data ?? [];

    // Upsert each non-Page participant as a real Contact in our DB so that
    // downstream features (notes, tickets, tags, analytics) can attach to a
    // stable id. Dedup is keyed on (workspaceId, externalSource, externalId).
    const contactByPsid = new Map<string, string>(); // psid -> DB contact id
    for (const c of rows) {
      const other = c.participants?.data.find((p) => p.id !== pageId);
      if (!other?.id) continue;
      if (contactByPsid.has(other.id)) continue;
      const contact = await this.prisma.contact.upsert({
        where: {
          workspaceId_externalSource_externalId: {
            workspaceId,
            externalSource: "facebook",
            externalId: other.id,
          },
        },
        create: {
          workspaceId,
          name: other.name ?? "Facebook user",
          industry: "social",
          lifecycle: "lead",
          source: "facebook",
          lastSeen: this.fmtCompact(c.updated_time),
          externalSource: "facebook",
          externalId: other.id,
        },
        update: {
          // Refresh the display name and last-seen on each sync; leave
          // user-edited fields like industry/lifecycle/tags alone.
          name: other.name ?? undefined,
          lastSeen: this.fmtCompact(c.updated_time),
        },
      });
      contactByPsid.set(other.id, contact.id);
    }

    return rows.map((c) => {
      const other = c.participants?.data.find((p) => p.id !== pageId);
      const dbContactId = other?.id ? contactByPsid.get(other.id) : undefined;
      return {
        id: c.id,
        contactId: dbContactId, // now a real DB cuid, not the FB PSID
        contactPsid: other?.id, // keep PSID for sending replies via Graph
        contactName: other?.name ?? "Unknown",
        snippet: c.snippet ?? "",
        unread: c.unread_count ?? 0,
        messageCount: c.message_count ?? 0,
        updatedAt: c.updated_time,
      };
    });
  }

  /** Compact relative-time formatter to keep Contact.lastSeen short and human. */
  private fmtCompact(iso?: string): string {
    if (!iso) return "—";
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return "—";
    const diffMin = Math.floor((Date.now() - t) / 60000);
    if (diffMin < 1) return "now";
    if (diffMin < 60) return `${diffMin}m`;
    const h = Math.floor(diffMin / 60);
    if (h < 24) return `${h}h`;
    const d = Math.floor(h / 24);
    if (d < 7) return `${d}d`;
    return new Date(t).toLocaleDateString();
  }

  async listMessagesInConversation(workspaceId: string, conversationId: string, limit = 25) {
    const { token } = await this.requireToken(workspaceId);
    const fields = "id,from,to,message,created_time,attachments";
    const res = await this.graphGet<{
      data: Array<{
        id: string;
        from?: { id: string; name?: string };
        message?: string;
        created_time: string;
        attachments?: { data: Array<{ mime_type?: string; image_data?: { url: string } }> };
      }>;
    }>(`/${conversationId}/messages?fields=${encodeURIComponent(fields)}&limit=${limit}`, token);
    // FB returns messages newest-first; return oldest-first for thread display.
    const messages = (res.data ?? []).slice().reverse();
    const { pageId } = await this.requireToken(workspaceId);
    return messages.map((m) => ({
      id: m.id,
      from: m.from?.id === pageId ? "page" : "them",
      authorName: m.from?.name ?? "Unknown",
      body: m.message ?? "",
      attachmentUrl: m.attachments?.data?.[0]?.image_data?.url,
      at: m.created_time,
    }));
  }

  async sendDirectMessage(workspaceId: string, recipientId: string, message: string) {
    const { token, pageId } = await this.requireToken(workspaceId);
    // Note: Graph requires { recipient: {id}, message: {text} } as JSON.
    // Our existing graphPost is form-encoded; use a JSON variant inline.
    const url = `${GRAPH}/${pageId}/messages?access_token=${encodeURIComponent(token)}`;
    const body = JSON.stringify({
      recipient: { id: recipientId },
      message: { text: message },
      messaging_type: "RESPONSE",
    });
    const res = await this.fetchJson<{ message_id: string; recipient_id: string }>(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    return { messageId: res.message_id, recipientId: res.recipient_id, ok: true };
  }

  // ─── Internals ──────────────────────────────────────────────────────────
  private async find(workspaceId: string) {
    return this.prisma.integration.findFirst({
      where: { workspaceId, platform: "facebook" },
    });
  }

  private async requireToken(workspaceId: string): Promise<{ token: string; pageId: string }> {
    const integ = await this.find(workspaceId);
    if (!integ?.accessToken || !integ.pageId) {
      throw new NotFoundException("Facebook is not connected");
    }
    return { token: integ.accessToken, pageId: integ.pageId };
  }

  /**
   * After a Page is connected, look up its linked Instagram Business
   * account. If one exists, create/update an Integration row with
   * platform="instagram" using the same Page Access Token.
   *
   * Returns the IG user id + username if discovered, else null.
   */
  private async maybeDiscoverIg(
    workspaceId: string,
    pageId: string,
    pageToken: string,
    expiresAt: Date | null,
  ): Promise<{ igUserId: string; igUsername: string } | null> {
    let res: { instagram_business_account?: { id: string } } | null = null;
    try {
      res = await this.graphGet<{ instagram_business_account?: { id: string } }>(
        `/${pageId}?fields=instagram_business_account`,
        pageToken,
      );
    } catch (e) {
      this.log.warn(`IG discovery: graph call failed: ${(e as Error).message}`);
      return null;
    }
    const igId = res?.instagram_business_account?.id;
    if (!igId) return null;

    let igUsername = "Instagram";
    try {
      const me = await this.graphGet<{ id: string; username?: string; name?: string }>(
        `/${igId}?fields=id,username,name`,
        pageToken,
      );
      igUsername = me.username ?? me.name ?? "Instagram";
    } catch (e) {
      this.log.warn(`IG discovery: username fetch failed: ${(e as Error).message}`);
    }

    const existing = await this.prisma.integration.findFirst({
      where: { workspaceId, platform: "instagram" },
    });
    const data = {
      platform: "instagram",
      pageId: igId,
      pageName: igUsername,
      accessToken: pageToken,
      scopes: null,
      expiresAt,
      raw: JSON.stringify({ linkedFbPageId: pageId }),
    };
    if (existing) {
      await this.prisma.integration.update({ where: { id: existing.id }, data });
    } else {
      await this.prisma.integration.create({ data: { ...data, workspaceId } });
    }
    return { igUserId: igId, igUsername };
  }

  private async touchFetched(workspaceId: string) {
    await this.prisma.integration.updateMany({
      where: { workspaceId, platform: "facebook" },
      data: { lastFetchedAt: new Date() },
    });
  }

  private async graphGet<T>(pathAndQuery: string, token: string): Promise<T> {
    const sep = pathAndQuery.includes("?") ? "&" : "?";
    const url = `${GRAPH}${pathAndQuery}${sep}access_token=${encodeURIComponent(token)}`;
    return this.fetchJson<T>(url, { method: "GET" });
  }

  private async graphPost<T>(path: string, token: string, body: Record<string, string>): Promise<T> {
    const url = `${GRAPH}${path}`;
    const params = new URLSearchParams({ ...body, access_token: token });
    return this.fetchJson<T>(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
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
      this.log.warn(`Graph ${init.method} ${url} -> ${res.status} ${errMsg}`);
      throw new HttpException(errMsg, res.status >= 500 ? 502 : 400);
    }
    return parsed as T;
  }

  private shapePost(p: FbPagePost) {
    const att = p.attachments?.data?.[0];
    return {
      id: p.id,
      body: p.message ?? att?.title ?? "",
      mediaUrl: p.full_picture ?? att?.media?.image?.src,
      attachmentType: att?.type,
      attachmentTitle: att?.title,
      permalink: p.permalink_url,
      createdAt: p.created_time,
      likes: p.reactions?.summary.total_count ?? 0,
      comments: p.comments?.summary.total_count ?? 0,
      shares: p.shares?.count ?? 0,
    };
  }
}
