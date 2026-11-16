# SP-23 Connectors Gallery: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- **A connectors gallery.** A "Connectors" / "الموصلات" tab on the AI agent screen (`#/agent?tab=connectors`) replaces the current "MCP Servers" tab. The legacy list stays under "Advanced" (ruling 9). It shows:
  - the curated providers: **Calendly** and **HubSpot** in this SP (roadmap: "Calendly and HubSpot first"); Pipedrive, Salla and Foodics are shown as "Coming soon" (ruling 1);
  - **custom connectors** (any HTTPS MCP server, with optional secret headers).
- **Per connector:**
  - connect (OAuth popup, or URL + headers for custom), the account label, and status (active / needs reconnect / disconnected);
  - **per-tool switches** with a read/write badge, and **re-scan** of the vendor's tools;
  - an **agent picker** (whether the agent may use it);
  - a **recent-activity card** (the last calls, outcomes, 7-day counts);
  - **sync cards**: "Bookings from Calendly" and "Contacts from HubSpot" (opt-in, inbound, ruling 8);
  - disconnect.
- **Enforcement where we control it.** The agent never talks to a vendor directly. Each connector is registered on the l platform as an MCP server whose URL is **our own proxy** (`POST /api/mcp/connectors/:connectorId`) with a per-connector bearer token. The proxy:
  - lists only switched-on tools (roadmap acceptance `tool switched off is not exposed to agent`);
  - refuses calls to anything else;
  - validates arguments, adds the vendor's current access token, and logs every call in `ConnectorCall`.
- **Tokens.** OAuth tokens are encrypted (`token-crypto.ts`), refreshed before expiry under a lock with rotation (acceptance `refresh token rotation`). An auth failure flips the connector to `needs_reconnect`, hides its tools from the agent, and notifies once (acceptance `connector auth failure → connector_needs_attention`).
- **Skills (SP-22).** SP-23 binds the real `ConnectorPresence`, so "Connect Calendly first" resolves, and it calls `SkillsService.onConnectorChanged` on every status change.

**Architecture:**
- **Provider catalog in code** (`backend/src/connectors/connector-catalog.ts`; keys mirrored in `src/screens/kewy-agent/connectors/connectorCatalog.ts`, a test pins equality):
  | provider | auth | upstream MCP URL (env override) | OAuth client | default-on read tools | notes |
  |---|---|---|---|---|---|
  | `calendly` | `oauth` | `CONNECTOR_CALENDLY_MCP_URL` (default `https://mcp.calendly.com`) | dynamic client registration (RFC 7591), scopes `mcp:scheduling:read mcp:scheduling:write` | user, event types and available times, busy times, locations, get event | write tools (create invitee, single-use links, cancel) default **off** |
  | `hubspot` | `oauth` | `CONNECTOR_HUBSPOT_MCP_URL` (default `https://mcp.hubspot.com`) | pre-registered app: `HUBSPOT_MCP_CLIENT_ID`/`HUBSPOT_MCP_CLIENT_SECRET`; missing → card shown disabled with the reason (SP-19 R1 pattern) | none until scanned; read-only tools on, everything else off | scopes chosen on HubSpot's consent screen |
  | `pipedrive`, `salla`, `foodics` | – | – | – | – | "Coming soon"; no vendor-hosted MCP server; each needs its own tool server (ruling 1) |
  | `custom` | `none` \| `headers` | owner-entered HTTPS URL (SSRF-guarded) | – | none (all off until switched on) | `connectors.manage` only |
- **Proxy (the enforcement point)** `backend/src/connectors/connector-proxy.controller.ts`:
  - `@Public()` + `ConnectorProxyGuard`. The bearer `cnp_<12 hex>_<secret>` is looked up by prefix and bcrypt-compared (the `McpTokenService` pattern). The guard checks the token's connector equals `:connectorId` (else 404, the same for unknown, foreign and revoked) and the payment lock (fail closed, `paymentOverdue()`, as `McpAuthGuard`).
  - A minimal **stateless MCP JSON-RPC handler** (`connector-proxy.rpc.ts`): `initialize`, `notifications/initialized` (202), `ping`, `tools/list`, `tools/call`; any other method gives JSON-RPC error `-32601`. Requests are JSON (no SSE needed for a stateless server). It is hand-written because `@mastra/mcp`'s server takes zod tools, while vendor tools arrive as JSON Schema (ruling 2).
  - **`tools/list`** returns only exposed tools (below), each with the stored `inputSchema` and `description`. For a connector that is not `active`, it returns `[]`.
  - **`tools/call`**, in order; a failure at any step writes `ConnectorCall` with `outcome: "refused"` and an `errorCode`:
    1. The tool must be exposed (else JSON-RPC error "tool not available").
    2. The arguments must be an object ≤ 64 KB that validates against the stored `inputSchema` with `connector-args.ts`, a small validator for the JSON Schema subset `type/properties/required/enum/items/minimum/maximum/minLength/maxLength/additionalProperties` (unknown keywords are ignored, and the vendor validates again).
    3. It gets a fresh access token (refreshing under the lock when it expires within 2 minutes).
    4. It calls upstream through `ConnectorUpstream.callTool` (timeout 30 s, response ≤ 1 MB, truncated with a note).
    5. It returns the vendor's `content` and records `ConnectorCall`.

    An upstream 401 triggers one refresh and one retry; a second 401 → `markNeedsReconnect`.
  - **Exposure rule** (`connector-tools.ts`, pure, shared with the UI): a tool is exposed iff `access !== "off"`, `removedAt` is null, and `access === "write"` or `kind === "read"`. So a write tool needs `access: "write"`; `read` on a write tool exposes nothing.
  - **Kind:** `annotations.readOnlyHint === true` → `read`; otherwise the curated catalog's per-tool override; otherwise `write`.
- **Upstream client** `connector-upstream.ts`: the CRM as an MCP **client** of the vendor server.
  - **Ruling 2 spike first:** `@mastra/mcp`'s client must be able to send a bearer header and return raw `inputSchema` + `annotations` from `tools/list`. If it cannot, the fallback is `@modelcontextprotocol/sdk`'s `Client` (already installed transitively at 1.32.1), which needs the user's approval as a direct dependency.
  - Every upstream request for a **custom** URL goes through `safe-fetch.ts`. Curated URLs come from code or env (trusted) and must be `https:` in production; a loopback `http://127.0.0.1` URL is allowed only when `NODE_ENV !== "production"` (verification stubs).
- **SSRF guard** `backend/src/connectors/safe-fetch.ts` (Node core only):
  - `https:` only; ports 443 and 8443;
  - the host is resolved with `dns.promises.lookup(host, {all: true})`, and the request is refused if **any** address is loopback, private (RFC 1918), link-local, CGNAT (100.64/10), multicast, reserved, `0.0.0.0/8`, `::1`, `fc00::/7`, `fe80::/10`, or IPv4-mapped/NAT64 forms of those;
  - the dial is pinned to the checked address (`https.request` with a `lookup` that returns it), with SNI and `Host` set to the original name, so DNS rebinding cannot swap it;
  - no redirects are followed (a 3xx is an error);
  - timeouts: 8 s connect, 30 s total; response ≤ 1 MB;
  - the credentials (headers) are never logged, nor is the URL query.
- **OAuth** (`connector-oauth.service.ts`, hand-written; ruling 3):
  - **Start** `GET /connectors/oauth/start?provider=` (`connectors.create`):
    - creates or reuses a `pending` connector row;
    - discovers the authorization server from the MCP server's `/.well-known/oauth-protected-resource` → `/.well-known/oauth-authorization-server` (cached on the row as `oauthMeta`);
    - for Calendly, registers a client once (DCR) and stores it encrypted;
    - builds a **PKCE S256** challenge;
    - stores the verifier encrypted in `oauthPendingEnc` with a 10-minute expiry;
    - signs `state` (HKDF-derived key `"aram/connectors/oauth-state/v1"` from `JWT_SECRET`, audience distinct from sessions, 10-minute lifetime, a single-use nonce: the SP-15 `meta-ads.service.ts` pattern);
    - returns `{authorizeUrl}` for a popup.
  - **Callback** `GET /connectors/oauth/callback` (public):
    - verifies `state` (signature, audience, expiry, nonce unused, the workspace and user in it); re-checks the user's `connectors.create` in that workspace (role changed mid-flow → refused);
    - matches the connector by id inside `(id, workspaceId)`;
    - an `error` param or no `code` → "cancelled";
    - exchanges the code with the stored verifier and the exact redirect URI;
    - clears `oauthPendingEnc`;
    - stores `{access_token, refresh_token, expires_at, scope}` encrypted in `tokenEnc`;
    - status `active`; scans tools; probes the account label (Calendly `users-get_current_user`, HubSpot `get_user_details`, each read-only and allowed even if switched off; probes are logged as `ConnectorCall` with tool `__probe`);
    - provisions the l MCP server (below);
    - answers an HTML page (`Cache-Control: no-store`, `Referrer-Policy: no-referrer`, a CSP with no inline script except a nonce'd `postMessage` to the opener's origin = `FRONTEND_URL`) that falls back to `#/agent?tab=connectors&connector=<id>&connected=1|0`.
  - Redirect URI: `${BACKEND_PUBLIC_URL}/api/connectors/oauth/callback`. For HubSpot it must be registered in the HubSpot app (a user action, recorded as pending).
