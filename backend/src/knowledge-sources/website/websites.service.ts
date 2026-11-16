/**
 * SP-21 website sources: check, add, change schedule / pause, refresh.
 * Every route is workspace-scoped (foreign id → 404 `knowledge.not_found`).
 */
import { Inject, Injectable, Optional } from "@nestjs/common";
import { isIP } from "node:net";
import { PrismaService } from "../../prisma/prisma.service";
import { checkedAddress, defaultDeps, fetchPublic, PublicFetchError, type PageFetchDeps } from "../../common/public-fetch";
import { CRAWL_UA, REFRESH_COOLDOWN_MS, SCHEDULES, WEBSITE_FETCH_TIMEOUT_MS, WEBSITE_MAX_SOURCES } from "../knowledge-constants";
import { knowledgeError } from "../knowledge-errors";
import { KnowledgeSourcesService } from "../knowledge-sources.service";
import type { KnowledgeSourceDto } from "../knowledge-sources.dto";
import { WEBSITE_FETCH_DEPS, WEBSITE_STALE_MS } from "./crawl-runner";
import { CrawlScheduler } from "./crawl.scheduler";
import { parseRobots, robotsAllows, ALLOW_ALL, type RobotsRules } from "./robots";
import { sitemapLocs } from "./discover";
import { bareHost, normalizeInputUrl, sameOrigin, siteOf, urlKey, type WebsiteScope } from "./website-url";
import { nextRunAt, type ScheduleKind } from "./schedule";

export interface WebsiteCheckDto {
  ok: true;
  normalizedUrl: string;
  host: string;
  robotsAllowed: boolean;
  sitemapPages: number | null;
}

const isSchedule = (v: unknown): v is ScheduleKind => typeof v === "string" && (SCHEDULES as readonly string[]).includes(v);

