import { Inject, Injectable, Logger } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type { Prisma } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { PermissionService } from "../permissions/permission.service";
import { availability, catalogEntry, curatedUrl, OAUTH_STATE_TTL_MS } from "./connector-catalog";
import { connectorError } from "./connector-errors";
import { openJson, sealJson, trustedServer, type StoredToken } from "./connector-credentials";
import { CALENDLY_SCOPES, connectorRedirectUri, hubspotClient } from "./connector-oauth-config";
import { ConnectorOAuthHttp, type OAuthClient } from "./connector-oauth-http";
import { NonceStore, newNonce, signConnectorState, verifySignedState, type VerifiedState } from "./connector-oauth-state";
import { ConnectorAgentService } from "./connector-agent.service";
import { ConnectorCallRecorder } from "./connector-call.recorder";
import { ConnectorStatusService } from "./connector-status.service";
import { clientFor, metaOf, tokenData } from "./connector-token.service";
import { applyRescan, initialTools, storedTools } from "./connector-tools";
import { CONNECTOR_UPSTREAM, type ConnectorUpstream, type UpstreamTarget } from "./connector-upstream";
import { PROVIDER_PROBES } from "./providers";
import type { CallbackOutcome } from "./oauth-callback-page";

export const CONNECT_PERMISSION = "connectors.create";

type Row = Prisma.ConnectorGetPayload<Record<string, never>>;

const b64url = (b: Buffer) => b.toString("base64url");

/** PKCE S256 (RFC 7636): a 43-character verifier and its challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

/**
 * SP-23 vendor OAuth (ruling 3: hand-written, no dependency), Calendly and
 * HubSpot.
 *  - start: discovery (RFC 9728 → 8414, cached on the row), Calendly DCR
 *    once (RFC 7591, client stored encrypted) or HubSpot's env app (ruling
 *    12: missing → provider_unavailable), PKCE S256 with the verifier stored
 *    encrypted for 10 minutes, a signed single-use state bound to the member,
 *    the workspace and the connector.
 *  - callback: state (signature, audience, expiry, nonce) and the stored
 *    verifier must match; the member must still hold connectors.create; the
 *    code is exchanged with the verifier and the exact redirect URI; tokens
 *    are stored encrypted; the connector turns active (a reconnect keeps its
 *    tool switches and its l server).
 * Every vendor call goes through the SSRF guard; tokens, codes and
 * verifiers are never logged.
 */
