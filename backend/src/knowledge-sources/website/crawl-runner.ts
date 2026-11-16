/**
 * SP-21 one website crawl run (R4, R8, Review Focus 1 and 2).
 *
 * Lease: a run claims the source by compare-and-set on `syncStartedAt`
 * (null, or older than WEBSITE_STALE_MS: the absolute cap of a run, separate
 * from the file processor's). The crawl itself reads into memory; the apply
 * phase is one transaction that first re-checks the lease, so a run that lost
 * it writes nothing.
 *
 * The crawler stays where it was told:
 *  - robots.txt is read once per run (our UA `KewyKnowledgeBot`, else `*`;
 *    longest match, Allow wins ties). 404 → allow all; any other failure
 *    (5xx, timeout, refused) → the run fails and nothing is removed;
 *  - only URLs of the site's origin (https, default port, `www.` folded) and,
 *    for scope `path`, under the start path are ever requested; a redirect
 *    leaving them is not followed and the page is `blocked`;
 *  - every request goes through the SSRF-guarded public fetcher (public
 *    addresses on every hop, DNS pinned);
 *  - ≥ 1 s between requests (`Crawl-delay` honoured up to 10 s), at most
 *    WEBSITE_PAGE_CAP pages (the rest `capped`, their chunks dropped), depth
 *    WEBSITE_LINK_DEPTH, WEBSITE_RUN_BUDGET_MS per run.
 *
 * Writes stay bounded however big the site is: at most SITEMAP_URL_CAP
 * in-scope sitemap URLs are collected; capped URLs get a row only when one
 * already exists (its chunks must go) or within the first CAPPED_ROW_SAMPLE,
 * and the full capped count is kept in `lastRun.pagesCapped`. The apply
 * transaction runs with an explicit APPLY_TX_TIMEOUT_MS / APPLY_TX_MAX_WAIT_MS
 * (Prisma's 5 s default would fail a large first sync every time). Chunk
 * re-creation stays inside it: that is what keeps it guarded by the lease.
 *
 * A failed run never deletes knowledge: a run that read no page fails and
 * changes no page; 401/403 keeps the last copy (`needs_login`); a page leaves
 * only after MAX_MISSED_RUNS complete runs without it (`removed`, chunks
 * dropped, row kept REMOVED_RETENTION_DAYS). Unchanged pages (same sha256)
 * keep their chunks.
 *
 * Three failed runs in a row → `failed`, schedule stopped, and every member
 * holding `knowledge.update` gets `knowledge_source_failed` (once per failing
 * run). Page text is reference data only: never logged, never instructions.
 */
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { createHash } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import { PermissionService } from "../../permissions/permission.service";
import { NotificationsService } from "../../notifications/notifications.service";
import { defaultDeps, fetchPublic, PublicFetchError, type PageFetchDeps, type PublicFetchResult } from "../../common/public-fetch";
import { htmlToText, plainText } from "../../catalog-import/html-to-text";
import { chunkText } from "../knowledge-chunker";
import {
  CRAWL_UA,
  MAX_CONSECUTIVE_FAILURES,
  MAX_MISSED_RUNS,
  REMOVED_RETENTION_DAYS,
  WEBSITE_FETCH_TIMEOUT_MS,
  WEBSITE_LINK_DEPTH,
  WEBSITE_PAGE_CAP,
  WEBSITE_PAGE_MAX_BYTES,
  WEBSITE_RUN_BUDGET_MS,
  WEBSITE_STALE_MS,
  type PageState,
} from "../knowledge-constants";
import type { KnowledgeSourceError } from "../knowledge-errors";
import { chunkRowsFor, KNOWLEDGE_PUBLISH_HOOK } from "../knowledge-processor";
import { ALLOW_ALL, parseRobots, robotsAllows, type RobotsRules } from "./robots";
import { isSitemapIndex, pageLinks, pageTitle, sitemapLocs } from "./discover";
import { inScope, sameOrigin, siteOf, urlKey, type Site, type WebsiteScope } from "./website-url";
import { nextRunAt, type ScheduleKind } from "./schedule";

export const WEBSITE_FETCH_DEPS = Symbol("WEBSITE_FETCH_DEPS");
export const CRAWL_SLEEP = Symbol("CRAWL_SLEEP");

