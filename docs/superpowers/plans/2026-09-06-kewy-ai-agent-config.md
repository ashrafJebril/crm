# Kewy AI Agent Config (Knowledge, Tools, MCP Servers) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a CRM user (owner/admin) manage their Kewy AI agent's knowledge base, HTTP tools, and MCP server connections from a dedicated CRM screen, by proxying to the external `kewy/l` agent platform's service-to-service `joteck` admin surface.

**Architecture:** Three layers, built bottom-up: (1) `kewy/l` gets new `joteck.py` routes for tools/MCP servers, mirroring its existing document routes exactly; (2) the CRM backend gets a thin proxy module (`backend/src/integrations/l-*`) that authenticates to that surface with a new shared secret and resolves the workspace's single agent slug; (3) the CRM frontend gets a new top-level "Kewy AI" screen with Knowledge/Tools/MCP Servers tabs built on existing `useFetch`/`useMutation`/`SettingsCard`-style primitives. No KB/tool/MCP data is ever stored in the CRM's own database — only a cached agent slug.

**Tech Stack:** `kewy/l`: Python 3.12, FastAPI, SQLAlchemy 2.0 async, Postgres+pgvector, pytest+testcontainers. `kewy/crm` backend: NestJS, Prisma, Jest. `kewy/crm` frontend: React+Vite, TanStack Query (via `useFetch`/`useMutation`), no component test framework (none exists in this repo today — verify manually per task).

**Spec:** `docs/superpowers/specs/2026-09-06-kewy-ai-agent-config-design.md`

## Global Constraints

- No KB document, tool definition, or MCP server config is ever persisted in the CRM's own Postgres database — the CRM only caches `Workspace.lAgentSlug`. All of it lives on `kewy/l`.
- The CRM's outbound secret to `kewy/l`'s joteck surface is a **new** env var, `L_JOTECK_SECRET`, sent as the `x-joteck-secret` header. Do **not** confuse this with the CRM's own existing `JOTECK_CRM_SECRET` (which gates the *inbound* direction — Kewy console calling into the CRM's own `/joteck` admin surface, `backend/src/joteck/joteck.guard.ts`). These are two different secrets for two different directions of the same pattern.
- Reuse the existing `L_API_URL` env var (already used by `LAgentService`) as the base URL for `kewy/l`; the joteck path is `${L_API_URL}/api/v1/joteck/...`.
- Every mutating CRM endpoint under `/integrations/l/*` must reject non-owner/non-admin members with a 403, following `WorkspacesController`'s manual `if (role !== "owner" && role !== "admin") throw new ForbiddenException(...)` pattern (there is no reusable `@Roles()` guard in this codebase — do not invent one for this feature alone).
- `kewy/l` route additions and tests live only in `backend/app/api/joteck.py` and `backend/tests/integration/test_joteck_routes.py` — do not touch `tools.py`/`mcp_servers.py`'s own per-user routes, which are out of scope and must keep working unmodified.
- Frontend currency: this repo's `api` client (`src/api/client.ts`) always JSON-encodes — any multipart upload must hand-roll `fetch` + `FormData` outside of it, exactly like `src/api/uploadMedia.ts` does.
- There is no frontend test framework in this repo (no Vitest/Jest/RTL configured). Do not introduce one as part of this feature — verify frontend tasks manually via the dev server, per the `verify` skill.

---

## Part A — `kewy/l` platform (`/Users/aabukhadir/projects/4pillars/kewy/l`)

### Task 1: Add joteck tools routes

**Files:**
- Modify: `backend/app/api/joteck.py`
- Test: `backend/tests/integration/test_joteck_routes.py`

**Interfaces:**
- Consumes: `HttpTool`, `AgentTool` (from `app.db.models`), `_get_tool_or_404`/`_to_response` (from `app.api.tools`, aliased), `_get_agent_or_404` (already imported into `joteck.py` from `app.api.agents`), `CreateToolRequest`/`ToolResponse` (from `app.schemas.tools`), `require_joteck_secret`/`_get_workspace` (already defined in `joteck.py`).
- Produces: six new routes under `/joteck/workspaces/{workspace_id}/tools[...]` that Task 3's CRM `l-joteck.client.ts` will call by exact path.

- [ ] **Step 1: Write the failing tests**

Add this new section to `backend/tests/integration/test_joteck_routes.py`, right before the final `# ── Documents ──` section's closing (i.e. append after the existing document tests, at the end of the file):

```python
# ── Tools ────────────────────────────────────────────────────────────────


def _tools_url(workspace_id) -> str:
    return f"{BASE}/{workspace_id}/tools"


def _agent_tools_url(workspace_id, slug="customer-support") -> str:
    return f"{BASE}/{workspace_id}/agents/{slug}/tools"


async def _create_tool(client, workspace_id, name="weather"):
    return await client.post(_tools_url(workspace_id), json={
        "name": name,
        "description": "Get weather for a city",
        "method": "GET",
        "url_template": "https://api.example.com/weather/{city}",
        "param_descriptions": {"city": "City name"},
    }, headers=AUTH)


async def test_create_tool_reports_its_derived_parameters(client):
    created = (await _create(client)).json()
    r = await _create_tool(client, created["id"])
    assert r.status_code == 201
    assert r.json()["params"] == ["city"]


async def test_create_tool_requires_joteck_secret(client):
    created = (await _create(client)).json()
    r = await client.post(_tools_url(created["id"]), json={
        "name": "weather", "description": "d", "method": "GET",
        "url_template": "https://x/{a}",
    })
    assert r.status_code == 401


async def test_create_tool_for_unknown_workspace_is_404(client):
    r = await client.post(
        f"{BASE}/00000000-0000-0000-0000-000000000000/tools",
        json={"name": "weather", "description": "d", "method": "GET",
              "url_template": "https://x/{a}"},
        headers=AUTH,
    )
    assert r.status_code == 404


async def test_duplicate_tool_name_in_one_workspace_is_rejected(client):
    created = (await _create(client)).json()
    await _create_tool(client, created["id"])
    assert (await _create_tool(client, created["id"])).status_code == 409


async def test_list_tools_shows_only_this_workspaces_tools(client):
    mine = (await _create(client)).json()
    theirs = (await _create(client, owner_email="other@example.com", slug="other")).json()
    await _create_tool(client, mine["id"], name="mine")
    await _create_tool(client, theirs["id"], name="theirs")
    names = [t["name"] for t in (await client.get(_tools_url(mine["id"]), headers=AUTH)).json()]
    assert names == ["mine"]


async def test_delete_tool_removes_it_and_its_bindings(client):
    created = (await _create(client)).json()
    tool_id = (await _create_tool(client, created["id"])).json()["id"]
    await client.put(f"{_agent_tools_url(created['id'])}/{tool_id}", headers=AUTH)
    r = await client.delete(f"{_tools_url(created['id'])}/{tool_id}", headers=AUTH)
    assert r.status_code == 204
    bound = (await client.get(_agent_tools_url(created["id"]), headers=AUTH)).json()
    assert bound == []


async def test_delete_unknown_tool_is_404(client):
    created = (await _create(client)).json()
    r = await client.delete(
        f"{_tools_url(created['id'])}/00000000-0000-0000-0000-000000000000", headers=AUTH,
    )
    assert r.status_code == 404


async def test_binding_a_tool_to_the_default_agent_then_listing_it(client):
    created = (await _create(client)).json()
    tool_id = (await _create_tool(client, created["id"])).json()["id"]
    r = await client.put(f"{_agent_tools_url(created['id'])}/{tool_id}", headers=AUTH)
    assert r.status_code == 204
    bound = (await client.get(_agent_tools_url(created["id"]), headers=AUTH)).json()
    assert [t["id"] for t in bound] == [tool_id]


async def test_binding_a_tool_is_idempotent(client):
    created = (await _create(client)).json()
    tool_id = (await _create_tool(client, created["id"])).json()["id"]
    await client.put(f"{_agent_tools_url(created['id'])}/{tool_id}", headers=AUTH)
    r = await client.put(f"{_agent_tools_url(created['id'])}/{tool_id}", headers=AUTH)
    assert r.status_code == 204
    bound = (await client.get(_agent_tools_url(created["id"]), headers=AUTH)).json()
    assert len(bound) == 1


async def test_unbinding_a_tool_removes_it(client):
    created = (await _create(client)).json()
    tool_id = (await _create_tool(client, created["id"])).json()["id"]
    await client.put(f"{_agent_tools_url(created['id'])}/{tool_id}", headers=AUTH)
    r = await client.delete(f"{_agent_tools_url(created['id'])}/{tool_id}", headers=AUTH)
    assert r.status_code == 204
    assert (await client.get(_agent_tools_url(created["id"]), headers=AUTH)).json() == []


async def test_cannot_bind_another_workspaces_tool(client):
    mine = (await _create(client)).json()
    theirs = (await _create(client, owner_email="other2@example.com", slug="other2")).json()
    tool_id = (await _create_tool(client, theirs["id"], name="theirs")).json()["id"]
    r = await client.put(f"{_agent_tools_url(mine['id'])}/{tool_id}", headers=AUTH)
    assert r.status_code == 404


async def test_binding_to_unknown_agent_slug_is_404(client):
    created = (await _create(client)).json()
    tool_id = (await _create_tool(client, created["id"])).json()["id"]
    r = await client.put(
        f"{_agent_tools_url(created['id'], slug='does-not-exist')}/{tool_id}", headers=AUTH,
    )
    assert r.status_code == 404
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `backend/`, with Docker available for testcontainers): `pytest tests/integration/test_joteck_routes.py -k "tool" -v`
Expected: FAIL — `404 Not Found` for every new route (they don't exist yet), since `_tools_url`/`_agent_tools_url` hit paths FastAPI hasn't registered.

- [ ] **Step 3: Implement the routes**

In `backend/app/api/joteck.py`, update the imports block to add:

```python
from app.agent.http_tools import extract_params
from app.api.tools import _get_tool_or_404
from app.db.models import (
    Agent,
    AgentPrompt,
    AgentTool,
    ChatSession,
    Document,
    HttpTool,
    McpServer,
    User,
    Workspace,
)
from app.schemas.tools import CreateToolRequest, ToolResponse
```

(This replaces the existing `from app.db.models import Agent, AgentPrompt, ChatSession, Document, McpServer, User, Workspace` line — add `AgentTool` and `HttpTool` to it — and adds two new import lines. Do not import `_to_response` from `app.api.tools`; it's private-by-convention and only used for tool rows there. Define a local one instead, matching `extract_params` usage, so `joteck.py` doesn't reach into another module's formatting helper.)

Add this function near the top of the file, after `_get_workspace`:

```python
def _tool_to_response(row: HttpTool) -> ToolResponse:
    return ToolResponse(
        id=row.id, name=row.name, description=row.description, method=row.method,
        url_template=row.url_template, enabled=row.enabled, created_at=row.created_at,
        params=extract_params(row.url_template, row.body_template),
    )
```

Append this section at the end of the file (after the existing document routes):

```python
# ── Tools ────────────────────────────────────────────────────────────────


@router.get(
    "/workspaces/{workspace_id}/tools",
    response_model=list[ToolResponse],
    dependencies=[Depends(require_joteck_secret)],
)
async def list_workspace_tools(
    workspace_id: uuid.UUID, db: AsyncSession = Depends(get_db),
) -> list[ToolResponse]:
    await _get_workspace(db, workspace_id)
    rows = (await db.execute(
        select(HttpTool).where(HttpTool.workspace_id == workspace_id).order_by(HttpTool.name)
    )).scalars().all()
    return [_tool_to_response(r) for r in rows]


@router.post(
    "/workspaces/{workspace_id}/tools",
    response_model=ToolResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_joteck_secret)],
)
async def create_workspace_tool(
    workspace_id: uuid.UUID, payload: CreateToolRequest, db: AsyncSession = Depends(get_db),
) -> ToolResponse:
    await _get_workspace(db, workspace_id)
    tool = HttpTool(
        id=uuid.uuid4(), workspace_id=workspace_id, name=payload.name,
        description=payload.description, method=payload.method,
        url_template=payload.url_template, headers=payload.headers,
        body_template=payload.body_template,
        param_descriptions=payload.param_descriptions, enabled=True,
    )
    db.add(tool)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "tool name already exists in this workspace")
    await db.refresh(tool)
    return _tool_to_response(tool)


@router.delete(
    "/workspaces/{workspace_id}/tools/{tool_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_joteck_secret)],
)
async def delete_workspace_tool(
    workspace_id: uuid.UUID, tool_id: uuid.UUID, db: AsyncSession = Depends(get_db),
) -> Response:
    await _get_workspace(db, workspace_id)
    tool = await _get_tool_or_404(db, workspace_id=workspace_id, tool_id=tool_id)
    await db.execute(
        AgentTool.__table__.delete().where(
            AgentTool.tool_id == tool.id, AgentTool.workspace_id == workspace_id,
        )
    )
    await db.delete(tool)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get(
    "/workspaces/{workspace_id}/agents/{slug}/tools",
    response_model=list[ToolResponse],
    dependencies=[Depends(require_joteck_secret)],
)
async def list_workspace_agent_tools(
    workspace_id: uuid.UUID, slug: str, db: AsyncSession = Depends(get_db),
) -> list[ToolResponse]:
    await _get_workspace(db, workspace_id)
    agent = await _get_agent_or_404(db, workspace_id=workspace_id, slug=slug)
    rows = (await db.execute(
        select(HttpTool)
        .join(AgentTool, AgentTool.tool_id == HttpTool.id)
        .where(AgentTool.agent_id == agent.id, HttpTool.workspace_id == workspace_id)
        .order_by(HttpTool.name)
    )).scalars().all()
    return [_tool_to_response(r) for r in rows]


