import { Injectable, Logger } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { REFRESH_AHEAD_MS } from "./connector-catalog";
import { ConnectorAttentionService } from "./connector-attention.service";
import { ConnectorCredentials, openJson, sealJson, trustedServer, type StoredToken } from "./connector-credentials";
import { hubspotClient } from "./connector-oauth-config";
import { ConnectorOAuthHttp, OAuthHttpError, type OAuthClient, type OAuthMeta, type TokenSet } from "./connector-oauth-http";
import type { UpstreamTarget } from "./connector-upstream";

type Conn = {
  id: string;
  workspaceId: string;
  provider: string;
  name: string;
  status: string;
  authKind: string;
  serverUrl: string;
  tokenEnc: string | null;
  tokenExpiresAt: Date | null;
  tokenVersion: number;
  refreshFailures: number;
  headersEnc: string | null;
  oauthClientEnc: string | null;
  oauthMeta: Prisma.JsonValue | null;
};

/** The OAuth client of a connector: Calendly's registered one, HubSpot's app. */
export function clientFor(conn: { provider: string; oauthClientEnc: string | null }): OAuthClient | null {
  if (conn.provider === "hubspot") {
    const h = hubspotClient();
    return h ? { client_id: h.clientId, client_secret: h.clientSecret } : null;
  }
  return openJson<OAuthClient>(conn.oauthClientEnc);
}

export function metaOf(conn: { oauthMeta: Prisma.JsonValue | null }): OAuthMeta | null {
  const m = conn.oauthMeta as Partial<OAuthMeta> | null;
  return m && typeof m.token_endpoint === "string" && typeof m.authorization_endpoint === "string" ? (m as OAuthMeta) : null;
}

/** The stored token row fields for a fresh token set (rotation keeps the old refresh token when none comes back). */
export function tokenData(set: TokenSet, previous: StoredToken | null, now: Date): Prisma.ConnectorUpdateManyMutationInput {
  const expiresAt = set.expires_in ? new Date(now.getTime() + set.expires_in * 1000) : null;
  const stored: StoredToken = {
    access_token: set.access_token,
    ...(set.refresh_token ? { refresh_token: set.refresh_token } : previous?.refresh_token ? { refresh_token: previous.refresh_token } : {}),
    ...(expiresAt ? { expires_at: expiresAt.toISOString() } : {}),
    ...(set.scope ? { scope: set.scope } : previous?.scope ? { scope: previous.scope } : {}),
  };
  return { tokenEnc: sealJson(stored), tokenExpiresAt: expiresAt, tokenVersion: { increment: 1 }, refreshFailures: 0, lastRefreshAt: now };
}

/**
 * SP-23 tokens (Review Focus 3).
 *  - `getAccessToken`: the stored token, refreshed first when it expires
 *    within 2 minutes.
 *  - `refresh` runs under `pg_advisory_xact_lock('connector-refresh:' || id)`
 *    and re-reads the row inside the lock: if another writer already rotated
 *    it (a newer `tokenVersion`, not near expiry) that token is used, so
 *    concurrent refreshes make ONE vendor call. A rotated refresh token
 *    replaces the old one; none returned keeps the old one.
 *  - Auth failure (`invalid_grant` confirmed by a re-read, no refresh token,
 *    or a second failure in a row) → `markNeedsReconnect`.
 */
