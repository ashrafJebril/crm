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
        "Instagram requires an image; text-only posts are not supported by the Graph API.",
      );
    }
    // Mint a 15-min public URL for Meta to fetch the image.
    const pubToken = await this.media.mintPublicToken(workspaceId, firstMediaId);
    const imageUrl = `${publicBaseUrl.replace(/\/$/, "")}/api/media/${firstMediaId}/public?token=${pubToken}`;

    // Step 1: create container
    const containerUrl =
      `${GRAPH}/${igUserId}/media?` +
      new URLSearchParams({
        image_url: imageUrl,
        caption: dto.content,
        access_token: token,
      }).toString();
    const container = await this.fetchJson<{ id: string }>(containerUrl, { method: "POST" });

    // Step 2: poll container (IG processes the image asynchronously)
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
  async sendInConversation(workspaceId: string, conversationId: string, message: string) {
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
    const res = await this.fetchJson<{ message_id?: string; recipient_id?: string }>(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientIgsid },
        message: { text: message },
        messaging_type: "RESPONSE",
      }),
    });

    // Mirror into our DB so the UI updates immediately.
    const now = new Date();
    const t = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    await this.prisma.message.create({
      data: {
        workspaceId,
        conversationId,
        from: "human",
        body: message,
        t,
      },
    });
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        preview: message.slice(0, 140),
        lastAt: "now",
        lastFrom: "human",
        unread: 0,
      },
    });

    return { ok: true, messageId: res.message_id };
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
