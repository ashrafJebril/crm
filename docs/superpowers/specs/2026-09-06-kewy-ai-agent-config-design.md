# Kewy AI Agent Config: Knowledge, Tools & MCP Servers — Design

**Date:** 2026-09-06
**Status:** Approved
**Context:** The CRM's AI agent ("l", surfaced to users as "Kewy AI") already answers conversations by delegating to the external Kewy "l" platform (`kewy/l` repo) over a per-endpoint webhook (`LAgentService.ask()`). Retrieval, tool execution, and MCP already run entirely on that platform — this CRM stores no agent data of its own beyond the opaque `lWorkspaceId`/`lEndpointId`/`lEndpointSecret` linkage fields on `Workspace`. A full local agent-config feature (KB, tools, mock escalation) existed once and was deleted (`cf2f600`) in favor of this external-platform model; this design does not resurrect local storage — it builds a thin admin surface that proxies to the platform, which already has fully-built `Document`/`HttpTool`/`McpServer` models and REST routes, gated by per-user JWT, plus a service-to-service admin surface (`joteck.py`, gated by a shared `X-Joteck-Secret`) that already covers workspaces/agents/documents but not yet tools or MCP servers.

## Goals

1. Let a CRM user (owner/admin) view and manage their Kewy AI agent's **knowledge base** (upload/list/delete documents), **tools** (create/list/delete HTTP tool definitions, bind/unbind to the agent), and **MCP server connections** (create/list/delete, bind/unbind, live-test) — all from a dedicated screen in the CRM.
2. Extend the `kewy/l` platform's `joteck.py` service-to-service surface with tools/MCP-server routes so the CRM (a system, not a logged-in platform user) can manage them without a per-workspace user login.
3. Resolve "which agent" transparently: today a workspace conceptually has exactly one agent; the CRM resolves and caches its slug rather than exposing multi-agent management.

## Non-goals

- Multi-agent management UI (creating additional agents, switching between them). The CRM always operates on the workspace's single (default) agent.
- Persona/prompt editing, escalation rules, or analytics — out of scope for this pass (the old deleted `Agents.tsx` had these; not being rebuilt here).
- Any local storage of KB documents, tool definitions, or MCP server config in the CRM's own database — this remains entirely on the `kewy/l` platform. The CRM stores only a cached agent slug.
- Changing the existing chat webhook path (`LAgentService.ask()`) or inbound webhook handling.

## 1. `kewy/l` platform changes

Add to `backend/app/api/joteck.py`, mirroring the existing document routes' exact pattern: `dependencies=[Depends(require_joteck_secret)]` on every route, `await _get_workspace(db, workspace_id)` first in every body (404-only tenant isolation, no 403 anywhere in this codebase), reusing `schemas/tools.py`/`schemas/mcp_servers.py` DTOs verbatim (never redefining them in `joteck.py`), and importing rather than duplicating `_get_agent_or_404`/tool/server lookup helpers from `app.api.agents`/`app.api.tools`/`app.api.mcp_servers`.

**Tools:**
- `GET /joteck/workspaces/{workspace_id}/tools` → `list[ToolResponse]`
- `POST /joteck/workspaces/{workspace_id}/tools` → `ToolResponse`, 201 (409 on duplicate name in workspace)
- `DELETE /joteck/workspaces/{workspace_id}/tools/{tool_id}` → 204 (cascades `AgentTool` bindings)
- `GET /joteck/workspaces/{workspace_id}/agents/{slug}/tools` → `list[ToolResponse]`
- `PUT /joteck/workspaces/{workspace_id}/agents/{slug}/tools/{tool_id}` → 204 (bind, idempotent; copy the "capture ids before rollback" `IntegrityError` disambiguation from `tools.py::bind_tool`)
- `DELETE /joteck/workspaces/{workspace_id}/agents/{slug}/tools/{tool_id}` → 204 (unbind)