- **Refresh and rotation** (`connector-token.service.ts`):
  - `getAccessToken(connector)`: if it expires within 2 minutes, `refresh(connectorId)`.
  - `refresh` runs in a `$transaction` with `pg_advisory_xact_lock(hashtext('connector-refresh:' || id))` and re-reads the row inside the lock. If another writer already refreshed (`tokenVersion` changed and the token is no longer near expiry), it uses that token.
  - Otherwise it POSTs `grant_type=refresh_token`, stores the **new refresh token when the vendor returns one** (rotation; otherwise it keeps the old one), bumps `tokenVersion`, `refreshFailures = 0`, `lastRefreshAt`.
  - An `invalid_grant` is re-checked against a fresh re-read (a concurrent rotation wins) before it is treated as an auth failure.
  - `ConnectorRefreshScheduler` (`@Cron("33 * * * *")`) refreshes active OAuth connectors whose token expires within 2 hours, one at a time; `tick({workspaceIds?})` exists for verification.
- **Needs attention** (`connector-attention.service.ts`):
  - **Auth failure** = `invalid_grant`, an expired token with no refresh token, a second consecutive refresh failure, or a second upstream 401 after a refresh.
  - `markNeedsReconnect(conn, reason)` is a compare-and-set `status: active → needs_reconnect` (the `meta-ads-notifier.ts` pattern). Only the winner notifies: `NotificationsService.notify(ws, membersWith(ws, "connectors.manage"), {type: "connector_needs_attention", title: "connectors.needs_reconnect", body: JSON {provider, name, reason}})`, then `SkillsService.onConnectorChanged(ws, provider)`.
  - The proxy then lists no tools. A reconnect (a new OAuth) clears it and restores the previous tool switches.
- **l provisioning** (`connector-agent.service.ts`, reusing `LMcpService` and `LAgentResolverService`):
  - on first activation: mint the proxy token; `LMcpService.create(ws, {name: "kewy_conn_" + provider + "_" + id.slice(-6), description, url: <CRM proxy URL>/api/mcp/connectors/<id>, headers: {Authorization: "Bearer cnp_…"}})`; store `lServerId`;
  - **agent picker** = `bind`/`unbind` of that server (`agentBound`);
  - disconnect = unbind + remove on l + revoke the proxy token (best effort on l; our token revoke is the guarantee).

  The proxy URL uses `CRM_MCP_PUBLIC_URL` (as `mcpEndpointUrl()`).
- **Re-scan** `POST /connectors/:id/rescan` (`connectors.update`):
  - `tools/list` upstream;
  - new tools → `access: "off"`;
  - vanished tools → `removedAt` set (kept, never exposed, switch disabled);
  - returning tools → `removedAt` cleared, access as before;
  - changed `inputSchema`/description → updated, and a write tool whose schema changed is switched **off** (ruling 6);
  - returns `{added, removed, changed}` for the UI notice. The tools JSON is written with optimistic `version`.
- **Disconnect** (`DELETE /connectors/:id`, `connectors.delete`): soft, as SP-19 R9:
  - `status: "disconnected"`, tokens wiped (`tokenEnc = null`), the l server removed, the proxy token revoked;
  - tool switches kept in `tools` for a reconnect;
  - `ConnectorCall` history kept;
  - sync cards stop.

  Tkana does not revoke at the vendor; we try the vendor's revocation endpoint when its metadata lists one (best effort, ruling 7).
- **Sync cards (Task 3, ruling 8):**
  - **Calendly → bookings:**
    - opt-in with a service mapping (Calendly event type → our `Service` or free text) and a default staff resource;
    - a 15-minute `ConnectorSyncScheduler` reads scheduled events since a stored cursor **through the proxy's upstream client** (read tools only, logged);
    - it writes through `BookingWriter` with `bypassFit: true` (the HJZ rule: external bookings bypass the fit gate but still show conflicts), `source: "calendly"`, idempotent on `externalRef = calendly event uuid` (stored in `ConnectorSyncLink`);
    - Calendly cancellations → our `cancelled`.
  - **HubSpot → contacts:**
    - opt-in; the same scheduler reads contacts modified since the cursor;
    - it matches by phone (E.164) then email; creates missing contacts with `source: "hubspot"`; never overwrites a non-empty local field;
    - `ConnectorSyncLink` keys the HubSpot id.
  - Both are inbound only. Nothing is written to the vendor. Each run writes `ConnectorSyncRun {added, matched, failed, error?}` for the card.

**Tech Stack:** NestJS 10, Prisma 5 (Postgres/Neon), `@nestjs/schedule`, `@nestjs/jwt` (existing), `bcryptjs` (existing), `@mastra/mcp` client (existing; ruling 2), Node core `https`/`dns`, jest/ts-jest; React 18 + Vite, vitest. **No new dependencies** unless ruling 2's fallback is approved. **No Claude/Anthropic call is added:** the agent's model runs on l, and the proxy only moves tool calls. If an implementer touches any Claude code, they load the `claude-api` skill first and take model ids only from it; adding `@anthropic-ai/sdk` needs the user's approval. Any later Claude call goes through SP-21's planned `backend/src/ai/claude.service.ts` once it has shipped (SP-21 ruling 1 decides SDK vs raw `fetch`). Never copy the stale default model or `anthropic-version` from `ads/ads-chat.service.ts`.

**Spec:** roadmap §SP-23, plus the Global Constraints and Review Focus 1. Carried contracts:
- **l integration:** `LMcpService` (`create/remove/bind/unbind/test`), `LAgentResolverService`, `McpTokenService` (token pattern), `mcpEndpointUrl()`, `McpAuthGuard` (payment lock, fail closed).
- **SP-05:** `NotificationsService.notify`, type `connector_needs_attention`, `PermissionService.membersWith`.
- **SP-10:** `BookingWriter` (`bypassFit`), `Service`, `StaffResource`.
- **SP-02/03:** contact create/match (phone normalisation `phone.ts`), `Contact.email`.
- **SP-15:** the OAuth state pattern (HKDF-derived key, audience, single-use nonce), `token-crypto.ts` (`TOKEN_ENC_KEY`), `meta-ads-notifier.ts` compare-and-set notify.
- **SP-19:** R5 (no `TOKEN_ENC_KEY` in production → refuse to store secrets, 400 `connectors.encryption_unavailable`), R9 (soft disconnect).
- **SP-22:** `ConnectorPresence` (`CONNECTOR_PRESENCE` token), `SkillsService.onConnectorChanged`, `CONNECTOR_PROVIDERS`, `AgentToolCall` (CRM tools; connector calls go to `ConnectorCall`).
- **SP-25:** `permission-map.ts`; resource `connectors` (`view, create, update, delete, manage`). System roles per `system-roles.ts`: owner and admin have everything; the agent role has **no** `connectors` permission (`connectors` is not in `AGENT_VIEW`); the viewer has `view`.