/** A run that holds its lease longer than this is stale; another may take it over. */
export { WEBSITE_STALE_MS };
export const MIN_REQUEST_GAP_MS = 1000;
export const MAX_CRAWL_DELAY_MS = 10_000;
/** In-scope URLs collected from sitemaps per run; the rest are never queued. */
export const SITEMAP_URL_CAP = 1000;
/** Capped URLs that get a new row (a sample for the UI); the rest are only counted. */
export const CAPPED_ROW_SAMPLE = 20;
/** The apply transaction's limits (Prisma's interactive default is 5 s). */
export const APPLY_TX_TIMEOUT_MS = 30_000;
export const APPLY_TX_MAX_WAIT_MS = 10_000;
/** Characters of text kept per page. */
export const PAGE_TEXT_MAX = 200_000;
const HTML_TYPES = ["text/html", "text/plain"];
const XML_TYPES = ["application/xml", "text/xml", "text/plain"];

export interface PublishHook {
  /** After-commit, never throws (the publisher records its own failures). */
  schedule(sourceId: string): void;
}

/** One page's outcome in a run. */
interface PageOutcome {
  url: URL;
  key: string;
  state: PageState | "missing";
  httpStatus: number | null;
  title?: string | null;
  text?: string;
  hash?: string;
}

export interface RunSummary {
  startedAt: string;
  finishedAt: string;
  pagesRead: number;
  pagesSame: number;
  pagesChanged: number;
  pagesNew: number;
  /** URLs past WEBSITE_PAGE_CAP (only a sample of them has a row). */
  pagesCapped: number;
  failed: boolean;
  reason?: string;
}

class LeaseLost extends Error {}

@Injectable()
export class CrawlRunner {
  private readonly log = new Logger(CrawlRunner.name);
  private readonly fetchDeps: PageFetchDeps;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Overridable in specs. */
  protected budgetMs = WEBSITE_RUN_BUDGET_MS;

  constructor(
    private readonly prisma: PrismaService,
    private readonly perm: PermissionService,
    private readonly notifications: NotificationsService,
    @Optional() @Inject(WEBSITE_FETCH_DEPS) fetchDeps?: PageFetchDeps,
    @Optional() @Inject(CRAWL_SLEEP) sleep?: (ms: number) => Promise<void>,
    @Optional() @Inject(KNOWLEDGE_PUBLISH_HOOK) private readonly publisher?: PublishHook,
  ) {
    this.fetchDeps = fetchDeps ?? defaultDeps();
    this.sleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Claim the source's lease. Null when another run holds a fresh lease (or it is not a runnable website). */
  async claim(sourceId: string, now = new Date()): Promise<Date | null> {
    const r = await this.prisma.knowledgeSource.updateMany({
      where: {
        id: sourceId,
        kind: "website",
        status: { notIn: ["paused"] },
        OR: [{ syncStartedAt: null }, { syncStartedAt: { lt: new Date(now.getTime() - WEBSITE_STALE_MS) } }],
      },
      data: { syncStartedAt: now },
    });
    return r.count === 1 ? now : null;
  }

  /** Claim and run one crawl. Null when it could not be claimed. */
  async run(sourceId: string, now = new Date()): Promise<RunSummary | null> {
    const lease = await this.claim(sourceId, now);
    if (!lease) return null;
    const src = await this.prisma.knowledgeSource.findFirst({ where: { id: sourceId, kind: "website" } });
    if (!src?.url) {
      await this.release(sourceId, lease);
      return null;
    }
    let start: URL;
    try {
      start = new URL(src.url);
    } catch {
      return this.finishFailed(src, lease, "knowledge.site_unreachable", "invalid_url");
    }
    const site = siteOf(start, (src.scope as WebsiteScope) ?? "site");
    try {
      const robots = await this.readRobots(site);
      if (!robots) return await this.finishFailed(src, lease, "knowledge.site_unreachable", "robots_unreachable");
      const { outcomes, complete } = await this.crawl(site, robots, lease);
      const read = outcomes.filter((o) => o.state === "synced");
      if (read.length === 0) return await this.finishFailed(src, lease, "knowledge.no_pages", "no_pages");
      return await this.apply(src, lease, outcomes, complete);
    } catch (e) {
      if (e instanceof LeaseLost) return null;
      this.log.warn(`website source ${sourceId}: run crashed (${(e as Error)?.name ?? "error"})`);
      return this.finishFailed(src, lease, "knowledge.site_unreachable", "error").catch(() => null);
    }
  }

  private async release(sourceId: string, lease: Date) {
    await this.prisma.knowledgeSource.updateMany({ where: { id: sourceId, syncStartedAt: lease }, data: { syncStartedAt: null } });
  }

  // ── reading ───────────────────────────────────────────────────────────

  private async get(url: URL, accept: string[], site: Site): Promise<PublicFetchResult> {
    return fetchPublic(
      url.toString(),
      {
        accept,
        maxBytes: WEBSITE_PAGE_MAX_BYTES,
        timeoutMs: WEBSITE_FETCH_TIMEOUT_MS,
        userAgent: CRAWL_UA,
        returnErrorStatus: true,
        // Never leave the site (origin and path scope); the target is not requested.
        followRedirect: (_from, to) => inScope(site, to),
      },
      this.fetchDeps,
    );
  }

  /** robots.txt: 404/410 → allow all; parsed rules on 2xx; null (run fails) on anything else. */
  private async readRobots(site: Site): Promise<RobotsRules | null> {
    const url = new URL(`https://${site.start.hostname}/robots.txt`);
    try {
      const res = await fetchPublic(
        url.toString(),
        {
          accept: ["text/plain", "text/html", "application/octet-stream"],
          maxBytes: 512 * 1024,
          timeoutMs: WEBSITE_FETCH_TIMEOUT_MS,
          userAgent: CRAWL_UA,
          returnErrorStatus: true,
          followRedirect: (_f, to) => sameOrigin(site, to),
        },
        this.fetchDeps,
      );
      if (res.redirectRefused) return null;
      if (res.status === 404 || res.status === 410) return ALLOW_ALL;
      if (res.status >= 200 && res.status < 300) return parseRobots(res.body);
      return null;
    } catch {
      return null;
    }
  }

  private async sitemapUrls(site: Site, robots: RobotsRules): Promise<URL[]> {
    const candidates = [`https://${site.start.hostname}/sitemap.xml`, ...robots.sitemaps];
    const out: URL[] = [];
    const seen = new Set<string>();
    const queue = [...candidates];
    let fetched = 0;
    while (queue.length && fetched < 5 && out.length < SITEMAP_URL_CAP) {
      const raw = queue.shift() as string;
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        continue;
      }
      // A sitemap on another origin (a CDN) is never read.
      if (!sameOrigin(site, url) || seen.has(url.toString()) || !robotsAllows(robots, url.pathname + url.search)) continue;
      seen.add(url.toString());
      fetched += 1;
      await this.sleep(this.gap(robots));
      try {
        const res = await this.get(url, XML_TYPES, site);
        if (res.status < 200 || res.status >= 300 || res.redirectRefused) continue;
        const locs = sitemapLocs(res.body);
        if (isSitemapIndex(res.body)) queue.push(...locs);
        else
          for (const loc of locs) {
            if (out.length >= SITEMAP_URL_CAP) break;
            try {
              const u = new URL(loc);
              // Only in-scope URLs count towards the cap (the rest are never requested).
              if (inScope(site, u)) out.push(u);
            } catch {
              // skip
            }
          }
      } catch {
        // A missing or broken sitemap is not an error: links still lead the way.
      }
    }
    return out;
  }