**MCP servers:**
- `GET /joteck/workspaces/{workspace_id}/mcp-servers` → `list[McpServerResponse]`
- `POST /joteck/workspaces/{workspace_id}/mcp-servers` → `McpServerResponse`, 201 (same URL-guard/409 behavior as the authenticated route)
- `DELETE /joteck/workspaces/{workspace_id}/mcp-servers/{server_id}` → 204 (cascades bindings)
- `GET /joteck/workspaces/{workspace_id}/agents/{slug}/mcp-servers` → `list[McpServerResponse]`
- `PUT /joteck/workspaces/{workspace_id}/agents/{slug}/mcp-servers/{server_id}` → 204 (bind)
- `DELETE /joteck/workspaces/{workspace_id}/agents/{slug}/mcp-servers/{server_id}` → 204 (unbind)
- `POST /joteck/workspaces/{workspace_id}/mcp-servers/{server_id}/test` → `McpServerTestResponse` (live connect + list advertised tools; writes `last_checked_at`/`last_error`)

**Agent resolution:** no change — reuse the existing idempotent `POST /joteck/workspaces/{workspace_id}/agents/default`, which returns the first existing agent (ordered by slug) or provisions the `customer-support` template if none exists.

No model/schema changes needed (`HttpTool`, `McpServer`, `AgentTool`, `AgentMcpServer` already exist and are unchanged). This is additive routing + tests only.

## 2. CRM backend proxy layer

**Schema:** add `lAgentSlug String?` to `Workspace` in `backend/prisma/schema.prisma`, alongside the existing `lWorkspaceId`/`lEndpointId`/`lEndpointSecret`. One migration, no other model changes — KB/tool/MCP data is never persisted in the CRM's own database.

