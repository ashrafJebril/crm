# SP-27 API Keys, Webhooks and AI-Tool Access: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- **Organization API keys.**
  - Owners and admins (`api_keys.create`) mint named keys with scopes (resource × `read | write | delete | admin`) and an optional expiry.
  - The full key is shown once. The list shows the name, prefix, scopes, creator, last used, expiry and status. Revoke takes effect immediately.
  - A key calls the same REST routes as the app with `Authorization: Bearer crm_…`. It acts as its creator, intersected with its scopes (ruling 2).
  - Roadmap acceptance: `key without contacts.write gets 403 on POST /contacts`.
- **Outgoing webhooks.**
  - Endpoints: an https URL, chosen events, an active switch and a description. The signing secret is shown once and can be rotated with a 24 h overlap.
  - Delivery: signed `POST` deliveries, retried with backoff (1 min, 5 min, 30 min, 2 h, 8 h; 6 attempts), a delivery log with status/code/attempts, a "Send test" ping, and auto-disable after 72 h of continuous failure with a `connector_needs_attention` notification.
  - Roadmap acceptance: `webhook retried with backoff and signed`.
- **API docs link.** A static bilingual developer page, `public/developers.html`: auth header, scopes, the key-callable route list, webhook events, payloads and signature verification. A spec keeps its route list true (ruling 9).
- **Per-member OAuth access for AI tools (MCP).**
  - The owner turns "AI tools" on and shares the MCP address.
  - Each member connects their own AI tool (Claude Desktop, ChatGPT, Cursor, and so on) through OAuth 2.1:
    - dynamic client registration;
    - authorization code + PKCE S256;
    - a branded consent screen that picks the workspace;
    - rotating refresh tokens.
  - The MCP server then runs **as that member, with that member's permissions and conversation visibility**.
  - The owner sees every connection and can block a member, which rejects that member's tokens at once. Members disconnect their own tools.
  - The current single workspace token (`McpAccessCard.tsx`, `mcp_…`) keeps working as the "legacy token" (roadmap).
  - Roadmap acceptance: `blocked member's OAuth token rejected`.

