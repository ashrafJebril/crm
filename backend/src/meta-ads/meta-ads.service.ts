import { Injectable, Logger } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type { MetaAdsConnection } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { PermissionService } from "../permissions/permission.service";
import { safeTimeZone } from "../ad-attribution/ad-range";
import { frontendConnectionUrl, META_ADS_CHECK_COOLDOWN_MS, metaAdsApp, redirectUri } from "./meta-ads.config";
import { toMetaAdsDto, type MetaAdsConnectionDto } from "./meta-ads-dto";
import { metaAdsError, metaAdsErrorKey } from "./meta-ads-errors";
import { MetaAdsGraphClient, MetaAdsGraphError, type AdAccountRow, type PageRow } from "./meta-ads-graph.client";
import { MetaAdsNotifier } from "./meta-ads-notifier";
import { encryptMetaAdsToken, metaAdsEncryptionAvailable, readMetaAdsToken } from "./meta-ads-token";

/** The OAuth `state` JWT purpose. */
export const META_ADS_OAUTH_PURPOSE = "meta_ads_oauth";
/** Connect, choose, check and disconnect need this (ruling 7). */
export const META_ADS_MANAGE = "connectors.manage";
/** A user token shorter-lived than this is swapped for a long-lived one. */
const LONG_LIVED_BELOW_S = 2 * 86_400;

interface OAuthState {
  workspaceId: string;
  userId: string;
  nonce: string;
  purpose: string;
}

export interface Candidates {
  adAccounts: Array<{ id: string; name: string | null; currency: string | null; timezone: string | null; accountStatus: number | null }>;
  pages: PageRow[];
}

/** The OAuth callback's outcome: the frontend URL to redirect to. */
export type CallbackOutcome = { redirect: string };

/**
 * SP-15 Meta Ads connect (Architecture → Meta Ads connect). The token lives
 * only in `tokenEnc` / `pendingTokenEnc`, encrypted (`encryptMetaAdsToken`),
 * and every read goes through `readMetaAdsToken` (`decryptSecret`). No DTO,
 * error, redirect or log line carries a token.
 */
@Injectable()
export class MetaAdsService {
  private readonly log = new Logger(MetaAdsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly graph: MetaAdsGraphClient,
    private readonly permissions: PermissionService,
    private readonly notifier: MetaAdsNotifier,
  ) {}

  /** `GET /meta-ads/connection`. */
  async connection(workspaceId: string, viewerCanManage: boolean): Promise<MetaAdsConnectionDto> {
    const row = await this.prisma.metaAdsConnection.findUnique({ where: { workspaceId } });
    return this.toDto(row, viewerCanManage);
  }

  async toDto(row: MetaAdsConnection | null, viewerCanManage: boolean): Promise<MetaAdsConnectionDto> {
    let by: { id: string; name: string } | null = null;
    if (row?.connectedById) {
      const u = await this.prisma.user.findUnique({ where: { id: row.connectedById }, select: { id: true, name: true } });
      if (u) by = { id: u.id, name: u.name };
    }
    return toMetaAdsDto(row, viewerCanManage, by);
  }

  /** `GET /meta-ads/oauth/start` → the Login for Business dialog URL. */
  start(workspaceId: string, userId: string): { url: string } {
    const app = metaAdsApp();
    if (app.missing.length) throw metaAdsError("meta_ads.not_configured", { missing: app.missing });
    if (!metaAdsEncryptionAvailable()) throw metaAdsError("meta_ads.encryption_unavailable");
    const state = this.jwt.sign(
      { workspaceId, userId, nonce: randomBytes(16).toString("hex"), purpose: META_ADS_OAUTH_PURPOSE } satisfies OAuthState,
      { expiresIn: "10m" },
    );
    const params = new URLSearchParams({
      client_id: app.appId,
      redirect_uri: redirectUri(),
      config_id: app.configId,
      response_type: "code",
      state,
    });
    return { url: `https://www.facebook.com/${app.graphVersion}/dialog/oauth?${params.toString()}` };
  }