@router.put(
    "/workspaces/{workspace_id}/agents/{slug}/tools/{tool_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_joteck_secret)],
)
async def bind_workspace_agent_tool(
    workspace_id: uuid.UUID, slug: str, tool_id: uuid.UUID, db: AsyncSession = Depends(get_db),
) -> Response:
    await _get_workspace(db, workspace_id)
    agent = await _get_agent_or_404(db, workspace_id=workspace_id, slug=slug)
    tool = await _get_tool_or_404(db, workspace_id=workspace_id, tool_id=tool_id)
    # Captured before the commit: a rollback expires every object in the
    # session, so re-reading .id off the ORM instances below would trigger a
    # lazy load needing IO outside an awaited context.
    agent_id, resolved_tool_id = agent.id, tool.id
    db.add(AgentTool(
        id=uuid.uuid4(), workspace_id=workspace_id, agent_id=agent_id, tool_id=resolved_tool_id,
    ))
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        existing = (await db.execute(
            select(AgentTool.id).where(
                AgentTool.agent_id == agent_id,
                AgentTool.tool_id == resolved_tool_id,
                AgentTool.workspace_id == workspace_id,
            )
        )).scalar_one_or_none()
        if existing is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "agent or tool not found")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete(
    "/workspaces/{workspace_id}/agents/{slug}/tools/{tool_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_joteck_secret)],
)
async def unbind_workspace_agent_tool(
    workspace_id: uuid.UUID, slug: str, tool_id: uuid.UUID, db: AsyncSession = Depends(get_db),
) -> Response:
    await _get_workspace(db, workspace_id)
    agent = await _get_agent_or_404(db, workspace_id=workspace_id, slug=slug)
    await db.execute(
        AgentTool.__table__.delete().where(
            AgentTool.agent_id == agent.id,
            AgentTool.tool_id == tool_id,
            AgentTool.workspace_id == workspace_id,
        )
    )
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pytest tests/integration/test_joteck_routes.py -k "tool" -v`
Expected: PASS (all new tests, plus every pre-existing test in the file since none of them were touched).

Also run the full integration suite to make sure nothing regressed: `pytest tests/integration/ -v`

- [ ] **Step 5: Commit**

```bash
cd /Users/aabukhadir/projects/4pillars/kewy/l
git add backend/app/api/joteck.py backend/tests/integration/test_joteck_routes.py
git commit -m "feat(joteck): add service-to-service tool management routes"
```

---

### Task 2: Add joteck MCP server routes

**Files:**
- Modify: `backend/app/api/joteck.py`
- Test: `backend/tests/integration/test_joteck_routes.py`

**Interfaces:**
- Consumes: `McpServer` (already imported), `AgentMcpServer` (from `app.db.models`), `_get_server_or_404` (from `app.api.mcp_servers`), `check_server` (from `app.agent.mcp_client`), `strip_url_userinfo`/`require_valid_target`/`UnguardedHostError` (from `app.agent.net`), `CreateMcpServerRequest`/`McpServerResponse`/`McpServerTestResponse` (from `app.schemas.mcp_servers`).
- Produces: seven new routes under `/joteck/workspaces/{workspace_id}/mcp-servers[...]` and `/joteck/workspaces/{workspace_id}/agents/{slug}/mcp-servers[...]` that Task 3's CRM client will call.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/integration/test_joteck_routes.py`, after the Tools section added in Task 1:

```python
# ── MCP servers ──────────────────────────────────────────────────────────


def _mcp_servers_url(workspace_id) -> str:
    return f"{BASE}/{workspace_id}/mcp-servers"


def _agent_mcp_servers_url(workspace_id, slug="customer-support") -> str:
    return f"{BASE}/{workspace_id}/agents/{slug}/mcp-servers"


async def _create_mcp_server(client, workspace_id, name="docs"):
    return await client.post(_mcp_servers_url(workspace_id), json={
        "name": name,
        "description": "Docs search over MCP",
        "url": "https://mcp.example.com/mcp",
        "headers": {"Authorization": "Bearer secret-token"},
    }, headers=AUTH)


async def test_create_mcp_server_returns_it_without_headers(client):
    created = (await _create(client)).json()
    r = await _create_mcp_server(client, created["id"])
    assert r.status_code == 201
    body = r.json()
    assert body["name"] == "docs"
    assert "headers" not in body


async def test_create_mcp_server_requires_joteck_secret(client):
    created = (await _create(client)).json()
    r = await client.post(_mcp_servers_url(created["id"]), json={
        "name": "docs", "description": "d", "url": "https://mcp.example.com/mcp",
    })
    assert r.status_code == 401


async def test_create_mcp_server_for_unknown_workspace_is_404(client):
    r = await client.post(
        f"{BASE}/00000000-0000-0000-0000-000000000000/mcp-servers",
        json={"name": "docs", "description": "d", "url": "https://mcp.example.com/mcp"},
        headers=AUTH,
    )
    assert r.status_code == 404


async def test_create_mcp_server_rejects_a_url_nothing_could_dial(client):
    created = (await _create(client)).json()
    r = await client.post(_mcp_servers_url(created["id"]), json={
        "name": "bad", "description": "d", "url": "file:///etc/passwd",
    }, headers=AUTH)
    assert r.status_code == 422


async def test_duplicate_mcp_server_name_in_one_workspace_is_rejected(client):
    created = (await _create(client)).json()
    await _create_mcp_server(client, created["id"])
    assert (await _create_mcp_server(client, created["id"])).status_code == 409


async def test_list_mcp_servers_shows_only_this_workspaces_servers(client):
    mine = (await _create(client)).json()
    theirs = (await _create(client, owner_email="mcp-other@example.com", slug="mcp-other")).json()
    await _create_mcp_server(client, mine["id"], name="mine")
    await _create_mcp_server(client, theirs["id"], name="theirs")
    names = [
        s["name"] for s in (await client.get(_mcp_servers_url(mine["id"]), headers=AUTH)).json()
    ]
    assert names == ["mine"]


async def test_delete_mcp_server_removes_it_and_its_bindings(client):
    created = (await _create(client)).json()
    server_id = (await _create_mcp_server(client, created["id"])).json()["id"]
    await client.put(f"{_agent_mcp_servers_url(created['id'])}/{server_id}", headers=AUTH)
    r = await client.delete(f"{_mcp_servers_url(created['id'])}/{server_id}", headers=AUTH)
    assert r.status_code == 204
    bound = (await client.get(_agent_mcp_servers_url(created["id"]), headers=AUTH)).json()
    assert bound == []


async def test_delete_unknown_mcp_server_is_404(client):
    created = (await _create(client)).json()
    r = await client.delete(
        f"{_mcp_servers_url(created['id'])}/00000000-0000-0000-0000-000000000000", headers=AUTH,
    )
    assert r.status_code == 404


async def test_binding_an_mcp_server_to_the_default_agent_then_listing_it(client):
    created = (await _create(client)).json()
    server_id = (await _create_mcp_server(client, created["id"])).json()["id"]
    r = await client.put(f"{_agent_mcp_servers_url(created['id'])}/{server_id}", headers=AUTH)
    assert r.status_code == 204
    bound = (await client.get(_agent_mcp_servers_url(created["id"]), headers=AUTH)).json()
    assert [s["id"] for s in bound] == [server_id]


async def test_binding_an_mcp_server_is_idempotent(client):
    created = (await _create(client)).json()
    server_id = (await _create_mcp_server(client, created["id"])).json()["id"]
    await client.put(f"{_agent_mcp_servers_url(created['id'])}/{server_id}", headers=AUTH)
    r = await client.put(f"{_agent_mcp_servers_url(created['id'])}/{server_id}", headers=AUTH)
    assert r.status_code == 204
    bound = (await client.get(_agent_mcp_servers_url(created["id"]), headers=AUTH)).json()
    assert len(bound) == 1


async def test_unbinding_an_mcp_server_removes_it(client):
    created = (await _create(client)).json()
    server_id = (await _create_mcp_server(client, created["id"])).json()["id"]
    await client.put(f"{_agent_mcp_servers_url(created['id'])}/{server_id}", headers=AUTH)
    r = await client.delete(f"{_agent_mcp_servers_url(created['id'])}/{server_id}", headers=AUTH)
    assert r.status_code == 204
    assert (await client.get(_agent_mcp_servers_url(created["id"]), headers=AUTH)).json() == []


async def test_cannot_bind_another_workspaces_mcp_server(client):
    mine = (await _create(client)).json()
    theirs = (await _create(client, owner_email="mcp-other2@example.com", slug="mcp-other2")).json()
    server_id = (await _create_mcp_server(client, theirs["id"], name="theirs")).json()["id"]
    r = await client.put(f"{_agent_mcp_servers_url(mine['id'])}/{server_id}", headers=AUTH)
    assert r.status_code == 404


async def test_mcp_server_test_endpoint_records_a_failure_on_the_row(client, monkeypatch):
    async def failing_check(row):
        return None, "ConnectError: refused"

    monkeypatch.setattr("app.api.joteck.check_server", failing_check)

    created = (await _create(client)).json()
    server_id = (await _create_mcp_server(client, created["id"])).json()["id"]
    r = await client.post(
        f"{_mcp_servers_url(created['id'])}/{server_id}/test", headers=AUTH,
    )
    assert r.status_code == 200
    assert r.json() == {"ok": False, "tools": [], "error": "ConnectError: refused"}

    listed = (await client.get(_mcp_servers_url(created["id"]), headers=AUTH)).json()[0]
    assert listed["last_error"] == "ConnectError: refused"
    assert listed["last_checked_at"] is not None


async def test_mcp_server_test_endpoint_clears_the_error_on_success(client, monkeypatch):
    async def ok_check(row):
        return ["echo", "search"], None

    monkeypatch.setattr("app.api.joteck.check_server", ok_check)

    created = (await _create(client)).json()
    server_id = (await _create_mcp_server(client, created["id"])).json()["id"]
    r = await client.post(
        f"{_mcp_servers_url(created['id'])}/{server_id}/test", headers=AUTH,
    )
    assert r.json() == {"ok": True, "tools": ["echo", "search"], "error": None}


async def test_mcp_server_test_for_unknown_server_is_404(client):
    created = (await _create(client)).json()
    r = await client.post(
        f"{_mcp_servers_url(created['id'])}/00000000-0000-0000-0000-000000000000/test",
        headers=AUTH,
    )
    assert r.status_code == 404
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pytest tests/integration/test_joteck_routes.py -k "mcp_server" -v`
Expected: FAIL — `404 Not Found` for every new route.

- [ ] **Step 3: Implement the routes**

In `backend/app/api/joteck.py`, update imports: add `AgentMcpServer` to the `app.db.models` import list (alongside `AgentTool`/`HttpTool` from Task 1), and add:

```python
from datetime import UTC, datetime

from app.agent.mcp_client import check_server
from app.agent.net import UnguardedHostError, require_valid_target, strip_url_userinfo
from app.api.mcp_servers import _get_server_or_404
from app.schemas.mcp_servers import (
    CreateMcpServerRequest,
    McpServerResponse,
    McpServerTestResponse,
)
```

Add this helper near `_tool_to_response` (added in Task 1):

```python
def _mcp_server_to_response(row: McpServer) -> McpServerResponse:
    return McpServerResponse.model_validate(row)
```

Append this section at the end of the file (after the Tools section from Task 1):

