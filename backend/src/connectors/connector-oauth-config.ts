/** SP-23 OAuth settings, from env only (nothing is invented). */
type Env = Record<string, string | undefined>;
const read = (env: Env, k: string) => (env[k] ?? "").trim();

/**
 * The redirect URI registered with the vendor: exactly one, from config
 * (`BACKEND_PUBLIC_URL`), compared exactly by the vendor and sent verbatim in
 * the token request.
 */
export function connectorRedirectUri(env: Env = process.env): string {
  const base = (read(env, "BACKEND_PUBLIC_URL") || "http://localhost:3001").replace(/\/+$/, "");
  return `${base}/api/connectors/oauth/callback`;
}

/** The frontend origin the callback page may post to (never "*"). */
export function frontendOrigin(env: Env = process.env): string {
  const raw = read(env, "FRONTEND_PUBLIC_URL") || read(env, "FRONTEND_URL") || "http://localhost:5173";
  try {
    return new URL(raw).origin;
  } catch {
    return "http://localhost:5173";
  }
}

export function frontendConnectorsUrl(params: Record<string, string>, env: Env = process.env): string {
  const qs = new URLSearchParams({ tab: "connectors", ...params }).toString();
  return `${frontendOrigin(env)}/#/agent?${qs}`;
}

/** HubSpot's pre-registered app (ruling 12): absent → the card is disabled. */
export function hubspotClient(env: Env = process.env): { clientId: string; clientSecret: string } | null {
  const clientId = read(env, "HUBSPOT_MCP_CLIENT_ID");
  const clientSecret = read(env, "HUBSPOT_MCP_CLIENT_SECRET");
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** Calendly's MCP scopes (DCR client). HubSpot's come from its consent screen. */
export const CALENDLY_SCOPES = "mcp:scheduling:read mcp:scheduling:write";
