/**
 * Strip secret-bearing query parameters from a URL before it goes to a log.
 *
 * Meta's Graph API takes `access_token`, `client_secret`, `input_token`, and
 * `appsecret_proof` as query params. Logging the raw request URL on an error
 * (as the integration services do) would write those secrets to disk / log
 * aggregation. This replaces their values with `***`.
 *
 * Telegram puts the bot token in the PATH (`/bot<token>/method`), so that
 * segment is masked too.
 */
const SENSITIVE_PARAMS = new Set([
  "access_token",
  "client_secret",
  "input_token",
  "appsecret_proof",
  "fb_exchange_token",
  "code",
]);

/** `/bot<id>:<secret>` → `/bot***` (Telegram Bot API and file download URLs).
 *  Telegram tokens are always `<digits>:<secret>`, so ordinary paths that
 *  merely start with "bot" are left alone. */
function redactBotPath(s: string): string {
  return s.replace(/\/bot\d+:[^/\s?#]+/g, "/bot***");
}

export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const key of u.searchParams.keys()) {
      if (SENSITIVE_PARAMS.has(key)) u.searchParams.set(key, "***");
    }
    u.pathname = redactBotPath(u.pathname);
    return u.toString();
  } catch {
    // Not a parseable absolute URL — fall back to a regex scrub so we never
    // leak a token even from a malformed string.
    return redactBotPath(
      url.replace(
        /(access_token|client_secret|input_token|appsecret_proof|fb_exchange_token|code)=[^&\s]+/gi,
        "$1=***",
      ),
    );
  }
}
