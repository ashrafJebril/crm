import { Injectable } from "@nestjs/common";
import type { KnowledgeSourceDto } from "../knowledge-sources.dto";
import { LKnowledge, toCrm, type LSource } from "../l-knowledge";

export interface WebsiteCheckDto {
  ok: true;
  normalizedUrl: string;
  host: string;
  robotsAllowed: boolean;
  sitemapPages: number | null;
}

/** Website sources, crawled and scheduled on l (see l-knowledge.ts). */
@Injectable()
export class WebsitesService {
  constructor(private readonly l: LKnowledge) {}

  async check(workspaceId: string, url: unknown): Promise<WebsiteCheckDto> {
    const t = await this.l.require(workspaceId);
    return this.l.call<WebsiteCheckDto>(t, "/websites/check", { method: "POST", body: { url: typeof url === "string" ? url : "" }, timeoutMs: 30_000 });
  }

  /** Add a website; its first run starts now. `firstRunPageCap` caps that run (onboarding). */
  async create(
    workspaceId: string,
    _userId: string | null,
    body: { url?: unknown; scope?: unknown; schedule?: unknown },
    opts: { firstRunPageCap?: number } = {},
  ): Promise<KnowledgeSourceDto> {
    const t = await this.l.require(workspaceId);
    const res = await this.l.call<LSource>(t, "/websites", {
      method: "POST",
      body: {
        url: typeof body.url === "string" ? body.url : "",
        ...(body.scope !== undefined ? { scope: body.scope } : {}),
        ...(body.schedule !== undefined ? { schedule: body.schedule } : {}),
        ...(opts.firstRunPageCap ? { firstRunPageCap: opts.firstRunPageCap } : {}),
      },
      timeoutMs: 30_000,
    });
    return toCrm(res);
  }

  async patch(workspaceId: string, id: string, body: { schedule?: unknown; paused?: unknown; version?: unknown }): Promise<KnowledgeSourceDto> {
    const t = await this.l.require(workspaceId);
    return toCrm(await this.l.call<LSource>(t, `/websites/${encodeURIComponent(id)}`, { method: "PATCH", body }));
  }

  async refresh(workspaceId: string, id: string): Promise<KnowledgeSourceDto> {
    const t = await this.l.require(workspaceId);
    return toCrm(await this.l.call<LSource>(t, `/websites/${encodeURIComponent(id)}/refresh`, { method: "POST" }));
  }
}
