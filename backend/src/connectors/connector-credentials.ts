import { Injectable } from "@nestjs/common";
import { decryptSecret, encryptSecret, isTokenEncryptionEnabled } from "../common/token-crypto";
import { catalogEntry, curatedUrl } from "./connector-catalog";
import { connectorError } from "./connector-errors";
import type { UpstreamTarget } from "./connector-upstream";

export interface StoredToken {
  access_token: string;
  refresh_token?: string;
  expires_at?: string;
  scope?: string;
}

type Row = { provider: string; authKind: string; serverUrl: string; tokenEnc: string | null; headersEnc: string | null };

/** SP-19 R5: production refuses to store a secret without TOKEN_ENC_KEY. */
export function sealJson(value: unknown): string {
  if (!isTokenEncryptionEnabled() && process.env.NODE_ENV === "production") throw connectorError("connectors.encryption_unavailable");
  return encryptSecret(JSON.stringify(value));
}

export function openJson<T>(stored: string | null): T | null {
  if (!stored) return null;
  try {
    return JSON.parse(decryptSecret(stored)) as T;
  } catch {
    return null;
  }
}

/**
 * The upstream request target for a connector: the URL (curated URLs are
 * trusted; a custom URL never is) and the credentials. Task 2's token
 * service takes over the OAuth access token (refresh under a lock); until
 * then the stored access token is used as is.
 */
@Injectable()
export class ConnectorCredentials {
  async target(conn: Row): Promise<UpstreamTarget | null> {
    const headers: Record<string, string> = {};
    if (conn.authKind === "oauth") {
      const tok = openJson<StoredToken>(conn.tokenEnc);
      if (!tok?.access_token) return null;
      headers.authorization = `Bearer ${tok.access_token}`;
    } else if (conn.authKind === "headers") {
      const h = openJson<Record<string, string>>(conn.headersEnc) ?? {};
      for (const [k, v] of Object.entries(h)) if (typeof v === "string") headers[k] = v;
    }
    const entry = catalogEntry(conn.provider);
    const trusted = conn.provider !== "custom" && !!entry && curatedUrl(entry) === conn.serverUrl;
    return { url: conn.serverUrl, headers, trusted };
  }
}