  private gap(robots: RobotsRules): number {
    const delay = robots.crawlDelaySeconds === null ? 0 : Math.min(robots.crawlDelaySeconds * 1000, MAX_CRAWL_DELAY_MS);
    return Math.max(MIN_REQUEST_GAP_MS, delay);
  }

  /**
   * Breadth-first crawl in memory. `complete` is false when the run budget
   * ran out: such a run counts no page as missing.
   */
  private async crawl(site: Site, robots: RobotsRules, lease: Date): Promise<{ outcomes: PageOutcome[]; complete: boolean }> {
    const deadline = lease.getTime() + this.budgetMs;
    const outcomes = new Map<string, PageOutcome>();
    const queue: { url: URL; depth: number }[] = [{ url: site.start, depth: 0 }];
    for (const u of await this.sitemapUrls(site, robots)) queue.push({ url: u, depth: 1 });
    let fetched = 0;
    while (queue.length) {
      const { url, depth } = queue.shift() as { url: URL; depth: number };
      // Off-origin or out-of-scope URLs are never requested and get no row.
      if (!inScope(site, url)) continue;
      const key = urlKey(url);
      if (outcomes.has(key)) continue;
      if (Date.now() > deadline) return { outcomes: [...outcomes.values()], complete: false };
      if (fetched >= WEBSITE_PAGE_CAP) {
        outcomes.set(key, { url, key, state: "capped", httpStatus: null });
        continue;
      }
      if (!robotsAllows(robots, url.pathname + url.search)) {
        outcomes.set(key, { url, key, state: "blocked", httpStatus: null });
        continue;
      }
      if (fetched > 0) await this.sleep(this.gap(robots));
      fetched += 1;
      const outcome = await this.readPage(site, url, key);
      outcomes.set(key, outcome.page);
      if (depth < WEBSITE_LINK_DEPTH) for (const link of outcome.links) queue.push({ url: link, depth: depth + 1 });
    }
    return { outcomes: [...outcomes.values()], complete: true };
  }

