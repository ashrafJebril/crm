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
