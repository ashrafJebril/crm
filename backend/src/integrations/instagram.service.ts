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

@Injectable()
export class InstagramService {
  private readonly log = new Logger(InstagramService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
  ) {}

  async status(workspaceId: string) {
    const integ = await this.find(workspaceId);
    if (!integ) return { connected: false };
    return {
      connected: true,
      userId: integ.pageId,
      username: integ.pageName,
      expiresAt: integ.expiresAt,
      lastFetchedAt: integ.lastFetchedAt,
    };
  }

  async publish(
    workspaceId: string,
    dto: { content: string; mediaIds?: string[] },
    publicBaseUrl: string,
  ) {
    const { token, igUserId } = await this.requireToken(workspaceId);
    const firstMediaId = dto.mediaIds?.[0];
    if (!firstMediaId) {
      throw new BadRequestException(
        "Instagram requires an image or video; text-only posts are not supported by the Graph API.",
      );
    }
    // Look at the stored mime type so we choose image_url vs video_url (Reels)
    // accordingly — IG returns 'Only photo or video can be accepted as media
    // type' when you mismatch these.
    const mediaRow = await this.media.get(workspaceId, firstMediaId);
    const mime = (mediaRow.mimeType ?? "").toLowerCase();
    const isVideo = mime.startsWith("video/");
    const isImage = mime.startsWith("image/");
    if (!isImage && !isVideo) {
      throw new BadRequestException(
        `Instagram only accepts image/* or video/* — got ${mime || "unknown"}.`,
      );
    }
    if (isImage && (mime.includes("gif") || mime.includes("webp"))) {
      throw new BadRequestException(
        "Instagram doesn't accept GIF or WebP via the API — use JPG or PNG.",
      );
    }
    // Mint a 15-min public URL for Meta to fetch the media.
    const pubToken = await this.media.mintPublicToken(workspaceId, firstMediaId);
    const mediaUrl = `${publicBaseUrl.replace(/\/$/, "")}/api/media/${firstMediaId}/public?token=${pubToken}`;

    // Step 1: create container — different params for image vs video.
    const params: Record<string, string> = {
      caption: dto.content,
      access_token: token,
    };
    if (isImage) {
      params.image_url = mediaUrl;
    } else {
      params.media_type = "REELS";
      params.video_url = mediaUrl;
    }
    const containerUrl =
      `${GRAPH}/${igUserId}/media?` + new URLSearchParams(params).toString();
    const container = await this.fetchJson<{ id: string }>(containerUrl, { method: "POST" });

    // Step 2: poll container (IG processes the media asynchronously; videos
    // take longer to transcode).
    await this.waitForContainerReady(container.id, token);

    // Step 3: publish
    const publishUrl =
      `${GRAPH}/${igUserId}/media_publish?` +
      new URLSearchParams({ creation_id: container.id, access_token: token }).toString();
    const published = await this.fetchJson<{ id: string }>(publishUrl, { method: "POST" });

    return { id: published.id, containerId: container.id };
  }

  /**
   * Fetch the connected IG Business account's media (posts/reels/carousels).
   * Returns the most recent items in our SocialPost-ish shape so the
   * frontend can render them next to FB posts without per-platform branches.
   */
  async listPosts(workspaceId: string, limit = 24) {
    const { token, igUserId } = await this.requireToken(workspaceId);
    const fields = [
      "id",
      "caption",
      "media_type",
      "media_url",
      "thumbnail_url",
      "permalink",
      "timestamp",
      "like_count",
      "comments_count",
    ].join(",");
    interface IgMedia {
      id: string;
      caption?: string;
      media_type?: string;
      media_url?: string;
      thumbnail_url?: string;
      permalink?: string;
      timestamp?: string;
      like_count?: number;
      comments_count?: number;
    }
    const res = await this.fetchJson<{ data: IgMedia[] }>(
      `${GRAPH}/${igUserId}/media?fields=${encodeURIComponent(fields)}&limit=${limit}&access_token=${encodeURIComponent(token)}`,
      { method: "GET" },
    );
    await this.prisma.integration.updateMany({
      where: { workspaceId, platform: "instagram" },
      data: { lastFetchedAt: new Date() },
    });
    return (res.data ?? []).map((m) => ({
      id: m.id,
      body: m.caption ?? "",
      mediaUrl:
        m.media_type === "VIDEO" ? m.thumbnail_url ?? m.media_url : m.media_url,
      attachmentType: m.media_type?.toLowerCase(),
      permalink: m.permalink,
      createdAt: m.timestamp,
      likes: m.like_count ?? 0,
      comments: m.comments_count ?? 0,
      shares: 0,
    }));
  }