  /**
   * `GET /meta-ads/oauth/callback` (public). Verifies `state` (signature,
   * expiry, purpose) and that its user still holds `connectors.manage` in its
   * workspace, exchanges the code and stores the token encrypted in
   * `pendingTokenEnc` only (the active `tokenEnc` is untouched, so cancelling
   * a "Change" keeps the working connection). Never throws: every failure is
   * a redirect with an error key, never Meta's text.
   */
  async callback(q: { code?: string; state?: string; error?: string }): Promise<CallbackOutcome> {
    const fail = (code: string) => ({ redirect: frontendConnectionUrl({ metaAds: "error", code }) });
    const st = this.verifyState(q.state);
    if (!st) return fail("invalid_state");
    if (q.error) return fail("cancelled");
    if (!q.code || q.code.length > 2048) return fail("invalid_state");

    // A fresh read, not the guard's 30 s cache: a role removed since start must count.
    this.permissions.invalidate(st.workspaceId, st.userId);
    const eff = await this.permissions.effective(st.workspaceId, st.userId).catch(() => null);
    if (!this.permissions.can(eff, META_ADS_MANAGE)) {
      this.log.warn(`meta ads oauth callback refused: user lost ${META_ADS_MANAGE} ws=${st.workspaceId}`);
      return fail("forbidden");
    }
    if (metaAdsApp().missing.length) return fail("not_configured");
    if (!metaAdsEncryptionAvailable()) return fail("encryption_unavailable");

    let grant;
    try {
      grant = await this.graph.exchangeCode(q.code, redirectUri());
      if (grant.expiresIn !== null && grant.expiresIn < LONG_LIVED_BELOW_S) grant = await this.graph.exchangeLongLived(grant.token);
    } catch (e) {
      this.log.warn(`meta ads oauth exchange failed ws=${st.workspaceId} kind=${e instanceof MetaAdsGraphError ? e.kind : "error"}`);
      return fail("exchange_failed");
    }
    let enc: string;
    try {
      enc = encryptMetaAdsToken(grant.token);
    } catch (e) {
      return fail(metaAdsErrorKey(e) === "meta_ads.encryption_unavailable" ? "encryption_unavailable" : "exchange_failed");
    }
    const pendingExpiresAt = grant.expiresIn !== null ? new Date(Date.now() + grant.expiresIn * 1000) : null;
    try {
      await this.prisma.metaAdsConnection.upsert({
        where: { workspaceId: st.workspaceId },
        create: { workspaceId: st.workspaceId, status: "pending", pendingTokenEnc: enc, pendingExpiresAt },
        update: { pendingTokenEnc: enc, pendingExpiresAt },
      });
    } catch (e) {
      this.log.warn(`meta ads oauth store failed ws=${st.workspaceId}: ${(e as { code?: string })?.code ?? "error"}`);
      return fail("exchange_failed");
    }
    return { redirect: frontendConnectionUrl({ metaAds: "choose" }) };
  }

  private verifyState(state: string | undefined): OAuthState | null {
    if (!state || state.length > 4096) return null;
    try {
      const p = this.jwt.verify<OAuthState>(state);
      if (p?.purpose !== META_ADS_OAUTH_PURPOSE || typeof p.workspaceId !== "string" || !p.workspaceId) return null;
      if (typeof p.userId !== "string" || !p.userId) return null;
      return p;
    } catch {
      return null;
    }
  }

  /**
   * `GET /meta-ads/candidates`: the ad accounts and Pages the pending token
   * (or the active one with `use=active`) reaches. A login without `ads_read`
   * is 400 `meta_ads.no_ads_permission`.
   */
  async candidates(workspaceId: string, opts: { use?: string } = {}): Promise<Candidates> {
    const use = opts.use === "active" ? "active" : "pending";
    const row = await this.prisma.metaAdsConnection.findUnique({ where: { workspaceId } });
    const stored = use === "active" ? row?.tokenEnc : row?.pendingTokenEnc;
    if (!row || !stored) throw metaAdsError("meta_ads.not_exchanged");
    if (use === "pending" && row.pendingExpiresAt && row.pendingExpiresAt.getTime() <= Date.now()) {
      throw metaAdsError("meta_ads.login_expired");
    }
    const token = readMetaAdsToken(stored);
    if (!token) throw metaAdsError("meta_ads.reconnect", { token: use });
    return this.readCandidates(token, use);
  }

