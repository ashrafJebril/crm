# Teach-the-AI screens in the CRM

Status: **planning**
Branch: `feat/ai-knowledge-ui` (off `feat/whatsapp-via-kapso`, which carries the live AI wiring)
Date: 2026-08-31

## Why

The AI now answers real WhatsApp customers on Ashraf's number. But everything
it knows was loaded by an agent running curl. The salon owner has no way to
correct a wrong answer, add a policy, or teach it about a promotion.

Right now the only knowledge is 3 auto-synced docs (services, branches, staff).
Ask it about parking, cancellation fees, or whether kids are welcome and it has
nothing.

**The owner must be able to teach it without a developer.**

## What already exists (kewy-ai, verified live)

`/api/v1/knowledge/*`, behind header `x-kewy-admin-secret`:

| method | path | does |
|---|---|---|
POST | `/docs` | create (no `id`) or update (with `id`) |
GET | `/docs?tenantId=` | list |
DELETE | `/docs/:id?tenantId=` | delete, 404 when nothing matched |
POST | `/sync` | re-pull services/branches/staff from hjz |

Doc shape: `{ tenantId, id?, title (≤200), body (≤100k), kind }`
Kinds: `POLICY · FAQ · SERVICE_DESCRIPTION · PROMOTION · TONE · OTHER`

Body is capped at 100k because every chunk is a paid embedding call.

**No file upload exists.** The API takes text only.

## Decisions

**1. It lives in the CRM, not kewy-site.** kewy-site is Ashraf's admin plane
across all tenants; the CRM is what the salon owner actually uses every day.
Teaching the AI is an owner task, not a platform-operator task.

**2. The browser must never hold the admin secret.** `x-kewy-admin-secret` is a
per-deployment key that can read and write EVERY tenant. Shipping it to the
frontend would put a cross-tenant key in devtools. So: the CRM backend proxies,
injecting the secret server-side and forcing `tenantId` from the session's
workspace — the browser cannot name another tenant.

**3. Files are parsed to text in the browser-facing backend, then stored as a
normal doc.** The AI service stays text-only; no new storage, no new contract.
Start with `.txt` and `.md`. PDF/DOCX are a follow-up — `pdf-parse` and
`mammoth` are the usual choices, but a bad extraction silently teaches the AI
garbage, so that deserves its own pass with real files.

**4. Deleting is a real delete.** No soft-delete: an owner who removes a wrong
price must be certain it is gone from what the AI answers with.

## Plan

### Phase 1 — backend proxy (CRM)
1. `KnowledgeController` under `ai/knowledge`, normal CRM auth (`@CurrentWorkspace`).
2. `KnowledgeService` calls kewy-ai with the admin secret from env, mapping
   `workspaceId` → kewy-ai `tenantId`.
3. Endpoints: `GET /docs`, `POST /docs`, `DELETE /docs/:id`, `POST /sync`.
4. Fail gracefully when kewy-ai is unreachable — the CRM must not 500 because
   the AI service is down.

### Phase 2 — the screen
5. New Settings tab **"AI Knowledge" / "معرفة الذكاء"**.
6. List: title, kind badge, size, updated. Empty state explains what this is for.
7. Add/Edit: title, kind dropdown, body textarea with a live character count
   against the 100k cap.
8. Delete with confirm — this one IS destructive and irreversible.
9. "Re-sync from hjz" button for services/branches/staff.
10. Arabic + English throughout via `tx()`, matching the other tabs.

### Phase 3 — file upload
11. Drop zone accepting `.txt` / `.md`, parsed to text, prefilled into the
    editor **for review before saving** — never silently ingested.
12. Show what was extracted. If parsing produced nothing useful, say so.

### Phase 4 — verify
13. Add a doc through the UI, then ask the AI about it on WhatsApp and confirm
    it uses the new knowledge. That is the only proof that matters.

## Hard requirements

- **The admin secret never reaches the browser.** Assert it isn't in any
  response body or bundled JS.
- **tenantId comes from the session, never the request body** — otherwise any
  logged-in user could read another salon's knowledge.
- Respect the 100k cap in the UI, with a visible counter — a rejection after
  a long paste is a bad experience and a wasted round trip.
- Deletes confirm; nothing else does.
- New branch, nothing merged. Ashraf merges.

## Open question

Ashraf mentioned "any thing you need to teach the AI". Beyond docs, the natural
next pieces are **persona/tone** (currently DB-only: name, greeting, style) and
**escalation rules** (when to hand to a human). Both are TenantConfig fields the
admin API can already patch — worth a second tab once knowledge lands.