```python
# ── MCP servers ──────────────────────────────────────────────────────────


@router.get(
    "/workspaces/{workspace_id}/mcp-servers",
    response_model=list[McpServerResponse],
    dependencies=[Depends(require_joteck_secret)],
)
async def list_workspace_mcp_servers(
    workspace_id: uuid.UUID, db: AsyncSession = Depends(get_db),
) -> list[McpServerResponse]:
    await _get_workspace(db, workspace_id)
    rows = (await db.execute(
        select(McpServer).where(McpServer.workspace_id == workspace_id).order_by(McpServer.name)
    )).scalars().all()
    return [_mcp_server_to_response(r) for r in rows]


@router.post(
    "/workspaces/{workspace_id}/mcp-servers",
    response_model=McpServerResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_joteck_secret)],
)
async def create_workspace_mcp_server(
    workspace_id: uuid.UUID, payload: CreateMcpServerRequest, db: AsyncSession = Depends(get_db),
) -> McpServerResponse:
    await _get_workspace(db, workspace_id)
    url = strip_url_userinfo(payload.url)
    try:
        require_valid_target(url)
    except UnguardedHostError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"url rejected: {exc}")

    server = McpServer(
        id=uuid.uuid4(), workspace_id=workspace_id, name=payload.name,
        description=payload.description, url=url, headers=payload.headers,
        enabled=True,
    )
    db.add(server)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT, "mcp server name already exists in this workspace",
        )
    await db.refresh(server)
    return _mcp_server_to_response(server)


@router.delete(
    "/workspaces/{workspace_id}/mcp-servers/{server_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_joteck_secret)],
)
async def delete_workspace_mcp_server(
    workspace_id: uuid.UUID, server_id: uuid.UUID, db: AsyncSession = Depends(get_db),
) -> Response:
    await _get_workspace(db, workspace_id)
    server = await _get_server_or_404(db, workspace_id=workspace_id, server_id=server_id)
    await db.execute(
        AgentMcpServer.__table__.delete().where(
            AgentMcpServer.server_id == server.id, AgentMcpServer.workspace_id == workspace_id,
        )
    )
    await db.delete(server)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get(
    "/workspaces/{workspace_id}/agents/{slug}/mcp-servers",
    response_model=list[McpServerResponse],
    dependencies=[Depends(require_joteck_secret)],
)
async def list_workspace_agent_mcp_servers(
    workspace_id: uuid.UUID, slug: str, db: AsyncSession = Depends(get_db),
) -> list[McpServerResponse]:
    await _get_workspace(db, workspace_id)
    agent = await _get_agent_or_404(db, workspace_id=workspace_id, slug=slug)
    rows = (await db.execute(
        select(McpServer)
        .join(AgentMcpServer, AgentMcpServer.server_id == McpServer.id)
        .where(AgentMcpServer.agent_id == agent.id, McpServer.workspace_id == workspace_id)
        .order_by(McpServer.name)
    )).scalars().all()
    return [_mcp_server_to_response(r) for r in rows]


@router.put(
    "/workspaces/{workspace_id}/agents/{slug}/mcp-servers/{server_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_joteck_secret)],
)
async def bind_workspace_agent_mcp_server(
    workspace_id: uuid.UUID, slug: str, server_id: uuid.UUID, db: AsyncSession = Depends(get_db),
) -> Response:
    await _get_workspace(db, workspace_id)
    agent = await _get_agent_or_404(db, workspace_id=workspace_id, slug=slug)
    server = await _get_server_or_404(db, workspace_id=workspace_id, server_id=server_id)
    agent_id, resolved_server_id = agent.id, server.id
    db.add(AgentMcpServer(
        id=uuid.uuid4(), workspace_id=workspace_id,
        agent_id=agent_id, server_id=resolved_server_id,
    ))
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        existing = (await db.execute(
            select(AgentMcpServer.id).where(
                AgentMcpServer.agent_id == agent_id,
                AgentMcpServer.server_id == resolved_server_id,
                AgentMcpServer.workspace_id == workspace_id,
            )
        )).scalar_one_or_none()
        if existing is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "agent or mcp server not found")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete(
    "/workspaces/{workspace_id}/agents/{slug}/mcp-servers/{server_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_joteck_secret)],
)
async def unbind_workspace_agent_mcp_server(
    workspace_id: uuid.UUID, slug: str, server_id: uuid.UUID, db: AsyncSession = Depends(get_db),
) -> Response:
    await _get_workspace(db, workspace_id)
    agent = await _get_agent_or_404(db, workspace_id=workspace_id, slug=slug)
    await db.execute(
        AgentMcpServer.__table__.delete().where(
            AgentMcpServer.agent_id == agent.id,
            AgentMcpServer.server_id == server_id,
            AgentMcpServer.workspace_id == workspace_id,
        )
    )
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/workspaces/{workspace_id}/mcp-servers/{server_id}/test",
    response_model=McpServerTestResponse,
    dependencies=[Depends(require_joteck_secret)],
)
async def test_workspace_mcp_server(
    workspace_id: uuid.UUID, server_id: uuid.UUID, db: AsyncSession = Depends(get_db),
) -> McpServerTestResponse:
    await _get_workspace(db, workspace_id)
    server = await _get_server_or_404(db, workspace_id=workspace_id, server_id=server_id)
    tools, error = await check_server(server)
    server.last_checked_at = datetime.now(UTC)
    server.last_error = error
    await db.commit()
    return McpServerTestResponse(ok=error is None, tools=tools or [], error=error)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pytest tests/integration/test_joteck_routes.py -v`
Expected: PASS — every test in the file, including Task 1's and the pre-existing ones.

Also run the full suite once more: `pytest tests/integration/ -v`

- [ ] **Step 5: Commit**

```bash
cd /Users/aabukhadir/projects/4pillars/kewy/l
git add backend/app/api/joteck.py backend/tests/integration/test_joteck_routes.py
git commit -m "feat(joteck): add service-to-service MCP server management routes"
```

---

## Part B — CRM backend (`/Users/aabukhadir/projects/4pillars/kewy/crm/backend`)

### Task 3: Add `Workspace.lAgentSlug` column

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Create: `backend/prisma/migrations/20260906120000_add_l_agent_slug/migration.sql`

**Interfaces:**
- Produces: `Workspace.lAgentSlug: string | null` on the Prisma client, consumed by Task 5's `LAgentResolverService`.

- [ ] **Step 1: Edit the schema**

In `backend/prisma/schema.prisma`, find the block around line 520-521:

```prisma
  lEndpointId     String?
  lEndpointSecret String?
```

Change it to:

```prisma
  lEndpointId     String?
  lEndpointSecret String?

  // The l agent slug this workspace's Kewy AI config screens operate on.
  // Resolved lazily via l's idempotent "ensure default agent" endpoint and
  // cached here so every tool/MCP-server bind call doesn't re-resolve it.
  lAgentSlug String?
```

- [ ] **Step 2: Create the migration**

Run from `backend/`:

```bash
npx prisma migrate dev --name add_l_agent_slug --create-only
```

This creates `backend/prisma/migrations/<timestamp>_add_l_agent_slug/migration.sql` with an empty/auto-generated body. Replace its contents with:

```sql
-- Cache column for the l platform agent slug this workspace's Kewy AI
-- screens operate on. Nullable and lazily populated — resolved the first
-- time a tool/MCP-server bind call needs it, via l's idempotent
-- "ensure default agent" endpoint.
ALTER TABLE "Workspace" ADD COLUMN "lAgentSlug" TEXT;
```

- [ ] **Step 3: Apply the migration and regenerate the client**

```bash
npx prisma migrate dev
npx prisma generate
```

Expected: migration applies cleanly, `@prisma/client` types now include `lAgentSlug` on `Workspace`.

- [ ] **Step 4: Verify**

Run: `npx prisma validate`
Expected: `The schema at prisma/schema.prisma is valid 🚀`

- [ ] **Step 5: Commit**

```bash
cd /Users/aabukhadir/projects/4pillars/kewy/crm
git add backend/prisma/schema.prisma backend/prisma/migrations
git commit -m "feat(l-config): add Workspace.lAgentSlug cache column"
```

---

### Task 4: `LJoteckClient` — low-level HTTP client to the l platform's joteck surface

**Files:**
- Create: `backend/src/integrations/l-joteck.client.ts`
- Test: `backend/src/integrations/l-joteck.client.spec.ts`

**Interfaces:**
- Consumes: `process.env.L_API_URL`, `process.env.L_JOTECK_SECRET`, global `fetch`.
- Produces: `LJoteckClient` with `enabled: boolean` getter and `request<T>(path: string, opts?: { method?: "GET"|"POST"|"PUT"|"DELETE"; body?: unknown; formData?: FormData }): Promise<T>`, throwing `ServiceUnavailableException` (not configured), `BadGatewayException` (network failure), or `HttpException` (upstream non-2xx, with the upstream status code preserved) — used by every service in Tasks 5-8.

- [ ] **Step 1: Write the failing test**

Create `backend/src/integrations/l-joteck.client.spec.ts`:

```ts
import { BadGatewayException, HttpException, ServiceUnavailableException } from "@nestjs/common";
import { LJoteckClient } from "./l-joteck.client";

describe("LJoteckClient", () => {
  let client: LJoteckClient;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env.L_API_URL = "http://l.test/";
    process.env.L_JOTECK_SECRET = "shh";
    client = new LJoteckClient();
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    delete process.env.L_API_URL;
    delete process.env.L_JOTECK_SECRET;
    jest.restoreAllMocks();
  });

  it("is enabled only when both env vars are set", () => {
    expect(client.enabled).toBe(true);
    delete process.env.L_JOTECK_SECRET;
    expect(new LJoteckClient().enabled).toBe(false);
  });

  it("sends the secret header and joteck-prefixed path, trimming a trailing slash", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) });
    await client.request("/workspaces/ws-1/documents");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://l.test/api/v1/joteck/workspaces/ws-1/documents");
    expect(init.headers["x-joteck-secret"]).toBe("shh");
    expect(init.method).toBe("GET");
  });

  it("JSON-encodes a body and sets content-type", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 201, text: async () => JSON.stringify({ id: "1" }) });
    await client.request("/workspaces/ws-1/tools", { method: "POST", body: { name: "x" } });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["content-type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ name: "x" }));
  });

  it("passes formData through untouched and without a content-type header", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 202, text: async () => JSON.stringify({ id: "1" }) });
    const fd = new FormData();
    await client.request("/workspaces/ws-1/documents", { method: "POST", formData: fd });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).toBe(fd);
    expect(init.headers["content-type"]).toBeUndefined();
  });

  it("returns undefined for a 204", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204, text: async () => "" });
    await expect(client.request("/workspaces/ws-1/tools/t1")).resolves.toBeUndefined();
  });

  it("throws HttpException with the upstream status and detail message on a non-2xx", async () => {
    fetchMock.mockResolvedValue({
      ok: false, status: 409, text: async () => JSON.stringify({ detail: "already exists", code: "conflict" }),
    });
    await expect(client.request("/workspaces/ws-1/tools", { method: "POST" })).rejects.toMatchObject({
      status: 409,
      message: "already exists",
    });
  });

  it("throws BadGatewayException when the platform is unreachable", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(client.request("/workspaces/ws-1/tools")).rejects.toBeInstanceOf(BadGatewayException);
  });

  it("throws ServiceUnavailableException when not configured", async () => {
    delete process.env.L_JOTECK_SECRET;
    await expect(new LJoteckClient().request("/workspaces/ws-1/tools")).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it("is still an HttpException on the non-2xx path (subclass check)", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, text: async () => JSON.stringify({ detail: "not found" }) });
    await expect(client.request("/workspaces/ws-1/tools/t1", { method: "DELETE" })).rejects.toBeInstanceOf(
      HttpException,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx jest l-joteck.client.spec.ts`
Expected: FAIL — `Cannot find module './l-joteck.client'`.

- [ ] **Step 3: Implement the client**

Create `backend/src/integrations/l-joteck.client.ts`:

```ts
import {
  BadGatewayException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";

interface JoteckRequestOpts {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  formData?: FormData;
}

/**
 * Low-level client for the l agent platform's service-to-service "joteck"
 * admin surface (`/api/v1/joteck/...`). Every Knowledge/Tools/MCP proxy
 * service in this module goes through this — the shared secret and error
 * mapping live in exactly one place.
 *
 * L_JOTECK_SECRET is a different secret from this CRM's own JOTECK_CRM_SECRET
 * (backend/src/joteck/joteck.guard.ts): that one gates the Kewy console
 * calling INTO this CRM; this one is this CRM calling OUT to l.
 */
@Injectable()
export class LJoteckClient {
  private readonly logger = new Logger(LJoteckClient.name);

  get enabled(): boolean {
    return Boolean(process.env.L_API_URL && process.env.L_JOTECK_SECRET);
  }

  async request<T>(path: string, opts: JoteckRequestOpts = {}): Promise<T> {
    const baseUrl = process.env.L_API_URL;
    const secret = process.env.L_JOTECK_SECRET;
    if (!baseUrl || !secret) {
      throw new ServiceUnavailableException("Kewy AI platform is not configured");
    }

    const url = `${baseUrl.replace(/\/$/, "")}/api/v1/joteck${path}`;
    const headers: Record<string, string> = { "x-joteck-secret": secret };
    let body: BodyInit | undefined;
    if (opts.formData) {
      body = opts.formData;
    } else if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.body);
    }

    let res: Response;
    try {
      res = await fetch(url, { method: opts.method ?? "GET", headers, body });
    } catch (err) {
      this.logger.warn(
        `Could not reach l platform at ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new BadGatewayException("Could not reach the Kewy AI platform");
    }

    if (res.status === 204) return undefined as T;

    const raw = await res.text();
    const data: unknown = raw ? safeJson(raw) : undefined;

    if (!res.ok) {
      const message =
        isRecord(data) && typeof data.detail === "string"
          ? data.detail
          : `Kewy AI platform returned ${res.status}`;
      throw new HttpException(message, res.status);
    }
    return data as T;
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx jest l-joteck.client.spec.ts`
Expected: PASS (all 9 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/aabukhadir/projects/4pillars/kewy/crm
git add backend/src/integrations/l-joteck.client.ts backend/src/integrations/l-joteck.client.spec.ts
git commit -m "feat(l-config): add LJoteckClient for the l platform joteck surface"
```

