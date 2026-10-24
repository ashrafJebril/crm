import { Logger } from "@nestjs/common";

/**
 * Where login checks passwords (env AUTH_SOURCE):
 *  - `local` (default): crm checks its own bcrypt hash and dual-writes every
 *    user/password change to Kewy, best-effort.
 *  - `kewy_with_fallback`: login asks Kewy's identity API; only when Kewy is
 *    unreachable (network error, timeout, 5xx) does crm check locally.
 *  - `kewy`: Kewy only. Unreachable → 503.
 */
export type AuthSource = "local" | "kewy_with_fallback" | "kewy";

const SOURCES: readonly AuthSource[] = ["local", "kewy_with_fallback", "kewy"];
let warned: string | undefined;

export function authSource(): AuthSource {
  const raw = (process.env.AUTH_SOURCE ?? "").trim().toLowerCase();
  if (!raw) return "local";
  if ((SOURCES as readonly string[]).includes(raw)) return raw as AuthSource;
  if (warned !== raw) {
    warned = raw;
    new Logger("AuthSource").warn(
      `Unknown AUTH_SOURCE "${raw}" — using "local". Expected one of ${SOURCES.join(", ")}.`,
    );
  }
  return "local";
}