**Architecture:**
- **Keys** (`backend/src/api-keys/`).
  - Format `crm_<12 hex prefix>_<43 base64url secret>` (32 random bytes). Stored as `prefix` (unique, displayed) and `hash = sha256(full key)` hex (unique).
  - sha256, not bcrypt: the key carries 256 bits of entropy, so a fast hash is safe. That allows one indexed lookup per request (the MCP token's bcrypt stays as it is).
  - `ApiKeyService.authenticate(raw)`:
    - parse the prefix and look up by `hash`;
    - refuse if revoked, expired, or the creator is no longer a member → 401 `api_keys.invalid` (one key for every reason, no oracle);
    - update `lastUsedAt` at most once per 60 s per key (an in-memory throttle, Tkana precedent).
  - **Scopes → permissions** (`api-key-scopes.ts`):
    - `read → view`, `write → view + create + update`, `delete → delete`, `admin → view + create + update + delete + manage`.
    - `KEY_RESOURCES` (what a key may ever hold) = `contacts, conversations, tickets, pipelines, bookings, campaigns, templates, audiences, reports`.
    - `members, roles, billing, api_keys, settings, connectors, agent, knowledge, channels, workflows` are refused (400 `api_keys.scope_not_allowed`; ruling 3).
    - At mint time, `PermissionService.assertCanGrant` (SP-25: "you cannot grant more than you hold") checks the mapped permissions against the creator's role.
  - **Request path:**
    - `AuthGuard` (`auth/auth.guard.ts`, before `jwt.verifyAsync`): a Bearer starting `crm_` → `authenticate`.
      - It sets `req.user = {sub: key.createdById, email: "", role: "api_key", workspaceId, apiKeyId}`.
      - The payment lock applies as for JWTs.
      - JWT-only checks (SP-26 session version, the 2FA purpose) are skipped for keys.
    - `PermissionGuard`: when `req.user.apiKeyId` is set:
      - a rule of `"authenticated"` or a membership-exempt route (`/auth/*`, `/admin/*`, `GET/POST /workspaces`) → 403 `api_keys.route_not_allowed`;
      - otherwise `eff = intersect(perms.effective(ws, creatorId), scopesToPermissions(key.scopes))` (both re-read each request; the role is cached 30 s as today);
      - then `req.permissions = eff` and `perms.can(eff, rule)`.
      - Conversation visibility is the creator's (`conversationVisibility` of their role), so `PermissionService.conversationScope` works unchanged.
    - `WorkspaceInterceptor` runs with `userId = creatorId`, so `createdById` fields name a real user. `AuditService.record` (SP-26) gets `actorKind: "api_key"`, `meta.apiKeyId`.
    - The realtime gateway and `/mcp/v1` refuse `crm_` tokens.
    - Rate limit: 600 requests/min per key (`SlidingWindowLimiter`, in memory) → 429 `api_keys.rate_limited` with `Retry-After`.
- **Webhooks** (`backend/src/webhooks/`).
  - **Events v1** (`webhook-events.ts`, ruling 4):
    - `contact.created`, `message.received`, `ticket.created`, `ticket.stage_changed`, `booking.completed` come from the existing `WORKFLOW_TRIGGER_EVENT` emits;
    - `booking.created` and `conversation.assigned` need two new emits, in `bookings/booking-writer.ts` and the SP-01 assign path;
    - `ping` (test only, not subscribable).
  - **Producer:**
    - `WebhookOutboxListener` subscribes with `@OnEvent(WORKFLOW_TRIGGER_EVENT, {async: true})` and `@OnEvent(WEBHOOK_EVENT)`.
    - It maps the trigger to a webhook event and builds `data` by **re-reading** the record by `(id, workspaceId)` through a whitelisting serializer (`webhook-payloads.ts`; never the raw workflow payload).
    - It then inserts one `WebhookDelivery (status "pending", nextAttemptAt now)` per active endpoint subscribed to the event.
    - Envelope: `{id: "evt_<cuid>", type, createdAt, workspaceId, data}`. The same `id` goes to every endpoint, and `@@unique([endpointId, eventId])` makes a duplicate emit a no-op.
  - **Dispatcher:**
    - `WebhookDispatcher` runs `@Interval(10_000)`, takes ≤ 50 due rows, and claims each with `updateMany({where:{id, status:"pending", OR:[{leaseUntil:null},{leaseUntil:{lt:now}}]}, data:{leaseUntil: now+60s}})`, skipping `count===0`. This is the workflow-poller claim pattern, safe across machines.
    - Signing (`webhook-signature.ts`):
      - body = the JSON envelope; `t = unix seconds`;
      - `v1 = hex(HMAC-SHA256(secret, t + "." + body))`;
      - header `X-Crm-Signature: t=<t>,v1=<hex>[,v1=<hex of previous secret during rotation>]`;
      - plus `X-Crm-Event`, `X-Crm-Event-Id`, `X-Crm-Delivery-Attempt` and `User-Agent: AramCRM-Webhooks/1`.
    - It sends through `safeFetch` (below) with a 10 s timeout.
      - A 2xx → `delivered`, `responseCode`, `deliveredAt`; the endpoint's `failingSince` is cleared.
      - Otherwise `attempts += 1`, `responseCode`/`lastError` (≤ 300 chars, no response body stored), `nextAttemptAt = now + BACKOFF[attempts-1]`. After attempt 6 the row is `failed`.
    - The endpoint's `failingSince` is set on the first failure. When it is ≥ 72 h old, the endpoint is disabled (`active = false`, `disabledReason = "failing"`) and `connector_needs_attention` goes to members with `api_keys.manage`, once.
    - A `safeFetch` `UnsafeUrlError` disables the endpoint at once (`disabledReason = "unsafe_url"`).
    - Re-enabling resets `failingSince`.
  - **Secrets:**
    - `whsec_<32 bytes base64url>`, stored with `encryptSecret` (TOKEN_ENC_KEY, SP-19 R5); production refuses without the key (503 `webhooks.encryption_unavailable`). Shown once on create/rotate and never returned again.
    - Rotation keeps `previousSecretEnc` until `previousSecretExpiresAt = now + 24 h`.
  - **Rules:** an endpoint's URL can be edited only by deleting and recreating it (Tkana precedent: a URL change would redirect signed data). Events, description and `active` are editable.
  - **Retention:** a daily cron deletes deliveries older than 30 days.
- **`safeFetch`** (`backend/src/common/safe-fetch.ts`, new; there is no general SSRF guard today):
  - https only;
  - `dns.lookup(host, {all: true})`, refusing any address that is loopback, private (RFC 1918), link-local, CGNAT `100.64/10`, `0.0.0.0/8`, metadata `169.254.169.254`, IPv6 ULA/link-local/loopback or IPv4-mapped forms of those;
  - connects through an `https.Agent` whose `lookup` returns the validated IP (pinning, so no DNS rebinding);
  - redirects are not followed (a 3xx is a failure);
  - port 443 or 8443 only;
  - the response is read to at most 2 KB and discarded.
  - **Test-only loopback:** when `WEBHOOK_TEST_LOOPBACK === "zz-verify"` **and** `FLY_APP_NAME` is unset, `http://127.0.0.1:<port>` is allowed. The production app never has the variable, and the check refuses it on Fly anyway (ruling 5).
  - URL validation runs at create time too (400 `webhooks.unsafe_url`).
- **OAuth authorization server for MCP** (`backend/src/oauth/`; ruling 6).
  - **Discovery** (outside the `/api` prefix via `app.setGlobalPrefix("api", {exclude: [...]})`, and also under `/api/...`):
    - `GET /.well-known/oauth-protected-resource/api/mcp/v1` (RFC 9728) → `{resource: <MCP url>, authorization_servers: [<backend origin>], scopes_supported: ["mcp"]}`;
    - `GET /.well-known/oauth-authorization-server` (RFC 8414) → the endpoints, `code_challenge_methods_supported: ["S256"]`, `grant_types_supported: ["authorization_code","refresh_token"]`, `token_endpoint_auth_methods_supported: ["none"]`.
  - **Register:** `POST /oauth/register` (RFC 7591, public, 10/h per IP) `{client_name ≤ 80, redirect_uris[] ≤ 5}`.
    - Each URI must be `https:` or a loopback `http://127.0.0.1|localhost:*` (desktop clients), with no fragment.
    - It stores an `OAuthClient` and returns `{client_id}`. These are public clients; there is no secret.
  - **Authorize:** `GET /oauth/authorize?response_type=code&client_id&redirect_uri&code_challenge&code_challenge_method=S256&state&scope` (public).
    - It validates the client and requires an **exact** `redirect_uri` match and S256. An invalid client or redirect URI → a 400 page, never a redirect.
    - It then redirects to `${APP_PUBLIC_URL}/#/oauth/consent?req=<signed request, 10 min>`. The request is a JWT `{purpose:"oauth_req", clientId, redirectUri, codeChallenge, state, scope}` refused by `AuthGuard` as a session.
  - **Consent:** `POST /oauth/consent {req, workspaceId, decision: "allow"|"deny"}` (authenticated, membership-exempt; the service checks membership of `workspaceId`).
    - `allow` requires `Workspace.aiToolsEnabled`, the member not blocked, and the member holding at least one `view` permission.
    - It creates a single-use `OAuthCode` (sha256 at rest, 60 s) bound to `{clientId, userId, workspaceId, redirectUri, codeChallenge}` and returns `{redirectTo: redirect_uri?code&state}`.
    - `deny` → `{redirectTo: …?error=access_denied&state}`.
  - **Token:** `POST /oauth/token` (public, form or JSON).
    - `authorization_code`: consume the code with a conditional update; verify `sha256(code_verifier)` base64url = challenge, the client and the redirect URI. Then create or reuse the `OAuthGrant` for `(workspaceId, userId, clientId)` and issue:
      - an access token: a JWT `{aud:"crm-mcp", sub:userId, ws, gid, exp: 1 h}`;
      - a refresh token `crr_<32 bytes>` whose sha256 is stored on the grant.
    - `refresh_token`: rotate. Presenting an already-rotated refresh token revokes the grant (reuse detection). A refresh token not used for 90 days → `invalid_grant` (idle expiry, Tkana precedent).
  - **Revoke:** `POST /oauth/revoke` (RFC 7009) revokes the grant.
  - **MCP guard** (`mcp-server/mcp-auth.guard.ts`):
    - A Bearer `mcp_…` is the legacy path, unchanged (full workspace access).
    - A Bearer JWT with `aud:"crm-mcp"` → verify, then load the grant **from the DB on every request** (no cache, so a block is immediate; MCP traffic is low). Refuse with 401 and `WWW-Authenticate: Bearer resource_metadata="…"` when:
      - the grant is revoked;
      - the member is gone or `aiToolsBlockedAt` is set;
      - the workspace's `aiToolsEnabled` is false;
      - the workspace is payment-locked.
    - On success it sets `req.user = {sub: userId, workspaceId, role: "member", oauthGrantId}` and touches `lastUsedAt` (throttled 60 s).
    - No token → 401 with the same header (MCP clients start discovery from it).
  - **Per-member tools.**
    - `mcp-tools.factory.ts` `build(workspaceId, viewer?)`.
    - With a viewer (OAuth), each tool requires its `TOOL_PERMISSIONS` entry:
      - `list_appointments/get_appointment/find_slots/list_services`: `bookings.view`;
      - `create_appointment/update_appointment`: `bookings.update` (create: `bookings.create`);
      - `cancel_appointment`: `bookings.update`;
      - `search_contacts/get_contact`: `contacts.view`;
      - `create_contact`: `contacts.create`;
      - `update_contact`: `contacts.update`;
      - `list_photos`: `conversations.view`.
    - A tool the member cannot use is **not listed**, and calling it is refused.
    - Services get the viewer, so SP-25 per-record rules apply.
    - Without a viewer (legacy token), behaviour is unchanged.
- **AI-tools settings** (`backend/src/oauth/ai-tools.controller.ts`):
  - `Workspace.aiToolsEnabled` (default false). Turning it off revokes nothing but refuses every OAuth request while off.
  - `WorkspaceMember.aiToolsBlockedAt`.
  - Owner-only actions use `api_keys.manage` **plus** `PermissionService.assertOwner` (roadmap: "owner enables it … can block a member"; ruling 7).
  - Members list and revoke **their own** grants.
  - SP-26 removal of a member revokes their grants in the same transaction (a hook in `removeWithHandover`).

**Tech Stack:** NestJS 10, Prisma 5 (Postgres/Neon), jest/ts-jest; React 18 + Vite, vitest. **No new dependencies.** JWTs use the existing `@nestjs/jwt`; hashing and HMAC use `node:crypto`; `safeFetch` uses `node:https` and `node:dns`. No Anthropic/Claude API code is involved: the MCP server is called *by* external AI tools, and SP-27 does not call any model. If a later change adds model calls, it must follow the claude-api skill.

**Spec:** roadmap §SP-27, plus the Global Constraints and Review Focus 1. Carried contracts:
- **SP-25:**
  - `catalog.ts` (`api_keys` resource exists; actions `view|create|update|delete|manage`);
  - `PermissionService.{effective, can, assertCanGrant, assertOwner, conversationScope, membersWith}`;
  - `PermissionGuard`, `permission-map.ts` + `permission-map.spec.ts`, `system-role-decisions.spec.ts`, `permission-sidedoors.spec.ts`;
  - `VIEWER_HIDDEN` includes `api_keys`.
- **SP-26:** `AuditService.record` (`actorKind: "api_key"`), session version in `AuthGuard` (keys skip it), `removeWithHandover` (grant revocation hook).
- **SP-19 R5:** `common/token-crypto.ts`.
- **SP-05:** `NotificationsService.notify`, type `connector_needs_attention`.
- Existing:
  - `workflows/workflow-events.ts` (`WORKFLOW_TRIGGER_EVENT`) and its emit points (`contacts.service.ts:359`, `inbound-sink.service.ts:149`, `zernio.service.ts:1809`, `tickets.service.ts:395,623,856`, `bookings/booking-writer.ts:202`);
  - `workflows/workflow-webhook-signature.guard.ts` (inbound HMAC + `timingSafeEqual`, the verifier pattern);
  - `mcp-server/*`, `integrations/mcp-token.{service,controller}.ts`, `settings/McpAccessCard.tsx`, `settings/IntegrationsTab.tsx`;
  - `common/rate-limit.ts`.

Consumers that build on this plan:
- **SP-23 connectors:** reuse `safeFetch` and the encrypted-secret pattern.
- **SP-28:** `api_keys` stays out of plan gating, or a plan may gate it (the catalogue decides).
- **SP-29:** the consent page shows the workspace logo.

Tkana reference (read-only, untrusted data; `C:\Users\ashra\Downloads\tkana-main\tkana-main\apps`):
- `api/src/features/api-keys/api-keys.{handlers,middleware}.ts`: `tko_` + 32 random bytes, sha256 hex, 12-character display prefix, expiry check, throttled `lastUsedAt`.
- `api/src/features/api-keys/api-keys.scopes.ts`, `web/app/lib/api-key-scopes.ts`: `read|write|delete|admin`; write implies read; admin implies all; the self-serve picker never offers admin.
- `api/src/public/v1/webhooks/{webhooks.schemas,webhooks.secrets}.ts`, `api/src/functions/webhooks/deliver.function.ts`:
  - the events list;
  - `whsec_` secrets, encrypted and shown once; rotation keeps the old secret 24 h;
  - `t=…,v1=…` HMAC over `t.body`;
  - 6 attempts at 1 m/5 m/30 m/2 h/8 h;
  - disabled after 72 h of failure, or immediately on an unsafe URL;
  - the URL is immutable.
- `api/src/core/safe-fetch.ts`: https only, DNS check with IP pinning, private ranges refused, redirects re-checked.
- `mcp/src/mastra/work/auth.ts`, `web/app/routes/{settings.ai-tools,oauth-consent}.tsx`: protected-resource metadata, `WWW-Authenticate`, an org switch, member block, 90-day idle connections, refusal reasons `switch_off | member_blocked | no_access`, a consent page with an org picker.

What we take and what we don't:
- We take: the key format and hashing, the scope words and implication rules, the webhook signature scheme, the retry schedule, the auto-disable, secret rotation, the immutable URL, `safeFetch`'s rules, the AI-tools switch/block/disconnect model, and 90-day idle grants.
- We do **not** take:
  - Clerk as the authorization server (we have none, so ours is in-app; ruling 6);
  - exchanging the OAuth token for a 15-minute read-only key (ours runs the member's own permissions; ruling 8);
  - platform keys (`tkp_`);
  - "member-acting" keys as a separate kind (all our keys act as their creator);
  - the 24-resource scope list (ours is the SP-25 catalogue subset).

## Global Constraints
- **Data (exact names; later SPs build on them):**
  ```
  model ApiKey {
    id          String    @id @default(cuid())
    workspaceId String
    workspace   Workspace @relation("WorkspaceApiKeys", fields: [workspaceId], references: [id], onDelete: Cascade)
    name        String
    prefix      String    @unique // "crm_<12 hex>"
    hash        String    @unique // sha256 hex of the full key
    scopes      Json      // {"contacts": ["read","write"], …}
    createdById String
    createdBy   User      @relation("ApiKeyCreatedBy", fields: [createdById], references: [id], onDelete: Cascade)
    expiresAt   DateTime?
    lastUsedAt  DateTime?
    revokedAt   DateTime?
    createdAt   DateTime  @default(now())

    @@index([workspaceId, createdAt])
  }

  model WebhookEndpoint {
    id                      String    @id @default(cuid())
    workspaceId             String
    workspace               Workspace @relation("WorkspaceWebhookEndpoints", fields: [workspaceId], references: [id], onDelete: Cascade)
    url                     String
    description             String?
    events                  String[]
    secretEnc               String    // enc:v1:… (token-crypto)
    previousSecretEnc       String?
    previousSecretExpiresAt DateTime?
    active                  Boolean   @default(true)
    disabledReason          String?   // "manual" | "failing" | "unsafe_url"
    failingSince            DateTime?
    createdById             String?
    createdBy               User?     @relation("WebhookEndpointCreatedBy", fields: [createdById], references: [id], onDelete: SetNull)
    createdAt               DateTime  @default(now())
    updatedAt               DateTime  @updatedAt
    deliveries              WebhookDelivery[]

    @@index([workspaceId])
  }

  model WebhookDelivery {
    id            String          @id @default(cuid())
    workspaceId   String
    endpointId    String
    endpoint      WebhookEndpoint @relation(fields: [endpointId], references: [id], onDelete: Cascade)
    eventId       String
    event         String
    payload       Json
    status        String          @default("pending") // "pending" | "delivered" | "failed"
    attempts      Int             @default(0)
    nextAttemptAt DateTime        @default(now())
    leaseUntil    DateTime?
    responseCode  Int?
    lastError     String?
    deliveredAt   DateTime?
    createdAt     DateTime        @default(now())

    @@unique([endpointId, eventId])
    @@index([status, nextAttemptAt])
    @@index([endpointId, createdAt])
    @@index([workspaceId, createdAt])
  }

  model OAuthClient {
    id           String   @id @default(cuid())
    clientId     String   @unique // "crc_<16 bytes base64url>"
    name         String
    redirectUris String[]
    createdAt    DateTime @default(now())
  }

  model OAuthCode {
    id            String    @id @default(cuid())
    codeHash      String    @unique
    clientId      String
    userId        String
    workspaceId   String
    redirectUri   String
    codeChallenge String
    expiresAt     DateTime
    usedAt        DateTime?
    createdAt     DateTime  @default(now())

    @@index([expiresAt])
  }

  model OAuthGrant {
    id                 String    @id @default(cuid())
    workspaceId        String
    workspace          Workspace @relation("WorkspaceOAuthGrants", fields: [workspaceId], references: [id], onDelete: Cascade)
    userId             String
    user               User      @relation("UserOAuthGrants", fields: [userId], references: [id], onDelete: Cascade)
    clientId           String
    scopes             String[]  @default(["mcp"])
    refreshHash        String?   @unique
    prevRefreshHash    String?   @unique // reuse detection
    refreshIssuedAt    DateTime?
    lastUsedAt         DateTime?
    revokedAt          DateTime?
    revokedReason      String?   // "user" | "owner" | "member_removed" | "refresh_reuse" | "idle"
    createdAt          DateTime  @default(now())

    @@unique([workspaceId, userId, clientId])
    @@index([workspaceId, revokedAt])
  }

  model Workspace      { /* … */ aiToolsEnabled Boolean @default(false) }
  model WorkspaceMember { /* … */ aiToolsBlockedAt DateTime? }
  ```
  - Back-relations on `Workspace`, `User` are Prisma-only. `OAuthCode` has no FKs (short-lived; swept by a daily cron when expired).
  - **Roadmap names kept:** `ApiKey {name, prefix, hash, scopes Json, expiresAt?, lastUsedAt?, revokedAt?}`, `WebhookEndpoint {url, events String[], secretEnc, active}`, `WebhookDelivery {endpointId, event, status, attempts, responseCode}`, `OAuthGrant {userId, clientId, scopes, revokedAt?}`. Everything else is additive.
- **Constants:**
  - `api-key-scopes.ts`: `KEY_ACTIONS = ["read","write","delete","admin"]`, `KEY_RESOURCES` (Architecture), `scopesToPermissions(scopes)`, `validateScopes(scopes)`.
  - `webhook-events.ts`: `WEBHOOK_EVENTS = ["contact.created","conversation.assigned","message.received","ticket.created","ticket.stage_changed","booking.created","booking.completed"]`, `WEBHOOK_BACKOFF_MS = [60e3, 300e3, 1800e3, 7200e3, 28800e3]`, `WEBHOOK_MAX_ATTEMPTS = 6`, `WEBHOOK_DISABLE_AFTER_MS = 72 h`, `WEBHOOK_ROTATION_OVERLAP_MS = 24 h`, `WEBHOOK_ENDPOINTS_MAX = 10` per workspace.
  - `API_KEYS_MAX = 25` active per workspace; `API_KEY_RPM = 600`.
  - `OAUTH_ACCESS_TTL_S = 3600`, `OAUTH_CODE_TTL_S = 60`, `OAUTH_IDLE_MS = 90 d`.
  - Frontend mirrors live in `src/screens/settings/developers/apiModel.ts`; a test pins equality of the lists.
- **DTOs:**
  - `CreateApiKeyDto {name ≤ 60, scopes: Record<KeyResource, KeyAction[]>, expiresAt?: ISO date > now and ≤ now + 2 y}`.
  - `ApiKeyDto = {id, name, prefix, scopes, createdBy: {id, name}, expiresAt, lastUsedAt, revokedAt, status: "active"|"expired"|"revoked", createdAt}`. Create also returns `key` once.
  - `CreateWebhookDto {url, events ⊆ WEBHOOK_EVENTS (≥ 1), description? ≤ 200}`; `UpdateWebhookDto {events?, description?, active?}` (no `url`).
  - `WebhookEndpointDto = {id, url, description, events, active, disabledReason, failingSince, hasPreviousSecret, createdAt}`. Create and rotate also return `secret` once.
  - `WebhookDeliveryDto = {id, eventId, event, status, attempts, responseCode, lastError, nextAttemptAt, deliveredAt, createdAt}`. The payload is included only on `GET …/deliveries/:id`.
  - `AiToolsStateDto = {enabled, address, blocked, isOwner, myConnections: GrantDto[]}`; `GrantDto = {id, clientName, user: {id, name}, createdAt, lastUsedAt, revokedAt}`.
- **API** (every route workspace-scoped unless public; a foreign id gives **404**):
  - `GET /api-keys` (`api_keys.view`) → `{items: ApiKeyDto[]}`.
  - `POST /api-keys` (`api_keys.create`) → `ApiKeyDto & {key}`.
  - `DELETE /api-keys/:id` (`api_keys.delete`) → revoke, `{ok: true}`, idempotent.
  - `GET /webhooks` (`api_keys.view`), `POST /webhooks` (`api_keys.create`), `PATCH /webhooks/:id` (`api_keys.update`), `DELETE /webhooks/:id` (`api_keys.delete`).
  - `POST /webhooks/:id/rotate-secret` (`api_keys.update`) → `{secret}`.
  - `POST /webhooks/:id/test` (`api_keys.update`) → enqueues a `ping` and returns the delivery id.
  - `GET /webhooks/:id/deliveries?status&cursor` (`api_keys.view`), `GET /webhooks/:id/deliveries/:deliveryId` (`api_keys.view`).
  - `POST /webhooks/:id/deliveries/:deliveryId/redeliver` (`api_keys.update`) → a new pending row with the same `eventId` suffixed `:r<n>`.
  - `GET /ai-tools` (`authenticated` → membership required in the service) → `AiToolsStateDto`.
  - `PATCH /ai-tools {enabled}` (`api_keys.manage` + owner).
  - `GET /ai-tools/connections` (`api_keys.manage` + owner).
  - `POST /ai-tools/members/:userId/block`, `/unblock` (`api_keys.manage` + owner).
  - `DELETE /ai-tools/connections/:grantId` (`authenticated`; own grant, or owner for any).
  - **Public:** `GET /.well-known/oauth-protected-resource/api/mcp/v1`, `GET /.well-known/oauth-authorization-server`, `POST /oauth/register`, `GET /oauth/authorize`, `POST /oauth/token`, `POST /oauth/revoke`.
  - `POST /oauth/consent` (`authenticated`) and `GET /oauth/consent/preview?req=` (`authenticated`) → `{clientName, redirectHost, workspaces: {id, name, allowed, reason?}[]}`.
- **Error keys** (`api-key-errors.ts`, `webhook-errors.ts`, `oauth-errors.ts`; the OAuth endpoints return RFC 6749 `{error, error_description}` instead):
  - 400: `api_keys.scope_not_allowed`, `api_keys.invalid_expiry`, `webhooks.unsafe_url`, `webhooks.invalid_events`, `webhooks.url_immutable`;
  - 401: `api_keys.invalid`;
  - 403: `api_keys.route_not_allowed`, `api_keys.scope_above_role`, `ai_tools.owner_only`;
  - 404: `api_keys.not_found`, `webhooks.not_found`, `ai_tools.grant_not_found`;
  - 409: `api_keys.limit_reached`, `webhooks.limit_reached`;
  - 429: `api_keys.rate_limited`;
  - 503: `webhooks.encryption_unavailable`.
  - Frontend `src/screens/settings/developers/developerErrors.ts` has `tx` copy for every key, with a test covering every key.
- **Copy and layout:**
  - Every string through `tx("English","العربية")` with real Arabic: "API keys" / "مفاتيح API", "Webhooks" / "الويب هوكس", "AI tools" / "أدوات الذكاء الاصطناعي", "Copy it now; you won't see it again" / "انسخه الآن؛ لن يظهر مرة أخرى", "Read" / "قراءة", "Write" / "كتابة", "Delete" / "حذف", "Admin" / "إدارة كاملة", "Delivered" / "تم التسليم", "Retrying" / "إعادة المحاولة", "Failed" / "فشل", "Block" / "حظر", "Disconnect" / "فصل", "Allow access" / "السماح بالوصول".
  - Logical CSS only. Keys, secrets, URLs, event names and response codes are in `<bdi dir="ltr">` with `font-family: var(--mono)`. Dialogs set `dir`.
  - The consent page is a public-shell page (no sidebar) with the workspace name (SP-29 adds the logo).
- **Permissions (SP-25).** No catalogue change. `permission-map.ts` adds every route above with its rule (public routes `"public"`, consent/ai-tools state `"authenticated"`). `system-role-decisions.spec.ts` adds an `SP-27 developer routes` block:
  - Owner: everything.
  - Admin: keys and webhooks, but not the AI-tools switch/block (403 `ai_tools.owner_only`).
  - Agent: no `api_keys` → 403 on keys/webhooks; can read `GET /ai-tools` and disconnect own grants.
  - Viewer (`api_keys` hidden): same as the agent.
  - Impersonation: blocked for `POST /api-keys`, `POST /webhooks`, `rotate-secret` (add to `blockedForImpersonation`; ruling 10).

  `permission-sidedoors.spec.ts` adds:
  - `api key of an assigned-only creator cannot read unassigned conversations`;
  - `api key cannot call auth or membership-exempt routes`;
  - `oauth mcp tools hide conversations the member cannot see`.
- **Secrets:** API keys and refresh tokens are stored only as sha256. OAuth codes are stored only as sha256. Webhook secrets are encrypted with `TOKEN_ENC_KEY` and returned only once. None of them, nor `Authorization` headers, appear in any log line or error body; a captured-`Logger` spec asserts it.
- **Outbound HTTP:** every spec stubs `safeFetch`'s transport. No spec opens a socket to a non-loopback address. Verification uses a loopback receiver under the test flag.
- **Migration:**
  - File: `backend/prisma/migrations/20261118130000_api_keys_webhooks/migration.sql`, after SP-26's `20261118120000_members_security`. **Every applied migration is never edited.** Hand-written, LF line endings, `SET lock_timeout = '5s'` first; apply with `npx prisma migrate deploy` only.
  - **Additive and idempotent:**
    - `CREATE TABLE IF NOT EXISTS` for `ApiKey`, `WebhookEndpoint`, `WebhookDelivery`, `OAuthClient`, `OAuthCode`, `OAuthGrant`;
    - every unique and index as listed, with Prisma names (`ApiKey_prefix_key`, `ApiKey_hash_key`, `ApiKey_workspaceId_createdAt_idx`, `WebhookDelivery_endpointId_eventId_key`, `WebhookDelivery_status_nextAttemptAt_idx`, `OAuthGrant_workspaceId_userId_clientId_key`, `OAuthGrant_refreshHash_key`, `OAuthGrant_prevRefreshHash_key`, …), each `IF NOT EXISTS`;
    - `ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "aiToolsEnabled" BOOLEAN NOT NULL DEFAULT false;`
    - `ALTER TABLE "WorkspaceMember" ADD COLUMN IF NOT EXISTS "aiToolsBlockedAt" TIMESTAMP(3);`
    - FKs in `DO $$ … duplicate_object` blocks: `ApiKey_workspaceId_fkey` (CASCADE), `ApiKey_createdById_fkey` (CASCADE, ruling 2), `WebhookEndpoint_workspaceId_fkey` (CASCADE), `WebhookEndpoint_createdById_fkey` (SET NULL), `WebhookDelivery_endpointId_fkey` (CASCADE), `OAuthGrant_workspaceId_fkey` (CASCADE), `OAuthGrant_userId_fkey` (CASCADE).
  - `prisma migrate diff` (no DB) must equal the file apart from `IF NOT EXISTS`, the `DO` wrappers and `lock_timeout`.
  - **Safe for the deployed `main`:**
    - new tables only, plus two columns with constant defaults or nullable;
    - `main` never sees `crm_` tokens (they fail its JWT check → 401, as any bad token does);
    - the legacy `mcp_` token path is unchanged;
    - no `UPDATE`, `DELETE`, `DROP` or `ALTER … TYPE`.
  - **No backfill.**
- **Tests:**
  - backend: `npx jest src/api-keys src/webhooks src/oauth src/mcp-server src/common src/permissions src/auth` plus `npx tsc --noEmit -p tsconfig.json`; the full `npm test` once per task. Known unrelated failure: `hjz-client-sync › is inert when HJZ is not configured`.
  - frontend: `npx vitest run` plus `npm run typecheck`; `npm run build` once in Task 4.
  - **Named acceptance tests (exact names):**
    - `key without contacts.write gets 403 on POST /contacts` (backend jest, `src/api-keys/api-key-auth.spec.ts`, through the real `AuthGuard` + `PermissionGuard` on a Nest testing app)
    - `webhook retried with backoff and signed` (backend jest, `src/webhooks/webhook-dispatcher.spec.ts`)
    - `blocked member's OAuth token rejected` (backend jest, `src/oauth/mcp-oauth.spec.ts`)
- **Commits:** selective `git add <paths>`, never `-A`. Trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not stage `.playwright-mcp/`, `.claude/worktrees/` or any untracked file this plan did not create.

## Review Focus
1. **A key is never more than its creator (Review Focus 1).**
   - Effective permissions = creator's current role ∩ scopes, re-evaluated per request.
   - A key whose creator lost a permission, left, or has `assigned` visibility sees no more than the creator.
   - Keys cannot reach auth, membership, roles, billing, keys or webhooks.
   - Tests:
     - `key without contacts.write gets 403 on POST /contacts`
     - `api key of an assigned-only creator cannot read unassigned conversations`
     - `key of a removed creator is 401`
     - `api key cannot call auth or membership-exempt routes`
     - `scope above creator role is refused at mint`
2. **Webhooks cannot be turned into SSRF or data leaks.**
   - Only public https addresses, pinned IPs, no redirects.
   - Payloads are built by a whitelist serializer from records of the endpoint's own workspace.
   - Secrets are encrypted, shown once, and never logged.
   - Tests:
     - `safeFetch refuses private, loopback, link-local and metadata addresses`
     - `safeFetch pins the validated ip`
     - `redirect is a failure`
     - `payload serializer exposes only whitelisted fields`
     - `event of workspace A never reaches workspace B endpoint`
3. **Delivery semantics.**
   - At-least-once, signed, with backoff; exactly one in-flight attempt per delivery across machines; no duplicate rows for one event per endpoint.
   - Auto-disable after 72 h, with one notification.
   - Tests:
     - `webhook retried with backoff and signed`
     - `two dispatchers never send the same attempt`
     - `endpoint disabled after 72h of failures notifies once`
     - `rotation signs with both secrets for 24h`
4. **OAuth correctness.**
   - PKCE S256 is required.
   - Redirect URIs match exactly.
   - Codes are single-use and live 60 s.
   - Refresh tokens rotate, and reuse revokes the grant.
   - A blocked or removed member, a switched-off workspace, a revoked grant or a payment lock → 401 at once.
   - MCP tools run with the member's permissions.
   - Tests:
     - `blocked member's OAuth token rejected`
     - `pkce mismatch is invalid_grant`
     - `redirect uri must match exactly`
     - `refresh token reuse revokes the grant`
     - `oauth mcp tools hide conversations the member cannot see`
     - `legacy mcp token unchanged`

## Architecture Rulings and Risks
Each item names the risk, then the recommended ruling. Items marked **(needs controller ruling)** are repeated under Controller rulings, where the controller fills in the decision.

1. **Scope vocabulary.** The roadmap says "resource × read/write/delete/admin", but the SP-25 catalogue uses `view|create|update|delete|manage`.
   - **Ruling:** store the Tkana words on the key, mapped to catalogue actions (Architecture). Acceptance `contacts.write` = `contacts: ["write"]`.
   - **Alternative:** store catalogue actions directly. **(needs controller ruling, minor)**
2. **Who a key acts as.**
   - **Ruling:** every key acts as its creator, and its permissions are the creator's current role intersected with its scopes. If the creator is removed, the key stops working (and is cascade-deleted with the user row).
   - This gives correct row-level visibility and audit names, at the cost that keys die when their creator leaves. The UI warns and lists keys in the SP-26 handover dialog.
   - **Alternative:** workspace-level keys with no user, which would need a synthetic actor everywhere `createdById` and visibility are used. **(needs controller ruling)**
3. **Which resources a key may hold.**
   - **Ruling:** `contacts, conversations, tickets, pipelines, bookings, campaigns, templates, audiences, reports`. Never `members, roles, billing, api_keys, settings, connectors, agent, knowledge, channels, workflows` (keys must not mint keys, change people or money, or reconfigure channels and the agent).
   - **Alternative:** allow `knowledge` and `channels` read. **(needs controller ruling, minor)**
4. **Webhook events v1.**
   - **Ruling:**
     - the five events that already have emits (`contact.created`, `message.received`, `ticket.created`, `ticket.stage_changed`, `booking.completed`);
     - two new emits (`booking.created` in `booking-writer.ts`; `conversation.assigned` in the SP-01 assign path);
     - `ping`.
     - Tkana's other 20 events (updates, deletes, merges, sent messages, …) are deferred; each needs an emit point and a payload contract.
     - Delivery rows are inserted by an async listener **after** the emitting service's write; any emit currently inside a transaction is moved after commit in this task (the implementer lists them).
   - **Alternative:** a transactional outbox written inside each writer's transaction (stronger, touches every writer). **(needs controller ruling)**
5. **Testing webhooks without sending anywhere.** `safeFetch` refuses loopback, but verification needs a local receiver.
   - **Ruling:** a test-only escape `WEBHOOK_TEST_LOOPBACK=zz-verify`, honoured only when `FLY_APP_NAME` is unset, permitting `http://127.0.0.1:<port>`. A spec proves the escape is refused when `FLY_APP_NAME` is set or the value differs.
   - **Alternative:** inject the transport in verification (no HTTP at all). It cannot prove the real HTTP path. **(needs controller ruling)**
6. **Building our own OAuth authorization server.** Tkana delegated it to Clerk; we have no identity provider. A home-made AS is security-sensitive.
   - **Ruling:** a minimal OAuth 2.1 AS scoped to MCP:
     - public clients only, DCR, code + PKCE S256, exact redirect match;
     - JWT access tokens (1 h, `aud: crm-mcp`) checked against the grant on every MCP call;
     - rotating refresh tokens with reuse detection;
     - no implicit, password or client-credentials grants.
   - It follows the MCP authorization spec (2025-06-18: RFC 9728 protected-resource metadata, RFC 8414, RFC 7591), with an extra security review task before merge.
   - **Alternatives:** defer OAuth to a follow-up (ship keys and webhooks only, sizing M as the roadmap says); or use a hosted AS (Auth0/WorkOS: a new vendor and a new dependency). **(needs controller ruling)**
7. **Who controls AI tools.**
   - **Ruling:** owners only (`api_keys.manage` + `assertOwner`) for the switch, block and the list of everyone's connections. Every member sees the address when enabled and not blocked, and disconnects their own tools.
   - **Alternative:** admins too (`api_keys.manage` alone). **(needs controller ruling, minor)**
8. **What an OAuth MCP session may do.**
   - **Ruling:** the member's own permissions per tool (`TOOL_PERMISSIONS`), including writes they are allowed in the app. Tools they cannot use are hidden. Conversation visibility applies.
   - **Alternative:** read-only tools only for OAuth (Tkana's 15-minute read-only key), leaving writes to the legacy token. **(needs controller ruling)**
9. **API docs.** There is no public API documentation today.
   - **Ruling:** a hand-written bilingual `public/developers.html` (served by the frontend host; linked from the API keys tab). `developers-doc.spec.ts` parses its route table and asserts each route exists in `permission-map.ts` and is key-callable. OpenAPI generation is deferred.
   - **Alternative:** `@nestjs/swagger` (a new dependency, and it would need DTO annotations everywhere). **(needs controller ruling, minor)**
10. **Impersonation.** Super-admins impersonating a workspace should not mint credentials that outlive the session.
    - **Ruling:** block `POST /api-keys`, `POST /webhooks` and `rotate-secret` for impersonators. **(needs controller ruling, minor)**
11. **Well-known paths and the `/api` prefix.**
    - The MCP clients discover metadata at the host root (`/.well-known/...`), while every route today is under `/api`.
    - **Ruling:** `setGlobalPrefix("api", {exclude: [the two well-known GETs]})` on the backend host (`BACKEND_PUBLIC_URL`, which is what `mcpEndpointUrl()` advertises), plus the same handlers under `/api/.well-known/...`.
    - The user must confirm the Fly/backend host serves the root path (a deploy check, not code). **(needs controller ruling)**
12. **Shared files with SP-26** (`auth.guard.ts`, `permission.guard.ts`, `schema.prisma`, `permission-map.ts`, `system-role-decisions.spec.ts`, `permission-sidedoors.spec.ts`, `Settings.tsx`, `workspaces.service.ts` removal hook).
    - **Ruling:** SP-27 bases on the commit that ships SP-26 and records the SHA. Task 1 owns `schema.prisma` and the migration. The migration applies after SP-26's. **(needs controller ruling)**
13. **Verification touches production** (as SP-09 R12).
    - Task 5 runs against the production DB in throwaway workspaces, with a loopback webhook receiver and a scripted MCP OAuth client, and no other provider.
    - The migration needs the user's **explicit approval**.
    - **(needs controller ruling)**
14. **Size.** The roadmap says M. With an in-app OAuth server this is L: 4 build tasks plus verification. **(needs controller ruling)**

### Controller rulings
*Decided 2026-11-17 by the controller: R1–R5, R9–R14 accepted as proposed. R6: OAuth deferred (user decision), so R7, R8 and R11 apply only as far as they concern API keys and webhooks; the OAuth task and its frontend part are skipped and the roadmap notes it. Base is the current feat/tkana-parity head with SP-26 merged (SHA in the ledger). The migration `20261118130000_api_keys_webhooks` needs explicit user approval before it runs.*
- **R1** (Tkana scope words mapped to catalogue actions): accepted
- **R2** (keys act as their creator; creator ∩ scopes; die with the creator): accepted
- **R3** (key resource allow-list): accepted
- **R4** (events v1: 5 existing + 2 new emits + ping; async listener after commit): accepted
- **R5** (test-only loopback escape, refused on Fly): accepted
- **R6** (minimal in-app OAuth 2.1 AS for MCP, or defer OAuth): deferred (user decision)
- **R7** (owner-only AI-tools controls): accepted where it applies without OAuth
- **R8** (OAuth MCP sessions use the member's own permissions, writes included): accepted where it applies without OAuth
- **R9** (static bilingual developers page with a route-truth spec): accepted
- **R10** (impersonators cannot mint keys or webhooks): accepted
- **R11** (well-known routes excluded from the `/api` prefix; host check by the user): accepted where it applies without OAuth
- **R12** (base on the SP-26 ship commit; Task 1 owns the schema): accepted
- **R13** (verification on the production DB with a loopback receiver; migration needs explicit user approval): accepted
- **R14** (size L; 4 build tasks + verification): accepted

---

### Task 1: Backend — schema, migration, API keys and the guard path
**Owns:** `schema.prisma` and the migration for all of SP-27.

**Files:**
- `backend/prisma/schema.prisma`; `backend/prisma/migrations/20261118130000_api_keys_webhooks/migration.sql`; `backend/src/api-keys/api-keys-webhooks-migration.spec.ts`.
- Create `backend/src/api-keys/`, each with a spec:
  - `api-key-scopes.ts`, `api-key-errors.ts`, `api-key-format.ts` (`newApiKey()`, `parseApiKey()`);
  - `api-keys.service.ts` (`create`, `list`, `revoke`, `authenticate`, the `lastUsedAt` throttle);
  - `api-keys.controller.ts`, `api-keys.module.ts`;
  - `api-key-auth.spec.ts` (a Nest testing app with the real guards and a small contacts controller double).
- `backend/src/auth/auth.guard.ts`: the `crm_` branch (keys skip the SP-26 `sv`/purpose checks); `backend/src/permissions/permission.guard.ts`: the key intersection and the route refusal; `permission.service.ts`: `intersect(a, b)`.
- `backend/src/realtime/realtime.gateway.ts`, `mcp-server/mcp-auth.guard.ts`: refuse `crm_`.
- `backend/src/common/rate-limit.ts` reuse: `ApiKeyRateLimiter`.
- `backend/src/audit/audit.service.ts` (SP-26): accept `actorKind: "api_key"`; `WorkspaceInterceptor` passes `apiKeyId`.
- `permission-map.ts` + spec, `impersonation.ts`, `system-role-decisions.spec.ts` (`SP-27 developer routes`), `permission-sidedoors.spec.ts`.

- [ ] Write the failing tests:
  - `migration is additive, idempotent and Prisma-named (SP-27)` (the SP-26 checklist; the folder name is greater than `20261118120000`; the SP-26 sha256 is pinned).
  - **`key without contacts.write gets 403 on POST /contacts`**:
    - a key `{contacts:["read"]}` → `GET /contacts` 200, `POST /contacts` 403;
    - a key `{contacts:["read","write"]}` → `POST` 201, with `createdById` = the creator.
  - `key of a removed creator is 401`; `revoked key is 401`; `expired key is 401` (one error key for all).
  - `scope above creator role is refused at mint` (an agent-role creator requesting `contacts: ["admin"]` → 403 `api_keys.scope_above_role`); `disallowed resource is 400`.
  - `api key cannot call auth or membership-exempt routes` (`GET /auth/me`, `POST /workspaces` → 403).
  - `api key of an assigned-only creator cannot read unassigned conversations` (sidedoors).
  - `key is never stored in plain text and never logged` (DB holds sha256 only; captured `Logger` free of the key and the `Authorization` header).
  - `lastUsedAt is written at most once per minute`; `rate limit returns 429 with Retry-After`.
  - `permission map covers SP-27 routes`; the `SP-27 developer routes` system-role block.
- [ ] Implement until green. `npx tsc --noEmit -p tsconfig.json`, the jest paths, the full `npm test` once; `npx prisma generate`. **Do not run `migrate`.**
- [ ] Commit `feat(api-keys): scoped organization api keys acting as their creator`.

### Task 2: Backend — webhooks, safeFetch, dispatcher
**Depends on:** Task 1.

**Files:**
- `backend/src/common/safe-fetch.ts` + spec.
- Create `backend/src/webhooks/`, each with a spec:
  - `webhook-events.ts`, `webhook-errors.ts`, `webhook-signature.ts` (`sign(secrets, t, body)`, `verify(...)`, the reference verifier also used in the developers page);
  - `webhook-payloads.ts` (whitelist serializers per event);
  - `webhooks.service.ts` (CRUD, rotate, test, redeliver);
  - `webhook-outbox.listener.ts`, `webhook-dispatcher.ts` (`@Interval`), `webhook-retention.scheduler.ts`;
  - `webhooks.controller.ts`, `webhooks.module.ts`.
- New emits: `bookings/booking-writer.ts` (`booking.created` through `WEBHOOK_EVENT`), the SP-01 assign path in `conversations` (`conversation.assigned`). Move any emit found inside a transaction to after commit.
- `permission-map.ts` entries; `system-role-decisions.spec.ts`.

- [ ] Write the failing tests:
  - **`webhook retried with backoff and signed`**:
    - a fake transport returns 500, 500, 200;
    - attempt 1 at T, attempt 2 at T + 1 min, attempt 3 at T + 1 min + 5 min (fake clock);
    - each request carries `X-Crm-Signature: t=…,v1=…` that `verify()` accepts with the endpoint secret and rejects with a wrong secret or a body changed by one byte;
    - `X-Crm-Event-Id` is the same across attempts; the final status is `delivered` with `attempts = 3`.
    - After 6 failures the row is `failed`, and no 7th attempt is made.
  - `two dispatchers never send the same attempt` (two claims in parallel → one send).
  - `endpoint disabled after 72h of failures notifies once`; `unsafe url at send time disables immediately`.
  - `rotation signs with both secrets for 24h` (two `v1`, then one after expiry).
  - `safeFetch refuses private, loopback, link-local and metadata addresses` (10.x, 172.16.x, 192.168.x, 127.x, 169.254.169.254, 100.64.x, ::1, fc00::, ::ffff:127.0.0.1, a hostname resolving to any of them, `http:`, port 22); `safeFetch pins the validated ip` (the agent's `lookup` returns the validated address even if a second resolution differs); `redirect is a failure`; `test loopback escape refused on Fly or with a wrong value`.
  - `payload serializer exposes only whitelisted fields` (a contact with custom fields, notes and internal ids → only the documented fields); `event of workspace A never reaches workspace B endpoint`.
  - `duplicate emit inserts one delivery per endpoint` (unique `(endpointId, eventId)`).
  - `secret encrypted, shown once, never logged` and `create refuses without TOKEN_ENC_KEY in production` (503).
  - `url is immutable` (`PATCH` with `url` → 400 `webhooks.url_immutable`).
  - `foreign endpoint or delivery id is 404`.
- [ ] Implement until green. tsc, the jest paths, the full `npm test` once.
- [ ] Commit `feat(webhooks): signed outgoing webhooks with retries, ssrf-safe delivery and logs`.

### Task 3: Backend — OAuth for MCP and per-member tools
**Depends on:** Task 1. **Ruling 6 must be accepted**; if OAuth is deferred, this task and its frontend part are skipped and the roadmap notes it.

**Files:**
- Create `backend/src/oauth/`, each with a spec:
  - `oauth-errors.ts`, `pkce.ts`;
  - `oauth-clients.service.ts` (DCR);
  - `oauth.service.ts` (authorize request JWT, consent → code, token exchange, refresh rotation, revoke, idle expiry);
  - `well-known.controller.ts`, `oauth.controller.ts`;
  - `ai-tools.service.ts`, `ai-tools.controller.ts`;
  - `oauth-sweep.scheduler.ts` (expired codes, idle grants);
  - `oauth.module.ts`;
  - `mcp-oauth.spec.ts`.
- `backend/src/main.ts`: `setGlobalPrefix("api", {exclude: [...]})`.
- `backend/src/auth/auth.guard.ts`: refuse `purpose: "oauth_req"` and `aud: "crm-mcp"` tokens as sessions.
- `backend/src/mcp-server/mcp-auth.guard.ts`: the OAuth branch, `WWW-Authenticate`. `mcp-tools.factory.ts`: `build(workspaceId, viewer?)` with `TOOL_PERMISSIONS`, passing the viewer to services.
- `backend/src/members/handover.service.ts` (SP-26): revoke grants on removal.
- `permission-map.ts` entries; `system-role-decisions.spec.ts`; `permission-sidedoors.spec.ts`.

- [ ] Write the failing tests:
  - **`blocked member's OAuth token rejected`**:
    - full flow in the testing app: register client → authorize → consent allow → token → `POST /mcp/v1 tools/list` 200;
    - the owner blocks the member → the same access token → 401 with `WWW-Authenticate` containing `resource_metadata`;
    - refresh → `invalid_grant`;
    - unblock → a new consent works.
  - `switched-off workspace rejects oauth tokens`; `removed member's grant is revoked`; `revoked grant is 401`; `payment-locked workspace is 401`.
  - `pkce mismatch is invalid_grant`; `plain pkce or missing challenge refused`; `redirect uri must match exactly` (a trailing slash or added query → 400 page, no redirect); `code is single-use and expires in 60s`.
  - `refresh token reuse revokes the grant`; `idle grant expires after 90 days`.
  - `consent requires membership and ai tools enabled` (a workspace the user is not in → 404; disabled → refused with a reason in preview).
  - `oauth mcp tools hide conversations the member cannot see` and `tool the member lacks permission for is not listed and refused` (agent without `bookings.update` → `create_appointment` absent; a direct call → error).
  - `legacy mcp token unchanged` (existing `mcp-server.http.spec.ts` stays green: the `mcp_` token lists every tool).
  - `well-known metadata is served at the root and under /api`.
  - `oauth request and access tokens are refused as app sessions`.
  - `no code, token or verifier in any log line`.
- [ ] Implement until green. tsc, the jest paths, the full `npm test` once.
- [ ] Request a focused security review of `src/oauth` and `safe-fetch.ts` (superpowers:requesting-code-review) before committing; fix findings.
- [ ] Commit `feat(oauth): per-member mcp access with pkce, consent and owner controls`.

### Task 4: Frontend — Developers settings, AI tools, consent page, docs
**Depends on:** Tasks 1–3 contracts.

**Files:**
- **F1 Model (pure):**
  - `src/screens/settings/developers/apiModel.ts`: scope matrix rows, implication rules (write ⇒ read, admin ⇒ all), `keyStatus`, `deliveryTone`, the event list mirror.
  - `developerErrors.ts`.
  - `src/auth/oauthConsent.ts`: `parseConsentFragment`, `redirectHostOf`.
  - Tests: `apiModel.test.ts`, `developerErrors.test.ts`, `oauthConsent.test.ts`.
- **F2 Settings tab "Developers"** (`Settings.tsx`: `Tab`, `TAB_IDS`, label, gate `can("api_keys.view")`):
  - `DevelopersTab.tsx` with the sections below;
  - **API keys:** list, `CreateApiKeyDialog.tsx` (name, scope matrix with row toggles, expiry), shown-once key panel with copy, revoke confirm;
  - **Webhooks:** list, `WebhookDialog.tsx` (URL read-only after create, events, description), shown-once secret, rotate, test, `WebhookDeliveries.tsx` (status filter, paging, payload viewer, redeliver);
  - **Legacy MCP token:** the existing `McpAccessCard` moves here, labelled "Legacy token" / "الرمز القديم";
  - a link to `/developers.html`.
- **F3 AI tools** (`AiToolsCard.tsx`, visible to every member):
  - the address with copy;
  - "My connections" with Disconnect;
  - for owners, the switch, all connections, and Block/Allow per member.
- **F4 Consent page** `src/auth/OAuthConsent.tsx` (public shell, requires sign-in, then returns to the consent URL):
  - client name and redirect host;
  - workspace picker with disabled reasons;
  - Allow / Deny → `window.location.assign(redirectTo)`.
  - `src/main.tsx` routes `#/oauth/consent`.
- **F5** `public/developers.html` (static, bilingual toggle, logical CSS, `dir` switch).
- **F6 Types:** `src/lib/types.ts`: `ApiKey`, `WebhookEndpoint`, `WebhookDelivery`, `AiToolsState`, `OAuthGrant`.

- [ ] Write the failing vitest tests:
  - `scope matrix implications and serialization` (write ⇒ read, admin ⇒ all four, unticking read clears write and admin, the output equals the backend shape).
  - `key and delivery status helpers` (expired vs revoked precedence; delivery tones).
  - `developer error copy covers every SP-27 key in both languages`.
  - `consent fragment parsing` (missing `req` → error state; the redirect host shown is the URL's host only).
  - `webhook event list equals the backend list` (shared fixture).
- [ ] Implement, then build the components. `npx vitest run`, `npm run typecheck`, `npm run build` clean.
- [ ] Commit `feat(developers): api keys, webhooks, ai tools settings, consent page and docs`.

### Task 5: Verification
Apply `20261118130000_api_keys_webhooks` with `npx prisma migrate deploy`, only when the controller and the user explicitly approve it (ruling 13). Record the results in `.superpowers/sdd/2026-11-18-sp27-api-keys-webhooks/live-verification.md` (SP-15 format).

**Before approval (read-only, production):** `SELECT count(*) FROM "Workspace"`, `SELECT count(*) FROM "WorkspaceMember"`, `SELECT reltuples FROM pg_class WHERE relname IN ('Workspace','WorkspaceMember')`.

**Isolation** (scripts in the session scratchpad `C:\Users\ashra\AppData\Local\Temp\claude\7b75a64029a712a6\ebb2057a-6300-4548-9aec-b98487880afb\scratchpad\`):
- **Own instance:** `launch-sp27.js` (from `launch-sp26.js`). Backend on **:4260**, outDir `backend/.verify-dist-sp27`, working directory `sp27-run/`. Crons disabled except the webhook dispatcher, which runs on a test hook called by the script. Storage env empty.
- **No external call, ever:**
  - **Webhook receiver:** `webhook-receiver-sp27.js` on `http://127.0.0.1:4259`. It records headers and body to `webhook-receiver-sp27.jsonl` and can be told to answer 500 for the next N requests. `WEBHOOK_TEST_LOOPBACK=zz-verify`; `FLY_APP_NAME` unset.
  - **MCP client:** `mcp-oauth-client-sp27.js` performs DCR, PKCE, consent (through the API with the test user's JWT), token and refresh, then calls `tools/list`/`tools/call` on :4260. It talks only to :4260.
  - **Email** (SP-26): the loopback stub, or `EMAIL_PROVIDER=off`.
  - **Zernio, Meta, l, OpenAI, Stripe, HJZ, Kewy:** every key and base URL an empty string.
  - `TOKEN_ENC_KEY`: a 48-character test value.
  - **The launcher refuses to start** unless `WEBHOOK_TEST_LOOPBACK=zz-verify`, `FLY_APP_NAME` is unset, and every provider variable above is empty. The SP-13 egress guard stays, and `blocked-egress-sp27.jsonl` must be empty at the end.
- Test tag `zz-verify-<ts>`.

**Setup** (ids in `verify-created-sp27.json`):
1. Workspace A: owner, admin, an agent with `assigned` visibility, a viewer. Workspace B: a foreign owner.
2. In A: two contacts, one conversation assigned to the agent and one unassigned, a ticket, a service and a staff resource (SP-10) for a booking.

**Checks:**
- **Migration:** tables, indexes, FKs and both columns exist; `aiToolsEnabled` false for every pre-existing workspace.
- **`key without contacts.write gets 403 on POST /contacts` (live):**
  - mint `{contacts:["read"]}` as the admin → `GET /contacts` 200, `POST /contacts` 403;
  - mint `{contacts:["read","write"]}` → `POST` 201;
  - the agent's key (`conversations:["read"]`) lists only the assigned conversation;
  - a key on `GET /auth/me` → 403;
  - revoke → 401;
  - the DB shows sha256 only;
  - `grep` of the :4260 log for the keys → 0.
- **`webhook retried with backoff and signed` (live):**
  - create an endpoint to `http://127.0.0.1:4259/hook` for `contact.created` and `ticket.stage_changed`;
  - create a contact with the receiver set to fail twice → three deliveries recorded with `nextAttemptAt` gaps of 1 and 5 min (the script advances via the dispatcher hook with a moved `nextAttemptAt` on the test row);
  - the script verifies each signature with the shown-once secret;
  - rotate → the next delivery carries two `v1`;
  - test ping → delivered;
  - an endpoint URL `https://10.0.0.1/x` → 400 `webhooks.unsafe_url`;
  - a workspace B endpoint receives nothing from A's events.
- **`blocked member's OAuth token rejected` (live):**
  - the owner enables AI tools;
  - the agent connects via the client script → `tools/list` lacks the tools the agent role cannot use, and `search_contacts` works;
  - the owner blocks the agent → the next `tools/list` → 401 with `WWW-Authenticate`; refresh → `invalid_grant`;
  - the admin's own connection keeps working;
  - switch off → the admin's call → 401;
  - legacy `mcp_` token (generated for A) → `tools/list` still lists every tool.
- **Refresh reuse:** use a rotated refresh token twice → the grant is revoked (DB `revokedReason = refresh_reuse`).
- **Roles:** agent and viewer per the `SP-27 developer routes` block; the admin toggling AI tools → 403 `ai_tools.owner_only`.
- **Index use:** `EXPLAIN` of the dispatcher claim query uses `WebhookDelivery_status_nextAttemptAt_idx` (in `BEGIN … ROLLBACK` with `enable_seqscan = off`).
- **Migration rerun:** in an always-rolled-back transaction (ask the user if the safety layer refuses).
- **UI through the `verify` skill:** the Developers tab (key create with shown-once panel, scope matrix, webhooks with deliveries), AI tools as owner and as agent, the consent page in English and Arabic (RTL), `developers.html`; screenshots.

**Cleanup:**
- Delete the recorded workspaces (the cascade covers keys, endpoints, deliveries and grants), the test users, and the `OAuthClient`/`OAuthCode` rows created by the script (by `clientId`).
- Delete `webhook-receiver-sp27.jsonl`.
- Residue sweep over every table with a `workspaceId` column, plus `OAuthClient`/`OAuthCode`.
- Before/after counts: `Workspace`, `User`, `WorkspaceMember`, `ApiKey`, `WebhookEndpoint`, `WebhookDelivery`, `OAuthClient`, `OAuthCode`, `OAuthGrant`, `Contact`, `Conversation`, `Ticket`, `Appointment`, `AuditLog`, `Notification`. Every count identical.
- Stop :4260 and the receiver; remove the outDir and `sp27-run/`.

Then tick SP-27's boxes in the roadmap with the rulings and deviations. Pending user actions: confirm the backend host serves `/.well-known/*` at its root (ruling 11), set `TOKEN_ENC_KEY` on Fly. Deferred: the remaining Tkana webhook events, OpenAPI docs, and retiring the legacy MCP token.


### User decisions (2026-11-16)
- **Defer OAuth** (R6): ship API keys and signed webhooks. The in-app OAuth server for AI tools is a follow-up; AI tools keep the existing workspace MCP token.