---

### Task 5: `LAgentResolverService` — resolve and cache the workspace's agent slug

**Files:**
- Create: `backend/src/integrations/l-agent-resolver.service.ts`
- Test: `backend/src/integrations/l-agent-resolver.service.spec.ts`

**Interfaces:**
- Consumes: `LJoteckClient.request<T>` (Task 4), `PrismaService.workspace.findUnique`/`.update`.
- Produces: `LAgentResolverService.resolveSlug(workspaceId: string, lWorkspaceId: string): Promise<string>` — used by Tasks 7 and 8's bind/unbind methods.

- [ ] **Step 1: Write the failing test**

Create `backend/src/integrations/l-agent-resolver.service.spec.ts`:

```ts
import { Test } from "@nestjs/testing";
import { LAgentResolverService } from "./l-agent-resolver.service";
import { LJoteckClient } from "./l-joteck.client";
import { PrismaService } from "../prisma/prisma.service";

describe("LAgentResolverService.resolveSlug", () => {
  let svc: LAgentResolverService;
  let prisma: any;
  let client: any;

  beforeEach(async () => {
    prisma = {
      workspace: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    client = { request: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        LAgentResolverService,
        { provide: PrismaService, useValue: prisma },
        { provide: LJoteckClient, useValue: client },
      ],
    }).compile();
    svc = moduleRef.get(LAgentResolverService);
  });

  it("returns the cached slug without calling the platform", async () => {
    prisma.workspace.findUnique.mockResolvedValue({ lAgentSlug: "customer-support" });

    const slug = await svc.resolveSlug("ws-1", "l-ws-1");

    expect(slug).toBe("customer-support");
    expect(client.request).not.toHaveBeenCalled();
    expect(prisma.workspace.update).not.toHaveBeenCalled();
  });

  it("resolves via the default-agent endpoint and caches it when uncached", async () => {
    prisma.workspace.findUnique.mockResolvedValue({ lAgentSlug: null });
    client.request.mockResolvedValue({ slug: "customer-support" });

    const slug = await svc.resolveSlug("ws-1", "l-ws-1");

    expect(slug).toBe("customer-support");
    expect(client.request).toHaveBeenCalledWith("/workspaces/l-ws-1/agents/default", { method: "POST" });
    expect(prisma.workspace.update).toHaveBeenCalledWith({
      where: { id: "ws-1" },
      data: { lAgentSlug: "customer-support" },
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx jest l-agent-resolver.service.spec.ts`
Expected: FAIL — `Cannot find module './l-agent-resolver.service'`.

- [ ] **Step 3: Implement the service**

Create `backend/src/integrations/l-agent-resolver.service.ts`:

```ts
import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { LJoteckClient } from "./l-joteck.client";

interface LAgentResponse {
  slug: string;
}

/**
 * Resolves the l agent slug a workspace's tool/MCP-server bindings operate
 * on. Every CRM workspace maps to exactly one l agent in practice (there is
 * no multi-agent UI here) — this caches the slug on first resolve so a
 * bind/unbind call doesn't round-trip to l every time.
 */
@Injectable()
export class LAgentResolverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly client: LJoteckClient,
  ) {}

  async resolveSlug(workspaceId: string, lWorkspaceId: string): Promise<string> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { lAgentSlug: true },
    });
    if (workspace?.lAgentSlug) return workspace.lAgentSlug;

    const agent = await this.client.request<LAgentResponse>(
      `/workspaces/${lWorkspaceId}/agents/default`,
      { method: "POST" },
    );
    await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: { lAgentSlug: agent.slug },
    });
    return agent.slug;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx jest l-agent-resolver.service.spec.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/aabukhadir/projects/4pillars/kewy/crm
git add backend/src/integrations/l-agent-resolver.service.ts backend/src/integrations/l-agent-resolver.service.spec.ts
git commit -m "feat(l-config): add LAgentResolverService to cache the workspace agent slug"
```

---

### Task 6: `LKnowledgeService` — proxy documents

**Files:**
- Create: `backend/src/integrations/l-knowledge.service.ts`
- Test: `backend/src/integrations/l-knowledge.service.spec.ts`

**Interfaces:**
- Consumes: `LJoteckClient.request` (Task 4), `PrismaService.workspace.findUnique`.
- Produces: `LKnowledgeService.list(workspaceId): Promise<{ connected: boolean; documents: LDocument[] }>`, `.upload(workspaceId, file: Express.Multer.File): Promise<LDocument>`, `.remove(workspaceId, documentId): Promise<void>` — consumed by Task 9's controller. Exports the `LDocument` type.

- [ ] **Step 1: Write the failing test**

Create `backend/src/integrations/l-knowledge.service.spec.ts`:

```ts
import { ServiceUnavailableException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { LKnowledgeService } from "./l-knowledge.service";
import { LJoteckClient } from "./l-joteck.client";
import { PrismaService } from "../prisma/prisma.service";

const DOC = {
  id: "doc-1", title: "notes.txt", source_type: "upload", status: "ready",
  meta: {}, created_at: "2026-09-06T00:00:00Z",
};

describe("LKnowledgeService", () => {
  let svc: LKnowledgeService;
  let prisma: any;
  let client: any;

  beforeEach(async () => {
    prisma = { workspace: { findUnique: jest.fn().mockResolvedValue({ lWorkspaceId: "l-ws-1" }) } };
    client = { request: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        LKnowledgeService,
        { provide: PrismaService, useValue: prisma },
        { provide: LJoteckClient, useValue: client },
      ],
    }).compile();
    svc = moduleRef.get(LKnowledgeService);
  });

  it("lists documents for a connected workspace", async () => {
    client.request.mockResolvedValue([DOC]);
    const result = await svc.list("ws-1");
    expect(result).toEqual({ connected: true, documents: [DOC] });
    expect(client.request).toHaveBeenCalledWith("/workspaces/l-ws-1/documents");
  });

  it("returns connected:false without calling the platform when unlinked", async () => {
    prisma.workspace.findUnique.mockResolvedValue({ lWorkspaceId: null });
    const result = await svc.list("ws-1");
    expect(result).toEqual({ connected: false, documents: [] });
    expect(client.request).not.toHaveBeenCalled();
  });

  it("uploads a file as multipart form data", async () => {
    client.request.mockResolvedValue(DOC);
    const file = { buffer: Buffer.from("hello"), originalname: "notes.txt" } as Express.Multer.File;

    const result = await svc.upload("ws-1", file);

    expect(result).toEqual(DOC);
    const [path, opts] = client.request.mock.calls[0];
    expect(path).toBe("/workspaces/l-ws-1/documents");
    expect(opts.method).toBe("POST");
    expect(opts.formData).toBeInstanceOf(FormData);
  });

  it("throws when uploading to an unlinked workspace", async () => {
    prisma.workspace.findUnique.mockResolvedValue({ lWorkspaceId: null });
    const file = { buffer: Buffer.from("hello"), originalname: "x.txt" } as Express.Multer.File;
    await expect(svc.upload("ws-1", file)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("deletes a document by id", async () => {
    client.request.mockResolvedValue(undefined);
    await svc.remove("ws-1", "doc-1");
    expect(client.request).toHaveBeenCalledWith("/workspaces/l-ws-1/documents/doc-1", { method: "DELETE" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx jest l-knowledge.service.spec.ts`
Expected: FAIL — `Cannot find module './l-knowledge.service'`.

- [ ] **Step 3: Implement the service**

Create `backend/src/integrations/l-knowledge.service.ts`:

```ts
import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { LJoteckClient } from "./l-joteck.client";

export interface LDocument {
  id: string;
  title: string;
  source_type: string;
  status: string;
  meta: Record<string, unknown>;
  created_at: string;
}

@Injectable()
export class LKnowledgeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly client: LJoteckClient,
  ) {}

  private async requireLWorkspaceId(workspaceId: string): Promise<string | null> {
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { lWorkspaceId: true },
    });
    return ws?.lWorkspaceId ?? null;
  }

  async list(workspaceId: string): Promise<{ connected: boolean; documents: LDocument[] }> {
    const lWorkspaceId = await this.requireLWorkspaceId(workspaceId);
    if (!lWorkspaceId) return { connected: false, documents: [] };
    const documents = await this.client.request<LDocument[]>(`/workspaces/${lWorkspaceId}/documents`);
    return { connected: true, documents };
  }

  async upload(workspaceId: string, file: Express.Multer.File): Promise<LDocument> {
    const lWorkspaceId = await this.requireLWorkspaceId(workspaceId);
    if (!lWorkspaceId) throw new ServiceUnavailableException("Workspace is not connected to Kewy");
    const form = new FormData();
    form.append("file", new Blob([file.buffer]), file.originalname);
    return this.client.request<LDocument>(`/workspaces/${lWorkspaceId}/documents`, {
      method: "POST",
      formData: form,
    });
  }

  async remove(workspaceId: string, documentId: string): Promise<void> {
    const lWorkspaceId = await this.requireLWorkspaceId(workspaceId);
    if (!lWorkspaceId) throw new ServiceUnavailableException("Workspace is not connected to Kewy");
    await this.client.request<void>(`/workspaces/${lWorkspaceId}/documents/${documentId}`, {
      method: "DELETE",
    });
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx jest l-knowledge.service.spec.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/aabukhadir/projects/4pillars/kewy/crm
git add backend/src/integrations/l-knowledge.service.ts backend/src/integrations/l-knowledge.service.spec.ts
git commit -m "feat(l-config): add LKnowledgeService to proxy document management"
```

---

### Task 7: `LToolsService` — proxy tool CRUD + agent binding

**Files:**
- Create: `backend/src/integrations/l-tools.service.ts`
- Test: `backend/src/integrations/l-tools.service.spec.ts`

**Interfaces:**
- Consumes: `LJoteckClient.request` (Task 4), `LAgentResolverService.resolveSlug` (Task 5), `PrismaService.workspace.findUnique`.
- Produces: `LToolsService.list/create/remove/bind/unbind`, and the `LTool`/`CreateLToolInput` types, consumed by Task 9's controller.

- [ ] **Step 1: Write the failing test**

Create `backend/src/integrations/l-tools.service.spec.ts`:

```ts
import { ServiceUnavailableException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { LToolsService } from "./l-tools.service";
import { LJoteckClient } from "./l-joteck.client";
import { LAgentResolverService } from "./l-agent-resolver.service";
import { PrismaService } from "../prisma/prisma.service";

const TOOL = {
  id: "tool-1", name: "weather", description: "d", method: "GET",
  url_template: "https://x/{city}", enabled: true, created_at: "2026-09-06T00:00:00Z",
  params: ["city"],
};

describe("LToolsService", () => {
  let svc: LToolsService;
  let prisma: any;
  let client: any;
  let resolver: any;

  beforeEach(async () => {
    prisma = { workspace: { findUnique: jest.fn().mockResolvedValue({ lWorkspaceId: "l-ws-1" }) } };
    client = { request: jest.fn() };
    resolver = { resolveSlug: jest.fn().mockResolvedValue("customer-support") };

    const moduleRef = await Test.createTestingModule({
      providers: [
        LToolsService,
        { provide: PrismaService, useValue: prisma },
        { provide: LJoteckClient, useValue: client },
        { provide: LAgentResolverService, useValue: resolver },
      ],
    }).compile();
    svc = moduleRef.get(LToolsService);
  });

  it("lists tools for a connected workspace", async () => {
    client.request.mockResolvedValue([TOOL]);
    const result = await svc.list("ws-1");
    expect(result).toEqual({ connected: true, tools: [TOOL] });
    expect(client.request).toHaveBeenCalledWith("/workspaces/l-ws-1/tools");
  });

  it("returns connected:false when unlinked", async () => {
    prisma.workspace.findUnique.mockResolvedValue({ lWorkspaceId: null });
    expect(await svc.list("ws-1")).toEqual({ connected: false, tools: [] });
  });

  it("creates a tool", async () => {
    client.request.mockResolvedValue(TOOL);
    const input = { name: "weather", description: "d", method: "GET", url_template: "https://x/{city}" };
    const result = await svc.create("ws-1", input);
    expect(result).toEqual(TOOL);
    expect(client.request).toHaveBeenCalledWith("/workspaces/l-ws-1/tools", { method: "POST", body: input });
  });

  it("deletes a tool", async () => {
    await svc.remove("ws-1", "tool-1");
    expect(client.request).toHaveBeenCalledWith("/workspaces/l-ws-1/tools/tool-1", { method: "DELETE" });
  });

  it("binds a tool to the resolved agent slug", async () => {
    await svc.bind("ws-1", "tool-1");
    expect(resolver.resolveSlug).toHaveBeenCalledWith("ws-1", "l-ws-1");
    expect(client.request).toHaveBeenCalledWith(
      "/workspaces/l-ws-1/agents/customer-support/tools/tool-1", { method: "PUT" },
    );
  });

  it("unbinds a tool from the resolved agent slug", async () => {
    await svc.unbind("ws-1", "tool-1");
    expect(client.request).toHaveBeenCalledWith(
      "/workspaces/l-ws-1/agents/customer-support/tools/tool-1", { method: "DELETE" },
    );
  });

  it("throws when binding on an unlinked workspace", async () => {
    prisma.workspace.findUnique.mockResolvedValue({ lWorkspaceId: null });
    await expect(svc.bind("ws-1", "tool-1")).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(resolver.resolveSlug).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx jest l-tools.service.spec.ts`