  private async readCandidates(token: string, use: "pending" | "active"): Promise<Candidates & { scopes: string[] }> {
    try {
      const scopes = await this.graph.permissions(token);
      if (!scopes.includes("ads_read")) throw metaAdsError("meta_ads.no_ads_permission");
      const adAccounts: AdAccountRow[] = await this.graph.adAccounts(token);
      let pages: PageRow[] = [];
      try {
        pages = await this.graph.pages(token);
      } catch (e) {
        // A login without Page access still connects ads (the Page is optional).
        if (!(e instanceof MetaAdsGraphError) || e.kind !== "refused") throw e;
      }
      return { adAccounts, pages, scopes };
    } catch (e) {
      throw this.interactiveError(e, use);
    }
  }

  private interactiveError(e: unknown, use: "pending" | "active"): unknown {
    if (!(e instanceof MetaAdsGraphError)) return e;
    if (e.kind === "token") return metaAdsError("meta_ads.reconnect", { token: use });
    return metaAdsError("meta_ads.meta_refused", { graphCode: e.code });
  }

  /**
   * `POST /meta-ads/connection`: checks the ids against a fresh candidates
   * read, then promotes `pendingTokenEnc → tokenEnc` in one conditional
   * update on the pending value it read (409 `meta_ads.connection_changed`
   * when another login replaced it meanwhile). The connection becomes
   * `active` with `syncAttemptedAt` null, so the next hourly sweep picks it
   * up first.
   */
  async save(workspaceId: string, userId: string, body: { adAccountId?: unknown; pageId?: unknown }): Promise<MetaAdsConnectionDto> {
    const adAccountId = typeof body?.adAccountId === "string" ? body.adAccountId.trim() : "";
    const pageId = body?.pageId == null || body.pageId === "" ? null : typeof body.pageId === "string" ? body.pageId.trim() : String(body.pageId);
    const bad = [
      ...(/^act_\d{1,32}$/.test(adAccountId) ? [] : [adAccountId.slice(0, 64)]),
      ...(pageId === null || /^\d{1,32}$/.test(pageId) ? [] : [pageId.slice(0, 64)]),
    ];
    if (bad.length) throw metaAdsError("meta_ads.unknown_asset", { ids: bad });

    const row = await this.prisma.metaAdsConnection.findUnique({ where: { workspaceId } });
    const seen = row?.pendingTokenEnc ?? null;
    if (!row || !seen) throw metaAdsError("meta_ads.not_exchanged");
    if (row.pendingExpiresAt && row.pendingExpiresAt.getTime() <= Date.now()) throw metaAdsError("meta_ads.login_expired");
    const token = readMetaAdsToken(seen);
    if (!token) throw metaAdsError("meta_ads.reconnect", { token: "pending" });

    const fresh = await this.readCandidates(token, "pending");
    const account = fresh.adAccounts.find((a) => a.id === adAccountId);
    const page = pageId === null ? null : fresh.pages.find((p) => p.id === pageId);
    const unknown = [...(account ? [] : [adAccountId]), ...(pageId !== null && !page ? [pageId] : [])];
    if (unknown.length) throw metaAdsError("meta_ads.unknown_asset", { ids: unknown });

    const sameAccount = row.adAccountId === adAccountId;
    const now = new Date();
    const won = await this.prisma.metaAdsConnection.updateMany({
      where: { workspaceId, pendingTokenEnc: seen },
      data: {
        tokenEnc: seen,
        pendingTokenEnc: null,
        tokenExpiresAt: row.pendingExpiresAt ?? null,
        pendingExpiresAt: null,
        status: "active",
        statusReason: null,
        scopes: fresh.scopes.join(",").slice(0, 2000),
        adAccountId,
        adAccountName: account!.name,
        currency: account!.currency,
        timezone: account!.timezone ? safeTimeZone(account!.timezone) : null,
        pageId,
        pageName: page?.name ?? null,
        connectedById: userId,
        connectedAt: now,
        lastSyncError: null,
        syncAttemptedAt: null,
        checkAttemptedAt: null,
        ...(sameAccount ? {} : { spendBackfilledAt: null, lastSyncedAt: null }),
      },
    });
    if (won.count !== 1) throw metaAdsError("meta_ads.connection_changed");
    return this.connection(workspaceId, true);
  }