  /** Fetch comments on a single IG media item. */
  async listComments(workspaceId: string, mediaId: string, limit = 25) {
    const { token } = await this.requireToken(workspaceId);
    interface IgComment {
      id: string;
      text?: string;
      username?: string;
      timestamp?: string;
      like_count?: number;
      replies?: { data: Array<{ id: string }> };
    }
    const res = await this.fetchJson<{ data: IgComment[] }>(
      `${GRAPH}/${mediaId}/comments?fields=id,text,username,timestamp,like_count,replies&limit=${limit}&access_token=${encodeURIComponent(token)}`,
      { method: "GET" },
    );
    return (res.data ?? []).map((c) => ({
      id: c.id,
      author: c.username ?? "instagram_user",
      authorId: undefined as string | undefined,
      body: c.text ?? "",
      likes: c.like_count ?? 0,
      at: c.timestamp ?? "",
      replyCount: c.replies?.data?.length ?? 0,
    }));
  }

  /**
   * Post a top-level comment to an IG media item via Graph. Used by the
   * Social tab composer. Returns the new comment id so the frontend can
   * swap in the real id over its optimistic placeholder.
   */
  async commentOnMedia(workspaceId: string, mediaId: string, message: string) {
    const { token } = await this.requireToken(workspaceId);
    const url =
      `${GRAPH}/${mediaId}/comments?` +
      new URLSearchParams({ message, access_token: token }).toString();
    const res = await this.fetchJson<{ id: string }>(url, { method: "POST" });
    return { id: res.id, ok: true as const };
  }

  /**
   * Live IG conversation list — same shape FB exposes. Pulls straight from
   * Graph each call so the Inbox doesn't depend on a DB sync to surface
   * inbound DMs. We prefix the IG thread id with `ig:` so the frontend can
   * tell it apart from FB Messenger threads (Graph uses the same `t_...`
   * format for both).
   */
  async listConversations(workspaceId: string, limit = 25) {
    const { token, igUserId } = await this.requireToken(workspaceId);
    const fb = await this.prisma.integration.findFirst({
      where: { workspaceId, platform: "facebook" },
    });
    if (!fb?.pageId) {
      throw new BadRequestException(
        "Facebook Page is not connected; Instagram DMs flow through the linked Page",
      );
    }
    const pageId = fb.pageId;
    interface IgConv {
      id: string;
      updated_time?: string;
      snippet?: string;
      unread_count?: number;
      message_count?: number;
      participants?: { data: Array<{ id: string; username?: string; name?: string }> };
    }
    const res = await this.fetchJson<{ data: IgConv[] }>(
      `${GRAPH}/${pageId}/conversations?platform=instagram&fields=id,updated_time,snippet,unread_count,message_count,participants&limit=${limit}&access_token=${encodeURIComponent(token)}`,
      { method: "GET" },
    );
    const rows = res.data ?? [];

    const contactByIgsid = new Map<string, string>();
    for (const c of rows) {
      const other = c.participants?.data.find((p) => p.id !== igUserId);
      if (!other?.id) continue;
      if (contactByIgsid.has(other.id)) continue;
      const displayName = other.username ?? other.name ?? `IG ${other.id.slice(-6)}`;
      const contact = await this.prisma.contact.upsert({
        where: {
          workspaceId_externalSource_externalId: {
            workspaceId,
            externalSource: "instagram",
            externalId: other.id,
          },
        },
        create: {
          workspaceId,
          name: displayName,
          industry: "instagram",
          lifecycle: "lead",
          source: "instagram",
          lastSeen: this.fmtCompact(c.updated_time),
          externalSource: "instagram",
          externalId: other.id,
        },
        update: {
          name: other.username ? other.username : undefined,
          lastSeen: this.fmtCompact(c.updated_time),
        },
      });
      contactByIgsid.set(other.id, contact.id);
    }

    await this.prisma.integration.updateMany({
      where: { workspaceId, platform: "instagram" },
      data: { lastFetchedAt: new Date() },
    });

    return rows.map((c) => {
      const other = c.participants?.data.find((p) => p.id !== igUserId);
      const dbContactId = other?.id ? contactByIgsid.get(other.id) : undefined;
      return {
        // ig: prefix lets the Inbox distinguish IG live threads from FB ones.
        id: `ig:${c.id}`,
        contactId: dbContactId,
        contactIgsid: other?.id,
        contactName: other?.username ?? other?.name ?? "Instagram user",
        snippet: c.snippet ?? "",
        unread: c.unread_count ?? 0,
        messageCount: c.message_count ?? 0,
        updatedAt: c.updated_time ?? new Date().toISOString(),
      };
    });
  }

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