**New module** `backend/src/integrations/l-config/`:
- `l-joteck.client.ts` — low-level HTTP client for the `joteck` surface: base URL `L_API_URL`, header `X-Joteck-Secret: process.env.JOTECK_CRM_SECRET`, JSON + multipart support, maps l's `{ detail, code }` error envelope to Nest `HttpException`s. `enabled` getter follows the existing "inert until env configured" convention (`LAgentService.enabled`, `KewySsoService`).
- `l-agent-resolver.service.ts` — returns the workspace's agent slug: reads `Workspace.lAgentSlug` if set; otherwise calls `POST /joteck/workspaces/{lWorkspaceId}/agents/default`, persists the returned slug onto `Workspace.lAgentSlug`, and returns it. All agent-scoped calls (tool/MCP binding) go through this first.
- `l-knowledge.service.ts` — proxies list/upload/delete against `.../workspaces/{id}/documents`.
- `l-tools.service.ts` — proxies workspace tool CRUD and, via the resolver, agent-scoped bind/unbind.
- `l-mcp.service.ts` — proxies MCP server CRUD, bind/unbind, and test.
- `l-config.controller.ts` — tenant-scoped REST surface for the frontend via `@CurrentWorkspace()`, mutations gated to `owner`/`admin` roles (mirrors `IntegrationsTab`'s `canEdit` convention):
  - `GET /integrations/l/knowledge`, `POST /integrations/l/knowledge` (multipart), `DELETE /integrations/l/knowledge/:documentId`
  - `GET /integrations/l/tools`, `POST /integrations/l/tools`, `DELETE /integrations/l/tools/:toolId`, `PUT /integrations/l/tools/:toolId/binding`, `DELETE /integrations/l/tools/:toolId/binding`
  - `GET /integrations/l/mcp-servers`, `POST /integrations/l/mcp-servers`, `DELETE /integrations/l/mcp-servers/:serverId`, `PUT /integrations/l/mcp-servers/:serverId/binding`, `DELETE /integrations/l/mcp-servers/:serverId/binding`, `POST /integrations/l/mcp-servers/:serverId/test`
- Registered in `integrations.module.ts` alongside the existing `l-*` providers.

If `workspace.lWorkspaceId` is unset, every endpoint returns a `{ connected: false }`-style response instead of erroring, so the frontend can render a clear "not connected" state.

## 3. CRM frontend

**Routing:** add `agents` to the `RouteId` union (`src/lib/types.ts`), a nav entry (`src/shell/nav.ts`), and a lazy-loaded `src/screens/KewyAgent.tsx` registered in `src/router.tsx` — same pattern the deleted `Agents.tsx` used, minus persona/escalation/analytics.

**Screen structure** (`src/screens/KewyAgent.tsx` + `src/screens/kewy-agent/*`):
- Top-level pill tab switcher: **Knowledge | Tools | MCP Servers**, following `Settings.tsx`'s tab-switcher idiom.
- **Not-connected state:** if the workspace has no `lWorkspaceId`, render a single `SettingsCard` explaining the workspace isn't linked to Kewy yet, instead of the tabs.
- **KnowledgeTab.tsx:** document list (title, status badge `pending|processing|ready|failed`, created date) via `useFetch`; upload via file input + multipart `useMutation`; delete per row with confirm modal. Close in shape to the dead `src/api/knowledge.ts` stub, which can be revived/adapted.
- **ToolsTab.tsx:** list of workspace tools with a bound/unbound toggle against the agent (PUT/DELETE binding); "Add tool" modal (name, description, method, url_template, headers, body_template, param_descriptions); delete per row. Real version of the old mock `ToolDef` list.
- **McpServersTab.tsx:** list of MCP servers with a bound/unbound toggle; "Add server" modal (name, description, url, headers); a "Test" button per row calling the test endpoint and rendering `ok`/`tools`/`error` inline; delete per row. No "edit" action — headers are write-only on the platform (never redisplayed), so changing them is delete-and-recreate.

**Data fetching:** `useFetch`/`useMutation` against `/integrations/l/*`, same as `IntegrationsTab`. `canEdit = role === "owner" || "admin"` gates all mutating actions; read-only users see lists without action buttons.

**i18n:** every string via `tx(en, ar)`, RTL-safe layout, per existing convention.

## 4. Error handling

- Upstream non-2xx from l → proxy raises a mapped `HttpException` (generic user-facing message, upstream `detail`/`code` logged server-side); frontend surfaces via `ErrorRow`/`StatusToast`.
- Upstream 404 (agent/tool/server vanished) → passed through as 404; frontend shows an inline "not found, refresh the list" and triggers a refetch.
- Upstream 409 (duplicate tool/server name) → surfaced as a field-level validation error inside the Add modal, not a toast.
- MCP `test` returning `{ ok: false }` is a normal result, not an error — rendered inline in the row, not as a toast/error state.

## 5. Testing

- `kewy/l`: unit/integration tests for the new joteck routes (secret-gate 401/503, 404 tenant isolation, CRUD + bind/unbind happy paths), following this repo's existing `test_joteck.py` conventions and TDD practice.
- CRM backend: unit tests for `l-joteck.client.ts` (auth header, error mapping), `l-agent-resolver.service.ts` (cache-hit vs. resolve-and-persist), each proxy service, and controller role-gating + the "not connected" branch.
- CRM frontend: component tests per tab (loading/empty/error/not-connected states, mutation flows), following existing `IntegrationsTab` test conventions.
- End-to-end manual pass via the `verify` skill with both repos' backends running and a workspace that has `lWorkspaceId` set.

## Open verification items (resolve during implementation, before dependent code)

1. Confirm `JOTECK_CRM_SECRET` is (or will be) the exact env var name the CRM should send as `X-Joteck-Secret` — it currently only appears in an uncommitted, not-yet-cleaned-up `backend/.env.example` diff; confirm the final name before wiring `l-joteck.client.ts`.
2. Confirm `L_API_URL` (already used by `LAgentService`) is the correct base URL to reuse for the joteck surface, or whether joteck is exposed on a different host/port in deployment.
3. Decide the exact CRM role names to gate on (`owner`/`admin` used elsewhere — verify these are the literal string values in this codebase's role enum).
