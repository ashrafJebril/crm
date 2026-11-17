import { createHash, randomBytes } from "crypto";

/** A fresh single-use token: 32 random bytes, base64url (43 chars). It is
 *  sent once (email or copy-link) and never stored or logged. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/** What the database stores: sha256 hex of the token. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** A token as `newToken` makes it (refuses junk before any lookup). */
export function isTokenShape(token: unknown): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
}

/** The public app origin for links (APP_PUBLIC_URL), without a trailing slash. */
export function appPublicUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.APP_PUBLIC_URL?.trim() || "http://localhost:5174").replace(/\/+$/, "");
}