@Injectable()
export class ConnectorTokenService {
  private readonly logger = new Logger(ConnectorTokenService.name);
  now: () => Date = () => new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly http: ConnectorOAuthHttp,
    private readonly attention: ConnectorAttentionService,
    private readonly credentials: ConnectorCredentials,
  ) {}

  private async read(id: string): Promise<Conn | null> {
    return (await this.prisma.connector.findUnique({ where: { id } })) as Conn | null;
  }

  private nearExpiry(conn: Pick<Conn, "tokenExpiresAt">, aheadMs = REFRESH_AHEAD_MS): boolean {
    return !!conn.tokenExpiresAt && conn.tokenExpiresAt.getTime() - this.now().getTime() <= aheadMs;
  }

  /** The upstream target with a usable token (refreshing when needed), or null. */
  async target(conn: Conn): Promise<UpstreamTarget | null> {
    if (conn.authKind !== "oauth") return this.credentials.target(conn);
    const token = await this.getAccessToken(conn);
    if (!token) return null;
    return { url: conn.serverUrl, headers: { authorization: `Bearer ${token}` }, trusted: trustedServer(conn) };
  }

  async getAccessToken(conn: Conn): Promise<string | null> {
    const tok = openJson<StoredToken>(conn.tokenEnc);
    if (!tok?.access_token) return null;
    if (!this.nearExpiry(conn)) return tok.access_token;
    return this.refresh(conn);
  }

  /**
   * Refreshes under the per-connector lock. `seen` is the row the caller
   * decided on; `force` refreshes even when not near expiry (an upstream 401).
   * Returns the access token to use, or null (the connector is unusable now).
   */
  async refresh(seen: Conn, opts: { force?: boolean; aheadMs?: number } = {}): Promise<string | null> {
    type Outcome = { token: string | null; escalate?: "invalid_grant" | "no_refresh_token" | "refresh_failed" };
    const outcome: Outcome = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('connector-refresh:' || ${seen.id}))`;
        const row = (await tx.connector.findUnique({ where: { id: seen.id } })) as Conn | null;
        if (!row || row.status !== "active" || row.authKind !== "oauth") return { token: null };
        const current = openJson<StoredToken>(row.tokenEnc);
        // Another writer rotated meanwhile: use its token.
        if (row.tokenVersion !== seen.tokenVersion && current?.access_token && !this.nearExpiry(row)) return { token: current.access_token };
        if (!opts.force && current?.access_token && !this.nearExpiry(row, opts.aheadMs)) return { token: current.access_token };
        if (!current?.refresh_token) {
          const expired = !row.tokenExpiresAt || row.tokenExpiresAt.getTime() <= this.now().getTime();
          return expired || opts.force ? { token: null, escalate: "no_refresh_token" } : { token: current?.access_token ?? null };
        }
        const meta = metaOf(row);
        const client = clientFor(row);
        if (!meta || !client) return { token: null, escalate: "refresh_failed" };
        try {
          const set = await this.http.refresh(meta, client, current.refresh_token, trustedServer(row));
          await tx.connector.updateMany({ where: { id: row.id, workspaceId: row.workspaceId }, data: tokenData(set, current, this.now()) });
          return { token: set.access_token };
        } catch (e) {
          const kind = e instanceof OAuthHttpError ? e.kind : "temporary";
          if (kind === "invalid_grant" || kind === "invalid_client") return { token: null, escalate: "invalid_grant" };
          const failures = row.refreshFailures + 1;
          await tx.connector.updateMany({ where: { id: row.id, workspaceId: row.workspaceId }, data: { refreshFailures: failures } });
          this.logger.warn(`connector ${row.id} refresh failed (${kind}), ${failures} in a row`);
          if (failures >= 2) return { token: null, escalate: "refresh_failed" };
          return { token: current.access_token && !this.expired(row) ? current.access_token : null };
        }
      },
      { maxWait: 15_000, timeout: 45_000 },
    );
    if (!outcome.escalate) return outcome.token;
    if (outcome.escalate === "invalid_grant") {
      // A concurrent rotation may have won the race (its new refresh token
      // made ours invalid): re-read before calling it an auth failure.
      const fresh = await this.read(seen.id);
      const tok = openJson<StoredToken>(fresh?.tokenEnc ?? null);
      if (fresh && fresh.tokenVersion !== seen.tokenVersion && fresh.status === "active" && tok?.access_token) return tok.access_token;
    }
    await this.attention.markNeedsReconnect(seen, outcome.escalate);
    return null;
  }

  private expired(row: Pick<Conn, "tokenExpiresAt">): boolean {
    return !!row.tokenExpiresAt && row.tokenExpiresAt.getTime() <= this.now().getTime();
  }

  /** Disconnect: revoke at the vendor when advertised (best effort, never throws). */
  async revoke(conn: Pick<Conn, "provider" | "authKind" | "serverUrl" | "tokenEnc" | "oauthClientEnc" | "oauthMeta">): Promise<void> {
    if (conn.authKind !== "oauth") return;
    const meta = metaOf(conn);
    const client = clientFor(conn);
    const tok = openJson<StoredToken>(conn.tokenEnc);
    if (!meta?.revocation_endpoint || !client || !tok) return;
    const trusted = trustedServer(conn);
    if (tok.refresh_token) await this.http.revoke(meta, client, tok.refresh_token, "refresh_token", trusted);
    await this.http.revoke(meta, client, tok.access_token, "access_token", trusted);
  }
}
