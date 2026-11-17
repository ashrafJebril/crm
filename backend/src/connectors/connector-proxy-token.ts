import * as bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";

/**
 * SP-23 proxy bearer, one per connector: `cnp_<12 hex>_<43 base64url>`.
 * Stored as the prefix (unique, the lookup key) and a bcrypt hash (the
 * McpTokenService pattern). Only l ever holds the full token.
 */
const RE = /^cnp_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;

export async function mintProxyToken(): Promise<{ token: string; prefix: string; hash: string }> {
  const prefix = randomBytes(6).toString("hex");
  const token = `cnp_${prefix}_${randomBytes(32).toString("base64url")}`;
  return { token, prefix, hash: await bcrypt.hash(token, 10) };
}

export function proxyTokenPrefix(token: string): string | null {
  return RE.exec(token)?.[1] ?? null;
}

export async function proxyTokenMatches(token: string, hash: string | null | undefined): Promise<boolean> {
  if (!hash || !RE.test(token)) return false;
  return bcrypt.compare(token, hash);
}
