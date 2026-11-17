import type { JwtService } from "@nestjs/jwt";
import { hkdfSync, randomBytes } from "node:crypto";
import { requireJwtSecret } from "../common/jwt-secret";
import { OAUTH_STATE_TTL_MS } from "./connector-catalog";

/** The state's audience: a session token never verifies as a state, nor the reverse. */
export const CONNECTOR_STATE_AUDIENCE = "connectors-oauth";
export const CONNECTOR_STATE_PURPOSE = "connector_oauth";

export interface ConnectorOAuthState {
  workspaceId: string;
  userId: string;
  connectorId: string;
  nonce: string;
  purpose: string;
  /** When start issued it (ms, the service clock): a lost duplicate callback compares connectedAt with it. */
  t?: number;
}

/** HKDF-derived key under its own label (the SP-15 pattern). */
export function connectorStateSecret(): string {
  return Buffer.from(hkdfSync("sha256", requireJwtSecret(), "", "aram/connectors/oauth-state/v1", 32)).toString("hex");
}

export function newNonce(): string {
  return randomBytes(16).toString("hex");
}

export function signConnectorState(
  jwt: JwtService,
  p: Omit<ConnectorOAuthState, "purpose">,
  expiresInS: number = OAUTH_STATE_TTL_MS / 1000,
): string {
  return jwt.sign({ ...p, purpose: CONNECTOR_STATE_PURPOSE }, { secret: connectorStateSecret(), audience: CONNECTOR_STATE_AUDIENCE, expiresIn: expiresInS });
}

/**
 * Single-use nonces, in memory (the SP-15 pattern). Caveat (recorded): with
 * several machines a state could be replayed once on another machine within
 * its 10 minutes; the PKCE verifier (stored on the row and cleared after the
 * first exchange) still makes the second exchange fail.
 */
export class NonceStore {
  private readonly used = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}

  /** False when already used. Expired entries are dropped as new ones arrive. */
  use(nonce: string, expiresAtMs: number): boolean {
    const now = this.now();
    for (const [n, exp] of this.used) if (exp <= now) this.used.delete(n);
    if (this.used.has(nonce)) return false;
    this.used.set(nonce, Math.max(expiresAtMs, now + OAUTH_STATE_TTL_MS));
    return true;
  }
}

export type VerifiedState = ConnectorOAuthState & { exp?: number; iat?: number };

/** Signature, audience, expiry, purpose and shape (the nonce is NOT used up). */
export function verifySignedState(jwt: JwtService, state: string | undefined): VerifiedState | null {
  if (!state || state.length > 4096) return null;
  let p: VerifiedState;
  try {
    p = jwt.verify<VerifiedState>(state, { secret: connectorStateSecret(), audience: CONNECTOR_STATE_AUDIENCE });
  } catch {
    return null;
  }
  if (p?.purpose !== CONNECTOR_STATE_PURPOSE) return null;
  for (const k of ["workspaceId", "userId", "connectorId", "nonce"] as const) if (typeof p[k] !== "string" || !p[k]) return null;
  return p;
}

/** Signature, audience, expiry, purpose and shape; then the nonce is used up. */
export function verifyConnectorState(jwt: JwtService, state: string | undefined, nonces: NonceStore): ConnectorOAuthState | null {
  const p = verifySignedState(jwt, state);
  if (!p) return null;
  return nonces.use(p.nonce, (p.exp ?? 0) * 1000) ? p : null;
}
