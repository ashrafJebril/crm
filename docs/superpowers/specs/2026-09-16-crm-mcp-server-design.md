# CRM as an MCP Server — Design

**Date:** 2026-09-16
**Status:** Approved

**Context:** The CRM already acts as an MCP *client* configuration surface: `McpServersTab.tsx` / `backend/src/integrations/l-mcp.service.ts` (from [[kewy-ai-agent-config]]) let an admin register remote MCP servers that the external "Kewy AI" agent (the `l` platform) can call as tools. This design adds the reverse direction: the CRM itself exposes an MCP **server**, so the `l` platform's agent can call back into this CRM's own appointment/contact data as tools during a conversation. The admin closes the loop by registering this CRM's own MCP endpoint through the *existing* `McpServersTab` "Add server" flow — no new consumer-facing MCP client UI is needed.

Implementation uses [Mastra](https://mastra.ai) (`@mastra/core`, `@mastra/mcp`) to define and serve the tool set, embedded directly in the existing NestJS backend rather than as a separate service.

## Goals

1. Let the `l` platform's agent list/create/update appointments and search/create/update contacts in a specific CRM workspace, scoped to that workspace only.
2. Let a CRM owner/admin generate, view (once), rotate, and revoke a per-workspace access token for this MCP endpoint from Settings → Integrations.
3. Reuse existing business logic (`ContactsService`, `AppointmentsService`) rather than duplicating validation/persistence.

## Non-goals

- No public/self-serve booking UI — this is a machine-to-machine (agent-to-CRM) interface, not a customer-facing booking page.
- No hard-delete tools. The agent can cancel an appointment (status change) but never permanently delete an appointment or contact record.
- No new MCP *client* UI — the admin reuses the existing `McpServersTab` to point the `l` platform at this CRM's new endpoint.
- No support for entities beyond appointments and contacts in this pass (deals/pipeline, tickets, etc. are out of scope).
- No standalone/separate-process deployment — the MCP server is embedded in the existing NestJS backend (see Approach discussion below).

## Approach

Two approaches were considered:

1. **Embedded module in the existing NestJS backend (chosen).** A new controller endpoint builds a fresh Mastra `MCPServer` per request, with tools that are closures over the calling workspace's `ContactsService`/`AppointmentsService`, and serves it over Mastra's stateless Streamable HTTP transport. This matches the codebase's existing pattern of thin in-process proxy modules (e.g. `l-config`) and avoids a second deployment target, a network hop per tool call, and a second auth surface.
2. **Standalone Mastra microservice**, deployed separately, calling back into the CRM over HTTP for data. Rejected: no current justification for the added deployment/ops complexity, and nothing else in this codebase is split this way.

## 1. Data model

Add to `Workspace` in `backend/prisma/schema.prisma` (one migration, additive only):

```prisma
// Per-workspace credential for the inbound MCP server endpoint (POST /mcp/v1).
// The l platform's agent authenticates as this workspace using this token,
// registered via the existing McpServersTab "Add server" flow. Only a bcrypt
// hash is stored — losing the plaintext means generating a new one, same
// contract as lEndpointSecret above.
mcpTokenPrefix String? @unique
mcpTokenHash   String?
mcpTokenCreatedAt DateTime?
```

`mcpTokenPrefix` is plaintext and indexed so the auth guard can find the owning workspace in one lookup before doing the (expensive) bcrypt compare against `mcpTokenHash`.

Token format: `mcp_<12-char-random-prefix>_<32-byte-random-secret>`. Generation replaces any existing prefix/hash (rotation invalidates the old token immediately).

## 2. Backend: token management endpoints

New routes on the existing `integrations` surface (`backend/src/integrations/`), gated to `owner`/`admin` roles (mirrors `IntegrationsTab`'s `canEdit` convention):

- `GET /integrations/mcp/token/status` → `{ connected: boolean, prefix?: string, createdAt?: string }`. Never returns the hash or the full token.
- `POST /integrations/mcp/token` → generates (or rotates) the token, returns `{ token: string, endpointUrl: string }` — the **only** time the plaintext token is returned.
- `DELETE /integrations/mcp/token` → clears `mcpTokenPrefix`/`mcpTokenHash`, revoking access immediately.

## 3. Backend: MCP server module

New `backend/src/mcp-server/` module:

- **`mcp-auth.guard.ts`** — reads `Authorization: Bearer <token>` on `POST /mcp/v1`, splits out the prefix, looks up the `Workspace` row by `mcpTokenPrefix`, bcrypt-compares the full token against `mcpTokenHash`, and attaches `workspaceId` to the request. Missing, malformed, unknown-prefix, or mismatched tokens all return a generic 401 (no distinction, to avoid leaking whether a workspace has a token configured at all).
- **`mcp-tools.factory.ts`** — given a `workspaceId`, builds the Mastra tool array via `createTool()` (zod input schemas), each tool's `execute` delegating to the injected `ContactsService`/`AppointmentsService`:
  - `list_appointments({ from?, to?, status? })`
  - `get_appointment({ id })`
  - `create_appointment({ contactId, service, serviceAr, startAt, durationMin, status, source, staffId?, note?, noteAr? })`
  - `update_appointment({ id, ...partial fields })`
  - `cancel_appointment({ id })` — implemented as `update(id, { status: "cancelled" })`, not the DTO's hard delete.
  - `search_contacts({ query })` — matches name/phone.
  - `get_contact({ id })`
  - `create_contact({ name, phone?, industry, lifecycle, source, value?, tags? })`
  - `update_contact({ id, ...partial fields })`
  - Deliberately **no** `delete_appointment`/`delete_contact` tools.
- **`mcp-server.controller.ts`** — `@Post("mcp/v1")`, protected by `McpAuthGuard`, handler signature `(@Req() req, @Res() res, @CurrentWorkspace() workspaceId: string)`: constructs a fresh Mastra `MCPServer` (static `name`/`version`, `tools: mcpToolsFactory.build(workspaceId)`) and calls:
  ```ts
  await server.startHTTP({
    url: new URL(req.url ?? "", `${req.protocol}://${req.get("host")}`),
    httpPath: "/mcp/v1",
    req,
    res,
    options: { sessionIdGenerator: () => randomUUID() },
  });
  ```
  A fresh `MCPServer`/tool set per request keeps the implementation stateless and avoids session affinity concerns across Nest's request lifecycle.
- Registered as `McpServerModule`, importing `ContactsModule` and `AppointmentsModule` (exporting their services if not already exported) into `AppModule`.

**New backend dependencies:** `@mastra/core`, `@mastra/mcp`, `zod` (none currently present in `backend/package.json`).

## 4. Frontend

New `src/screens/settings/McpAccessCard.tsx`, added to `IntegrationsTab.tsx` next to `ZernioCard`/`WhatsAppCard`, following the same structural idiom:

- Status row: `GET /integrations/mcp/token/status` → `Connected`/`Off` badge (mirrors `WhatsAppCard`'s status row).
- Not-connected + `canEdit`: a "Generate token" button (`POST /integrations/mcp/token`).
- On generate/rotate: a one-time modal showing the full token and the `/mcp/v1` endpoint URL, with a copy button and an explicit "this won't be shown again" note.
- Connected state: shows the masked prefix (`mcp_a1b2c3d4e5f6_••••`) and creation date; `canEdit`-gated "Rotate" and "Revoke" buttons (`Revoke` behind `window.confirm`, matching `onDisconnect`'s pattern).
- Inline hint text pointing the admin at the existing MCP Servers tab (in the Kewy AI screen) to actually wire the endpoint + token into the agent's remote MCP server list — this card only manages the credential, not the binding.
- `!canEdit` state: read-only notice, matching the existing cards' convention.

## 5. Error handling

- Auth guard failure → 401, generic message, logged server-side with more detail.
- Tool-level errors (e.g. `ContactsService` throwing `NotFoundException`, or zod validation failure on tool input) → caught inside each tool's `execute` and returned as an MCP tool-error result (`isError: true` in the tool response), not an HTTP-level failure — so the agent sees a structured "not found" / "invalid input" and can react conversationally, rather than the whole MCP call failing opaquely.
- Token endpoints reuse the existing `ErrorRow`/`StatusToast` conventions on the frontend.

## 6. Testing

- Backend unit tests: `McpAuthGuard` (valid/invalid/revoked/missing token, wrong prefix), each tool's `execute` (happy path + not-found + validation error), token controller (generate/rotate/revoke/status, role-gating on non-owner/admin).
- One backend integration test posting a real MCP `tools/call` JSON-RPC payload through `mcp-server.controller.ts` against a test DB, confirming workspace isolation (a token minted for workspace A cannot see or mutate workspace B's appointments/contacts).
- Frontend component test for `McpAccessCard` (not-connected/connected/generate/rotate/revoke/read-only states), following `IntegrationsTab`'s existing test conventions.
- Manual end-to-end pass via the `verify` skill: generate a token, register the CRM's own `/mcp/v1` URL + token as a remote MCP server through the existing `McpServersTab` "Add server" flow, hit "Test", confirm the expected tool names come back, then exercise one tool call (e.g. `list_appointments`) end-to-end.

## Open verification items (resolve during implementation, before dependent code)

1. Confirm `@mastra/mcp`'s exact `MCPServer` constructor/`startHTTP` signature against the installed version at implementation time (verified against current docs during design, but pin and re-check on install).
2. Confirm whether `ContactsService`/`AppointmentsService` need to be exported from their modules already, or whether `McpServerModule` needs a small export addition to `ContactsModule`/`AppointmentsModule`.
3. Confirm the exact CRM role enum values (`owner`/`admin`) match the literal strings used elsewhere (same open item carried over from [[kewy-ai-agent-config]]).
