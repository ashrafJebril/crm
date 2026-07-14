/**
 * Strip secret-bearing query parameters from a URL before it goes to a log.
 *
 * Meta's Graph API takes `access_token`, `client_secret`, `input_token`, and
 * `appsecret_proof` as query params. Logging the raw request URL on an error
 * (as the integration services do) would write those secrets to disk / log
 * aggregation. This replaces their values with `***`.
 */
const SENSITIVE_PARAMS = new Set([
  "access_token",
  "client_secret",
  "input_token",
  "appsecret_proof",
  "fb_exchange_token",
  "code",
]);

export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const key of u.searchParams.keys()) {
      if (SENSITIVE_PARAMS.has(key)) u.searchParams.set(key, "***");
    }
    return u.toString();
  } catch {
    // Not a parseable absolute URL — fall back to a regex scrub so we never
    // leak a token even from a malformed string.
    return url.replace(
      /(access_token|client_secret|input_token|appsecret_proof|fb_exchange_token|code)=[^&\s]+/gi,
      "$1=***",
    );
  }
}