  /** Live messages for a single IG thread. The id arrives without the
   *  `ig:` prefix (controller strips it before calling). Single Graph call
   *  with field expansion — splitting it into N+1 calls per message took
   *  long enough that the frontend's 3s poll kept aborting in-flight requests. */
  async listMessagesInConversation(
    workspaceId: string,
    conversationId: string,
    limit = 25,
  ) {
    const { token, igUserId } = await this.requireToken(workspaceId);
    interface IgMessage {
      id: string;
      from?: { id: string; username?: string };
      message?: string;
      created_time: string;
    }
    const res = await this.fetchJson<{ messages?: { data: IgMessage[] } }>(
      `${GRAPH}/${conversationId}?fields=messages.limit(${limit}){id,from,message,created_time}&access_token=${encodeURIComponent(token)}`,
      { method: "GET" },
    );
    const raw = res.messages?.data ?? [];
    // Graph returns most-recent first; reverse so the UI renders oldest-first.
    const ordered = [...raw].reverse();
    return ordered.map((m) => ({
      id: m.id,
      from: m.from?.id === igUserId ? "page" : "them",
      authorName: m.from?.username ?? m.from?.id ?? "Unknown",
      body: m.message ?? "",
      at: m.created_time,
    }));
  }

  /** Send an outbound DM to a specific IGSID without needing an existing
   *  internal Conversation row. Mirrors the FB sendDirectMessage path. */
  async sendDirectMessage(
    workspaceId: string,
    igsid: string,
    message: string,
    mediaId?: string,
  ) {
    const { token } = await this.requireToken(workspaceId);
    const fb = await this.prisma.integration.findFirst({
      where: { workspaceId, platform: "facebook" },
    });
    if (!fb?.pageId) {
      throw new BadRequestException("Facebook Page is not connected");
    }
    const url = `${GRAPH}/${fb.pageId}/messages?access_token=${encodeURIComponent(token)}`;

    // Same pattern as the FB send path — image and text go in separate calls.
    if (mediaId) {
      const imageUrl = await this.media.resolveExternalUrl(workspaceId, mediaId, 60 * 60);
      await this.fetchJson<{ message_id?: string }>(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: { id: igsid },
          message: {
            attachment: {
              type: "image",
              payload: { url: imageUrl, is_reusable: false },
            },
          },
          messaging_type: "RESPONSE",
        }),
      });
    }

    let messageId: string | undefined;
    if (message && message.trim().length > 0) {
      const res = await this.fetchJson<{ message_id?: string; recipient_id?: string }>(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: { id: igsid },
          message: { text: message },
          messaging_type: "RESPONSE",
        }),
      });
      messageId = res.message_id;
    }
    return { ok: true as const, messageId };
  }

  async deleteComment(workspaceId: string, commentId: string) {
    const { token } = await this.requireToken(workspaceId);
    const url = `${GRAPH}/${commentId}?access_token=${encodeURIComponent(token)}`;
    const res = await this.fetchJson<{ success: boolean }>(url, { method: "DELETE" });
    return { ok: res.success === true };
  }

  async deletePost(workspaceId: string, mediaId: string) {
    const { token } = await this.requireToken(workspaceId);
    const url = `${GRAPH}/${mediaId}?access_token=${encodeURIComponent(token)}`;
    const res = await this.fetchJson<{ success: boolean }>(url, { method: "DELETE" });
    return { ok: res.success === true };
  }

  async editCaption(workspaceId: string, mediaId: string, caption: string) {
    const { token } = await this.requireToken(workspaceId);
    const url =
      `${GRAPH}/${mediaId}?` +
      new URLSearchParams({ caption, access_token: token }).toString();
    const res = await this.fetchJson<{ success?: boolean; id?: string }>(url, { method: "POST" });
    return { ok: res.success !== false, id: res.id ?? mediaId };
  }

  /**
   * Pulls all Instagram DM threads for the connected IG Business account
   * and mirrors them into the local Conversation / Message tables so the
   * unified Inbox can display them.  Idempotent: each call wipes IG messages
   * for this workspace, then re-inserts from Graph.
   */
  async syncConversations(workspaceId: string) {
    const { token, igUserId } = await this.requireToken(workspaceId);

    // The /conversations endpoint for IG DMs is on the FB Page, scoped via
    // `?platform=instagram`. So we need the Page ID, not the IG User ID.
    const fb = await this.prisma.integration.findFirst({
      where: { workspaceId, platform: "facebook" },
    });
    if (!fb?.pageId) {
      throw new BadRequestException(
        "Facebook Page is not connected; Instagram DMs flow through the linked Page",
      );
    }
    const pageId = fb.pageId;

    interface IgParticipant { id: string; username?: string }
    interface IgConversation {
      id: string;
      participants?: { data: IgParticipant[] };
      updated_time?: string;
    }
    interface IgMessage {
      id: string;
      message?: string;
      from?: IgParticipant;
      created_time: string;
    }

    const convsRes = await this.fetchJson<{ data: IgConversation[] }>(
      `${GRAPH}/${pageId}/conversations?platform=instagram&fields=id,participants,updated_time&access_token=${encodeURIComponent(token)}`,
      { method: "GET" },
    );

    let conversationsTouched = 0;
    let messagesInserted = 0;

    for (const conv of convsRes.data ?? []) {
      const other = conv.participants?.data?.find((p) => p.id !== igUserId);
      if (!other) continue;
      const displayName = other.username ?? `IG ${other.id.slice(-6)}`;

      // Upsert Contact (per IG participant)
      const contact = await this.prisma.contact.upsert({
        where: {
          workspaceId_externalSource_externalId: {
            workspaceId,
            externalSource: "instagram",
            externalId: other.id,
          },
        },
        create: {
          workspaceId,
          name: displayName,
          industry: "instagram",
          lifecycle: "lead",
          source: "instagram",
          lastSeen: "now",
          externalSource: "instagram",
          externalId: other.id,
        },
        update: { name: displayName, lastSeen: "now" },
      });

      // Find or create the local Conversation for this contact + channel.
      let dbConv = await this.prisma.conversation.findFirst({
        where: { workspaceId, contactId: contact.id, channel: "instagram" },
      });
      if (!dbConv) {
        dbConv = await this.prisma.conversation.create({
          data: {
            workspaceId,
            contactId: contact.id,
            agent: "",
            unread: 0,
            pinned: false,
            lastAt: "now",
            lastFrom: "them",
            preview: "",
            channel: "instagram",
            status: "human",
            intent: "—",
            confidence: 0,
          },
        });
      }
      conversationsTouched++;

      // Fetch this conversation's messages (newest-first per Graph default).
      const msgsRes = await this.fetchJson<{
        messages?: { data: IgMessage[] };
      }>(
        `${GRAPH}/${conv.id}?fields=messages{id,from,message,created_time}&access_token=${encodeURIComponent(token)}`,
        { method: "GET" },
      );
      const rawMsgs = msgsRes.messages?.data ?? [];

      // Wipe + reinsert IG messages for this conversation (idempotent refresh).
      await this.prisma.message.deleteMany({
        where: { workspaceId, conversationId: dbConv.id },
      });

      // Insert in chronological order (Graph returns newest-first).
      const ordered = [...rawMsgs].reverse();
      for (const m of ordered) {
        const createdAt = new Date(m.created_time);
        const d = isNaN(createdAt.getTime()) ? new Date() : createdAt;
        const t = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
        const fromUs = m.from?.id === igUserId;
        await this.prisma.message.create({
          data: {
            workspaceId,
            conversationId: dbConv.id,
            from: fromUs ? "human" : "them",
            body: m.message ?? "[attachment]",
            t,
            createdAt: d,
          },
        });
        messagesInserted++;
      }

      // Update conversation preview/timestamps from the latest message.
      const latest = ordered[ordered.length - 1];
      if (latest) {
        await this.prisma.conversation.update({
          where: { id: dbConv.id },
          data: {
            preview: (latest.message ?? "[attachment]").slice(0, 140),
            lastAt: "now",
            lastFrom: latest.from?.id === igUserId ? "human" : "them",
          },
        });
      }
    }

    // Mark the integration as freshly synced.
    await this.prisma.integration.updateMany({
      where: { workspaceId, platform: "instagram" },
      data: { lastFetchedAt: new Date() },
    });

    return {
      ok: true,
      conversations: conversationsTouched,
      messages: messagesInserted,
    };
  }

  /**
   * Send an outbound Instagram DM in an existing conversation.  Uses the
   * FB Page's `/messages` endpoint with platform=instagram routing.  Writes
   * the message into our own DB so the Inbox reflects it immediately.
   */
  async sendInConversation(
    workspaceId: string,
    conversationId: string,
    message: string,
    mediaId?: string,
  ) {
    const { token } = await this.requireToken(workspaceId);

    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, workspaceId, channel: "instagram" },
      include: { contact: true },
    });
    if (!conv) throw new NotFoundException("Instagram conversation not found");
    const recipientIgsid = conv.contact.externalId;
    if (!recipientIgsid) {
      throw new BadRequestException("Recipient Instagram-scoped ID missing on contact");
    }

    const fb = await this.prisma.integration.findFirst({
      where: { workspaceId, platform: "facebook" },
    });
    if (!fb?.pageId) {
      throw new BadRequestException("Facebook Page is not connected");
    }

    const url = `${GRAPH}/${fb.pageId}/messages?access_token=${encodeURIComponent(token)}`;

    if (mediaId) {
      const imageUrl = await this.media.resolveExternalUrl(workspaceId, mediaId, 60 * 60);
      await this.fetchJson<{ message_id?: string }>(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: { id: recipientIgsid },
          message: {
            attachment: {
              type: "image",
              payload: { url: imageUrl, is_reusable: false },
            },
          },
          messaging_type: "RESPONSE",
        }),
      });
    }

    let messageId: string | undefined;
    if (message && message.trim().length > 0) {
      const res = await this.fetchJson<{ message_id?: string; recipient_id?: string }>(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: { id: recipientIgsid },
          message: { text: message },
          messaging_type: "RESPONSE",
        }),
      });
      messageId = res.message_id;
    }

    // Mirror into our DB so the UI updates immediately.
    const now = new Date();
    const t = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const previewBody =
      message && message.trim().length > 0 ? message : "[image]";
    await this.prisma.message.create({
      data: {
        workspaceId,
        conversationId,
        from: "human",
        body: previewBody,
        t,
        attach: mediaId ?? null,
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

    return { ok: true, messageId };
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private async waitForContainerReady(containerId: string, token: string): Promise<void> {
    const maxAttempts = 15; // ~30 seconds (2s sleeps)
    for (let i = 0; i < maxAttempts; i++) {
      let st: { status_code?: string; status?: string } = {};
      try {
        st = await this.fetchJson<{ status_code?: string; status?: string }>(
          `${GRAPH}/${containerId}?fields=status_code,status&access_token=${encodeURIComponent(token)}`,
          { method: "GET" },
        );
      } catch (e) {
        this.log.warn(`Container poll ${containerId} threw: ${(e as Error).message}`);
      }
      if (st.status_code === "FINISHED") return;
      if (st.status_code === "ERROR" || st.status_code === "EXPIRED") {
        throw new HttpException(`Instagram container ${containerId} ${st.status_code}: ${st.status ?? ""}`, 400);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new HttpException(`Instagram container ${containerId} did not finish within timeout`, 504);
  }

  private async find(workspaceId: string) {
    return this.prisma.integration.findFirst({
      where: { workspaceId, platform: "instagram" },
    });
  }

  private async requireToken(workspaceId: string): Promise<{ token: string; igUserId: string }> {
    const integ = await this.find(workspaceId);
    if (!integ?.accessToken || !integ.pageId) {
      throw new NotFoundException("Instagram is not connected");
    }
    return { token: integ.accessToken, igUserId: integ.pageId };
  }

  private async fetchJson<T>(url: string, init: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (e) {
      this.log.error(`IG Graph network error: ${(e as Error).message}`);
      throw new HttpException("Instagram Graph unreachable", 502);
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
          // @ts-expect-error - Graph shape
          ? (parsed.error?.message as string) ?? `IG error ${res.status}`
          : `IG error ${res.status}`;
      this.log.warn(`IG ${init.method} ${url} -> ${res.status} ${errMsg}`);
      throw new HttpException(errMsg, res.status >= 500 ? 502 : 400);
    }
    return parsed as T;
  }
}