Expected: FAIL — `Cannot find module './l-tools.service'`.

- [ ] **Step 3: Implement the service**

Create `backend/src/integrations/l-tools.service.ts`:

```ts
import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { LAgentResolverService } from "./l-agent-resolver.service";
import { LJoteckClient } from "./l-joteck.client";

export interface LTool {
  id: string;
  name: string;
  description: string;
  method: string;
  url_template: string;
  enabled: boolean;
  created_at: string;
  params: string[];
}

export interface CreateLToolInput {
  name: string;
  description: string;
  method: string;
  url_template: string;
  headers?: Record<string, string>;
  body_template?: Record<string, unknown> | null;
  param_descriptions?: Record<string, string>;
}

@Injectable()
export class LToolsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly client: LJoteckClient,
    private readonly resolver: LAgentResolverService,
  ) {}

  private async requireLWorkspaceId(workspaceId: string): Promise<string | null> {
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { lWorkspaceId: true },
    });
    return ws?.lWorkspaceId ?? null;
  }

  async list(workspaceId: string): Promise<{ connected: boolean; tools: LTool[] }> {
    const lWorkspaceId = await this.requireLWorkspaceId(workspaceId);
    if (!lWorkspaceId) return { connected: false, tools: [] };
    const tools = await this.client.request<LTool[]>(`/workspaces/${lWorkspaceId}/tools`);
    return { connected: true, tools };
  }

  async create(workspaceId: string, input: CreateLToolInput): Promise<LTool> {
    const lWorkspaceId = await this.requireLWorkspaceId(workspaceId);
    if (!lWorkspaceId) throw new ServiceUnavailableException("Workspace is not connected to Kewy");
    return this.client.request<LTool>(`/workspaces/${lWorkspaceId}/tools`, { method: "POST", body: input });
  }

  async remove(workspaceId: string, toolId: string): Promise<void> {
    const lWorkspaceId = await this.requireLWorkspaceId(workspaceId);
    if (!lWorkspaceId) throw new ServiceUnavailableException("Workspace is not connected to Kewy");
    await this.client.request<void>(`/workspaces/${lWorkspaceId}/tools/${toolId}`, { method: "DELETE" });
  }

  async bind(workspaceId: string, toolId: string): Promise<void> {
    const lWorkspaceId = await this.requireLWorkspaceId(workspaceId);
    if (!lWorkspaceId) throw new ServiceUnavailableException("Workspace is not connected to Kewy");
    const slug = await this.resolver.resolveSlug(workspaceId, lWorkspaceId);
    await this.client.request<void>(
      `/workspaces/${lWorkspaceId}/agents/${slug}/tools/${toolId}`, { method: "PUT" },
    );
  }

  async unbind(workspaceId: string, toolId: string): Promise<void> {
    const lWorkspaceId = await this.requireLWorkspaceId(workspaceId);
    if (!lWorkspaceId) throw new ServiceUnavailableException("Workspace is not connected to Kewy");
    const slug = await this.resolver.resolveSlug(workspaceId, lWorkspaceId);
    await this.client.request<void>(
      `/workspaces/${lWorkspaceId}/agents/${slug}/tools/${toolId}`, { method: "DELETE" },
    );
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx jest l-tools.service.spec.ts`
Expected: PASS (all 7 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/aabukhadir/projects/4pillars/kewy/crm
git add backend/src/integrations/l-tools.service.ts backend/src/integrations/l-tools.service.spec.ts
git commit -m "feat(l-config): add LToolsService to proxy tool management"
```

---

### Task 8: `LMcpService` — proxy MCP server CRUD + agent binding + test

**Files:**
- Create: `backend/src/integrations/l-mcp.service.ts`
- Test: `backend/src/integrations/l-mcp.service.spec.ts`

**Interfaces:**
- Consumes: `LJoteckClient.request` (Task 4), `LAgentResolverService.resolveSlug` (Task 5), `PrismaService.workspace.findUnique`.
- Produces: `LMcpService.list/create/remove/bind/unbind/test`, and `LMcpServer`/`LMcpTestResult`/`CreateLMcpServerInput` types, consumed by Task 9's controller.

- [ ] **Step 1: Write the failing test**

Create `backend/src/integrations/l-mcp.service.spec.ts`:

```ts
import { ServiceUnavailableException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { LMcpService } from "./l-mcp.service";
import { LJoteckClient } from "./l-joteck.client";
import { LAgentResolverService } from "./l-agent-resolver.service";
import { PrismaService } from "../prisma/prisma.service";

const SERVER = {
  id: "srv-1", name: "docs", description: "d", url: "https://mcp.example.com/mcp",
  enabled: true, last_checked_at: null, last_error: null, created_at: "2026-09-06T00:00:00Z",
};

describe("LMcpService", () => {
  let svc: LMcpService;
  let prisma: any;
  let client: any;
  let resolver: any;

  beforeEach(async () => {
    prisma = { workspace: { findUnique: jest.fn().mockResolvedValue({ lWorkspaceId: "l-ws-1" }) } };
    client = { request: jest.fn() };
    resolver = { resolveSlug: jest.fn().mockResolvedValue("customer-support") };

    const moduleRef = await Test.createTestingModule({
      providers: [
        LMcpService,
        { provide: PrismaService, useValue: prisma },
        { provide: LJoteckClient, useValue: client },
        { provide: LAgentResolverService, useValue: resolver },
      ],
    }).compile();
    svc = moduleRef.get(LMcpService);
  });

  it("lists servers for a connected workspace", async () => {
    client.request.mockResolvedValue([SERVER]);
    expect(await svc.list("ws-1")).toEqual({ connected: true, servers: [SERVER] });
    expect(client.request).toHaveBeenCalledWith("/workspaces/l-ws-1/mcp-servers");
  });

  it("returns connected:false when unlinked", async () => {
    prisma.workspace.findUnique.mockResolvedValue({ lWorkspaceId: null });
    expect(await svc.list("ws-1")).toEqual({ connected: false, servers: [] });
  });

  it("creates a server", async () => {
    client.request.mockResolvedValue(SERVER);
    const input = { name: "docs", description: "d", url: "https://mcp.example.com/mcp" };
    expect(await svc.create("ws-1", input)).toEqual(SERVER);
    expect(client.request).toHaveBeenCalledWith("/workspaces/l-ws-1/mcp-servers", { method: "POST", body: input });
  });

  it("deletes a server", async () => {
    await svc.remove("ws-1", "srv-1");
    expect(client.request).toHaveBeenCalledWith("/workspaces/l-ws-1/mcp-servers/srv-1", { method: "DELETE" });
  });

  it("binds a server to the resolved agent slug", async () => {
    await svc.bind("ws-1", "srv-1");
    expect(client.request).toHaveBeenCalledWith(
      "/workspaces/l-ws-1/agents/customer-support/mcp-servers/srv-1", { method: "PUT" },
    );
  });

  it("unbinds a server from the resolved agent slug", async () => {
    await svc.unbind("ws-1", "srv-1");
    expect(client.request).toHaveBeenCalledWith(
      "/workspaces/l-ws-1/agents/customer-support/mcp-servers/srv-1", { method: "DELETE" },
    );
  });

  it("tests a server", async () => {
    client.request.mockResolvedValue({ ok: true, tools: ["echo"], error: null });
    const result = await svc.test("ws-1", "srv-1");
    expect(result).toEqual({ ok: true, tools: ["echo"], error: null });
    expect(client.request).toHaveBeenCalledWith(
      "/workspaces/l-ws-1/mcp-servers/srv-1/test", { method: "POST" },
    );
  });

  it("throws when creating on an unlinked workspace", async () => {
    prisma.workspace.findUnique.mockResolvedValue({ lWorkspaceId: null });
    await expect(
      svc.create("ws-1", { name: "docs", description: "d", url: "https://x" }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx jest l-mcp.service.spec.ts`
Expected: FAIL — `Cannot find module './l-mcp.service'`.

- [ ] **Step 3: Implement the service**

Create `backend/src/integrations/l-mcp.service.ts`:

```ts
import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { LAgentResolverService } from "./l-agent-resolver.service";
import { LJoteckClient } from "./l-joteck.client";

export interface LMcpServer {
  id: string;
  name: string;
  description: string;
  url: string;
  enabled: boolean;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface LMcpTestResult {
  ok: boolean;
  tools: string[];
  error: string | null;
}

export interface CreateLMcpServerInput {
  name: string;
  description: string;
  url: string;
  headers?: Record<string, string>;
}

@Injectable()
export class LMcpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly client: LJoteckClient,
    private readonly resolver: LAgentResolverService,
  ) {}

  private async requireLWorkspaceId(workspaceId: string): Promise<string | null> {
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { lWorkspaceId: true },
    });
    return ws?.lWorkspaceId ?? null;
  }

  async list(workspaceId: string): Promise<{ connected: boolean; servers: LMcpServer[] }> {
    const lWorkspaceId = await this.requireLWorkspaceId(workspaceId);
    if (!lWorkspaceId) return { connected: false, servers: [] };
    const servers = await this.client.request<LMcpServer[]>(`/workspaces/${lWorkspaceId}/mcp-servers`);
    return { connected: true, servers };
  }

  async create(workspaceId: string, input: CreateLMcpServerInput): Promise<LMcpServer> {
    const lWorkspaceId = await this.requireLWorkspaceId(workspaceId);
    if (!lWorkspaceId) throw new ServiceUnavailableException("Workspace is not connected to Kewy");
    return this.client.request<LMcpServer>(`/workspaces/${lWorkspaceId}/mcp-servers`, {
      method: "POST",
      body: input,
    });
  }

  async remove(workspaceId: string, serverId: string): Promise<void> {
    const lWorkspaceId = await this.requireLWorkspaceId(workspaceId);
    if (!lWorkspaceId) throw new ServiceUnavailableException("Workspace is not connected to Kewy");
    await this.client.request<void>(`/workspaces/${lWorkspaceId}/mcp-servers/${serverId}`, {
      method: "DELETE",
    });
  }

  async bind(workspaceId: string, serverId: string): Promise<void> {
    const lWorkspaceId = await this.requireLWorkspaceId(workspaceId);
    if (!lWorkspaceId) throw new ServiceUnavailableException("Workspace is not connected to Kewy");
    const slug = await this.resolver.resolveSlug(workspaceId, lWorkspaceId);
    await this.client.request<void>(
      `/workspaces/${lWorkspaceId}/agents/${slug}/mcp-servers/${serverId}`, { method: "PUT" },
    );
  }

  async unbind(workspaceId: string, serverId: string): Promise<void> {
    const lWorkspaceId = await this.requireLWorkspaceId(workspaceId);
    if (!lWorkspaceId) throw new ServiceUnavailableException("Workspace is not connected to Kewy");
    const slug = await this.resolver.resolveSlug(workspaceId, lWorkspaceId);
    await this.client.request<void>(
      `/workspaces/${lWorkspaceId}/agents/${slug}/mcp-servers/${serverId}`, { method: "DELETE" },
    );
  }

  async test(workspaceId: string, serverId: string): Promise<LMcpTestResult> {
    const lWorkspaceId = await this.requireLWorkspaceId(workspaceId);
    if (!lWorkspaceId) throw new ServiceUnavailableException("Workspace is not connected to Kewy");
    return this.client.request<LMcpTestResult>(
      `/workspaces/${lWorkspaceId}/mcp-servers/${serverId}/test`, { method: "POST" },
    );
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx jest l-mcp.service.spec.ts`
Expected: PASS (all 8 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/aabukhadir/projects/4pillars/kewy/crm
git add backend/src/integrations/l-mcp.service.ts backend/src/integrations/l-mcp.service.spec.ts
git commit -m "feat(l-config): add LMcpService to proxy MCP server management"
```

---

### Task 9: `LConfigController` + module wiring + env var docs

**Files:**
- Create: `backend/src/integrations/l-config.controller.ts`
- Modify: `backend/src/integrations/integrations.module.ts`
- Modify: `backend/.env.example`

**Interfaces:**
- Consumes: `LKnowledgeService` (Task 6), `LToolsService` (Task 7), `LMcpService` (Task 8), `WorkspacesService.requireMember` (existing, from `WorkspacesModule`), `CurrentWorkspace`/`CurrentUserId` decorators (existing), `PrismaService` (existing).
- Produces: the full `/integrations/l/*` REST surface the frontend (Tasks 11-13) calls against.

This task has no automated test of its own — this codebase has no controller-level test convention (`ZernioController`, `MediaController`, etc. are untested; only services are). Verify manually in Step 4.

- [ ] **Step 1: Create the controller**

Create `backend/src/integrations/l-config.controller.ts`:

```ts
import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import { IsIn, IsObject, IsOptional, IsString } from "class-validator";
import { CurrentUserId, CurrentWorkspace } from "../common/current-workspace.decorator";
import { PrismaService } from "../prisma/prisma.service";
import { WorkspacesService } from "../workspaces/workspaces.service";
import { LKnowledgeService } from "./l-knowledge.service";
import { LMcpService, type CreateLMcpServerInput } from "./l-mcp.service";
import { LToolsService, type CreateLToolInput } from "./l-tools.service";

class CreateToolDto implements CreateLToolInput {
  @IsString() name!: string;
  @IsString() description!: string;
  @IsIn(["GET", "POST", "PUT", "PATCH", "DELETE"]) method!: string;
  @IsString() url_template!: string;
  @IsOptional() @IsObject() headers?: Record<string, string>;
  @IsOptional() @IsObject() body_template?: Record<string, unknown> | null;
  @IsOptional() @IsObject() param_descriptions?: Record<string, string>;
}

class CreateMcpServerDto implements CreateLMcpServerInput {
  @IsString() name!: string;
  @IsString() description!: string;
  @IsString() url!: string;
  @IsOptional() @IsObject() headers?: Record<string, string>;
}

@Controller("integrations/l")
export class LConfigController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaces: WorkspacesService,
    private readonly knowledge: LKnowledgeService,
    private readonly tools: LToolsService,
    private readonly mcp: LMcpService,
  ) {}

  private async requireEditor(userId: string, workspaceId: string): Promise<void> {
    const role = await this.workspaces.requireMember(userId, workspaceId);
    if (role !== "owner" && role !== "admin") {
      throw new ForbiddenException("Only owner or admin can manage the Kewy AI agent");
    }
  }

  @Get("status")
  async status(@CurrentWorkspace() workspaceId: string) {
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { lWorkspaceId: true },
    });
    return { connected: Boolean(ws?.lWorkspaceId) };
  }

  @Get("knowledge")
  listKnowledge(@CurrentWorkspace() workspaceId: string) {
    return this.knowledge.list(workspaceId);
  }

  @Post("knowledge")
  @UseInterceptors(FileInterceptor("file", { storage: memoryStorage() }))
  async uploadKnowledge(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUserId() userId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    await this.requireEditor(userId, workspaceId);
    return this.knowledge.upload(workspaceId, file);
  }

  @Delete("knowledge/:documentId")
  async deleteKnowledge(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUserId() userId: string,
    @Param("documentId") documentId: string,
  ) {
    await this.requireEditor(userId, workspaceId);
    await this.knowledge.remove(workspaceId, documentId);
    return { ok: true };
  }

  @Get("tools")
  listTools(@CurrentWorkspace() workspaceId: string) {
    return this.tools.list(workspaceId);
  }

  @Post("tools")
  async createTool(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUserId() userId: string,
    @Body() dto: CreateToolDto,
  ) {
    await this.requireEditor(userId, workspaceId);
    return this.tools.create(workspaceId, dto);
  }

  @Delete("tools/:toolId")
  async deleteTool(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUserId() userId: string,
    @Param("toolId") toolId: string,
  ) {
    await this.requireEditor(userId, workspaceId);
    await this.tools.remove(workspaceId, toolId);
    return { ok: true };
  }

  // POST, not PUT: the frontend's shared `api` client (src/api/client.ts)
  // only exposes get/post/patch/delete, and adding a fifth verb there for
  // one call site isn't worth it — this endpoint is idempotent either way.
  @Post("tools/:toolId/binding")
  async bindTool(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUserId() userId: string,
    @Param("toolId") toolId: string,
  ) {
    await this.requireEditor(userId, workspaceId);
    await this.tools.bind(workspaceId, toolId);
    return { ok: true };
  }

  @Delete("tools/:toolId/binding")
  async unbindTool(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUserId() userId: string,
    @Param("toolId") toolId: string,
  ) {
    await this.requireEditor(userId, workspaceId);
    await this.tools.unbind(workspaceId, toolId);
    return { ok: true };
  }

  @Get("mcp-servers")
  listMcpServers(@CurrentWorkspace() workspaceId: string) {
    return this.mcp.list(workspaceId);
  }

  @Post("mcp-servers")
  async createMcpServer(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUserId() userId: string,
    @Body() dto: CreateMcpServerDto,
  ) {
    await this.requireEditor(userId, workspaceId);
    return this.mcp.create(workspaceId, dto);
  }

  @Delete("mcp-servers/:serverId")
  async deleteMcpServer(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUserId() userId: string,
    @Param("serverId") serverId: string,
  ) {
    await this.requireEditor(userId, workspaceId);
    await this.mcp.remove(workspaceId, serverId);
    return { ok: true };
  }

  // POST, not PUT — same reason as bindTool above.
  @Post("mcp-servers/:serverId/binding")
  async bindMcpServer(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUserId() userId: string,
    @Param("serverId") serverId: string,
  ) {
    await this.requireEditor(userId, workspaceId);
    await this.mcp.bind(workspaceId, serverId);
    return { ok: true };
  }

  @Delete("mcp-servers/:serverId/binding")
  async unbindMcpServer(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUserId() userId: string,
    @Param("serverId") serverId: string,
  ) {
    await this.requireEditor(userId, workspaceId);
    await this.mcp.unbind(workspaceId, serverId);
    return { ok: true };
  }

  @Post("mcp-servers/:serverId/test")
  async testMcpServer(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUserId() userId: string,
    @Param("serverId") serverId: string,
  ) {
    await this.requireEditor(userId, workspaceId);
    return this.mcp.test(workspaceId, serverId);
  }
}
```

- [ ] **Step 2: Wire the module**

Modify `backend/src/integrations/integrations.module.ts` — add the new imports, register `WorkspacesModule` (for `WorkspacesService`), the new controller, and the new providers:

```ts
import { Module } from "@nestjs/common";
import { FacebookController } from "./facebook.controller";
import { FacebookService } from "./facebook.service";
import { InstagramController } from "./instagram.controller";
import { InstagramService } from "./instagram.service";
import { WhatsAppController } from "./whatsapp.controller";
import { WhatsAppService } from "./whatsapp.service";
import { ZernioController } from "./zernio.controller";
import { ZernioService } from "./zernio.service";
import { ZernioClient } from "./zernio.client";
import { MetaWebhooksController } from "./meta-webhooks.controller";
import { MetaWebhooksService } from "./meta-webhooks.service";
import { HjzWebhooksController } from "./hjz-webhooks.controller";
import { HjzWebhooksService } from "./hjz-webhooks.service";
import { LWebhooksController } from "./l-webhooks.controller";
import { LWebhooksService } from "./l-webhooks.service";
import { LAgentService } from "./l-agent.service";
import { LConfigController } from "./l-config.controller";
import { LJoteckClient } from "./l-joteck.client";
import { LAgentResolverService } from "./l-agent-resolver.service";
import { LKnowledgeService } from "./l-knowledge.service";
import { LToolsService } from "./l-tools.service";
import { LMcpService } from "./l-mcp.service";
import { MediaModule } from "../media/media.module";
import { RealtimeModule } from "../realtime/realtime.module";
import { TicketsModule } from "../tickets/tickets.module";
import { WorkspacesModule } from "../workspaces/workspaces.module";

@Module({
  imports: [MediaModule, RealtimeModule, TicketsModule, WorkspacesModule],
  controllers: [
    FacebookController,
    InstagramController,
    WhatsAppController,
    ZernioController,
    MetaWebhooksController,
    HjzWebhooksController,
    LWebhooksController,
    LConfigController,
  ],
  providers: [
    FacebookService,
    InstagramService,
    WhatsAppService,
    ZernioService,
    ZernioClient,
    MetaWebhooksService,
    HjzWebhooksService,
    LWebhooksService,
    LAgentService,
    LJoteckClient,
    LAgentResolverService,
    LKnowledgeService,
    LToolsService,
    LMcpService,
  ],
  exports: [FacebookService, InstagramService, WhatsAppService, ZernioService],
})
export class IntegrationsModule {}
```

- [ ] **Step 3: Document the new env var**

Add to `backend/.env.example`, near the existing "l (agent platform) webhook integration" section:

```
# Outbound secret this CRM sends as x-joteck-secret when calling l's service-
# to-service joteck admin surface (Knowledge/Tools/MCP management). NOT the
# same value as JOTECK_CRM_SECRET above — that one gates the opposite
# direction (Kewy console calling into this CRM's own /joteck surface).
L_JOTECK_SECRET=
```

- [ ] **Step 4: Verify manually**

```bash
cd backend
npm run build
```
Expected: compiles with no TypeScript errors.

Then, with `L_API_URL` and `L_JOTECK_SECRET` set to point at a running `kewy/l` instance (from Part A) and a workspace whose `lWorkspaceId` is set, start the backend and smoke-test with curl (replace `$TOKEN` with a real JWT for a workspace member):

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:4100/api/integrations/l/status
curl -H "Authorization: Bearer $TOKEN" http://localhost:4100/api/integrations/l/tools
```
Expected: `{"connected":true}` and `{"connected":true,"tools":[]}` respectively (or a `403` if the test user isn't owner/admin for a mutating call — status/list are read-only and unrestricted here by design, matching `ZernioController`'s read endpoints).

- [ ] **Step 5: Commit**

```bash
cd /Users/aabukhadir/projects/4pillars/kewy/crm
git add backend/src/integrations/l-config.controller.ts backend/src/integrations/integrations.module.ts backend/.env.example
git commit -m "feat(l-config): expose /integrations/l REST surface for Knowledge/Tools/MCP"
```

---

## Part C — CRM frontend (`/Users/aabukhadir/projects/4pillars/kewy/crm`)

### Task 10: Route, nav entry, and the KewyAgent screen shell

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/shell/nav.ts`
- Modify: `src/router.tsx`
- Create: `src/screens/KewyAgent.tsx`

**Interfaces:**
- Consumes: `useFetch` (`@/api/useFetch`), `useAuth` (`@/auth/context`), `useTweaks`/`makeTx` (`@/tweaks/context`, `@/lib/tx`), `PageHeader` (`@/components/PageHeader`).
- Produces: the `agent` `RouteId`, a sidebar nav item, and `KewyAgentImpl`'s internal tab state (`"knowledge" | "tools" | "mcp"`), which Tasks 11-13 plug their tab components into.

This is a UI shell task with no backend logic to unit test (this repo has no frontend test framework — see Global Constraints). Verify manually in Step 2.

- [ ] **Step 1: Wire the route**

In `src/lib/types.ts`, add `"agent"` to the `RouteId` union (after `"team"`, before `"settings"`, matching the old Agents.tsx's nav position):

```ts
export type RouteId =
  | "dashboard"
  | "inbox"
  | "calendar"
  | "social"
  | "media"
  | "pipeline"
  | "campaigns"
  | "contacts"
  | "analytics"
  | "templates"
  | "team"
  | "agent"
  | "settings"
  | "admin";
```

In `src/shell/nav.ts`, add `IconBot` to the icon import, a `NavItem` entry, and a `TITLES` entry:

```ts
import {
  IconHome, IconInbox, IconCampaign, IconUsers,
  IconChart, IconTemplate, IconTeam, IconCog, IconCal, IconGlobe,
  IconLayers, IconBolt, IconAttach, IconBot,
} from "@/icons";
```

```ts
export const NAV: NavEntry[] = [
  { section: "Workspace" },
  { id: "dashboard",   label: "Dashboard",   ar: "اللوحة",        Icon: IconHome },
  { id: "inbox",       label: "Inbox",       ar: "الرسائل",       Icon: IconInbox },
  { id: "calendar",    label: "Calendar",    ar: "التقويم",       Icon: IconCal },
  { id: "social",      label: "Social",      ar: "السوشيال",      Icon: IconGlobe },
  { id: "campaigns",   label: "Campaigns",   ar: "الحملات",       Icon: IconCampaign },
  { id: "pipeline",    label: "Pipeline",    ar: "خط الأنابيب",   Icon: IconLayers },
  { id: "contacts",    label: "Contacts",    ar: "جهات الاتصال",  Icon: IconUsers },
  { id: "analytics",   label: "Analytics",   ar: "التحليلات",     Icon: IconChart },
  { section: "Manage" },
  { id: "templates",   label: "Templates",   ar: "القوالب",       Icon: IconTemplate },
  { id: "media",       label: "Media",       ar: "الوسائط",        Icon: IconAttach },
  { id: "team",        label: "Team",        ar: "الفريق",        Icon: IconTeam },
  { id: "agent",       label: "Kewy AI",     ar: "كيوي الذكاء",    Icon: IconBot },
  { id: "settings",    label: "Settings",    ar: "الإعدادات",     Icon: IconCog },
  { section: "Kewy ops" },
  { id: "admin",       label: "Admin portal", ar: "بوابة الإدارة",  Icon: IconBolt, superAdminOnly: true },
];

export const TITLES: Record<RouteId, { en: string; ar: string }> = {
  dashboard:   { en: "Dashboard",       ar: "لوحة التحكم" },
  inbox:       { en: "Inbox",           ar: "صندوق الرسائل" },
  calendar:    { en: "Calendar",        ar: "التقويم والحجوزات" },
  social:      { en: "Social media",    ar: "وسائل التواصل" },
  campaigns:   { en: "Campaigns",       ar: "الحملات" },
  pipeline:    { en: "Sales pipeline",  ar: "مسار المبيعات" },
  contacts:    { en: "Contacts",        ar: "جهات الاتصال" },
  analytics:   { en: "Analytics",       ar: "التحليلات" },
  templates:   { en: "Templates",       ar: "القوالب" },
  media:       { en: "Media library",   ar: "مكتبة الوسائط" },
  team:        { en: "Team",            ar: "الفريق" },
  agent:       { en: "Kewy AI agent",   ar: "وكيل كيوي الذكاء" },
  settings:    { en: "Settings",        ar: "الإعدادات" },
  admin:       { en: "Kewy admin portal", ar: "بوابة إدارة كيوي" },
};
```

In `src/router.tsx`, add the lazy import:

```ts
const screens: Record<RouteId, React.LazyExoticComponent<React.ComponentType>> = {
  dashboard: lazy(() => import("@/screens/Dashboard")),
  inbox: lazy(() => import("@/screens/Inbox")),
  calendar: lazy(() => import("@/screens/Calendar")),
  social: lazy(() => import("@/screens/Social")),
  campaigns: lazy(() => import("@/screens/Campaigns")),
  pipeline: lazy(() => import("@/screens/pipeline/PipelinePage")),
  contacts: lazy(() => import("@/screens/Contacts")),
  analytics: lazy(() => import("@/screens/Analytics")),
  templates: lazy(() => import("@/screens/Templates")),
  media: lazy(() => import("@/screens/Media")),
  team: lazy(() => import("@/screens/Team")),
  agent: lazy(() => import("@/screens/KewyAgent")),
  settings: lazy(() => import("@/screens/Settings")),
  admin: lazy(() => import("@/screens/Admin")),
};
```

- [ ] **Step 2: Create the screen shell**

Create `src/screens/KewyAgent.tsx`:

```tsx
import { memo, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { useAuth } from "@/auth/context";
import { useFetch } from "@/api/useFetch";
import { PageHeader } from "@/components/PageHeader";
import { KnowledgeTab } from "./kewy-agent/KnowledgeTab";
import { ToolsTab } from "./kewy-agent/ToolsTab";
import { McpServersTab } from "./kewy-agent/McpServersTab";

type Tab = "knowledge" | "tools" | "mcp";

interface LStatus {
  connected: boolean;
}

function KewyAgentImpl() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const { activeWorkspace } = useAuth();
  const canEdit = activeWorkspace?.role === "owner" || activeWorkspace?.role === "admin";
  const [tab, setTab] = useState<Tab>("knowledge");

  const statusQ = useFetch<LStatus>("/integrations/l/status");
  const connected = statusQ.data?.connected === true;

  const tabs: Array<{ id: Tab; label: string; ar: string }> = [
    { id: "knowledge", label: "Knowledge", ar: "المعرفة" },
    { id: "tools", label: "Tools", ar: "الأدوات" },
    { id: "mcp", label: "MCP Servers", ar: "خوادم MCP" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <PageHeader
        title={tx("Kewy AI agent", "وكيل كيوي الذكاء")}
        subtitle={tx(
          "Manage your agent's knowledge base, tools, and MCP connections.",
          "إدارة قاعدة معرفة وكيلك وأدواته واتصالات MCP.",
        )}
      />

      {!statusQ.loading && !connected ? (
        <div style={{ padding: "0 32px" }}>
          <div
            style={{
              background: "var(--bg-1)",
              border: "1px solid var(--line-soft)",
              borderRadius: 12,
              padding: 18,
              maxWidth: 560,
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
              {tx("Not connected to Kewy", "غير متصل بكيوي")}
            </div>
            <div className="muted" style={{ fontSize: 13 }}>
              {tx(
                "This workspace isn't linked to a Kewy AI agent yet. Connect it from the Kewy control panel to manage its knowledge base, tools, and MCP servers here.",
                "لم تُربط مساحة العمل هذه بوكيل كيوي الذكاء بعد. اربطها من لوحة تحكم كيوي لإدارة قاعدة المعرفة والأدوات وخوادم MCP هنا.",
              )}
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="tabs" style={{ padding: "0 24px" }}>
            {tabs.map((tb) => (
              <button
                key={tb.id}
                type="button"
                className={`tab ${tab === tb.id ? "active" : ""}`.trim()}
                onClick={() => setTab(tb.id)}
              >
                <span>{t.lang === "ar" ? tb.ar : tb.label}</span>
              </button>
            ))}
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: "24px 32px" }}>
            {tab === "knowledge" && <KnowledgeTab tx={tx} canEdit={canEdit} />}
            {tab === "tools" && <ToolsTab tx={tx} canEdit={canEdit} />}
            {tab === "mcp" && <McpServersTab tx={tx} canEdit={canEdit} />}
          </div>
        </>
      )}
    </div>
  );
}

const KewyAgent = memo(KewyAgentImpl);
export default KewyAgent;
```

Create empty placeholder tab files so this compiles before Tasks 11-13 fill them in — `src/screens/kewy-agent/KnowledgeTab.tsx`, `src/screens/kewy-agent/ToolsTab.tsx`, `src/screens/kewy-agent/McpServersTab.tsx`, each with this shape (shown for `KnowledgeTab.tsx`; repeat verbatim with the other two names):

```tsx
import type { Tx } from "@/lib/tx";

export function KnowledgeTab({ tx, canEdit }: { tx: Tx; canEdit: boolean }) {
  return <div className="muted">{tx("Coming soon.", "قريبًا.")}</div>;
}
```

- [ ] **Step 3: Verify manually**

```bash
cd /Users/aabukhadir/projects/4pillars/kewy/crm
npm run typecheck
```
Expected: no errors.

Then start the dev server (per the `verify` skill) and confirm: a "Kewy AI" sidebar item appears; clicking it navigates to `#/agent`; if the logged-in workspace has no `lWorkspaceId`, the "Not connected to Kewy" card renders; if it does, the three-tab switcher renders with "Coming soon." placeholders.

- [ ] **Step 4: Commit**

```bash
git add src/lib/types.ts src/shell/nav.ts src/router.tsx src/screens/KewyAgent.tsx src/screens/kewy-agent/
git commit -m "feat(kewy-agent): add Kewy AI screen shell with not-connected state"
```

---

### Task 11: Knowledge tab

**Files:**
- Create: `src/api/l-knowledge.ts` (replaces the dead `src/api/knowledge.ts`)
- Delete: `src/api/knowledge.ts`
- Modify: `src/screens/kewy-agent/KnowledgeTab.tsx`

**Interfaces:**
- Consumes: `useFetch`/`useMutation` (`@/api/useFetch`), `api` (`@/api/client`), `SettingsCard`/`ErrorRow` (`@/screens/settings/form`), `Badge` (`@/components/Badge`), `IconBook` (`@/icons`).
- Produces: a working Knowledge tab; no other task depends on its internals.

- [ ] **Step 1: Replace the dead API stub**

Delete `src/api/knowledge.ts` and create `src/api/l-knowledge.ts`:

```ts
import { API_BASE, ApiError, tokenStore } from "./client";

export interface LDocument {
  id: string;
  title: string;
  source_type: string;
  status: string; // "pending" | "processing" | "ready" | "failed"
  meta: Record<string, unknown>;
  created_at: string;
}

/**
 * Upload a file to the Kewy AI agent's knowledge base. Multipart — can't go
 * through the JSON `api` client (see src/api/uploadMedia.ts for the same
 * pattern). Throws an Error carrying the server's message on rejection.
 */
export async function uploadKnowledgeDocument(file: File): Promise<LDocument> {
  const fd = new FormData();
  fd.append("file", file);
  const token = tokenStore.get();
  const res = await fetch(`${API_BASE}/integrations/l/knowledge`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: fd,
  });
  const text = await res.text();
  const data: unknown = text ? safeJson(text) : undefined;
  if (!res.ok) {
    const msg =
      typeof data === "object" && data !== null && "message" in data
        ? String((data as { message: unknown }).message)
        : `HTTP ${res.status}`;
    throw new ApiError(msg, res.status);
  }
  return data as LDocument;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
```

- [ ] **Step 2: Implement the tab**

Replace the contents of `src/screens/kewy-agent/KnowledgeTab.tsx`:

```tsx
import { useRef, useState } from "react";
import type { Tx } from "@/lib/tx";
import { useFetch, useMutation } from "@/api/useFetch";
import { api } from "@/api/client";
import { uploadKnowledgeDocument, type LDocument } from "@/api/l-knowledge";
import { Badge } from "@/components/Badge";
import { SettingsCard, ErrorRow } from "@/screens/settings/form";
import { IconBook } from "@/icons";

interface LKnowledgeList {
  connected: boolean;
  documents: LDocument[];
}

export function KnowledgeTab({ tx, canEdit }: { tx: Tx; canEdit: boolean }) {
  const listQ = useFetch<LKnowledgeList>("/integrations/l/knowledge");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const deleteMut = useMutation<{ id: string }, { ok: true }>(({ id }) =>
    api.delete(`/integrations/l/knowledge/${id}`),
  );

  const docs = listQ.data?.documents ?? [];

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setUploading(true);
    setError(null);
    try {
      await uploadKnowledgeDocument(f);
      listQ.refetch();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }

  async function onDelete(id: string) {
    setError(null);
    try {
      await deleteMut.mutate({ id });
      listQ.refetch();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <SettingsCard
      title={tx("Knowledge sources", "مصادر المعرفة")}
      description={tx(
        "Documents your agent can retrieve from when answering.",
        "المستندات التي يمكن لوكيلك الرجوع إليها عند الرد.",
      )}
    >
      <ErrorRow message={error} />
      {canEdit && (
        <div>
          <button
            type="button"
            className="btn primary"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            <IconBook w={13} />
            {uploading ? tx("Uploading…", "جارٍ الرفع…") : tx("Upload document", "رفع مستند")}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            hidden
            onChange={onPickFile}
          />
        </div>
      )}
      <table className="tbl">
        <thead>
          <tr>
            <th>{tx("Title", "العنوان")}</th>
            <th>{tx("Status", "الحالة")}</th>
            <th>{tx("Added", "أُضيف")}</th>
            {canEdit && <th style={{ width: 80 }} aria-label="actions" />}
          </tr>
        </thead>
        <tbody>
          {docs.length === 0 && (
            <tr>
              <td colSpan={canEdit ? 4 : 3} className="muted" style={{ textAlign: "center", padding: 24 }}>
                {tx("No documents yet.", "لا توجد مستندات بعد.")}
              </td>
            </tr>
          )}
          {docs.map((d) => (
            <tr key={d.id}>
              <td style={{ fontWeight: 500 }}>{d.title}</td>
              <td>
                {d.status === "ready" && <Badge kind="ok" dot>ready</Badge>}
                {(d.status === "pending" || d.status === "processing") && (
                  <Badge kind="warn" dot>{d.status}</Badge>
                )}
                {d.status === "failed" && <Badge kind="bad" dot>failed</Badge>}
              </td>
              <td className="mono muted">{new Date(d.created_at).toLocaleDateString()}</td>
              {canEdit && (
                <td>
                  <button type="button" className="btn ghost sm" onClick={() => onDelete(d.id)}>
                    {tx("Delete", "حذف")}
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </SettingsCard>
  );
}
```

- [ ] **Step 3: Verify manually**

```bash
npm run typecheck
```
Expected: no errors (confirms `src/api/knowledge.ts`'s deletion left no dangling imports — it was already dead per the design doc's research).

Start the dev server, navigate to `#/agent` → Knowledge tab, and confirm: the empty state renders when no documents exist; uploading a small `.txt` file shows it in the table with a `pending`/`processing` badge that becomes `ready` on refetch; delete removes a row.

- [ ] **Step 4: Commit**

```bash
git add src/api/l-knowledge.ts src/screens/kewy-agent/KnowledgeTab.tsx
git rm src/api/knowledge.ts
git commit -m "feat(kewy-agent): implement the Knowledge tab"
```

---

### Task 12: Tools tab

**Files:**
- Modify: `src/screens/kewy-agent/ToolsTab.tsx`

**Interfaces:**
- Consumes: `useFetch`/`useMutation`, `api`, `SettingsCard`/`Field`/`ErrorRow`/`inputStyle`, `Toggle`, `Modal`, `IconPlus`/`IconBolt`.
- Produces: a working Tools tab.

- [ ] **Step 1: Implement the tab**

Replace the contents of `src/screens/kewy-agent/ToolsTab.tsx`:

```tsx
import { useState } from "react";
import type { Tx } from "@/lib/tx";
import { useFetch, useMutation } from "@/api/useFetch";
import { api } from "@/api/client";
import { SettingsCard, Field, ErrorRow, inputStyle } from "@/screens/settings/form";
import { Modal } from "@/components/Modal";
import { Toggle } from "@/components/Toggle";
import { IconPlus, IconBolt } from "@/icons";

interface LTool {
  id: string;
  name: string;
  description: string;
  method: string;
  url_template: string;
  enabled: boolean;
  created_at: string;
  params: string[];
}

interface LToolList {
  connected: boolean;
  tools: LTool[];
}

interface CreateToolInput {
  name: string;
  description: string;
  method: string;
  url_template: string;
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

export function ToolsTab({ tx, canEdit }: { tx: Tx; canEdit: boolean }) {
  const listQ = useFetch<LToolList>("/integrations/l/tools");
  const [showAdd, setShowAdd] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bound, setBound] = useState<Set<string>>(new Set());

  const createMut = useMutation<CreateToolInput, LTool>((input) => api.post("/integrations/l/tools", input));
  const deleteMut = useMutation<{ id: string }, { ok: true }>(({ id }) => api.delete(`/integrations/l/tools/${id}`));
  const bindMut = useMutation<{ id: string; on: boolean }, { ok: true }>(({ id, on }) =>
    on ? api.post(`/integrations/l/tools/${id}/binding`) : api.delete(`/integrations/l/tools/${id}/binding`),
  );

  const tools = listQ.data?.tools ?? [];

  const [form, setForm] = useState<CreateToolInput>({
    name: "",
    description: "",
    method: "GET",
    url_template: "",
  });

  async function onCreate() {
    setError(null);
    try {
      await createMut.mutate(form);
      setForm({ name: "", description: "", method: "GET", url_template: "" });
      setShowAdd(false);
      listQ.refetch();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function onDelete(id: string) {
    setError(null);
    try {
      await deleteMut.mutate({ id });
      listQ.refetch();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function onToggle(id: string, on: boolean) {
    setError(null);
    const next = new Set(bound);
    if (on) next.add(id);
    else next.delete(id);
    setBound(next);
    try {
      await bindMut.mutate({ id, on });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <SettingsCard
      title={tx("Tools", "الأدوات")}
      description={tx(
        "HTTP tools your agent can call while answering.",
        "أدوات HTTP يمكن لوكيلك استدعاؤها أثناء الرد.",
      )}
      footer={
        canEdit && (
          <button type="button" className="btn primary" onClick={() => setShowAdd(true)}>
            <IconPlus w={13} />
            {tx("Add tool", "إضافة أداة")}
          </button>
        )
      }
    >
      <ErrorRow message={error} />
      {tools.length === 0 && (
        <div className="muted" style={{ textAlign: "center", padding: 24 }}>
          {tx("No tools yet.", "لا توجد أدوات بعد.")}
        </div>
      )}
      {tools.map((toolRow) => (
        <div
          key={toolRow.id}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            padding: 14,
            borderBottom: "1px solid var(--line-soft)",
          }}
        >
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              background: "var(--bg-2)",
              display: "grid",
              placeItems: "center",
              color: "var(--ink-3)",
            }}
          >
            <IconBolt w={16} />
          </div>
          <div style={{ flex: 1 }}>
            <div className="mono" style={{ fontSize: 13, fontWeight: 500 }}>
              {toolRow.name}({toolRow.params.join(", ")})
            </div>
            <div style={{ fontSize: 12, color: "var(--ink-3)" }}>{toolRow.description}</div>
          </div>
          {canEdit && (
            <>
              <Toggle on={bound.has(toolRow.id)} onChange={(on) => onToggle(toolRow.id, on)} />
              <button type="button" className="btn ghost sm" onClick={() => onDelete(toolRow.id)}>
                {tx("Delete", "حذف")}
              </button>
            </>
          )}
        </div>
      ))}

      {showAdd && (
        <Modal onClose={() => setShowAdd(false)} label={tx("Add tool", "إضافة أداة")}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Field label={tx("Name", "الاسم")} hint={tx("Lowercase, e.g. search_listings", "أحرف صغيرة")}>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                style={inputStyle}
              />
            </Field>
            <Field label={tx("Description", "الوصف")}>
              <input
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                style={inputStyle}
              />
            </Field>
            <Field label={tx("Method", "الطريقة")}>
              <select
                value={form.method}
                onChange={(e) => setForm({ ...form, method: e.target.value })}
                style={inputStyle}
              >
                {METHODS.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </Field>
            <Field label={tx("URL template", "قالب الرابط")} hint="https://api.example.com/weather/{city}">
              <input
                value={form.url_template}
                onChange={(e) => setForm({ ...form, url_template: e.target.value })}
                style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
              />
            </Field>
            <button
              type="button"
              className="btn primary"
              onClick={onCreate}
              disabled={!form.name || !form.description || !form.url_template}
            >
              {tx("Create", "إنشاء")}
            </button>
          </div>
        </Modal>
      )}
    </SettingsCard>
  );
}
```

Note: this initializes `bound` as an empty local set rather than fetching the true binding state — the controller only exposes workspace-level tool CRUD plus per-tool `binding` mutations (Task 9), not a "list bound tools" read endpoint. The toggle state is optimistic-only for this pass: it reflects actions taken in the current session, not what's bound on load. Reflecting true bound-state on load is a follow-up, not blocking this feature.

- [ ] **Step 2: Verify manually**

```bash
npm run typecheck
```
Expected: no errors.

Start the dev server, navigate to `#/agent` → Tools tab, and confirm: "Add tool" opens the modal; creating a tool adds a row; toggling shows the toggle flip immediately; delete removes the row.

- [ ] **Step 3: Commit**

```bash
git add src/screens/kewy-agent/ToolsTab.tsx
git commit -m "feat(kewy-agent): implement the Tools tab"
```

---

### Task 13: MCP Servers tab

**Files:**
- Modify: `src/screens/kewy-agent/McpServersTab.tsx`

**Interfaces:**
- Consumes: `useFetch`/`useMutation`, `api`, `SettingsCard`/`Field`/`ErrorRow`/`inputStyle`, `Toggle`, `Modal`, `Badge`, `IconPlus`/`IconGlobe`.
- Produces: a working MCP Servers tab. Last task in the plan.

- [ ] **Step 1: Implement the tab**

Replace the contents of `src/screens/kewy-agent/McpServersTab.tsx`:

```tsx
import { useState } from "react";
import type { Tx } from "@/lib/tx";
import { useFetch, useMutation } from "@/api/useFetch";
import { api } from "@/api/client";
import { SettingsCard, Field, ErrorRow, inputStyle } from "@/screens/settings/form";
import { Modal } from "@/components/Modal";
import { Toggle } from "@/components/Toggle";
import { Badge } from "@/components/Badge";
import { IconPlus, IconGlobe } from "@/icons";

interface LMcpServer {
  id: string;
  name: string;
  description: string;
  url: string;
  enabled: boolean;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

interface LMcpServerList {
  connected: boolean;
  servers: LMcpServer[];
}

interface LMcpTestResult {
  ok: boolean;
  tools: string[];
  error: string | null;
}

interface CreateServerInput {
  name: string;
  description: string;
  url: string;
}

export function McpServersTab({ tx, canEdit }: { tx: Tx; canEdit: boolean }) {
  const listQ = useFetch<LMcpServerList>("/integrations/l/mcp-servers");
  const [showAdd, setShowAdd] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bound, setBound] = useState<Set<string>>(new Set());
  const [testResults, setTestResults] = useState<Record<string, LMcpTestResult>>({});

  const createMut = useMutation<CreateServerInput, LMcpServer>((input) =>
    api.post("/integrations/l/mcp-servers", input),
  );
  const deleteMut = useMutation<{ id: string }, { ok: true }>(({ id }) =>
    api.delete(`/integrations/l/mcp-servers/${id}`),
  );
  const bindMut = useMutation<{ id: string; on: boolean }, { ok: true }>(({ id, on }) =>
    on
      ? api.post(`/integrations/l/mcp-servers/${id}/binding`)
      : api.delete(`/integrations/l/mcp-servers/${id}/binding`),
  );
  const testMut = useMutation<{ id: string }, LMcpTestResult>(({ id }) =>
    api.post(`/integrations/l/mcp-servers/${id}/test`),
  );

  const servers = listQ.data?.servers ?? [];

  const [form, setForm] = useState<CreateServerInput>({ name: "", description: "", url: "" });

  async function onCreate() {
    setError(null);
    try {
      await createMut.mutate(form);
      setForm({ name: "", description: "", url: "" });
      setShowAdd(false);
      listQ.refetch();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function onDelete(id: string) {
    setError(null);
    try {
      await deleteMut.mutate({ id });
      listQ.refetch();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function onToggle(id: string, on: boolean) {
    setError(null);
    const next = new Set(bound);
    if (on) next.add(id);
    else next.delete(id);
    setBound(next);
    try {
      await bindMut.mutate({ id, on });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function onTest(id: string) {
    setError(null);
    try {
      const result = await testMut.mutate({ id });
      setTestResults({ ...testResults, [id]: result });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <SettingsCard
      title={tx("MCP servers", "خوادم MCP")}
      description={tx(
        "Remote MCP servers your agent can use for extra tools.",
        "خوادم MCP عن بُعد يمكن لوكيلك استخدامها لأدوات إضافية.",
      )}
      footer={
        canEdit && (
          <button type="button" className="btn primary" onClick={() => setShowAdd(true)}>
            <IconPlus w={13} />
            {tx("Add server", "إضافة خادم")}
          </button>
        )
      }
    >
      <ErrorRow message={error} />
      {servers.length === 0 && (
        <div className="muted" style={{ textAlign: "center", padding: 24 }}>
          {tx("No MCP servers yet.", "لا توجد خوادم MCP بعد.")}
        </div>
      )}
      {servers.map((server) => {
        const result = testResults[server.id];
        return (
          <div
            key={server.id}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              padding: 14,
              borderBottom: "1px solid var(--line-soft)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 8,
                  background: "var(--bg-2)",
                  display: "grid",
                  placeItems: "center",
                  color: "var(--ink-3)",
                }}
              >
                <IconGlobe w={16} />
              </div>
              <div style={{ flex: 1 }}>
                <div className="mono" style={{ fontSize: 13, fontWeight: 500 }}>{server.name}</div>
                <div style={{ fontSize: 12, color: "var(--ink-3)" }}>{server.description}</div>
              </div>
              {canEdit && (
                <>
                  <button type="button" className="btn ghost sm" onClick={() => onTest(server.id)}>
                    {tx("Test", "اختبار")}
                  </button>
                  <Toggle on={bound.has(server.id)} onChange={(on) => onToggle(server.id, on)} />
                  <button type="button" className="btn ghost sm" onClick={() => onDelete(server.id)}>
                    {tx("Delete", "حذف")}
                  </button>
                </>
              )}
            </div>
            {result && (
              <div style={{ paddingInlineStart: 46 }}>
                {result.ok ? (
                  <Badge kind="ok" dot>
                    {tx(`Connected · tools: ${result.tools.join(", ") || "none"}`, `متصل · الأدوات: ${result.tools.join(", ") || "لا شيء"}`)}
                  </Badge>
                ) : (
                  <Badge kind="bad" dot>{result.error ?? tx("Failed", "فشل")}</Badge>
                )}
              </div>
            )}
          </div>
        );
      })}

      {showAdd && (
        <Modal onClose={() => setShowAdd(false)} label={tx("Add MCP server", "إضافة خادم MCP")}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Field label={tx("Name", "الاسم")} hint={tx("Lowercase, e.g. docs", "أحرف صغيرة")}>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                style={inputStyle}
              />
            </Field>
            <Field label={tx("Description", "الوصف")}>
              <input
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                style={inputStyle}
              />
            </Field>
            <Field label={tx("URL", "الرابط")} hint="https://mcp.example.com/mcp">
              <input
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
              />
            </Field>
            <button
              type="button"
              className="btn primary"
              onClick={onCreate}
              disabled={!form.name || !form.description || !form.url}
            >
              {tx("Create", "إنشاء")}
            </button>
          </div>
        </Modal>
      )}
    </SettingsCard>
  );
}
```

- [ ] **Step 2: Verify manually**

```bash
npm run typecheck
```
Expected: no errors.

Start the dev server, navigate to `#/agent` → MCP Servers tab, and confirm: "Add server" opens the modal; creating a server adds a row; "Test" against a real reachable MCP server shows a green "Connected · tools: ..." badge, and against an unreachable one shows a red error badge; toggling and delete work as in Task 12.

- [ ] **Step 3: Commit**

```bash
git add src/screens/kewy-agent/McpServersTab.tsx
git commit -m "feat(kewy-agent): implement the MCP Servers tab"
```

---

## Final integration check

After all 13 tasks: run `kewy/l`'s full test suite (`pytest`), the CRM backend's full test suite (`cd backend && npm test`), and the CRM frontend's typecheck (`npm run typecheck`) one more time together, then do one end-to-end manual pass per the spec's testing section — a workspace with `lWorkspaceId` set, both backends running, walking through upload/delete a document, create/bind/unbind/delete a tool, and create/test/bind/unbind/delete an MCP server from the `#/agent` screen.