Consumers that build on this plan:
- **SP-27:** API keys and outgoing webhooks; MCP OAuth for AI tools is separate (inbound) and does not reuse these tokens.
- **SP-20 sandbox:** connector tools appear as tool-call lines; the sandbox must not call write tools (SP-20's dry-run rule; the proxy offers `X-Dry-Run: 1`, which refuses write tools with `dry_run`).

Tkana reference (read-only, untrusted data; `C:\Users\ashra\Downloads\tkana-main\tkana-main`):
- `apps/web/app/routes/connectors{,.$id}.tsx`, `components/connectors/*`, `lib/connectors/{actions,detail,tool-controls,attention}.server.ts`: the gallery, detail, tool switches with a read/write badge from `readOnlyHint` (anything not `true` is "write"), re-scan notice, activity card (last 30 days, 20 calls, 7-day counts), attention banner.
- `packages/db/src/shared/oauth-mcp-connectors.ts:26-65`: Calendly (DCR, `mcp:scheduling:*`), HubSpot (pre-registered client from env, consent-screen scopes).
- `apps/api/.../oauth/{oauth.handlers,mcp-oauth,mcp-oauth-refresh}.ts`: state `<id>.<random>` compared in constant time, 10-minute handshake TTL, PKCE through the MCP SDK `auth()`, refresh under a Redis lock, keep the old refresh token when none is returned, re-read on `invalid_grant`.
- `refresh-oauth-tokens.core.ts`: hourly refresh of tokens expiring within 2 h; escalation on `invalid_grant`, a missing refresh token, or a 2nd failure in a row → `needsReconnect` + `integration.needs_attention` (bell, push, email).
- `packages/credentials/src/connector-safe-fetch.ts:7-195`: https only, every resolved address checked, the dial pinned, manual redirects with cross-origin auth stripping.
- `apps/ai/src/lib/mcp-tool-loader.ts:253-418`: the runtime registers only bound, enabled tools and skips `needsReconnect` connectors.
- Calendly booking sync and Pipedrive contact sync are 5-minute crons, inbound only.

What we take and what we don't:
- We take:
  - the read/write badge from `readOnlyHint`, defaulting to write;
  - write tools off by default;
  - PKCE plus a signed, single-use, 10-minute state;
  - refresh under a lock with rotation and a re-read on `invalid_grant`;
  - the escalation rules;
  - the SSRF rules, plus our own pinning;
  - soft disconnect that remembers tool switches;
  - removed tools flagged, not deleted;
  - inbound-only sync.
- We do **not** take:
  - letting the agent runtime reach the vendor directly (ours: a CRM proxy, ruling 4);
  - the per-agent tool bindings table (one agent; per-tool access lives on the connector);
  - push and email alerts (no email provider yet, D3; the bell only);
  - Pipedrive/Salla/Foodics tool servers (ruling 1);
  - custom OAuth connectors (ruling 5);
  - the `connectors.custom` add-on entitlement (SP-28).

## Global Constraints
- **Data (exact names; later SPs build on them):**
  ```
  /// SP-23: one external tool source for the agent.
  model Connector {
    id               String    @id @default(cuid())
    workspaceId      String
    workspace        Workspace @relation("WorkspaceConnectors", fields: [workspaceId], references: [id], onDelete: Cascade)
    provider         String    // "calendly" | "hubspot" | "custom" (pipedrive/salla/foodics reserved)
    name             String
    /// "oauth" | "headers" | "none"
    authKind         String
    /// "pending" | "active" | "needs_reconnect" | "disconnected"
    status           String    @default("pending")
    statusReason     String?
    serverUrl        String
    /// token-crypto JSON {access_token, refresh_token?, expires_at?, scope?}; null when not connected.
    tokenEnc         String?
    tokenExpiresAt   DateTime?
    tokenVersion     Int       @default(0)
    refreshFailures  Int       @default(0)
    lastRefreshAt    DateTime?
    /// token-crypto JSON of custom secret headers {name: value}.
    headersEnc       String?
    /// token-crypto JSON of a dynamically registered OAuth client.
    oauthClientEnc   String?
    oauthMeta        Json?
    oauthPendingEnc  String?
    oauthPendingExpiresAt DateTime?
    /// [{name, title?, description, kind: "read"|"write", access: "off"|"read"|"write", inputSchema, removedAt?}]
    tools            Json      @default("[]")
    toolsScannedAt   DateTime?
    accountLabel     String?
    lServerId        String?
    agentBound       Boolean   @default(false)
    proxyTokenPrefix String?   @unique
    proxyTokenHash   String?
    /// {calendly?: {enabled, serviceMap, resourceId, cursor}, hubspot?: {enabled, cursor}}
    sync             Json      @default("{}")
    connectedById    String?
    connectedBy      User?     @relation("ConnectorConnectedBy", fields: [connectedById], references: [id], onDelete: SetNull)
    connectedAt      DateTime?
    disconnectedAt   DateTime?
    version          Int       @default(0)
    createdAt        DateTime  @default(now())
    updatedAt        DateTime  @updatedAt
    calls            ConnectorCall[]
    syncLinks        ConnectorSyncLink[]
    syncRuns         ConnectorSyncRun[]

    @@index([workspaceId, provider])
    @@index([status, tokenExpiresAt])
  }

  /// SP-23: one proxied tool call (no arguments, no results).
  model ConnectorCall {
    id          String    @id @default(cuid())
    workspaceId String
    workspace   Workspace @relation("WorkspaceConnectorCalls", fields: [workspaceId], references: [id], onDelete: Cascade)
    connectorId String
    connector   Connector @relation(fields: [connectorId], references: [id], onDelete: Cascade)
    tool        String
    kind        String    // "read" | "write"
    outcome     String    // "ok" | "error" | "refused"
    errorCode   String?
    durationMs  Int
    source      String    @default("agent") // "agent" | "sync" | "probe"
    at          DateTime  @default(now())

    @@index([connectorId, at])
    @@index([workspaceId, at])
  }

  /// SP-23: an external record a sync card imported (idempotency).
  model ConnectorSyncLink {
    id          String    @id @default(cuid())
    workspaceId String
    connectorId String
    connector   Connector @relation(fields: [connectorId], references: [id], onDelete: Cascade)
    kind        String    // "booking" | "contact"
    externalId  String
    localId     String    // Appointment.id or Contact.id (no FK: either may be deleted locally)
    createdAt   DateTime  @default(now())
    updatedAt   DateTime  @updatedAt

    @@unique([connectorId, kind, externalId])
    @@index([workspaceId])
  }

  /// SP-23: one sync card run.
  model ConnectorSyncRun {
    id          String    @id @default(cuid())
    workspaceId String
    connectorId String
    connector   Connector @relation(fields: [connectorId], references: [id], onDelete: Cascade)
    kind        String    // "booking" | "contact"
    added       Int       @default(0)
    matched     Int       @default(0)
    failed      Int       @default(0)
    error       String?
    startedAt   DateTime  @default(now())
    finishedAt  DateTime?

    @@index([connectorId, startedAt])
  }
  ```
  - `ConnectorSyncLink.workspaceId` and `ConnectorSyncRun.workspaceId` have workspace FKs (cascade) so the residue sweep finds them.
  - Back-relations on `Workspace` (`connectors`, `connectorCalls`, `connectorSyncLinks`, `connectorSyncRuns`) and `User` (`connectorsConnected`) are Prisma-only.
- **Constants** (`backend/src/connectors/connector-catalog.ts`):
  - `CONNECTOR_PROVIDERS` (from SP-22);
  - `CONNECTOR_CALL_RETENTION_DAYS = 90`;
  - `REFRESH_AHEAD_MS = 2 * 60_000`; `REFRESH_SWEEP_AHEAD_MS = 2 * 60 * 60_000`;
  - `PROXY_ARGS_MAX_BYTES = 64 * 1024`; `UPSTREAM_RESPONSE_MAX_BYTES = 1024 * 1024`;
  - `OAUTH_STATE_TTL_MS = 10 * 60_000`;
  - `CUSTOM_CONNECTORS_MAX = 10` per workspace.
- **DTOs:**
  - `ConnectorCardDto = {provider, name: {en, ar}, description: {en, ar}, authKind, available: boolean, unavailableReason: "not_configured"|"coming_soon"|null, connectors: ConnectorSummaryDto[]}`.
  - `ConnectorSummaryDto = {id, provider, name, status, statusReason, accountLabel, agentBound, toolCounts: {on, total}, connectedAt, calls7d}`.
  - `ConnectorDetailDto = ConnectorSummaryDto & {serverHost (host only, never the full URL with query), tools: ConnectorToolDto[], toolsScannedAt, sync: SyncCardDto[], usedBySkills: {key, name}[], version}`.
  - `ConnectorToolDto = {name, title, description, kind, access, exposed, removed: boolean}`.
  - `PatchToolsDto = {version, tools: {name, access}[]}` (≤ 200 entries).
  - `CreateCustomDto = {name ≤ 60, url (https, ≤ 2048), headers?: {name ≤ 100 (token chars), value ≤ 4096}[] (≤ 10)}`.
  - Secrets and tokens are never returned: header values come back as `"••••"` plus the last 4 characters.
- **API** (every route workspace-scoped; a foreign or unknown connector id is **404** `connectors.not_found`):
  - `GET /connectors` (`connectors.view`) → `{cards: ConnectorCardDto[], attention: ConnectorSummaryDto[]}`.
  - `GET /connectors/:id` (`connectors.view`) → `ConnectorDetailDto`.
  - `GET /connectors/oauth/start?provider=` (`connectors.create`) → `{authorizeUrl}`; 400 `connectors.provider_unavailable`; 400 `connectors.encryption_unavailable` (production without `TOKEN_ENC_KEY`).
  - `GET /connectors/oauth/callback` (public) → the HTML hand-off page.
  - `POST /connectors/custom` (`connectors.manage`) → `ConnectorDetailDto` (status `active` after a successful check; tools scanned, all `off`); 400 `connectors.unsafe_url {reason}`, 400 `connectors.check_failed {reason}`, 409 `connectors.custom_limit`.
  - `PATCH /connectors/:id/tools` (`connectors.update`) → `ConnectorDetailDto`:
    - turning a **write** tool to `write` needs `connectors.manage` (checked in the service → 403 `connectors.write_access_requires_manage`);
    - a removed tool → 400 `connectors.tool_removed`;
    - a stale version → 409 `connectors.version_conflict {current}`;
    - a disconnected connector → 409 `connectors.disconnected`.
  - `POST /connectors/:id/rescan` (`connectors.update`) → `{detail, added, removed, changed}`; 409 `connectors.needs_reconnect` when the token is unusable.
  - `PUT /connectors/:id/agent` (`connectors.update`) body `{bound: boolean}` → `ConnectorSummaryDto`; 409 `connectors.agent_not_connected` (no l link).
  - `GET /connectors/:id/activity` (`connectors.view`) → `{calls: {tool, kind, outcome, errorCode, source, at}[] (≤ 20, last 30 days), counts7d: {tool, ok, error, refused}[]}`.
  - `PATCH /connectors/:id/sync` (`connectors.manage`) body `{kind: "booking"|"contact", enabled, serviceMap?, resourceId?}`:
    - the service also requires `bookings.create` (booking) or `contacts.create` (contact) of the caller, else 403;
    - `serviceMap` targets and `resourceId` must belong to the workspace (else 404).
  - `POST /connectors/:id/sync/run` (`connectors.manage`) → `ConnectorSyncRun` (manual run now).
  - `DELETE /connectors/:id` (`connectors.delete`) → `{ok: true}`; a second call → 404.
  - `POST /mcp/connectors/:connectorId` (public, `ConnectorProxyGuard`): the proxy.
  - **Route order:** `oauth/start`, `oauth/callback` and `custom` are declared before `:id`.
- **Error keys** (`backend/src/connectors/connector-errors.ts`):
  - 400: `connectors.provider_unavailable`, `connectors.encryption_unavailable`, `connectors.unsafe_url`, `connectors.check_failed`, `connectors.tool_removed`, `connectors.invalid_tools`;
  - 403: `connectors.write_access_requires_manage`;
  - 404: `connectors.not_found`;
  - 409: `connectors.custom_limit`, `connectors.version_conflict`, `connectors.disconnected`, `connectors.needs_reconnect`, `connectors.agent_not_connected`;
  - OAuth outcomes (`connected=0&reason=`): `invalid_state`, `cancelled`, `exchange_failed`, `forbidden`.
  - Frontend `src/screens/kewy-agent/connectors/connectorErrors.ts` has `tx` copy for every key, with a test covering every key.
- **Copy and layout:**
  - Every string through `tx("English","العربية")` with real Arabic:
    - Connect / ربط
    - Reconnect / إعادة الربط
    - Disconnect / فصل
    - Needs reconnecting / يحتاج إعادة ربط
    - Coming soon / قريبًا
    - Read / قراءة
    - Makes changes / يُجري تغييرات
    - Re-scan tools / إعادة فحص الأدوات
    - Agent can use this / يستطيع الوكيل استخدامه
    - Recent activity / النشاط الأخير
    - Bookings from Calendly / الحجوزات من Calendly
    - Contacts from HubSpot / جهات الاتصال من HubSpot
    - Custom connector / موصل مخصص
  - The write-switch warning: "The agent will be able to change data in <X> on its own." / "سيتمكن الوكيل من تعديل البيانات في <X> بنفسه."
  - Logical CSS only. Tool names, hosts and counts sit in `<bdi>`; vendor descriptions are rendered as text with `dir="auto"` (never HTML: they are untrusted vendor data); dialogs set `dir`.
- **Permissions (SP-25).** No catalogue change. `permission-map.ts` adds:
  - `GET /connectors`: `connectors.view`
  - `GET /connectors/:id`: `connectors.view`
  - `GET /connectors/oauth/start`: `connectors.create`
  - `GET /connectors/oauth/callback`: `public`
  - `POST /connectors/custom`: `connectors.manage`
  - `PATCH /connectors/:id/tools`: `connectors.update`
  - `POST /connectors/:id/rescan`: `connectors.update`
  - `PUT /connectors/:id/agent`: `connectors.update`
  - `GET /connectors/:id/activity`: `connectors.view`
  - `PATCH /connectors/:id/sync`: `connectors.manage`
  - `POST /connectors/:id/sync/run`: `connectors.manage`
  - `DELETE /connectors/:id`: `connectors.delete`
  - `POST /mcp/connectors/:connectorId`: `public`

  `system-role-decisions.spec.ts` adds an `SP-23 connector routes` block:
  - owner and admin can do everything; admin holds `connectors.manage`;
  - agent has no `connectors` permissions, so 403 on every route (the tab is hidden);
  - viewer can list, read details and activity, and gets 403 on everything else.

  `permission-sidedoors.spec.ts` adds `connector activity never includes arguments or customer data` (a structural check of the DTO).
- **Migration:**
  - File: `backend/prisma/migrations/20261117170000_connectors_gallery/migration.sql`. The timestamp is after SP-22's `20261117160000_skills_gallery`. **An applied migration is never edited.** Hand-written, LF; apply with `npx prisma migrate deploy` only (from `backend/`), never `migrate dev`.
  - **Additive and idempotent:** `CREATE TABLE IF NOT EXISTS` for `Connector`, `ConnectorCall`, `ConnectorSyncLink`, `ConnectorSyncRun`, with every column above. Indexes:
    - `Connector_workspaceId_provider_idx`, `Connector_status_tokenExpiresAt_idx`, unique `Connector_proxyTokenPrefix_key`;
    - `ConnectorCall_connectorId_at_idx`, `ConnectorCall_workspaceId_at_idx`;
    - unique `ConnectorSyncLink_connectorId_kind_externalId_key`, `ConnectorSyncLink_workspaceId_idx`;
    - `ConnectorSyncRun_connectorId_startedAt_idx`.

    All are `IF NOT EXISTS`; FKs are in `DO $$ … duplicate_object` blocks (workspace CASCADE, connector CASCADE, `connectedById` SET NULL; ON UPDATE CASCADE).
  - **Prisma-conformant names**; the `prisma migrate diff` check as in SP-09/24/22.
  - **Safe for the deployed `main`:** four new tables `main` never reads. No existing table changes. No `UPDATE`, `DELETE`, `DROP` or `ALTER`. **No backfill.** The legacy direct l MCP servers are untouched (ruling 9).
- **Tests:**
  - backend: `npx jest src/connectors src/skills src/mcp-server src/integrations src/notifications src/permissions src/bookings src/contacts` plus `npx tsc --noEmit -p tsconfig.json`; the full `npm test` once per task. Known unrelated failure: `hjz-client-sync › is inert when HJZ is not configured`.
  - frontend (repo root): `npx vitest run` plus `npm run typecheck`; `npm run build` once in Task 4.
  - **Named acceptance tests (exact names):**
    - `tool switched off is not exposed to agent` (backend jest, `src/connectors/connector-proxy.spec.ts`)
    - `refresh token rotation` (backend jest, `src/connectors/connector-token.service.spec.ts`)
    - `connector auth failure → connector_needs_attention` (backend jest, `src/connectors/connector-attention.service.spec.ts`)
  - No provider is called in any spec (vendor OAuth/MCP, l and DNS are fakes; `safe-fetch.spec.ts` stubs `dns.lookup`).
- **Commits:** selective `git add <paths>`, never `-A`. Trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not stage `.playwright-mcp/`, `.claude/worktrees/` or any untracked file this plan did not create.

## Review Focus
1. **The agent only ever reaches switched-on tools.**
   - Off, removed and (for write tools) read-only tools are absent from `tools/list` and refused on `tools/call`. A `needs_reconnect`/`disconnected` connector lists nothing. A proxy token of connector A cannot drive connector B, and a workspace's token cannot reach another workspace.
   - Tests: `tool switched off is not exposed to agent`, `write tool needs write access`, `proxy token is bound to its connector`, `inactive connector lists no tools`, `payment lock closes the proxy`.
2. **Model output is untrusted at the proxy.**
   - Arguments are validated against the stored schema and size-capped. Vendor responses are capped and passed through as content, never interpreted.
   - Tests: `invalid tool arguments are refused before upstream`, `oversized arguments and responses are capped`.
3. **Tokens rotate safely.**
   - Concurrent refreshes produce one vendor refresh. A rotated refresh token replaces the old one; a missing one keeps the old. An `invalid_grant` that loses a race to another rotation is not an auth failure. Tokens are encrypted at rest and never logged or returned.
   - Tests: `refresh token rotation`, `concurrent refresh calls the vendor once`, `invalid_grant after a concurrent rotation is not a failure`, `tokens are never returned or logged`.
4. **One notification per failure.**
   - Tests: `connector auth failure → connector_needs_attention`, `second consecutive refresh failure escalates`, `reconnect restores tool switches`.
5. **No SSRF through custom connectors.**
   - Private, loopback, link-local, CGNAT, metadata and IPv6-local addresses, non-https URLs, redirects, and DNS answers that change between check and dial are all refused.
   - Test: `custom connector url is ssrf-guarded`.
6. **OAuth state cannot be forged or replayed**, and a role change mid-flow is honoured.
   - Tests: `oauth state is signed single-use and expires`, `callback rechecks permission`, `pkce verifier is required`.

## Architecture Rulings and Risks
Each item names the risk, then the recommended ruling. Items marked **(needs controller ruling)** are repeated under Controller rulings, where the controller fills in the decision.

1. **Provider scope.**
   - Calendly and HubSpot run vendor-hosted MCP servers with OAuth.
   - Pipedrive (API token), Salla (partner app store install) and Foodics (static token) have no vendor MCP server: Tkana wrote its own tool servers (`apps/mcp`), and Salla/Foodics are not even in Tkana's gallery.
   - **Ruling:** this SP ships Calendly, HubSpot and custom connectors. Pipedrive, Salla and Foodics appear as "Coming soon" and become one follow-up sub-task each: our own tool server inside `backend/src/connectors/providers/<x>` behind the same proxy.
   - **Alternative:** build Pipedrive's tool server now (+1 week). **(needs controller ruling)**
2. **MCP client and server libraries.** The proxy must serve vendor JSON-Schema tools (`@mastra/mcp`'s server takes zod) and call vendor MCP servers with a bearer header.
   - **Ruling:**
     - a hand-written stateless JSON-RPC server for the proxy (four methods);
     - `@mastra/mcp`'s client for upstream, confirmed by a Task 1 spike: bearer header, raw `inputSchema`, `annotations`, streamable HTTP and SSE responses.
   - **Fallback:** if the spike fails, add `@modelcontextprotocol/sdk` (already installed transitively at 1.32.1) as a direct dependency. That needs the **user's approval** (Global Constraints: new dependencies). **(needs controller ruling)**
3. **OAuth implementation.**
   - **Ruling:** hand-written Authorization Code + PKCE (S256) with RFC 9728/8414 discovery and RFC 7591 DCR, covered by specs against a fake authorization server. No new dependency.
   - **Alternative:** the MCP SDK `auth()` helper (the same dependency question as R2). **(needs controller ruling)**
4. **Proxy vs direct registration.** Registering the vendor URL on l directly (as the current MCP Servers tab does) would put vendor tokens on l, make per-tool switches and audit impossible, and require rotating headers on l. `LMcpService` has no update; it would be remove + create, a window with no tools.
   - **Ruling:** the CRM proxy with a per-connector bearer. l sees a stable URL and token; rotation, switches, audit and refusal live here.
   - **Accept:** one extra hop on every tool call (≈ tens of ms, same region). **(needs controller ruling)**
5. **Custom connectors.**
   - **Ruling:** HTTPS URL with no auth or with secret headers (what the legacy MCP Servers tab already allowed), `connectors.manage` only, all tools off after the first scan, at most 10 per workspace, SSRF-guarded. Custom OAuth (DCR on arbitrary servers) is deferred.
   - **Alternative:** custom OAuth now (Tkana has DCR and own-app). **(needs controller ruling)**
6. **Re-scan and tool drift.** A vendor can change a tool's schema or description after the owner switched it on.
   - **Ruling:** new tools arrive `off`; vanished tools are flagged `removedAt` (never deleted, never exposed); a **write** tool whose schema changed is switched off and listed in the notice; a read tool keeps its switch.
   - **Alternative:** keep every switch as is. **(needs controller ruling)**
7. **Disconnect.**
   - **Ruling:** soft (SP-19 R9): wipe tokens, revoke the proxy token, remove the l server, keep tool switches and history; best-effort vendor revocation when advertised.
   - **Alternative:** hard delete. **(needs controller ruling, minor)**
8. **Sync cards scope.** The roadmap lists "contact/booking sync cards".
   - **Ruling:** Calendly → bookings and HubSpot → contacts, inbound only, opt-in, every 15 minutes, idempotent through `ConnectorSyncLink`. Calendly bookings bypass the fit gate as HJZ bookings do (SP-10 ruling), with `source: "calendly"`.
     - Because they enter through `BookingWriter`, SP-24 lifecycle messages fire for them if the owner enabled those (R9 of SP-24 applies); the card says so.
     - The first run imports only events/contacts changed in the last 30 days.
   - **Alternative:** defer both sync cards to a follow-up (SP-23 = gallery + tools only, Task 3 dropped). **(needs controller ruling)**
9. **The existing MCP Servers tab** (direct l MCP servers, including `kewy_crm`).
   - **Ruling:** it moves under "Advanced → Direct MCP servers (legacy)" with a note that these bypass tool switches and activity. `kewy_crm` is hidden from that list (it is managed by setup), and nothing there is migrated.
   - **Alternative:** auto-convert direct servers into custom connectors. That needs their header secrets, which l never returns, so it is impossible. **(needs controller ruling, minor)**
10. **Agent picker.**
    - **Ruling:** one l agent per workspace, so the picker is a single switch (`agentBound`). Connecting binds it automatically (Tkana binds when there is one agent).
    - **Accept.** **(needs controller ruling, minor)**
11. **Write access permission.**
    - **Ruling:** switching a tool to `write` (the agent may change vendor data on its own) needs `connectors.manage`; reads need `connectors.update`. The proxy enforces the stored switch for every call, because the agent has no user identity.
    - **Alternative:** a per-call approval (SP-18 pending actions). Not available to a customer-facing agent; deferred. **(needs controller ruling)**
12. **HubSpot app registration.** HubSpot needs a pre-registered app with our redirect URI.
    - **Ruling:** the card is disabled with "Not configured on this server" / "غير مُعدّ على هذا الخادم" until `HUBSPOT_MCP_CLIENT_ID/SECRET` are set. Never invent values. The user registers the app and sets the Fly secrets (pending user action, like SP-15's Meta Ads). **(needs controller ruling)**
13. **Shared files with SP-22 (before), SP-20/21/18 (parallel) and SP-27 (later).** These touch `schema.prisma`, `permission-map.ts`, `system-role-decisions.spec.ts`, `KewyAgent.tsx`, `McpServersTab.tsx`, `skills/connector-presence.ts`, `notifications`, `bookings/booking-writer.ts` (the `source` value).
    - **Ruling:** SP-23 bases on the commit that ships SP-22 and records that SHA. Task 1 owns `schema.prisma` and the migration. Migrations apply in timestamp order (`…160000` SP-22 before `…170000` SP-23). `Appointment.source` gains the documented value `calendly` (a string column; no schema change). **(needs controller ruling)**
14. **Verification touches production** (as SP-15/17).
    - Task 5 runs against the production DB in throwaway workspaces, with local stubs for:
      - a Calendly-like OAuth authorization server + MCP server;
      - a HubSpot-like one;
      - l;
      - Zernio.
    - The curated URLs point at loopback stubs (allowed only outside production `NODE_ENV`).
    - The custom-connector SSRF checks use only literal IP URLs and the reserved `.invalid` TLD, so no external DNS query is made. Wildcard-DNS names such as `*.nip.io` are **not** used.
    - The migration needs the user's **explicit approval**. **(needs controller ruling)**
15. **Size.** The roadmap says L. Four build tasks plus verification (Task 3 drops if R8 defers the sync cards). **(needs controller ruling, minor)**

### Controller rulings
*Pending. The controller fills in each decision (R1–R15) and the base commit before Task 1 starts. Migration `20261117170000_connectors_gallery` needs explicit user approval before it runs.*
- **R1** (Calendly + HubSpot + custom now; Pipedrive/Salla/Foodics coming soon): pending.
- **R2** (hand-written proxy server; `@mastra/mcp` client after a spike; SDK fallback needs user approval): pending.
- **R3** (hand-written OAuth + PKCE + DCR): pending.
- **R4** (CRM proxy instead of direct vendor registration on l): pending.
- **R5** (custom = none/headers only; custom OAuth deferred): pending.
- **R6** (re-scan: new off, removed flagged, changed write tools switched off): pending.
- **R7** (soft disconnect, best-effort vendor revocation): pending.
- **R8** (Calendly bookings + HubSpot contacts sync, inbound, opt-in, or defer): pending.
- **R9** (legacy MCP Servers under Advanced; no migration): pending.
- **R10** (single agent switch, auto-bind on connect): pending.
- **R11** (write access needs `connectors.manage`): pending.
- **R12** (HubSpot disabled until its app is configured): pending.
- **R13** (base on the SP-22 ship commit; schema ownership; migration order): pending.
- **R14** (verification on the production DB with loopback vendor stubs; no external DNS; explicit migration approval): pending.
- **R15** (size L; 4 build tasks + verification): pending.

---

### Task 1: Backend — schema, migration, connector core, proxy, SSRF guard, custom connectors, tool switches, re-scan, activity, l provisioning
**Owns:** `schema.prisma` and the migration for all of SP-23. Tasks 2–4 depend on this contract.

**Files:**
- `backend/prisma/schema.prisma`: Global Constraints → Data.
- `backend/prisma/migrations/20261117170000_connectors_gallery/migration.sql` and `backend/src/connectors/connectors-migration.spec.ts`.
- Create in `backend/src/connectors/`, each with a spec:
  - `connector-catalog.ts`: providers, default tool switches, kind overrides, availability (`available`, `unavailableReason` from env).
  - `connector-tools.ts`: `kindOf(tool, catalog)`, `isExposed(tool)`, `applyRescan(oldTools, upstreamTools) → {tools, added, removed, changed}`, `applyPatch(tools, patch, canManage)`.
  - `connector-args.ts`: the JSON Schema subset validator.
  - `safe-fetch.ts`: the guard and pinned HTTPS request (with streaming SSE parse for MCP responses).
  - `connector-upstream.ts`: `listTools`, `callTool`, `initialize`, behind a `ConnectorUpstream` interface (fake in specs). **Spike first** (ruling 2), recorded in the task report.
  - `connector-proxy.guard.ts`, `connector-proxy.rpc.ts`, `connector-proxy.controller.ts`.
  - `connector-proxy-token.ts`: mint/verify `cnp_` tokens.
  - `connector-call.recorder.ts` and `connector-call-prune.scheduler.ts` (daily, 90 days, `workspaceIds?` for verification).
  - `connector-agent.service.ts`: l provisioning, bind/unbind, remove.
  - `connector-presence.service.ts`: the real `ConnectorPresence` (`status = "active"` and a usable token), bound to SP-22's token.
  - `connectors.service.ts`: list, detail, custom create (check = `initialize` + `tools/list` through `safe-fetch`), patch tools, rescan, agent, activity, disconnect; it calls `SkillsService.onConnectorChanged` on every status change.
  - `connector-errors.ts`, `connectors.controller.ts`, `connectors.module.ts`.
- `backend/src/skills/skills.module.ts`: the `CONNECTOR_PRESENCE` provider now comes from `ConnectorsModule` (no import cycle: `SkillsModule` imports nothing from connectors; `ConnectorsModule` exports the binding and is imported by the app module after `SkillsModule`, or use a forward ref; decided and recorded in the report).
- `backend/src/permissions/permission-map.ts` + `permission-map.spec.ts`, `system-role-decisions.spec.ts` (`SP-23 connector routes`), `permission-sidedoors.spec.ts`.

**Produces (contract for Tasks 2–4):** every route, DTO and error key; `ConnectorUpstream`; `ConnectorsService.setStatus(conn, status, reason)` used by Task 2.

- [ ] Write the failing tests:
  - `migration is additive, idempotent and Prisma-named (SP-23)`:
    - `IF NOT EXISTS` everywhere; FKs in `duplicate_object` blocks; no `UPDATE`, `DELETE`, `DROP` or `ALTER`;
    - the folder name is greater than `20261117160000`;
    - the sha256 of `20261117150000_lifecycle_messages` and `20261117160000_skills_gallery` are pinned;
    - LF line endings;
    - the `prisma migrate diff` statements match.
  - **`tool switched off is not exposed to agent`**:
    - a connector with tools `get_event` (read, `read`), `list_events` (read, `off`), `cancel_event` (write, `off`) and `create_invitee` (write, `write`);
    - the proxy `tools/list` with the connector's bearer → exactly `get_event` and `create_invitee`;
    - `tools/call list_events` and `tools/call cancel_event` → JSON-RPC errors "tool not available"; the upstream fake records zero calls; `ConnectorCall` rows `outcome: "refused"`;
    - switch `cancel_event` to `read` → still not exposed; to `write` → exposed;
    - a removed tool → never exposed.
  - `write tool needs write access`: `PATCH /connectors/:id/tools` setting a write tool to `write` as a role with `connectors.update` but not `connectors.manage` → 403 `connectors.write_access_requires_manage`; as admin → ok.
  - `proxy token is bound to its connector` (A's token on B's URL → 404; a revoked token → 404; no bearer → 401), `inactive connector lists no tools` (`needs_reconnect`, `pending` → `[]`; `disconnected` → 404), `payment lock closes the proxy` (locked → the `paymentOverdue` error; a failing lookup → error, never open).
  - `invalid tool arguments are refused before upstream` (a missing required field, a wrong type, an extra property where `additionalProperties: false`, a non-object), `oversized arguments and responses are capped`.
  - **`custom connector url is ssrf-guarded`**:
    - refused: `http://…`; `https://127.0.0.1`; `https://10.0.0.5`; `https://169.254.169.254`; `https://[::1]`; `https://[fd00::1]`; `https://[::ffff:10.0.0.1]`; `https://100.64.0.1`; a name whose lookup returns one public and one private address; port 22; a 302 response;
    - a public address is pinned: the socket connects to the checked IP even if a second lookup would return another.
  - `custom connector starts with every tool off` and `custom connector limit` (the 11th → 409).
  - `rescan flags removed tools and switches off changed write tools` (`applyRescan` table cases; optimistic `version`).
  - `activity lists the last calls without arguments` (≤ 20 in 30 days, 7-day counts by outcome).
  - `connector activity never includes arguments or customer data` (sidedoors: DTO keys are exactly the listed ones).
  - `agent switch binds and unbinds the l server` (the l fake records `PUT`/`DELETE …/agents/:slug/mcp-servers/:id`); `disconnect wipes tokens, revokes the proxy token and removes the l server, keeping switches`; `foreign connector id is 404 everywhere`.
  - `presence answers only for active connectors` and `status changes notify skills` (`onConnectorChanged` called with the provider on activate, needs_reconnect and disconnect).
  - `tokens are never returned or logged` (DTO snapshot; a `Logger` spy sees no `access_token`, `refresh_token`, header value or `cnp_` secret).
  - `permission map covers SP-23 routes`, plus the `SP-23 connector routes` block.
- [ ] Implement until green.
- [ ] `npx tsc --noEmit -p tsconfig.json`, the listed jest paths, then the full `npm test` once. Run `npx prisma generate`. **Do not run `migrate`** (ruling 14). The existing `l-mcp.service.spec.ts`, `mcp-server.*.spec.ts` and SP-22 specs stay green.
- [ ] Commit `feat(connectors): connector core, tool-switching MCP proxy, ssrf-guarded custom connectors and activity`.

### Task 2: Backend — OAuth (Calendly, HubSpot), refresh and rotation, needs-attention
**Depends on:** Task 1.

**Files:**
- `backend/src/connectors/`, each with a spec:
  - `connector-oauth.service.ts`: discovery, DCR, PKCE, state, start, callback.
  - `connector-oauth-state.ts`: sign/verify, nonce store (the SP-15 in-memory single-use set; same caveat about multiple machines, recorded).
  - `connector-token.service.ts`: `getAccessToken`, `refresh` with the lock and rotation.
  - `connector-refresh.scheduler.ts`: hourly; `tick({now, workspaceIds?})`.
  - `connector-attention.service.ts`: `markNeedsReconnect`, notify, skills hook.
  - `oauth-callback-page.ts`: the HTML with a CSP nonce.
  - `providers/calendly.ts`, `providers/hubspot.ts`: tool overrides and label probes.
- `connectors.controller.ts`: `oauth/start`, `oauth/callback`.
- `backend/src/notifications`: the UI copy key `connectors.needs_reconnect` (frontend in Task 4).

- [ ] Write the failing tests:
  - **`refresh token rotation`**:
    - a token expiring in 1 min → a proxy call triggers one refresh;
    - the vendor fake returns a new access **and** a new refresh token → both stored encrypted, `tokenVersion + 1`, `refreshFailures = 0`, and the old refresh token is never sent again;
    - a second refresh where the vendor returns no refresh token → the previous refresh token is kept.
  - `concurrent refresh calls the vendor once` (two parallel `getAccessToken` through the lock fake → one vendor call; both get the new token).
  - `invalid_grant after a concurrent rotation is not a failure` (a re-read shows a newer `tokenVersion` → the new token is used; status stays `active`).
  - **`connector auth failure → connector_needs_attention`**:
    - `invalid_grant` on a fresh re-read → status `needs_reconnect` with the reason;
    - exactly one `connector_needs_attention` notification to members with `connectors.manage` (owner and admin; not viewer);
    - `onConnectorChanged` called;
    - the proxy now lists `[]`;
    - a second failure while already `needs_reconnect` → no second notification.
  - `second consecutive refresh failure escalates` (one 500 → `refreshFailures = 1`, still active; the next → `needs_reconnect`), `expired token without refresh token escalates`, `second upstream 401 after refresh escalates`.
  - `reconnect restores tool switches` (a new OAuth on a `needs_reconnect` connector → `active`, the same `tools` access values, the same `lServerId`).
  - `oauth state is signed single-use and expires` (forged signature, another audience, expired, reused nonce, another workspace's connector id → `connected=0&reason=invalid_state`; nothing stored).
  - `callback rechecks permission` (the user lost `connectors.create` between start and callback → `reason=forbidden`, no tokens stored).
  - `pkce verifier is required` (a missing or expired `oauthPendingEnc` → `invalid_state`; the token request carries `code_verifier` and the exact `redirect_uri`).
  - `discovery and dcr register once` (Calendly: the second connect reuses the stored client; HubSpot: the env client is used; no env → `provider_unavailable`).
  - `encryption is required in production` (`NODE_ENV=production` without `TOKEN_ENC_KEY` → 400 `connectors.encryption_unavailable` at start; nothing stored).
  - `callback page posts only to the frontend origin` (the HTML contains the nonce'd script, `targetOrigin = FRONTEND_URL`, `no-store`, `no-referrer`, and no token).
  - `refresh sweep picks only tokens expiring within two hours` (and `tick` honours `workspaceIds`).
- [ ] Implement until green; `npx tsc --noEmit -p tsconfig.json`; `npx jest src/connectors src/notifications src/skills`; the full `npm test` once.
- [ ] Commit `feat(connectors): oauth with pkce for calendly and hubspot, locked token rotation and needs-attention alerts`.

### Task 3: Backend — sync cards (ruling 8; dropped if the controller defers them)
**Depends on:** Tasks 1–2.

**Files:**
- `backend/src/connectors/sync/`, each with a spec:
  - `calendly-booking-sync.ts`: read events and invitees through `ConnectorUpstream` (read tools only, `source: "sync"`); map them through `serviceMap`; `BookingWriter.create/update` with `bypassFit: true` and `source: "calendly"`; cancellations; links.
  - `hubspot-contact-sync.ts`: read contacts modified since the cursor; match by E.164 phone then email; create with `source: "hubspot"`; never overwrite a non-empty local field; links.
  - `connector-sync.scheduler.ts`: `*/15 * * * *`; `tick({workspaceIds?})`; one run per enabled card; skip on payment lock; skip when the connector is not active.
- `connectors.service.ts`: `patchSync`, `runSync`, and sync cards in the detail DTO (last run, totals, enabled, mapping).

- [ ] Write the failing tests:
  - `calendly sync imports each event once` (two runs over the same events → one appointment each; a link per event; a rescheduled event updates the time; a cancelled one → `cancelled`).
  - `calendly sync bypasses the fit gate but keeps conflicts visible` (an event outside the resource's hours imports; an overlap is imported and shown as a conflict, as HJZ bookings are).
  - `hubspot sync matches before creating and never overwrites` (match by phone then email; an empty local email is filled; a non-empty local name is kept).
  - `sync uses read tools only and logs them` (a catalog write tool is never called; `ConnectorCall.source = "sync"`).
  - `enabling a sync card needs the target permission` (no `bookings.create` → 403; `serviceMap` to a foreign service → 404).
  - `sync stops when the connector needs reconnecting` (no upstream call; the run records `error: "needs_reconnect"`).
  - `first run is limited to 30 days`.
- [ ] Implement until green; `npx tsc --noEmit -p tsconfig.json`; `npx jest src/connectors src/bookings src/contacts`; the full `npm test` once.
- [ ] Commit `feat(connectors): calendly bookings and hubspot contacts sync cards`.

### Task 4: Frontend — Connectors tab
**Depends on:** Task 1–3 contracts.

**Files:**
- **F1 Model (pure):**
  - `src/screens/kewy-agent/connectors/connectorCatalog.ts`;
  - `connectorTools.ts`: a mirror of `isExposed`, badge (Read / Makes changes), switch state per role;
  - `connectorView.ts`: card and detail states, the attention banner list, the re-scan notice text;
  - `connectorErrors.ts`.
  - Tests: `connectorTools.test.ts`, `connectorView.test.ts`, `connectorErrors.test.ts`.
- **F2 Gallery:** `src/screens/kewy-agent/ConnectorsTab.tsx` in `KewyAgent.tsx` (it replaces the "MCP Servers" tab; `Tab` adds `"connectors"`; the URL `#/agent?tab=connectors&connector=<id>` is honoured; shown with `connectors.view`).
  - Cards with logo, name, description, status; Connect opens the OAuth popup (`window.open` of `authorizeUrl`, listening for `postMessage` from the backend origin only, then reloading);
  - "Coming soon" and "Not configured on this server" states;
  - the attention banner ("<X> needs reconnecting" with a Reconnect button);
  - "Add custom connector" (`connectors.manage`): name, URL, headers (value inputs `type="password"`), check result.
- **F3 Detail:** `ConnectorDetail.tsx` (`dir` set):
  - account label, server host, status;
  - agent switch;
  - the tools list (switch, badge, description as text, "Removed by the provider" / "أزالها المزوّد"; the write-switch confirm dialog);
  - Re-scan with the added/removed/changed notice;
  - recent activity (time in the workspace timezone, tool, outcome, source);
  - "Used by skills" (from SP-22);
  - sync cards (enable switch, service mapping select, resource select, last run totals, "Run now");
  - Disconnect (confirm).
- **F4 Advanced:** `McpServersTab.tsx` renders under "Advanced → Direct MCP servers (legacy)" with the bypass note, without `kewy_crm`.
- **F5 Notifications:** the bell maps `connectors.needs_reconnect` to "<name> needs reconnecting" / "يحتاج <name> إلى إعادة الربط" with a deep link to the connector.
- **F6 Types:** `src/lib/types.ts`: `ConnectorCard`, `ConnectorSummary`, `ConnectorDetail`, `ConnectorTool`, `SyncCard`.
- **Permission gating** with `usePermissions().can(...)`: connect `connectors.create`; tool switches, re-scan and agent switch `connectors.update`; write switches, custom connectors and sync cards `connectors.manage`; disconnect `connectors.delete`. Hidden actions are not rendered; a 403 shows the shared no-permission toast; a 409 version conflict reloads with "Someone else changed this connector" / "عدّل شخص آخر هذا الموصل".

- [ ] Write the failing vitest tests:
  - `tool switched off is not exposed to agent` (UI mirror: `isExposed` truth table equals the backend's, from a shared fixture).
  - `write switch needs manage and shows the warning` (`connectors.update` only → the write switch is disabled with the reason).
  - `oauth popup accepts messages only from the backend origin` (a pure `acceptOAuthMessage(event, backendOrigin)`).
  - `rescan notice lists added, removed and changed tools in both languages`.
  - `connector error copy covers every SP-23 key in both languages`; `catalog keys equal the backend keys`.
- [ ] Implement until green, then build the components.
- [ ] `npx vitest run`, `npm run typecheck` and `npm run build` clean.
- [ ] Commit `feat(connectors): connectors gallery with oauth connect, tool switches, activity and sync cards`.

### Task 5: Verification (live, production DB, throwaway workspaces)
Apply `20261117170000_connectors_gallery` with `npx prisma migrate deploy` (from `backend/`), only when the controller and the user explicitly approve it (ruling 14). Record the results in `.superpowers/sdd/2026-11-17-sp23-connectors-gallery/live-verification.md` (SP-15's format). If the harness refuses the write, put the tables in the scratchpad and say so; do not reroute.

**Before approval (read-only, production):** confirm none of the four tables exist; `SELECT count(*) FROM "Workspace" WHERE "lWorkspaceId" IS NOT NULL`.

**Isolation** (no repo code changed; scripts derived from SP-15's/SP-17's in the session scratchpad `C:\Users\ashra\AppData\Local\Temp\claude\7b75a64029a712a6\ebb2057a-6300-4548-9aec-b98487880afb\scratchpad\`):
- **Own instance:** `launch-sp23.js`. Backend on **:4280** (another free port if busy, recorded), outDir `backend/.verify-dist-sp23`, working directory `sp23-run/`, `NODE_ENV=development` (so loopback curated URLs are accepted), `TOKEN_ENC_KEY` a throwaway test key, `JWT_SECRET` the run's own, and `BACKEND_PUBLIC_URL`/`CRM_MCP_PUBLIC_URL`/`FRONTEND_URL` loopback. The user's :4100 process is not touched.
- **Crons:** all disabled (the SP-13 patch). The refresh, sync and prune schedulers run only through their `tick({workspaceIds: [test ids]})` from `sp23-tick.js`.
- **No external call, ever:**
  - **Vendor stubs:** `vendor-stub-sp23.js` on 127.0.0.1:4281 (Calendly-like) and :4282 (HubSpot-like). Each serves:
    - `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`;
    - `/register` (DCR; Calendly only);
    - `/authorize`, which auto-approves and redirects to our callback with `code` and `state`;
    - `/token`: checks `code_verifier`; rotates refresh tokens; scriptable `invalid_grant` and 500;
    - `/revoke`;
    - an MCP endpoint (`initialize`, `tools/list` with `readOnlyHint` on some tools, `tools/call`; scriptable tool set for re-scan; a 401 mode);
    - control endpoints `/__control/*`; a call log without secrets.

    `CONNECTOR_CALENDLY_MCP_URL=http://127.0.0.1:4281/mcp`, `CONNECTOR_HUBSPOT_MCP_URL=http://127.0.0.1:4282/mcp`, `HUBSPOT_MCP_CLIENT_ID/SECRET` throwaway values.
  - **l:** `L_API_URL=http://127.0.0.1:4283` (the SP-22 l stub with its MCP-client control). It drives our proxy end to end with the bearer it received at registration.
  - **Zernio:** `ZERNIO_BASE_URL=http://127.0.0.1:4284/api/v1`, `ZERNIO_API_KEY=zz-verify-stub` (unused; set so nothing points at the real one).
  - **Meta, HJZ, OpenAI, Anthropic, kewy-ai, Telegram:** every key and base URL an empty string.
  - **The launcher refuses to start** unless every curated connector URL, `L_API_URL` and `ZERNIO_BASE_URL` is loopback, `ZERNIO_API_KEY` equals `zz-verify-stub`, `NODE_ENV` is not `production`, and every `DO_SPACES_*`, `HJZ_*`, `META_*`, `ANTHROPIC_*` and `KEWY_AI_*` value is empty.
  - The SP-13 egress guard stays. `safe-fetch` refusals are expected and logged separately; `blocked-egress-sp23.jsonl` (non-loopback attempts) must be empty before cleanup.
- Test tag `zz-verify-<ts>`.

**Setup** (throwaway rows only; ids in `verify-created-sp23.json`):
1. Register an owner (workspace A) and a foreign owner (B). Invite an admin, an agent-role member and a viewer.
2. Link A to the l stub (as SP-17) and run agent setup.
3. Create a service and a staff resource (SP-10), and a contact with a phone matching one HubSpot stub contact.
4. Install SP-22's `calendly_scheduling` skill → `needs_connector`.
5. Before-counts.

**Checks:**
- **Migration:** the four tables, indexes and FKs exist; no other table changed.
- **OAuth (Calendly):**
  - start → DCR once, PKCE challenge in the authorize URL;
  - the callback stores encrypted tokens (DB: `tokenEnc` is not plaintext JSON);
  - status `active`, tools scanned (write tools off), the account label;
  - the l stub has a `kewy_conn_calendly_*` server pointing at our proxy, bound to the agent;
  - the SP-22 skill moves to `enabled`.
  - A forged/replayed state → `connected=0&reason=invalid_state`; nothing changed.
- **`tool switched off is not exposed to agent` (live):** the l stub's MCP client `tools/list` on our proxy shows only switched-on tools; calling an off tool → error and a `refused` `ConnectorCall`; switch it on (admin) → listed and callable (the vendor stub logs the call with our bearer, never the `cnp_` token).
- **Argument validation:** a call with a missing required field → refused before upstream (the vendor log has no call).
- **`refresh token rotation` (live):** the vendor stub issues 90-second tokens. Two parallel proxy calls after expiry → one `/token` call; the new refresh token is stored; `tokenVersion` incremented; the stub sees the old refresh token used exactly once.
- **`connector auth failure → connector_needs_attention` (live):** the vendor stub answers `invalid_grant` → `needs_reconnect`; exactly one notification for owner and admin; none for the viewer and agent; the proxy lists `[]`; the skill is back to `needs_connector`. Reconnect → `active` with the same switches.
- **HubSpot:** connect with the env client; scan; label probe; disconnect → tokens null, the l server removed, the proxy token rejected (404), the vendor revocation called once.
- **Custom connector:**
  - `https://127.0.0.1/…`, `https://10.0.0.5/…`, `https://169.254.169.254/…`, `https://[::1]/…`, `http://example.invalid/` → 400 `connectors.unsafe_url` (no external DNS: literal IPs and `.invalid` only);
  - a custom connector pointing at a loopback stub is **refused** too, which confirms the guard is not bypassed for custom URLs.
- **Sync cards (if R8 keeps them):** enable Calendly bookings with a service mapping → `sp23-tick.js` imports the stub's two events once (a second tick imports none); a cancelled event → `cancelled`. HubSpot contacts → one matched, one created; a non-empty local name is unchanged.
- **Re-scan:** the stub adds a tool, removes one and changes a write tool's schema → the notice and states match ruling 6.
- **Scoping and roles:** B gets 404 for A's connector ids on every route and on the proxy; the agent role gets 403 everywhere; the viewer reads only.
- **Payment lock:** simulate the lock on A → the proxy refuses; the sync tick skips.
- **Logs:** grep the :4280 log and the stub logs for `access_token`, `refresh_token`, `cnp_` secrets and header values → none.
- **Migration rerun** in an always-rolled-back transaction: no error, 0 rows changed (or a recorded refusal; ask the user, do not reroute).
- **UI through the `verify` skill:** the Connectors tab in English and Arabic (RTL); the OAuth popup round trip against the stub; tools with badges and the write warning; activity; sync cards; the attention banner; Advanced legacy list; screenshots.

**Cleanup:**
- Delete only the recorded test rows: the workspaces (cascade covers `Connector`, `ConnectorCall`, `ConnectorSyncLink`, `ConnectorSyncRun`, skills, contacts, appointments, services, staff, notifications, roles), then the users.
- Residue sweep over every table with a `workspaceId` column.
- Read-only counts before and after: `Workspace`, `User`, `Connector`, `ConnectorCall`, `ConnectorSyncLink`, `ConnectorSyncRun`, `SkillInstall`, `AgentToolCall`, `Contact`, `Appointment`, `Service`, `StaffResource`, `Notification`, `Role`, `WorkspaceMember`. Every count identical.
- Stop :4280 and the stubs; remove the outDir and `sp23-run/`.

Then tick SP-23's "Detailed plan written" and "Shipped" boxes in the roadmap, noting the rulings and deviations. Record the pending user actions:
- register the HubSpot app with the callback URI and set `HUBSPOT_MCP_CLIENT_ID/SECRET` on Fly;
- confirm `TOKEN_ENC_KEY` is set on Fly;
- run a real Calendly/HubSpot connect once (read-only probe).

Add the deferred items: Pipedrive, Salla and Foodics tool servers, custom OAuth connectors, write-call approvals, and email/push alerts (D3).