@Injectable()
export class WebsitesService {
  private readonly fetchDeps: PageFetchDeps;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sources: KnowledgeSourcesService,
    private readonly scheduler: CrawlScheduler,
    @Optional() @Inject(WEBSITE_FETCH_DEPS) fetchDeps?: PageFetchDeps,
  ) {
    this.fetchDeps = fetchDeps ?? defaultDeps();
  }

  /**
   * Normalise and vet a URL: https (an `http:` address is upgraded and must
   * answer over https → else `knowledge.not_https`), no IP literal, no local
   * or private host (`knowledge.url_blocked`), not a web address at all →
   * `knowledge.url_invalid`. Reads robots.txt and the sitemap (count only).
   */
  async check(rawUrl: unknown): Promise<WebsiteCheckDto> {
    const input = normalizeInputUrl(typeof rawUrl === "string" ? rawUrl : "");
    if (!input) throw knowledgeError("knowledge.url_invalid");
    const { url, wasHttp } = input;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || !host.includes(".")) {
      throw knowledgeError("knowledge.url_blocked");
    }
    try {
      await checkedAddress(url, this.fetchDeps);
    } catch (e) {
      if (e instanceof PublicFetchError && e.code === "url_blocked") throw knowledgeError("knowledge.url_blocked");
      throw knowledgeError(wasHttp ? "knowledge.not_https" : "knowledge.url_invalid");
    }
    const site = siteOf(url, "site");
    // The start page must answer over https.
    try {
      const res = await fetchPublic(
        url.toString(),
        { accept: ["text/html", "text/plain"], timeoutMs: WEBSITE_FETCH_TIMEOUT_MS, userAgent: CRAWL_UA, returnErrorStatus: true, followRedirect: (_f, to) => sameOrigin(site, to) },
        this.fetchDeps,
      );
      if (res.status >= 500 || res.status === 0) throw new PublicFetchError("fetch_failed");
    } catch (e) {
      if (e instanceof PublicFetchError && e.code === "url_blocked") throw knowledgeError("knowledge.url_blocked");
      throw knowledgeError("knowledge.not_https");
    }
    const robots = await this.robots(url);
    return {
      ok: true,
      normalizedUrl: url.toString(),
      host: bareHost(url.hostname),
      robotsAllowed: robotsAllows(robots, url.pathname + url.search),
      sitemapPages: await this.sitemapCount(url),
    };
  }

  private async robots(url: URL): Promise<RobotsRules> {
    try {
      const res = await fetchPublic(
        `https://${url.hostname}/robots.txt`,
        { accept: ["text/plain", "text/html", "application/octet-stream"], timeoutMs: WEBSITE_FETCH_TIMEOUT_MS, userAgent: CRAWL_UA, returnErrorStatus: true },
        this.fetchDeps,
      );
      return res.status >= 200 && res.status < 300 ? parseRobots(res.body) : ALLOW_ALL;
    } catch {
      return ALLOW_ALL;
    }
  }

  private async sitemapCount(url: URL): Promise<number | null> {
    try {
      const res = await fetchPublic(
        `https://${url.hostname}/sitemap.xml`,
        { accept: ["application/xml", "text/xml", "text/plain"], timeoutMs: WEBSITE_FETCH_TIMEOUT_MS, userAgent: CRAWL_UA, returnErrorStatus: true },
        this.fetchDeps,
      );
      if (res.status < 200 || res.status >= 300) return null;
      return sitemapLocs(res.body).length;
    } catch {
      return null;
    }
  }

  /** Add a website source (≤ WEBSITE_MAX_SOURCES per workspace); its first run starts now. */
  async create(workspaceId: string, userId: string | null, body: { url?: unknown; scope?: unknown; schedule?: unknown }): Promise<KnowledgeSourceDto> {
    const scope = (body.scope ?? "site") as WebsiteScope;
    if (scope !== "site" && scope !== "path") throw knowledgeError("knowledge.url_invalid", { field: "scope" });
    const schedule = body.schedule === undefined ? "weekly" : body.schedule;
    if (!isSchedule(schedule)) throw knowledgeError("knowledge.url_invalid", { field: "schedule" });
    const checked = await this.check(body.url);
    const start = new URL(checked.normalizedUrl);
    const key = `${scope}:${urlKey(start)}`;
    const now = new Date();
    const id = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`knowledge:website:${workspaceId}`}))`;
      const sites = await tx.knowledgeSource.findMany({ where: { workspaceId, kind: "website" }, select: { url: true, scope: true } });
      if (sites.length >= WEBSITE_MAX_SOURCES) throw knowledgeError("knowledge.website_limit", { limit: WEBSITE_MAX_SOURCES });
      if (sites.some((s) => s.url && `${s.scope ?? "site"}:${urlKey(new URL(s.url))}` === key)) throw knowledgeError("knowledge.website_exists");
      const row = await tx.knowledgeSource.create({
        data: {
          workspaceId,
          kind: "website",
          status: "queued",
          title: checked.host,
          url: start.toString(),
          scope,
          schedule,
          nextSyncAt: now,
          createdById: userId,
        },
      });
      return row.id;
    });
    this.scheduler.kick(id, workspaceId);
    return this.sources.get(workspaceId, id);
  }

  private async loadWebsite(workspaceId: string, id: string) {
    const row = await this.prisma.knowledgeSource.findFirst({ where: { id: String(id ?? ""), workspaceId, kind: "website" } });
    if (!row) throw knowledgeError("knowledge.not_found");
    return row;
  }

  /** Change the schedule and/or pause or resume (optimistic `version`). */
  async patch(workspaceId: string, id: string, body: { schedule?: unknown; paused?: unknown; version?: unknown }): Promise<KnowledgeSourceDto> {
    const row = await this.loadWebsite(workspaceId, id);
    const data: Record<string, unknown> = {};
    const schedule = body.schedule === undefined ? (row.schedule as ScheduleKind) : body.schedule;
    if (!isSchedule(schedule)) throw knowledgeError("knowledge.url_invalid", { field: "schedule" });
    if (body.schedule !== undefined) data.schedule = schedule;
    if (body.paused === true) {
      data.status = "paused";
      data.nextSyncAt = null;
    } else if (body.paused === false || body.schedule !== undefined) {
      if (row.status === "paused" || body.schedule !== undefined) {
        if (row.status === "paused") data.status = row.lastSyncAt ? "ready" : "queued";
        data.nextSyncAt = (data.status ?? row.status) === "failed" ? null : nextRunAt(schedule, new Date());
      }
    }
    const r = await this.prisma.knowledgeSource.updateMany({
      where: { id: row.id, workspaceId, version: Number(body.version) },
      data: { ...data, version: { increment: 1 } },
    });
    if (r.count !== 1) throw knowledgeError("knowledge.version_conflict", { current: await this.sources.get(workspaceId, row.id) });
    return this.sources.get(workspaceId, row.id);
  }

  /**
   * Refresh now. 409 `knowledge.syncing` while a run holds a fresh lease;
   * 409 `knowledge.cooldown {retryAfterSeconds}` within REFRESH_COOLDOWN_MS
   * of the last refresh. A failed source may be refreshed (a success resets it).
   */
  async refresh(workspaceId: string, id: string, now = new Date()): Promise<KnowledgeSourceDto> {
    const row = await this.loadWebsite(workspaceId, id);
    if (row.syncStartedAt && row.syncStartedAt.getTime() > now.getTime() - WEBSITE_STALE_MS) throw knowledgeError("knowledge.syncing");
    if (row.refreshRequestedAt) {
      const wait = row.refreshRequestedAt.getTime() + REFRESH_COOLDOWN_MS - now.getTime();
      if (wait > 0) throw knowledgeError("knowledge.cooldown", { retryAfterSeconds: Math.ceil(wait / 1000) });
    }
    if (row.status === "paused") throw knowledgeError("knowledge.syncing");
    const r = await this.prisma.knowledgeSource.updateMany({
      where: {
        id: row.id,
        workspaceId,
        OR: [{ refreshRequestedAt: null }, { refreshRequestedAt: { lte: new Date(now.getTime() - REFRESH_COOLDOWN_MS) } }],
      },
      data: { refreshRequestedAt: now, nextSyncAt: now },
    });
    if (r.count !== 1) throw knowledgeError("knowledge.cooldown", { retryAfterSeconds: Math.ceil(REFRESH_COOLDOWN_MS / 1000) });
    this.scheduler.kick(row.id, workspaceId);
    return this.sources.get(workspaceId, row.id);
  }
}