  private async readPage(site: Site, url: URL, key: string): Promise<{ page: PageOutcome; links: URL[] }> {
    let res: PublicFetchResult;
    try {
      res = await this.get(url, HTML_TYPES, site);
    } catch (e) {
      const state: PageState = e instanceof PublicFetchError && e.code === "url_blocked" ? "blocked" : "error";
      return { page: { url, key, state, httpStatus: null }, links: [] };
    }
    if (res.redirectRefused) return { page: { url, key, state: "blocked", httpStatus: res.status }, links: [] };
    if (res.status === 401 || res.status === 403) return { page: { url, key, state: "needs_login", httpStatus: res.status }, links: [] };
    if (res.status === 404 || res.status === 410) return { page: { url, key, state: "missing", httpStatus: res.status }, links: [] };
    if (res.status === 451) return { page: { url, key, state: "blocked", httpStatus: res.status }, links: [] };
    if (res.status < 200 || res.status >= 300) return { page: { url, key, state: "error", httpStatus: res.status }, links: [] };
    const robotsTag = (res.headers["x-robots-tag"] ?? "").toLowerCase();
    if (/\bnoai\b|\bnoimageai\b/.test(robotsTag)) return { page: { url, key, state: "blocked", httpStatus: res.status }, links: [] };
    const html = res.contentType === "text/html";
    const text = html ? htmlToText(res.body, PAGE_TEXT_MAX) : plainText(res.body, PAGE_TEXT_MAX);
    const links = html ? pageLinks(res.body, res.url) : [];
    if (!text.trim()) return { page: { url, key, state: "error", httpStatus: res.status }, links };
    return {
      page: {
        url: res.url,
        key,
        state: "synced",
        httpStatus: res.status,
        title: html ? pageTitle(res.body) : null,
        text,
        hash: createHash("sha256").update(text).digest("hex"),
      },
      links,
    };
  }

  // ── writing ───────────────────────────────────────────────────────────

