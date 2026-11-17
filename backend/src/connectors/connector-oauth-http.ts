import { Injectable } from "@nestjs/common";
import { parseConnectorUrl, safeFetch, SafeFetchError, type SafeFetchDeps } from "./safe-fetch";

/**
 * SP-23: every OAuth HTTP call (discovery, DCR, token, refresh, revoke) goes
 * through the SSRF guard (`safe-fetch.ts`). Vendor answers are untrusted:
 * only the documented fields are read, and nothing (tokens, codes,
 * verifiers, client secrets) is logged.
 */
export interface OAuthMeta {
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  code_challenge_methods_supported?: string[];
}

export interface OAuthClient {
  client_id: string;
  client_secret?: string;
}

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

/** `invalid_grant` (the grant is dead) vs anything else (temporary). */
export class OAuthHttpError extends Error {
  constructor(public readonly kind: "invalid_grant" | "invalid_client" | "temporary" | "unsafe_url" | "bad_response") {
    super(`oauth_${kind}`);
    this.name = "OAuthHttpError";
  }
}

const MAX = 64 * 1024;

function json(body: string): Record<string, unknown> {
  try {
    const v = JSON.parse(body);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const str = (v: unknown) => (typeof v === "string" && v.length > 0 && v.length <= 8192 ? v : undefined);

@Injectable()
export class ConnectorOAuthHttp {
  /** Specs swap the transport (an in-memory authorization server). */
  deps?: SafeFetchDeps;

  private async call(url: string, opts: { method: "GET" | "POST"; trusted: boolean; form?: Record<string, string>; json?: unknown; basic?: OAuthClient }) {
    const headers: Record<string, string> = { accept: "application/json", "user-agent": "KewyCRM-Connectors/1" };
    let body: string | undefined;
    if (opts.form) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(opts.form).toString();
    } else if (opts.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.json);
    }
    if (opts.basic?.client_secret) {
      headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(opts.basic.client_id)}:${encodeURIComponent(opts.basic.client_secret)}`).toString("base64")}`;
    }
    try {
      return await safeFetch(url, { method: opts.method, headers, body, trusted: opts.trusted, maxBytes: MAX }, this.deps);
    } catch (e) {
      if (e instanceof SafeFetchError && e.code === "unsafe_url") throw new OAuthHttpError("unsafe_url");
      throw new OAuthHttpError("temporary");
    }
  }

  /** RFC 9728 → RFC 8414 discovery from the MCP server URL. */
  async discover(serverUrl: string, trusted: boolean): Promise<OAuthMeta> {
    const u = new URL(serverUrl);
    const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
    let asBase = u.origin;
    const prm = await this.call(`${u.origin}/.well-known/oauth-protected-resource${path}`, { method: "GET", trusted }).catch(() => null);
    if (prm && prm.status === 200) {
      const servers = json(prm.body).authorization_servers;
      if (Array.isArray(servers) && typeof servers[0] === "string") asBase = servers[0].replace(/\/$/, "");
    }
    const res = await this.call(`${asBase}/.well-known/oauth-authorization-server`, { method: "GET", trusted });
    if (res.status !== 200) throw new OAuthHttpError("bad_response");
    const m = json(res.body);
    // Review: the endpoints are vendor data and the authorize URL goes to the
    // browser: each must pass the URL policy (https, public host; a loopback
    // stub only for a trusted curated server outside production) before it is
    // stored. `javascript:`, `http:`, private hosts… are refused.
    const endpoint = (v: unknown): string | undefined => {
      const raw = str(v);
      if (!raw) return undefined;
      try {
        return parseConnectorUrl(raw, { trusted }).toString();
      } catch {
        throw new OAuthHttpError("unsafe_url");
      }
    };
    const authorization_endpoint = endpoint(m.authorization_endpoint);
    const token_endpoint = endpoint(m.token_endpoint);
    if (!authorization_endpoint || !token_endpoint) throw new OAuthHttpError("bad_response");
    const methods = Array.isArray(m.code_challenge_methods_supported) ? m.code_challenge_methods_supported.filter((x): x is string => typeof x === "string") : undefined;
    // OAuth 2.1: S256 or nothing.
    if (methods && !methods.includes("S256")) throw new OAuthHttpError("bad_response");
    return {
      issuer: str(m.issuer),
      authorization_endpoint,
      token_endpoint,
      registration_endpoint: endpoint(m.registration_endpoint),
      revocation_endpoint: endpoint(m.revocation_endpoint),
      code_challenge_methods_supported: methods,
    };
  }

  /** RFC 7591 dynamic client registration (a public client, PKCE). */
  async register(meta: OAuthMeta, redirectUri: string, scope: string, trusted: boolean): Promise<OAuthClient> {
    if (!meta.registration_endpoint) throw new OAuthHttpError("bad_response");
    const res = await this.call(meta.registration_endpoint, {
      method: "POST",
      trusted,
      json: {
        client_name: "Kewy CRM",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope,
      },
    });
    if (res.status !== 200 && res.status !== 201) throw new OAuthHttpError("bad_response");
    const b = json(res.body);
    const client_id = str(b.client_id);
    if (!client_id) throw new OAuthHttpError("bad_response");
    return { client_id, ...(str(b.client_secret) ? { client_secret: str(b.client_secret) } : {}) };
  }

  private async token(meta: OAuthMeta, client: OAuthClient, form: Record<string, string>, trusted: boolean): Promise<TokenSet> {
    const res = await this.call(meta.token_endpoint, {
      method: "POST",
      trusted,
      form: { ...form, client_id: client.client_id },
      basic: client.client_secret ? client : undefined,
    });
    const b = json(res.body);
    if (res.status >= 400 && res.status < 500) {
      if (b.error === "invalid_grant") throw new OAuthHttpError("invalid_grant");
      if (b.error === "invalid_client" || b.error === "unauthorized_client") throw new OAuthHttpError("invalid_client");
      throw new OAuthHttpError(res.status === 429 ? "temporary" : "invalid_grant");
    }
    if (res.status !== 200) throw new OAuthHttpError("temporary");
    const access_token = str(b.access_token);
    if (!access_token) throw new OAuthHttpError("bad_response");
    const expires = typeof b.expires_in === "number" && b.expires_in > 0 ? b.expires_in : typeof b.expires_in === "string" ? Number(b.expires_in) || undefined : undefined;
    return {
      access_token,
      ...(str(b.refresh_token) ? { refresh_token: str(b.refresh_token) } : {}),
      ...(expires ? { expires_in: expires } : {}),
      ...(str(b.scope) ? { scope: str(b.scope) } : {}),
    };
  }

  exchange(meta: OAuthMeta, client: OAuthClient, p: { code: string; verifier: string; redirectUri: string }, trusted: boolean): Promise<TokenSet> {
    return this.token(meta, client, { grant_type: "authorization_code", code: p.code, code_verifier: p.verifier, redirect_uri: p.redirectUri }, trusted);
  }

  refresh(meta: OAuthMeta, client: OAuthClient, refreshToken: string, trusted: boolean): Promise<TokenSet> {
    return this.token(meta, client, { grant_type: "refresh_token", refresh_token: refreshToken }, trusted);
  }

  /** RFC 7009, best effort: never throws. */
  async revoke(meta: OAuthMeta, client: OAuthClient, token: string, hint: "refresh_token" | "access_token", trusted: boolean): Promise<boolean> {
    if (!meta.revocation_endpoint) return false;
    try {
      const res = await this.call(meta.revocation_endpoint, {
        method: "POST",
        trusted,
        form: { token, token_type_hint: hint, client_id: client.client_id },
        basic: client.client_secret ? client : undefined,
      });
      return res.status === 200;
    } catch {
      return false;
    }
  }
}