@Injectable()
export class ConnectorOAuthService {
  private readonly logger = new Logger(ConnectorOAuthService.name);
  private readonly nonces = new NonceStore();
  now: () => Date = () => new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly perms: PermissionService,
    private readonly http: ConnectorOAuthHttp,
    private readonly status: ConnectorStatusService,
    private readonly agent: ConnectorAgentService,
    private readonly recorder: ConnectorCallRecorder,
    @Inject(CONNECTOR_UPSTREAM) private readonly upstream: ConnectorUpstream,
  ) {}

  async start(workspaceId: string, userId: string, provider: string): Promise<{ authorizeUrl: string }> {
    const entry = catalogEntry(provider);
    if (!entry || entry.authKind !== "oauth" || !availability(entry).available) throw connectorError("connectors.provider_unavailable");
    const url = curatedUrl(entry);
    if (!url) throw connectorError("connectors.provider_unavailable");
    if (provider === "hubspot" && !hubspotClient()) throw connectorError("connectors.provider_unavailable");
    // Fails (400 encryption_unavailable) in production without TOKEN_ENC_KEY, before anything is stored.
    sealJson({ probe: true });

    let row = (await this.prisma.connector.findFirst({ where: { workspaceId, provider }, orderBy: { createdAt: "desc" } })) as Row | null;
    if (!row) {
      row = (await this.prisma.connector.create({
        data: { workspaceId, provider, name: entry.name.en, authKind: "oauth", status: "pending", serverUrl: url },
      })) as Row;
    } else if (row.serverUrl !== url) {
      // The curated URL moved (env change): rediscover.
      await this.prisma.connector.updateMany({ where: { id: row.id, workspaceId }, data: { serverUrl: url, oauthMeta: null as never } });
      row = { ...row, serverUrl: url, oauthMeta: null };
    }
    const trusted = trustedServer(row);
    let meta = metaOf(row);
    try {
      if (!meta) {
        meta = await this.http.discover(url, trusted);
        await this.prisma.connector.updateMany({ where: { id: row.id, workspaceId }, data: { oauthMeta: meta as unknown as Prisma.InputJsonValue } });
      }
      let client: OAuthClient | null = clientFor(row);
      if (!client && provider === "calendly") {
        client = await this.http.register(meta, connectorRedirectUri(), CALENDLY_SCOPES, trusted);
        await this.prisma.connector.updateMany({ where: { id: row.id, workspaceId }, data: { oauthClientEnc: sealJson(client) } });
      }
      if (!client) throw connectorError("connectors.provider_unavailable");
      const { verifier, challenge } = pkcePair();
      const nonce = newNonce();
      await this.prisma.connector.updateMany({
        where: { id: row.id, workspaceId },
        data: { oauthPendingEnc: sealJson({ verifier, nonce }), oauthPendingExpiresAt: new Date(this.now().getTime() + OAUTH_STATE_TTL_MS) },
      });
      const state = signConnectorState(this.jwt, { workspaceId, userId, connectorId: row.id, nonce, t: this.now().getTime() });
      const auth = new URL(meta.authorization_endpoint);
      auth.searchParams.set("response_type", "code");
      auth.searchParams.set("client_id", client.client_id);
      auth.searchParams.set("redirect_uri", connectorRedirectUri());
      auth.searchParams.set("code_challenge", challenge);
      auth.searchParams.set("code_challenge_method", "S256");
      auth.searchParams.set("state", state);
      auth.searchParams.set("resource", url);
      if (provider === "calendly") auth.searchParams.set("scope", CALENDLY_SCOPES);
      return { authorizeUrl: auth.toString() };
    } catch (e) {
      if ((e as { getStatus?: () => number })?.getStatus) throw e;
      this.logger.warn(`connector oauth start failed (${provider}): ${(e as Error).name}`);
      throw connectorError("connectors.provider_unavailable", { reason: "discovery_failed" });
    }
  }

  /** Never throws: every outcome is a hand-off page. */
  async callback(q: { code?: string; state?: string; error?: string }): Promise<CallbackOutcome> {
    const signed = verifySignedState(this.jwt, q.state);
    if (!signed) return { connected: false, connectorId: null, reason: "invalid_state" };
    // A duplicate arriving while the first callback for this state is still
    // running (same machine) waits for it, then re-reads the status.
    const running = this.inflight.get(signed.nonce);
    if (running) await running.catch(() => undefined);
    const p = this.complete(q, signed);
    if (!running) {
      this.inflight.set(signed.nonce, p);
      void p.finally(() => this.inflight.delete(signed.nonce)).catch(() => undefined);
    }
    return p;
  }

  private readonly inflight = new Map<string, Promise<CallbackOutcome>>();

  private async complete(q: { code?: string; state?: string; error?: string }, st: VerifiedState): Promise<CallbackOutcome> {
    const out = (connectorId: string | null, reason: string | null): CallbackOutcome => ({ connected: reason === null, connectorId, reason });
    const row = (await this.prisma.connector.findFirst({ where: { id: st.connectorId, workspaceId: st.workspaceId } })) as Row | null;
    if (!row || row.authKind !== "oauth") return out(null, "invalid_state");
    // Review: a duplicate callback for the same state (a double load, two
    // tabs) that loses the race reports the winner's result: "connected" when
    // the connector is now active from a connect made after this state was
    // issued, never a misleading failure.
    const lost = async (reason: string) => (await this.connectedSince(row.id, row.workspaceId, st)) ? out(row.id, null) : out(row.id, reason);
    if (!this.nonces.use(st.nonce, (st.exp ?? 0) * 1000)) return lost("invalid_state");
    const pending = openJson<{ verifier?: string; nonce?: string }>(row.oauthPendingEnc);
    const live = !!row.oauthPendingExpiresAt && row.oauthPendingExpiresAt.getTime() > this.now().getTime();
    if (!pending?.verifier || pending.nonce !== st.nonce || !live) return lost("invalid_state");
    const clearPending = () =>
      this.prisma.connector.updateMany({ where: { id: row.id, workspaceId: row.workspaceId }, data: { oauthPendingEnc: null, oauthPendingExpiresAt: null } });
    if (q.error || !q.code || q.code.length > 4096) {
      await clearPending();
      return out(row.id, "cancelled");
    }
    // A fresh read, not the 30 s cache: a role removed since start counts.
    this.perms.invalidate(st.workspaceId, st.userId);
    const eff = await this.perms.effective(st.workspaceId, st.userId).catch(() => null);
    if (!this.perms.can(eff, CONNECT_PERMISSION)) {
      await clearPending();
      this.logger.warn(`connector oauth callback refused: user lost ${CONNECT_PERMISSION} ws=${st.workspaceId}`);
      return out(row.id, "forbidden");
    }
    const meta = metaOf(row);
    const client = clientFor(row);
    if (!meta || !client) {
      await clearPending();
      return out(row.id, "exchange_failed");
    }
    const trusted = trustedServer(row);
    let set;
    try {
      set = await this.http.exchange(meta, client, { code: q.code, verifier: pending.verifier, redirectUri: connectorRedirectUri() }, trusted);
    } catch (e) {
      if (await this.connectedSince(row.id, row.workspaceId, st)) return out(row.id, null);
      await clearPending();
      this.logger.warn(`connector oauth exchange failed (${row.provider}) ws=${row.workspaceId}: ${(e as Error).name}`);
      return out(row.id, "exchange_failed");
    }
    const now = this.now();
    try {
      await this.prisma.connector.updateMany({
        where: { id: row.id, workspaceId: row.workspaceId },
        data: {
          ...tokenData(set, null, now),
          oauthPendingEnc: null,
          oauthPendingExpiresAt: null,
          connectedById: st.userId,
          connectedAt: now,
          disconnectedAt: null,
          statusReason: null,
        },
      });
    } catch {
      await clearPending().catch(() => undefined);
      return out(row.id, "exchange_failed");
    }
    await this.status.set(row, "active", null);
    await this.afterConnect(row.id, row.workspaceId, set.access_token);
    return out(row.id, null);
  }

  /** Re-read: is the connector active from a connect made since this state was issued? */
  private async connectedSince(id: string, workspaceId: string, st: VerifiedState): Promise<boolean> {
    const fresh = (await this.prisma.connector.findFirst({ where: { id, workspaceId }, select: { status: true, connectedAt: true } })) as {
      status: string;
      connectedAt: Date | null;
    } | null;
    if (typeof st.t !== "number") return false;
    return !!fresh && fresh.status === "active" && !!fresh.connectedAt && fresh.connectedAt.getTime() >= st.t;
  }

  /** Scan (keeping switches on a reconnect), probe the label, provision on l. Best effort. */
  private async afterConnect(id: string, workspaceId: string, accessToken: string): Promise<void> {
    const row = (await this.prisma.connector.findFirst({ where: { id, workspaceId } })) as Row | null;
    if (!row) return;
    const target: UpstreamTarget = { url: row.serverUrl, headers: { authorization: `Bearer ${accessToken}` }, trusted: trustedServer(row) };
    try {
      const upstream = await this.upstream.listTools(target);
      const old = storedTools(row.tools);
      const tools = old.length ? applyRescan(old, upstream, row.provider, this.now()).tools : initialTools(upstream, row.provider);
      await this.prisma.connector.updateMany({
        where: { id, workspaceId },
        data: { tools: tools as unknown as Prisma.InputJsonValue, toolsScannedAt: this.now(), version: { increment: 1 } },
      });
    } catch (e) {
      this.logger.warn(`connector ${id} tool scan after connect failed: ${(e as Error).name}`);
    }
    const probe = PROVIDER_PROBES[row.provider];
    if (probe) {
      const started = Date.now();
      try {
        const res = await this.upstream.callTool(target, probe.tool, {});
        const label = res.isError ? null : probe.label(res.content);
        if (label) await this.prisma.connector.updateMany({ where: { id, workspaceId }, data: { accountLabel: label } });
        await this.recorder.record({ workspaceId, connectorId: id, tool: "__probe", kind: "read", outcome: res.isError ? "error" : "ok", durationMs: Date.now() - started, source: "probe" });
      } catch {
        await this.recorder.record({ workspaceId, connectorId: id, tool: "__probe", kind: "read", outcome: "error", errorCode: "probe_failed", durationMs: Date.now() - started, source: "probe" });
      }
    }
    try {
      await this.agent.provision(row, { bind: true });
    } catch (e) {
      this.logger.warn(`connector ${id} not registered on l yet: ${(e as Error).name}`);
    }
  }

  /** For specs: what the stored token is (never exposed by any route). */
  static storedToken(row: { tokenEnc: string | null }): StoredToken | null {
    return openJson<StoredToken>(row.tokenEnc);
  }
}