  private async apply(
    src: { id: string; workspaceId: string; schedule: string | null; title: string; consecutiveFailures: number },
    lease: Date,
    outcomes: PageOutcome[],
    complete: boolean,
  ): Promise<RunSummary> {
    const now = new Date();
    const summary: RunSummary = {
      startedAt: lease.toISOString(),
      finishedAt: now.toISOString(),
      pagesRead: 0,
      pagesSame: 0,
      pagesChanged: 0,
      pagesNew: 0,
      pagesCapped: outcomes.filter((o) => o.state === "capped").length,
      failed: false,
    };
    const ws = src.workspaceId;
    let cappedCreated = 0;
    await this.prisma.$transaction(async (tx) => {
      // Our lease, re-checked first: a run that lost it writes nothing.
      const mine = await tx.knowledgeSource.updateMany({ where: { id: src.id, syncStartedAt: lease }, data: { error: null } });
      if (mine.count !== 1) throw new LeaseLost();
      const existing = await tx.knowledgePage.findMany({ where: { workspaceId: ws, sourceId: src.id } });
      const byKey = new Map(existing.map((p) => [p.urlKey, p]));
      const touched = new Set<string>();
      const dropChunks = (pageId: string) => tx.knowledgeChunk.deleteMany({ where: { workspaceId: ws, sourceId: src.id, pageId } });

      for (const o of outcomes) {
        const prev = byKey.get(o.key);
        if (o.state === "missing") continue; // handled with the pages not seen below
        touched.add(o.key);
        const base = { url: o.url.toString(), state: o.state as PageState, httpStatus: o.httpStatus, lastSeenAt: now };
        if (o.state === "synced") {
          summary.pagesRead += 1;
          const same = !!prev && prev.contentHash === o.hash && prev.state === "synced";
          const data = { ...base, title: o.title ?? null, contentHash: o.hash, missedRuns: 0, lastReadAt: now, removedAt: null };
          let pageId: string;
          if (prev) {
            await tx.knowledgePage.update({ where: { id: prev.id }, data });
            pageId = prev.id;
          } else {
            pageId = (await tx.knowledgePage.create({ data: { workspaceId: ws, sourceId: src.id, urlKey: o.key, ...data } })).id;
          }
          if (same) {
            summary.pagesSame += 1;
            continue;
          }
          if (prev) summary.pagesChanged += 1;
          else summary.pagesNew += 1;
          await dropChunks(pageId);
          const chunks = chunkText(o.text ?? "", { heading: o.title ?? null });
          if (chunks.length) await tx.knowledgeChunk.createMany({ data: chunkRowsFor(ws, src.id, chunks, pageId) });
          continue;
        }
        // needs_login and error keep the last copy; blocked and capped drop it.
        const keep = o.state === "needs_login" || o.state === "error";
        if (prev) {
          await tx.knowledgePage.update({ where: { id: prev.id }, data: { ...base, missedRuns: 0, removedAt: null } });
          if (!keep) await dropChunks(prev.id);
        } else if (o.state !== "capped" || cappedCreated++ < CAPPED_ROW_SAMPLE) {
          // A capped URL without a row gets one only within the sample.
          await tx.knowledgePage.create({ data: { workspaceId: ws, sourceId: src.id, urlKey: o.key, ...base } });
        }
      }

      // Pages this complete run did not find (or that answered 404/410).
      for (const p of complete ? existing : []) {
        if (touched.has(p.urlKey) || p.state === "removed") continue;
        const missed = p.missedRuns + 1;
        if (missed >= MAX_MISSED_RUNS) {
          await tx.knowledgePage.update({ where: { id: p.id }, data: { state: "removed", missedRuns: missed, removedAt: now } });
          await dropChunks(p.id);
        } else {
          await tx.knowledgePage.update({ where: { id: p.id }, data: { missedRuns: missed } });
        }
      }
      // Removed pages are kept REMOVED_RETENTION_DAYS, then deleted.
      await tx.knowledgePage.deleteMany({
        where: { workspaceId: ws, sourceId: src.id, state: "removed", removedAt: { lt: new Date(now.getTime() - REMOVED_RETENTION_DAYS * 86_400_000) } },
      });

      const itemCount = await tx.knowledgeChunk.count({ where: { workspaceId: ws, sourceId: src.id } });
      await tx.knowledgeSource.updateMany({
        where: { id: src.id, syncStartedAt: lease },
        data: {
          status: "ready",
          error: null,
          consecutiveFailures: 0,
          lastSyncAt: now,
          nextSyncAt: nextRunAt(src.schedule as ScheduleKind, now),
          lastRun: summary as never,
          itemCount,
          syncStartedAt: null,
        },
      });
    }, { timeout: APPLY_TX_TIMEOUT_MS, maxWait: APPLY_TX_MAX_WAIT_MS });
    this.publisher?.schedule(src.id);
    return summary;
  }

  /**
   * A failed run changes no page. The counter goes up; at
   * MAX_CONSECUTIVE_FAILURES the source is `failed` with its schedule stopped,
   * and every failing run from then on notifies the members holding
   * `knowledge.update` (once per run: the run's start time is in the body).
   */
  private async finishFailed(
    src: { id: string; workspaceId: string; schedule: string | null; title: string; consecutiveFailures: number; lastSyncAt?: Date | null },
    lease: Date,
    error: KnowledgeSourceError,
    reason: string,
  ): Promise<RunSummary> {
    const now = new Date();
    const failures = src.consecutiveFailures + 1;
    const final = failures >= MAX_CONSECUTIVE_FAILURES;
    const summary: RunSummary = {
      startedAt: lease.toISOString(),
      finishedAt: now.toISOString(),
      pagesRead: 0,
      pagesSame: 0,
      pagesChanged: 0,
      pagesNew: 0,
      pagesCapped: 0,
      failed: true,
      reason,
    };
    const r = await this.prisma.knowledgeSource.updateMany({
      where: { id: src.id, syncStartedAt: lease },
      data: {
        consecutiveFailures: failures,
        error,
        lastRun: summary as never,
        syncStartedAt: null,
        ...(final
          ? { status: "failed", nextSyncAt: null }
          : { status: src.lastSyncAt ? "ready" : "queued", nextSyncAt: nextRunAt(src.schedule as ScheduleKind, now) }),
      },
    });
    if (r.count !== 1) throw new LeaseLost();
    this.log.warn(`website source ${src.id}: run failed (${reason}), ${failures} in a row`);
    if (final) {
      const members = await this.perm.membersWith(src.workspaceId, "knowledge.update");
      await this.notifications.notify(src.workspaceId, members, {
        type: "knowledge_source_failed",
        title: "knowledge.source_failed",
        body: JSON.stringify({ sourceId: src.id, sourceTitle: src.title, runStartedAt: lease.toISOString(), error }),
      });
    }
    return summary;
  }
}