  /**
   * `POST /meta-ads/check`: two Graph reads (`/me`, the ad account), at most
   * one per workspace per minute (raw-SQL claim on `checkAttemptedAt`, so it
   * holds across restarts and machines). A refused token or account parks the
   * connection (one notification); other failures are 502 `meta_ads.meta_refused`.
   */
  async check(workspaceId: string, now: Date = new Date()): Promise<MetaAdsConnectionDto> {
    const row = await this.prisma.metaAdsConnection.findUnique({ where: { workspaceId } });
    if (!row || !row.tokenEnc || !row.adAccountId || (row.status !== "active" && row.status !== "needs_reconnect")) {
      throw metaAdsError("meta_ads.not_connected");
    }
    if (!(await this.claimCheck(workspaceId, now))) {
      const again = await this.prisma.metaAdsConnection.findUnique({ where: { workspaceId }, select: { checkAttemptedAt: true } });
      const last = again?.checkAttemptedAt?.getTime() ?? now.getTime();
      const next = new Date(last + META_ADS_CHECK_COOLDOWN_MS);
      throw metaAdsError("meta_ads.check_cooldown", {
        retryAfter: Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 1000)),
        nextAt: next.toISOString(),
      });
    }
    const token = readMetaAdsToken(row.tokenEnc);
    if (!token) {
      await this.notifier.park(row, "token_refused");
      return this.connection(workspaceId, true);
    }
    try {
      await this.graph.me(token);
      const acct = await this.graph.adAccount(row.adAccountId, token);
      await this.prisma.metaAdsConnection.updateMany({
        where: { workspaceId, tokenEnc: row.tokenEnc },
        data: {
          adAccountName: acct.name,
          currency: acct.currency ?? row.currency,
          timezone: acct.timezone ? safeTimeZone(acct.timezone) : row.timezone,
          // A check that reads both again re-arms a parked connection.
          ...(row.status === "needs_reconnect" ? { status: "active", statusReason: null, lastSyncError: null } : {}),
        },
      });
    } catch (e) {
      if (e instanceof MetaAdsGraphError && (e.kind === "token" || e.kind === "refused")) {
        await this.notifier.park(row, e.kind === "token" ? "token_refused" : "account_refused");
      } else if (e instanceof MetaAdsGraphError) {
        throw metaAdsError("meta_ads.meta_refused", { graphCode: e.code });
      } else {
        throw e;
      }
    }
    return this.connection(workspaceId, true);
  }

  /** Cooldown claim: true when this check may run. Raw SQL, no `updatedAt` bump. */
  private async claimCheck(workspaceId: string, now: Date): Promise<boolean> {
    const at = now.toISOString();
    const cutoff = new Date(now.getTime() - META_ADS_CHECK_COOLDOWN_MS).toISOString();
    const n = await this.prisma.$executeRaw`UPDATE "MetaAdsConnection" SET "checkAttemptedAt" = ${at}::timestamp(3) WHERE "workspaceId" = ${workspaceId} AND ("checkAttemptedAt" IS NULL OR "checkAttemptedAt" <= ${cutoff}::timestamp(3))`;
    return Number(n) === 1;
  }

  /**
   * `DELETE /meta-ads/connection`: wipes both token columns and marks the
   * connection `disconnected` (ruling 10). Stored spend stays, but reads as
   * Unknown while no connection is active. No Graph call. Idempotent.
   */
  async disconnect(workspaceId: string): Promise<MetaAdsConnectionDto> {
    await this.prisma.metaAdsConnection.updateMany({
      where: { workspaceId },
      data: {
        tokenEnc: null,
        pendingTokenEnc: null,
        tokenExpiresAt: null,
        pendingExpiresAt: null,
        status: "disconnected",
        statusReason: null,
      },
    });
    return this.connection(workspaceId, true);
  }
}
