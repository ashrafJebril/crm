# SP-17 Media Details for the AI Agent: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- **Describe a file.** Every library file can carry a title, alt text, tags and a "use when" note ("Send when a customer asks for the menu" / "أرسلها عندما يطلب العميل القائمة"). They are edited in one details dialog from the Gallery, the Media screen and the agent's Photos tab.
- **Approve or hide it for the agent.** One switch, `approvedForAgent`, off by default. Only approved photos ever reach the AI agent. Turning the switch off takes effect on the agent's next tool call and on the next send.
- **Search.** `GET /media?q&approved` finds files by title, alt text, "use when", file name and tag, and filters by approval. The Gallery and the Photos tab have a search box and an approval filter.
- **A "Photos" tab in agent knowledge.** `#/kewy-agent` gains a Photos tab next to Knowledge, Tools and MCP Servers. It lists the library's images, filtered to "Approved for agent" by default, with a switch on each tile.
- **The agent can send approved photos.** The CRM's own MCP server (`POST /mcp/v1`, server name `tkana-crm`, bound to every linked Kewy agent as `kewy_crm`) gains the tool `list_photos`. It returns approved photos only, each with its details and a URL the agent can attach as the reply's image (ruling 1). The roadmap's acceptance test is `agent tool never returns unapproved media`.

**Architecture:**
- **How the AI agent gets CRM context today (read from the code, no live call).**
  - `LAgentService.ask(ws, {externalId, message, sessionId?})` (`backend/src/integrations/l-agent.service.ts`) posts only `{external_id, message, session_id?}` to l's webhook endpoint. It reads back `{answer, image_url?}`. There is **no field in this payload for context**, and the l platform's webhook API is not ours to change.
  - The agent reaches CRM data through tools instead. `LAgentSetupService.ensure` (`l-agent-setup.service.ts`) registers the CRM's own MCP endpoint (`mcpEndpointUrl()` → `<CRM_MCP_PUBLIC_URL>/api/mcp/v1`) on l as the server `kewy_crm`, with a per-workspace bearer token (`McpTokenService`), binds it to the agent, and appends a prompt section marked `<!-- kewy-crm-tools -->`.
  - `McpServerController` builds a fresh `MCPServer` per request from `McpToolsFactory.build(workspaceId)`. Nine tools exist today (appointments and contacts). Because `tools/list` is answered from the factory on every request, a new tool is visible to every linked agent without re-registering the server.
  - Sending: `ZernioService.queueAgentReply` sends `result.answer` and, when l returns `image_url`, the image as `{url, type: "image"}` through `sendInDbConversation`. If the image fails, it retries text-only. `LOutboundService` (l-origin chats) only stores `attach: result.imageUrl`; l itself delivered it.
  - **Decision (ruling 1):** SP-17 does **not** change the l webhook payload. It extends the CRM MCP server with `list_photos` and appends a photos section to the agent prompt. The agent sends a photo by returning the tool's `url` as its `image_url`, which the existing send path already delivers.
- **Data.** Five columns on `Media` (Global Constraints). `approvedForAgent` defaults to false, so no existing file is exposed by the migration.
- **One read path for the agent** (`MediaService.listForAgent(ws, {query, tag, limit})`), used only by `list_photos`:
  - `workspaceId = ws`, `approvedForAgent = true`, `mimeType in AGENT_PHOTO_MIMES` (`image/jpeg`, `image/png`) and `sizeBytes ≤ AGENT_PHOTO_MAX_BYTES` (5 MB) are applied **in the query** every time, whatever was true at approval time (ruling 3).
  - The search uses the same token rules as `GET /media?q` (`mediaSearchWhere`, below).
  - Newest first, `limit` 1..10, default 5.
  - Each row gets `url = resolveExternalUrl(ws, id, AGENT_PHOTO_URL_TTL_S)` (24 h; ruling 9).
  - There is no viewer: the MCP token is a workspace credential, and visibility rules for restricted members do not apply to staff-uploaded photos, which are the only approvable ones (ruling 3).
- **Send-time re-check (ruling 2).** `agentImageDecision(prisma, ws, url)` in `backend/src/media/agent-photo.ts` (pure parsing plus one lookup):
  - It recognises our own media URLs: `<PUBLIC_BASE_URL|APP_BASE_URL>/api/media/<id>/public?token=…` (local storage), and a Spaces signed or CDN URL whose path ends in a `Media.storedPath` of this workspace.
  - Our media that is still approved and still an agent photo type → `send`. Our media that is not (hidden since, never approved, a PDF, or another workspace's file) → `drop`. A URL that is not ours → `external`, which keeps today's behaviour (l validated it).
  - `queueAgentReply` calls it before the send. On `drop` it sends the text alone and logs `agent image dropped: not approved` with the media id (never the token).
  - `LOutboundService` and `LWebhooksService` are unchanged: they mirror what l already delivered and send nothing.
- **Search** (`mediaSearchWhere(q)` in `media.service.ts`, shared by `GET /media` and `list_photos`):
  - `q` is trimmed, split on whitespace, at most 5 tokens.
  - Every token must match (AND). A token matches when it is contained, case-insensitively, in `title`, `alt`, `useWhen` or `fileName`, or equals one of `tags` after tag normalisation.
  - Arabic matches as typed (no letter folding; ruling 7).
- **Edits** (`PATCH /media/:id`): load through `MediaService.get(ws, id, viewer)`, so a foreign id, or a file a restricted viewer cannot see, is 404 "Media not found" as today. Normalise, validate approval (ruling 3, ruling 4), update, return the row. Last write wins (ruling 12).
- **Prompt.** `LAgentSetupService.ensurePrompt` appends a second section with its own marker `<!-- kewy-crm-photos -->` when missing, so the existing `<!-- kewy-crm-tools -->` section and its idempotence are untouched. Already-linked workspaces receive it the next time Joteck calls `POST /joteck/workspaces/:id/agent-setup` (ruling 10).

**Tech Stack:** NestJS 10, Prisma 5 (Postgres/Neon), class-validator, jest/ts-jest, `@mastra/core/tools` + `@mastra/mcp` (already used by `mcp-server/`), zod; React 18 + Vite, `@tanstack/react-query` (`useMediaPages`), vitest. **No new dependencies.**

**Spec:** roadmap §SP-17, plus the cross-cutting Global Constraints:
- **Gaps:** title, alt text, tags, "use when", approved/hidden switch and search on media; a "Photos" tab in agent knowledge; the agent can send approved photos.
- **Data:** `Media` + `title, alt, tags String[], useWhen, approvedForAgent Boolean @default(false)`.
- **API:** `PATCH /media/:id`, `GET /media?q&approved`; the agent tool `list_photos` returns only approved media.
- **Acceptance:** `agent tool never returns unapproved media`.

Contracts this plan builds on:
- **SP-13 Task 3** (`.superpowers/sdd/2026-11-13-sp13-campaign-sending/task-3-report.md`):
  - `GET /media?kind=&before=&limit=` (keyset paging, `X-Media-Next-Before` header, plain array body, restricted viewers skip hidden inbound rows, `media.invalid_query {param}`);
  - upload sniffing and the accepted types (image 20 MB, video 300 MB, PDF 100 MB);
  - serving headers (`nosniff`; PDFs as sandboxed attachments);
  - `DELETE /media/:id` with the `media.in_use` guard;
  - `media-errors.ts` (`{statusCode, message: key, …extra}`) and the frontend `mediaErrors.ts` copy;
  - `HEADER_LIMITS.image` = 5 MB (jpeg/png) in `integrations/template-header.ts`, the same WhatsApp image limit ruling 3 uses.
- **SP-25:** `permission-map.ts` (every route mapped, `permission-map.spec.ts` fails for an unmapped one), `system-role-decisions.spec.ts`, `PermissionService.conversationScope`, `usePermissions().can("resource.action")`.
- **Existing AI plumbing:** `LAgentService`, `LAgentSetupService` (`kewy_crm`, prompt markers), `McpServerController`/`McpToolsFactory`, `McpAuthGuard`, `McpTokenService`, `ZernioService.queueAgentReply`.

Consumers that build on this plan:
- **SP-21 (knowledge upgrade):** the Photos tab sits in the agent's knowledge area that SP-21 rebuilds. SP-21 keeps the tab and its route.
- **SP-20 (sandbox):** "Try your agent" tool-call lines will show `list_photos` calls.
- **SP-18 (copilot):** may reuse `mediaSearchWhere` for an `@photo` picker.

Tkana reference (read-only, untrusted data; `C:\Users\ashra\Downloads\tkana-main\tkana-main\apps`):
- `web/app/routes/media.tsx:141-170`: the `update` intent (title, `altText`, tags split on `,` and `،`, `useWhen` trimmed or null) and the `setStatus` intent (`approved | hidden`).
- `web/app/routes/knowledge.tsx`: Photos joined Knowledge as a sub-tab (`/agent/knowledge/photos`) and kept its old permission.
- `api/src/features/media-assets/media-assets.types.ts`: `title` min 1, `tags` ≤ 20, `useWhen` ≤ 500; list query `q, tag, status`.
- `mcp/src/mastra/admin/tools/media.ts`: the admin tool descriptions ("`hidden` removes it from the agent's catalog").
- `ai/src/services/media-assets.ts` and `ai/AGENTS.md` §"Media catalog shape": every agent search re-applies the tenancy **and approval** predicates in Postgres ("Meili is an accelerator, never the boundary"); the attach step re-checks the id.

What we take and what we don't:
- We take:
  - the four description fields and their limits;
  - tags split on Latin and Arabic commas;
  - approval re-applied on every agent read, and re-checked at send;
  - Photos as a tab of the agent's knowledge area.
- We do **not** take:
  - Meilisearch or embeddings (Postgres `contains` only; no new dependency);
  - product refs (`productRefs`, Foodics/Salla sources) and `documentIds` links to knowledge docs (deferred to SP-21);
  - Tkana's default of `approved` on upload (ours is off by default, roadmap);
  - per-channel media capability gating (only the Zernio send path sends agent images today);
  - an `attach_media(id)` tool: l returns `image_url`, and we cannot add an attach step inside l (ruling 1).

## Global Constraints
- **Data (exact names; later SPs build on them):**
  ```
  model Media {
    // … existing fields unchanged …
    /// SP-17: agent-facing details. Null = not described.
    title            String?
    /// SP-17: what is visible in the file (accessibility and search).
    alt              String?
    /// SP-17: normalised (trimmed, Latin lowercased, deduped), ≤ 20 tags of ≤ 40 chars.
    tags             String[] @default([])
    /// SP-17: when the agent should send it. ≤ 500 chars.
    useWhen          String?
    /// SP-17: the agent may list and send this file. Off by default.
    approvedForAgent Boolean  @default(false)
  }
  ```
  - No new index (ruling 11). `@@index([workspaceId])` already serves both reads.
- **Limits and normalisation** (`backend/src/media/media-details.ts`, pure; frontend mirror `src/components/media/mediaDetails.ts`):
  - `title` ≤ 120, `alt` ≤ 500, `useWhen` ≤ 500 characters, after trimming. An empty string becomes `null`.
  - `tags`: the body is a `string[]` (≤ 20 items before normalisation). Each tag is trimmed, Latin letters lowercased (`toLocaleLowerCase("en")`), empty tags dropped, duplicates dropped (first kept), each ≤ 40 chars. More than 20 after normalisation → 400.
  - `AGENT_PHOTO_MIMES = ["image/jpeg", "image/png"]`, `AGENT_PHOTO_MAX_BYTES = 5 * 1024 * 1024`. The backend imports the 5 MB figure from `HEADER_LIMITS.image` so the two cannot drift.
  - `approvalBlock(row) → null | "type" | "size" | "inbound"`: not jpeg/png → `type`; over 5 MB → `size`; `uploadedById` null (an inbound customer attachment) → `inbound`.
- **DTOs:**
  - The media row returned by `GET /media`, `POST /media/upload` and `PATCH /media/:id` gains `title, alt, tags, useWhen, approvedForAgent`. The body stays the plain Prisma row, as SP-13 left it.
  - `UpdateMediaDto` (`backend/src/media/media.dto.ts`, class-validator; the global pipe has `whitelist` and `forbidNonWhitelisted`, so an unknown field is 400):
    ```
    title?: string | null           // @IsOptional @IsString @MaxLength(120) (null allowed via ValidateIf)
    alt?: string | null             // @MaxLength(500)
    tags?: string[]                 // @IsArray @ArrayMaxSize(20) @IsString({each}) @MaxLength(40, {each})
    useWhen?: string | null         // @MaxLength(500)
    approvedForAgent?: boolean      // @IsBoolean
    ```
    An empty body is 400 `media.no_changes`.
  - Frontend `Media` (`src/lib/types.ts`) gains `title: string | null; alt: string | null; tags: string[]; useWhen: string | null; approvedForAgent: boolean`.
- **API:**
  - **`PATCH /media/:id`** (`knowledge.update`, ruling 5) → 200 the updated row. Errors:
    - 404 "Media not found" (unknown, foreign, or hidden from a restricted viewer; unchanged text, other modules match it);
    - 400 `media.no_changes`;
    - 400 `media.not_approvable {reason: "type" | "size" | "inbound"}` when the result would be `approvedForAgent = true` on a blocked file. This includes a PATCH that changes only details on a file already approved before a rule existed: it is not re-checked unless `approvedForAgent: true` is in the body (the read path filters it anyway);
    - 400 `media.title_required` when the result would be approved with a null title (ruling 4);
    - class-validator 400 for limits.
  - **`GET /media?q=&approved=`** (unchanged `conversations.view`), combined with the existing `kind`, `before` and `limit`:
    - `q`: trimmed; empty is ignored; longer than 100 → 400 `media.invalid_query {param: "q"}`.
    - `approved`: `true` | `false`; anything else → 400 `media.invalid_query {param: "approved"}`.
    - Paging, the cursor header, the default kinds (no `kind` = images and videos) and restricted-viewer visibility are unchanged. The filters are added to `base` in `listPage`, so the keyset cursor stays valid across pages of a filtered list.
    - A `before` id that exists in the workspace but does not match the filter is still a valid cursor (the cursor is a position, not a member).
  - **No other new route.** The Photos tab reads `GET /media?kind=image&approved=…&q=…` (ruling 6).
- **Agent tool** (`backend/src/mcp-server/mcp-tools.factory.ts`):
  ```
  list_photos: createTool({
    id: "list_photos",
    description:
      "List photos this business approved for you to send to customers. Each photo has a title, " +
      "alt text, tags and a 'use when' note. To send one, use its url as your reply's image. " +
      "Only photos returned by this tool may be sent. An empty list means there is no approved photo for that request.",
    inputSchema: z.object({
      query: z.string().trim().max(100).optional().describe("Words to match in title, alt text, use-when, file name or tags"),
      tag: z.string().trim().max(40).optional(),
      limit: z.number().int().min(1).max(10).default(5),
    }),
    execute: (input) => unwrap(() => this.media.listForAgent(workspaceId, input)),
  })
  ```
  Output: `{ photos: { id, title, alt, tags, useWhen, mimeType, url }[] }`. `title` falls back to `fileName` only if null (cannot happen for rows approved under ruling 4, but older data is read safely). No `storedPath`, `publicToken`, uploader or size is returned.
  - `McpToolsFactory` gains `MediaService`; `McpServerModule` imports `MediaModule`.
  - The factory's tool set becomes ten; the existing spec line "exposes exactly the nine expected tools and no delete tool" is updated to the ten names (a deliberate contract change, not a weakened check).
- **Prompt section** (`l-agent-setup.service.ts`, `CRM_PHOTOS_SECTION`, marker `<!-- kewy-crm-photos -->`):
  ```
  ## Photos
  When a photo would help the customer (a product, the menu, a location, how-to steps), call list_photos
  with a few words from their request. Send at most one photo per reply by using its url as the reply image,
  and follow its "use when" note. Never send a photo that list_photos did not return, and never describe a
  photo as sent unless you attached it.
  ```
- **Error keys** (`media-errors.ts`):
  - `media.no_changes` (400), `media.not_approvable` (400, `{reason}`), `media.title_required` (400).
  - `media.invalid_query` gains `param: "q" | "approved"`.
  - Frontend `src/components/media/mediaErrors.ts`: `tx` copy for the three new keys and the two new params, covered by its test.
- **Permissions (SP-25).** No catalogue change. `permission-map.ts` adds:
  - `PATCH /media/:id`: `knowledge.update`

  `GET /media` keeps `conversations.view`. `POST /mcp/v1` stays `public` (its own `McpAuthGuard`).

  `system-role-decisions.spec.ts` adds an `SP-17 media details` block:
  - owner and admin can PATCH;
  - agent and viewer cannot (agent holds only `knowledge.view`; ruling 5);
  - all four can `GET /media` with `q` and `approved`;
  - impersonation is not blocked (`blockedForImpersonation` covers only billing and `campaigns.manage`).

  The handler loads the row by `(id, workspaceId)` first. A foreign path id returns **404**.
- **Migration:**
  - File: `backend/prisma/migrations/20261115140000_media_ai_details/migration.sql`. The timestamp is after `20261114140000_number_template_health`. **Every existing migration is applied in production and is never edited.** Hand-written; apply with `npx prisma migrate deploy` only, never `migrate dev`.
  - **Additive and idempotent:**
    ```sql
    -- AlterTable
    ALTER TABLE "Media" ADD COLUMN IF NOT EXISTS "alt" TEXT,
    ADD COLUMN IF NOT EXISTS "approvedForAgent" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN IF NOT EXISTS "title" TEXT,
    ADD COLUMN IF NOT EXISTS "useWhen" TEXT;
    ```
    The exact column order and the `NOT NULL` on `tags` follow whatever `prisma migrate diff` prints (the SP-13 `senderChannelIds` column came out as `TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]`).
  - **Check with `prisma migrate diff --from-schema-datamodel <HEAD schema> --to-schema-datamodel prisma/schema.prisma --script`** (no DB). The output must equal the file, apart from `IF NOT EXISTS`, as in SP-13 T1 and SP-14 T1.
  - **Safe for the deployed `main`:**
    - Three nullable columns and two columns with constant defaults. On Postgres 11+ a constant default is metadata-only: no table rewrite, a brief `ACCESS EXCLUSIVE` lock on `Media` for the catalog change only.
    - `main`'s Prisma client lists columns explicitly, so it never selects the new ones. Its creates (`finalizeUpload`, `ingestBuffer`, `ingestDocument`) omit them and get the defaults: `tags = {}`, `approvedForAgent = false`.
    - No existing column, constraint or index changes. The migration has no `UPDATE`, `DELETE`, `DROP` or `ALTER … TYPE`.
    - `main` never reads `approvedForAgent`, and its MCP server has no `list_photos`, so nothing is exposed before SP-17 ships.
  - **No backfill.** Every file starts unapproved and undescribed.
- **Copy and layout:**
  - Every string goes through `tx("English","العربية")` with real Arabic.
  - Logical CSS only (`margin-inline-start`, `padding-inline`, `text-align: start`, `inset-inline-end`).
  - File names, tags and URLs inside Arabic sentences go in `<bdi>`. Title, alt and "use when" inputs use `dir="auto"`, because a business may write them in either language.
  - Dialogs set `dir`.
  - The approval switch is labelled "Agent can send this" / "يمكن للوكيل إرسال هذا". A blocked file shows the switch disabled with its reason: "Only JPG or PNG photos" / "صور JPG أو PNG فقط", "Larger than 5 MB" / "أكبر من 5 ميغابايت", "Customer attachments can't be approved" / "لا يمكن اعتماد مرفقات العملاء".
- **Tests:**
  - backend (from `backend/`): `npx jest src/media src/mcp-server src/integrations src/permissions` plus `npx tsc --noEmit -p tsconfig.json`; the full `npm test` once in Task 1. The known unrelated failure is `hjz-client-sync › is inert when HJZ is not configured`.
  - frontend (repo root): `npx vitest run` plus `npm run typecheck`; `npm run build` once in Task 2.
  - **Named acceptance test (exact name, roadmap):**
    - `agent tool never returns unapproved media` (backend jest, `backend/src/mcp-server/list-photos.spec.ts`, through the real `McpToolsFactory` and the real `MediaService` on the in-memory Prisma double).
  - Every l, Zernio and storage call in specs is mocked. An unmocked `fetch` throws.
- **Commits:** selective `git add <paths>`, never `-A`. Trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not stage `.playwright-mcp/` or any untracked file this plan did not create.

## Review Focus
1. **The agent never sees or sends an unapproved file.**
   - `list_photos` filters `approvedForAgent`, the photo types, the size cap and the workspace **in the query**, on every call. A row approved and later hidden is gone on the next call.
   - The query text cannot widen the filter: search conditions are ANDed onto the approval filter, never ORed with it.
   - The send path re-checks our own URLs, so a photo hidden between the tool call and the reply is not sent (text only).
   - Tests: `agent tool never returns unapproved media`, `agent reply drops an unapproved CRM photo but keeps the text`.
2. **Tenant isolation.**
   - `list_photos` is built per request with the token's workspace; another workspace's approved photo never appears, and its URL is `drop`, not `external`, at send.
   - `PATCH /media/:id` with a foreign id is 404; a restricted viewer gets 404 for a hidden inbound file, as for `GET /media/:id/file`.
   - Tests: `foreign ids return 404 on SP-17 routes`, `agent tool never returns unapproved media` (foreign row case).
3. **Customer files stay private.** An inbound attachment (`uploadedById` null) cannot be approved, so a customer's photo can never be sent to another customer. Test: `approval refuses non-images, oversize and inbound files`.
4. **Search does not break paging.** The `q`/`approved` filters live in `base`, so `before` keeps its meaning and the restricted-viewer scan still fills pages. Test: `media list filters by q and approved and pages with the cursor`.
5. **Safe migration on the shared production DB.** Additive, idempotent, defaults only; `main` unaffected. Test: `migration is additive, idempotent and Prisma-named (SP-17)`, plus the rolled-back rerun in Task 3.

## Architecture Rulings and Risks
Each item names the risk, then the recommended ruling. Items marked **(needs controller ruling)** are repeated under Controller rulings, where the controller fills in the decision.

1. **How the AI agent receives media details.** The l webhook payload (`{external_id, message, session_id}`) has no context field and belongs to the l platform. The agent already reads CRM data through the CRM MCP server (`kewy_crm`), whose tool list is rebuilt on every request.
   - **Ruling:** SP-17 extends the CRM MCP server with `list_photos` and appends a photos prompt section. It does **not** change the l payload, and it does not push photo descriptions into l's knowledge base.
   - **Alternatives:**
     - (a) store and edit only, with no agent access until SP-21; that misses the roadmap's "the agent can send approved photos";
     - (b) sync approved photo descriptions to l as knowledge documents (`LKnowledgeService`); that creates a second copy that goes stale when a photo is hidden, which breaks Review Focus 1. **(needs controller ruling)**
2. **How a photo is sent, and the send-time re-check.** The only way an l reply carries an image is `image_url`, which `queueAgentReply` sends as given. The tool hands the agent a URL, so a photo hidden after the tool call could still be sent.
   - **Ruling:** add `agentImageDecision` before the Zernio send. Our own media URLs are sent only if the row is still an approved agent photo in this workspace; otherwise the image is dropped and the text is sent. Other URLs keep today's behaviour.
   - `LOutboundService` (l-origin chats) and `LWebhooksService` only mirror what l delivered and stay unchanged.
   - **Alternative:** no re-check; hiding then only stops new tool results. **(needs controller ruling)**
3. **What can be approved.** The agent sends images through WhatsApp and other channels as `type: "image"`. WhatsApp accepts JPEG and PNG up to 5 MB for images; WebP is a sticker type, GIF is refused, and videos and PDFs need other message types. Inbound customer attachments are private data.
   - **Ruling:** approvable = JPEG or PNG, ≤ 5 MB, staff-uploaded (`uploadedById` not null). The same type and size filter is reapplied on every agent read. Video and PDF sending by the agent is deferred.
   - **Risk:** a staff upload whose uploader is later deleted has `uploadedById` set to null (`onDelete: SetNull`). It stays approved and listed (the read path does not check the uploader), but it cannot be re-approved once hidden. Accepted as rare. **(needs controller ruling)**
4. **Defaults and the title rule.** Roadmap: `approvedForAgent @default(false)`. Tkana requires a title.
   - **Ruling:** off by default, no backfill. Approving requires a non-empty title (`media.title_required`), so the agent always has a name to match and say. The dialog pre-fills the title from the file name without its extension; the user can edit it before approving. **(needs controller ruling, minor)**
5. **Who may edit details and approve.** Approval decides what the AI may send to every customer. Today media routes use `conversations.*`, which agents hold; `knowledge.update` is owner and admin by default.
   - **Ruling:** `PATCH /media/:id` requires `knowledge.update`, for both the details and the switch (one route, one rule). Agents still upload and delete under the existing `conversations.*` rules.
   - **Alternative:** `conversations.update` (same as `DELETE /media/:id`), which lets every agent approve photos for the AI. **(needs controller ruling)**
6. **Photos tab data source.** The tab uses `GET /media` (`conversations.view`). A custom role with `knowledge.view` but no `conversations.view` gets 403 there, and the tab shows the shared no-access text.
   - **Ruling:** accept; no separate `GET /ai/photos` route in SP-17. The tab is shown when the member has `knowledge.view`. **(needs controller ruling, minor)**
7. **Search semantics.** Up to 5 whitespace tokens; every token must match some field (AND across tokens, OR across fields); case-insensitive `contains` on text fields and exact match on normalised tags. No Arabic letter folding (أ/ا/إ, ة/ه) and no stemming; SP-21 or later may add them. **(needs controller ruling, minor)**
8. **Tag normalisation.** Trim, lowercase Latin letters, drop empties and duplicates, ≤ 20 tags of ≤ 40 chars. Arabic tags are stored as typed. The UI splits typed input on `,` and `،`. **(needs controller ruling, minor)**
9. **URL lifetime.** `resolveExternalUrl` returns a Spaces signed URL (Spaces storage) or a public-token URL (local storage). `AGENT_PHOTO_URL_TTL_S = 86400` covers a slow l turn and a channel fetch.
   - **Risk (existing behaviour, unchanged):** the `Message.attach` stored for the reply keeps that URL, so the inbox preview of an agent-sent photo stops loading after 24 h. Fixing it means storing the media id in `attach`, which touches the inbox renderer; deferred.
   - For local storage, `mintPublicToken` is extend-only, so an approved photo's public token stays valid at most 24 h past the last listing. **(needs controller ruling, minor)**
10. **Rolling the prompt out to already-linked agents.** `ensurePrompt` runs on link and on Joteck's `POST /joteck/workspaces/:id/agent-setup`. A bulk backfill would call the l API for every linked workspace.
    - **Ruling:** SP-17 adds the section with its own marker and runs no bulk backfill. New links get it at once; existing ones get it the next time Joteck calls agent-setup. The tool itself appears to every linked agent at once (tools are listed per request). The user decides whether and when to trigger agent-setup for existing workspaces; the PR documents it.
    - **Alternative:** a one-off script over linked workspaces, with the user's approval. **(needs controller ruling)**
11. **No index.** Agent and library reads are per workspace and already use `Media_workspaceId_idx`; a workspace holds hundreds to low thousands of rows. A new index on a table that inbound webhooks write to would need `CREATE INDEX` under a write lock (Prisma runs the file in a transaction, so `CONCURRENTLY` is not available). **(needs controller ruling, minor)**
12. **Concurrent edits.** Two admins editing the same file: last write wins. Media details are low-contention; there is no `version` column (Review Focus 4 of the roadmap targets assignment, pipelines and bookings). **(needs controller ruling, minor)**
13. **Verification touches production** (as SP-13 R20 and SP-14 R17).
    - Task 3 runs against the production DB in a throwaway workspace, with local stubs for l and Zernio, local file storage in a scratch directory, and an egress guard. Nothing is sent to a customer or a provider.
    - The migration needs the user's **explicit approval** before `migrate deploy`; earlier approvals do not carry over.
    - The deployed app is unaffected (Global Constraints). **(needs controller ruling)**
14. **Unverified l behaviour** (record as pending real checks, as SP-13 and SP-14 did):
    - whether l re-reads `tools/list` per turn or caches it (and so when `list_photos` becomes visible to an existing agent);
    - whether the l agent sets `image_url` from a URL a tool returned, and how it handles two images (we send at most the one `image_url` field);
    - whether the channel fetches a Spaces signed URL with a 24 h expiry without trouble (today's `queueAgentReply` already retries text-only on failure).

    These cannot be checked without live l calls, which this plan does not make. **(needs controller ruling, minor)**
15. **Size.** The roadmap says S. Backend (columns, PATCH, search, tool, send re-check, prompt) and frontend (dialog, Gallery and Media actions, Photos tab) fit 2 build tasks plus verification. If the send re-check (ruling 2) is declined, Task 1 shrinks. **(needs controller ruling, minor)**

### Controller rulings
*Decided 2026-11-10. Every recommended ruling is accepted. R13: migration 20261115140000_media_ai_details needs explicit user approval before it is applied.*
- **R1** Accepted (agent access through the CRM MCP `list_photos` tool; no l payload change).
- **R2** Accepted (send-time re-check of our own media URLs).
- **R3** Accepted (approvable = JPEG/PNG ≤ 5 MB, staff uploads only).
- **R4** Accepted (off by default; a title is required to approve).
- **R5** Accepted (`PATCH /media/:id` = `knowledge.update`).
- **R6** Accepted (Photos tab reads `GET /media`).
- **R7** Accepted (search semantics).
- **R8** Accepted (tag normalisation).
- **R9** Accepted (24 h URL; inbox preview expiry stays as today).
- **R10** Accepted (prompt rollout without a bulk backfill).
- **R11** Accepted (no new index).
- **R12** Accepted (last write wins).
- **R13** Accepted (verification on production; explicit approval for `20261115140000_media_ai_details`).
- **R14** Accepted (unverified l behaviour listed in the PR).
- **R15** Accepted (size S, 2 build tasks plus verification).

---

### Task 1: Backend — schema, migration, details PATCH, search, `list_photos`, send re-check and prompt
**Owns:** `schema.prisma` and the migration for all of SP-17. Task 2 depends on this contract and does not edit the backend.

**Files:**
- `backend/prisma/schema.prisma`: the Global Constraints → Data changes.
- `backend/prisma/migrations/20261115140000_media_ai_details/migration.sql`.
- `backend/src/media/media-details.ts` (new, pure) + `media-details.spec.ts`:
  - `MEDIA_DETAIL_LIMITS`, `AGENT_PHOTO_MIMES`, `AGENT_PHOTO_MAX_BYTES` (from `HEADER_LIMITS.image`), `AGENT_PHOTO_URL_TTL_S`;
  - `normalizeTags(input) → string[]` (throws a class-validator-shaped 400 over 20);
  - `normalizeDetails(dto) → Prisma update data` (`""` → null; absent → untouched);
  - `approvalBlock(row) → null | "type" | "size" | "inbound"`;
  - `searchTokens(q) → string[]` (≤ 5).
- `backend/src/media/media.dto.ts`: `UpdateMediaDto` (replaces the placeholder comment).
- `backend/src/media/media-errors.ts`: `media.no_changes`, `media.not_approvable`, `media.title_required`.
- `backend/src/media/media.service.ts`:
  - `mediaSearchWhere(q)` (exported; AND of per-token ORs over `title`, `alt`, `useWhen`, `fileName` with `mode: "insensitive"`, plus `tags: {has: token.toLocaleLowerCase("en")}`);
  - `listPage` options gain `q?: string` and `approved?: boolean`, merged into `base`;
  - `update(ws, id, dto, viewer)`: `get` (404 path), compute the merged state, `media.no_changes` for an empty body, `approvalBlock` and the title rule only when the merged state is approved and the body sets `approvedForAgent: true` or clears the title of an approved row, then `media.update({where: {id}, data})`;
  - `listForAgent(ws, {query, tag, limit})` → `{photos}` (Architecture), each row's `url` from `resolveExternalUrl(ws, id, AGENT_PHOTO_URL_TTL_S)`.
- `backend/src/media/media.controller.ts`:
  - `list` validates `q` (≤ 100) and `approved` (`"true"|"false"`) with `media.invalid_query {param}` and passes them on;
  - `@Patch(":id") update(@CurrentWorkspace, @Param id, @Body UpdateMediaDto, @CurrentViewer)`.
- `backend/src/media/agent-photo.ts` (new) + `agent-photo.spec.ts`: `parseOwnMediaUrl(url, env) → {id} | {storedPathCandidates: string[]} | null` (pure) and `agentImageDecision(prisma, ws, url) → "send" | "drop" | "external"`.
- `backend/src/integrations/zernio.service.ts` `queueAgentReply`: call `agentImageDecision` when `result.imageUrl` is set; on `drop`, send text only and log the media id. (`ZernioService` already has `PrismaService`.)
- `backend/src/mcp-server/mcp-tools.factory.ts`: `list_photos`; constructor gains `MediaService`.
- `backend/src/mcp-server/mcp-server.module.ts`: import `MediaModule`.
- `backend/src/mcp-server/list-photos.spec.ts` (new, acceptance); `mcp-tools.factory.spec.ts` (ten tools); `mcp-server.http.spec.ts` (`tools/list` includes `list_photos`).
- `backend/src/integrations/l-agent-setup.service.ts`: `CRM_PHOTOS_SECTION`, marker `<!-- kewy-crm-photos -->`; `ensurePrompt` appends each missing section in one `PUT` and returns `"updated"` if anything was added. The `kewy_crm` server description for **new** registrations adds "and approved photos". Spec in `l-agent-setup.service.spec.ts`.
- `backend/src/channels/test-prisma.ts`: `contains` honours `mode: "insensitive"` (lowercase both sides); `media.update` with array fields. Existing specs stay green.
- `backend/src/permissions/permission-map.ts`: `PATCH /media/:id`. Rows in `permission-map.spec.ts` and `system-role-decisions.spec.ts`; `permission-viewer-coverage.spec.ts` if it enumerates non-GET media routes.

**Produces (contract for Task 2):**
- `PATCH /media/:id` and its error keys; `GET /media?q&approved`.
- The media row's five new fields.
- `list_photos` on the CRM MCP server; `MediaService.listForAgent`; `mediaSearchWhere`.
- `agentImageDecision` wired into `queueAgentReply`.
- The photos prompt section.

- [ ] Write the failing tests:
  - `migration is additive, idempotent and Prisma-named (SP-17)` (reads the SQL):
    - every `ADD COLUMN` has `IF NOT EXISTS`;
    - the column names and types are exactly as listed;
    - there is no `DROP`, `UPDATE`, `DELETE`, `ALTER COLUMN`, `TYPE` or `CREATE INDEX`;
    - the folder name is greater than `20261114140000`;
    - the sha256 values of `20261114130000_contact_workspace_id_index` and `20261114140000_number_template_health` are pinned (unchanged);
    - `prisma migrate diff` from the HEAD schema produces the same statements (recorded in the task report).
  - **`agent tool never returns unapproved media`** (`list-photos.spec.ts`; real `McpToolsFactory` and `MediaService` on `makeFakePrisma`, storage mocked so `resolveExternalUrl` returns `https://cdn.test/<id>`). Rows in workspace A:
    - `ok-jpg` approved JPEG, `ok-png` approved PNG (both staff uploads, titled);
    - `unapproved` JPEG whose title matches the query;
    - `hidden` approved then set to `approvedForAgent=false` through `MediaService.update`;
    - `pdf` and `webp` and `big` (6 MB JPEG) with `approvedForAgent=true` written straight into the double (bypassing the PATCH rules);

    plus `foreign` approved JPEG in workspace B. Then:
    - `list_photos({})` returns exactly `ok-png`, `ok-jpg` (newest first);
    - `list_photos({query: <unapproved's title>})` returns `[]`;
    - `list_photos({tag})` and `{query}` never return a row outside the approved set, across a table of queries that match every row's text;
    - after `update(…, {approvedForAgent: false})` on `ok-jpg`, the next call omits it;
    - the output objects have exactly the keys `id, title, alt, tags, useWhen, mimeType, url` (no `storedPath`, `publicToken`, `uploadedById`);
    - `limit` above 10 is refused by the schema; default 5.
  - `patch media updates details and normalizes tags`: `["Menu", " menu ", "", "قائمة", "MENU"]` → `["menu", "قائمة"]`; `""` clears to null; absent fields untouched; an unknown body field is 400 (pipe); 21 tags → 400; `{}` → `media.no_changes`.
  - `approval refuses non-images, oversize and inbound files`: PDF, MP4, WebP, GIF → `media.not_approvable {reason:"type"}`; a 6 MB PNG → `size`; an inbound JPEG (`uploadedById` null) → `inbound`; a 4 MB staff JPEG with a title → approved.
  - `approval requires a title`: approving with no title → `media.title_required`; clearing the title of an approved row → `media.title_required`; title and approval in one body → OK.
  - `media list filters by q and approved and pages with the cursor`:
    - `q` matches title, alt, use-when, file name (case-insensitive) and an exact tag; two tokens must both match; an Arabic query matches an Arabic title;
    - `approved=true|false` filters;
    - with `limit=2` over 5 matching rows, three pages follow `nextBefore` without gaps or repeats;
    - a restricted viewer still never sees a hidden inbound file, even when it matches `q`.
  - `invalid q or approved is a keyed 400`: 101-char `q` → `{param:"q"}`; `approved=yes` → `{param:"approved"}`; no query at all → unchanged SP-13 behaviour (existing tests stay green).
  - `foreign ids return 404 on SP-17 routes`: `PATCH /media/:id` with workspace B's id from A → 404 "Media not found"; a restricted viewer patching a hidden inbound file → 404.
  - `agent reply drops an unapproved CRM photo but keeps the text` (`zernio.service.ai-reply.spec.ts`; l mocked to answer with an image URL):
    - our public-token URL for an approved photo → one send with `{url, type:"image"}`;
    - the same photo hidden → one text-only send, no image, log line with the id and without the token;
    - a Spaces URL whose path is a `storedPath` of an unapproved row → text only;
    - another workspace's approved photo URL → text only;
    - an external `https://example.com/x.jpg` → sent as today (`external`).
  - `parse own media url recognises public-token and storage urls` (pure; base URL from env, path-style and CDN Spaces URLs, query strings ignored, malformed URLs → null).
  - `prompt setup appends the photos section once`: no section → one `PUT` with both markers; tools marker only → one `PUT` adding the photos section; both present → no `PUT`, `"already-present"`.
  - `mcp tools list includes list_photos` (http spec) and the factory spec's ten-tool list.
  - `permission map covers SP-17 routes`: `PATCH /media/:id` is `knowledge.update`. System-role block `SP-17 media details`: owner and admin yes; agent and viewer no; `GET /media` all four; impersonation not blocked.
- [ ] Implement until green.
- [ ] `npx tsc --noEmit -p tsconfig.json`, the listed jest paths, then the full `npm test` once. Run `npx prisma generate`. An EPERM on the engine DLL while the dev watcher runs is harmless, as in SP-12/13/14; restart the watcher. **Do not run `migrate`** (ruling 13).
- [ ] Commit `feat(media): agent details, approval and search on media, list_photos agent tool and send-time photo check`.

### Task 2: Frontend — details dialog, Gallery and Media actions, search and the Photos tab
**Depends on:** Task 1's contract. It can start from the contract while Task 1 is in review.

**Files:**
- **F1 Types:** `src/lib/types.ts`: `Media` gains the five fields.
- **F2 Model:** `src/components/media/mediaDetails.ts` (pure) + `mediaDetails.test.ts`:
  - `MEDIA_DETAIL_LIMITS`, `AGENT_PHOTO_MIMES`, `AGENT_PHOTO_MAX_BYTES` (mirrors of the backend);
  - `parseTags(text) → string[]` (split on `,` and `،`, same normalisation as the backend);
  - `detailsPatch(original, draft) → UpdateMediaBody | null` (only changed fields; empty → null; null when nothing changed);
  - `approvalBlock(media)` and `approvalBlockText(reason, tx)`;
  - `defaultTitle(fileName)` (file name without extension);
  - `displayTitle(media)` (`title ?? fileName`).
- **F3 Paging:** `src/components/media/mediaKinds.ts` `mediaPagePath(kind, before, limit, filters?: {q?, approved?})`; `mediaApi.ts` `useMediaPages(kind, enabled, filters?)` puts the filters in the query key. `mediaApi.test.ts`/`mediaKinds.test.ts` extended.
- **F4 Dialog:** `src/components/media/MediaDetailsDialog.tsx`:
  - preview (image via `AuthorizedImage`; file card for video/PDF), file name in `<bdi>`;
  - inputs: Title / العنوان, Alt text / النص البديل, Tags / الوسوم (comma or Arabic comma; chips), "Use when" / "متى تُستخدم" (textarea, counter 0/500), all `dir="auto"`;
  - the switch "Agent can send this" / "يمكن للوكيل إرسال هذا", disabled with its reason when `approvalBlock` is set; the title is pre-filled with `defaultTitle` when empty and the switch is turned on;
  - Save sends `PATCH /media/:id` with `detailsPatch`; errors through `mediaErrorText`; invalidates `useMediaPages`'s keys and `/media`;
  - read-only (inputs disabled, no Save) without `knowledge.update`.
- **F5 Gallery:** `src/screens/templates/GalleryTab.tsx`:
  - a search box (debounced 300 ms) and a filter "All" / "الكل", "Approved for agent" / "معتمدة للوكيل", "Not approved" / "غير معتمدة";
  - each tile shows `displayTitle` and an "Agent" / "الوكيل" badge when approved;
  - a "Details" / "التفاصيل" action opens the dialog (visible to everyone; editable with `knowledge.update`).
- **F6 Media screen:** `src/screens/Media.tsx`: the same badge and "Details" action on `MediaTile`. Its plain `/media` list is unchanged.
- **F7 Photos tab:** `src/screens/kewy-agent/PhotosTab.tsx` and `src/screens/KewyAgent.tsx`:
  - a fourth tab "Photos" / "الصور", shown with `knowledge.view`;
  - grid from `useMediaPages("image", true, {q, approved})`, default filter "Approved for agent", "Load more" as in the Gallery;
  - a switch on each tile (`knowledge.update`) that PATCHes `approvedForAgent` and shows the keyed error in a toast (for example a missing title opens the dialog instead);
  - an empty state: "No approved photos yet. Approve photos so your agent can send them to customers." / "لا توجد صور معتمدة بعد. اعتمد الصور ليتمكن وكيلك من إرسالها إلى العملاء.", with a link to the Gallery (`#/templates?tab=gallery` or the existing route);
  - the no-access text from `mediaNoAccessText` when `GET /media` returns 403 (ruling 6).
- **F8 Copy:** `src/components/media/mediaErrors.ts`: `media.no_changes`, `media.not_approvable` (per reason), `media.title_required`, and `media.invalid_query` for `q`/`approved`.
- **Permission gating** with `usePermissions().can(...)`: edit and switch `knowledge.update`; Photos tab `knowledge.view`. Hidden actions are not rendered; a 403 shows the shared no-permission toast.

**Produces:**
- The details dialog, the Gallery and Media actions and badges, search and the approval filter, and the Photos tab, in English and Arabic (RTL).

- [ ] Write the failing vitest tests:
  - `parseTags splits on latin and arabic commas and dedupes` (`"Menu، menu, قائمة ,, MENU"` → `["menu","قائمة"]`; more than 20 → the first 20 plus a flag the dialog shows).
  - `detailsPatch sends only changed fields and clears with null`.
  - `approval is blocked for non-images, oversize and inbound files` (and the bilingual reason text).
  - `media page path carries q and approved` (`/media?kind=image&limit=60&q=…&approved=true`; `q` encoded; empty `q` omitted).
  - `media error copy covers the SP-17 keys in both languages`.

  Then implement until they pass, then build the components.
- [ ] `npx vitest run`, `npm run typecheck` and `npm run build` clean. A read-only look at the screens on the dev server is optional; the real UI pass is in Task 3.
- [ ] Commit `feat(media): details dialog, agent approval and search in the gallery, and the agent Photos tab`.

### Task 3: Verification
Apply `20261115140000_media_ai_details` with `npx prisma migrate deploy`, and only when the controller and the user explicitly approve it (ruling 13). It is safe for `main` (Global Constraints). Record the results in `.superpowers/sdd/2026-11-15-sp17-media-ai-details/live-verification.md`, in the format of SP-14's `live-verification.md`: summary, a results table with evidence, DB-side checks, findings, cleanup, and the pending real-l items (ruling 14). If the harness refuses the write, put the tables in the scratchpad and say so; do not reroute.

**Isolation** (no repo code changed; scripts derived from SP-14's in the session scratchpad `C:\Users\ashra\AppData\Local\Temp\claude\7b75a64029a712a6\ebb2057a-6300-4548-9aec-b98487880afb\scratchpad\`):
- **Own instance:** `launch-sp17.js`, derived from `launch-sp14.js`.
  - Backend on **:4240**, compiled with `tsc -p tsconfig.build.json` into a throwaway outDir (`backend/.verify-dist-sp17`, never `backend/dist`) and started with `node`, with its **working directory** set to a scratch folder `sp17-run/`, so `LocalStorage` writes to `sp17-run/uploads` and never to `backend/uploads`. The user's :4100 process is not touched.
  - All `@nestjs/schedule` jobs are disabled (the SP-13 `lookupSchedulers` patch).
- **Storage:** every `DO_SPACES_*` variable is set to an **empty string**, so `MediaStorageProvider` picks `LocalStorage` and nothing is written to the real bucket. `PUBLIC_BASE_URL=http://127.0.0.1:4240`.
- **No external call, ever:**
  - **l:** `L_API_URL=http://127.0.0.1:4249`, pointing at `l-stub-sp17.js`, which binds 127.0.0.1 only and serves `POST /api/v1/webhooks/:endpointId/messages`. It checks `x-webhook-secret = zz-verify-l-secret-<ts>` and answers a scripted `{answer, image_url?}` settable through `POST /__control/next`. It logs every call. `L_JOTECK_*`/admin keys are empty, so `LAgentSetupService` cannot reach a real l.
  - **Zernio:** `ZERNIO_BASE_URL=http://127.0.0.1:4239/api/v1`, `ZERNIO_API_KEY=zz-verify-stub`, pointing at `zernio-stub-sp17.js` (derived from SP-14's). It records message sends (text and image) and forwards nothing.
  - Other provider keys are empty strings, not deleted (SP-19 finding E2), the same list as SP-14.
  - **The launcher refuses to start** unless `L_API_URL` and `ZERNIO_BASE_URL` begin with `http://127.0.0.1`, `ZERNIO_API_KEY` equals `zz-verify-stub`, and every `DO_SPACES_*` is empty.
  - The SP-13 egress guard (fetch, http and https to any non-loopback host throws and is logged to `blocked-egress-sp17.jsonl`) stays. Before cleanup, the script asserts that `blocked-egress-sp17.jsonl` is empty.
- `ZERNIO_WEBHOOK_SECRET` is a test value, so the inbound WhatsApp message that triggers the agent reply can be replayed signed.
- Test tag `zz-verify-<ts>` on every name and email.

**Setup** (writes only rows tagged with the test tag):
1. Register an owner and a foreign owner. Invite an admin, an agent and a viewer.
2. Give the test workspace `lEndpointId zz-verify-l-<ts>` and `lEndpointSecret zz-verify-l-secret-<ts>`; mint an MCP token through `POST /integrations/mcp/token` (test workspace only) and record its prefix.
3. Insert one active Zernio WhatsApp channel with `externalId zz-verify-acc-<ts>`, a contact, and a conversation with `aiEnabled = true`.
4. Upload through `POST /media/upload` as the owner: two JPEGs, one PNG, one PDF, one WebP and one 6 MB PNG (generated bytes with real magic numbers). Insert one inbound JPEG through `MediaService.ingestBuffer` (uploadedById null) via a replayed signed Zernio image message. In the foreign workspace, upload one JPEG.

**Checks:**
- **Details and approval** (API, as the owner):
  - PATCH title, alt, tags `["Menu", "قائمة", "menu"]` and use-when on JPEG 1 → tags stored `["menu","قائمة"]`;
  - approve JPEG 1 and the PNG → 200; approve JPEG 2 without a title → 400 `media.title_required`;
  - approve the PDF / WebP → `not_approvable {reason:"type"}`; the 6 MB PNG → `size`; the inbound JPEG → `inbound`;
  - the admin can PATCH; the agent and viewer get 403 (ruling 5); the foreign owner gets 404 on JPEG 1;
  - an empty body → `media.no_changes`; an unknown field → 400.
- **Search:** `GET /media?q=menu` finds JPEG 1 by tag; `q=قائمة` finds it too; `q=<use-when word> <title word>` (two tokens) finds it; `approved=true` lists exactly JPEG 1 and the PNG; `approved=false&kind=image` excludes them; `q` of 101 chars and `approved=yes` give the keyed 400s; `limit=1` paging with `q` follows `X-Media-Next-Before` to the end.
- **`agent tool never returns unapproved media` (live):** call `POST http://127.0.0.1:4240/api/mcp/v1` with the test token:
  - `tools/list` includes `list_photos`;
  - `tools/call list_photos {}` returns exactly JPEG 1 and the PNG, with `url`s on `http://127.0.0.1:4240/api/media/<id>/public?token=…` that load (200, image type, `nosniff`);
  - `{query: <JPEG 2's file name>}` returns nothing (unapproved);
  - hide the PNG → the next call returns only JPEG 1;
  - the foreign workspace's photo never appears; with the foreign workspace's token (minted for it), JPEG 1 never appears;
  - a bad token → 401, and the tool runs no query.
- **Send re-check:**
  - script the l stub to answer "Here is our menu" with `image_url` = JPEG 1's tool URL; replay a signed inbound customer message → the Zernio stub records one image send with that URL and the text;
  - script it with the hidden PNG's URL → the stub records a text-only send, and the backend log shows `agent image dropped: not approved` with the id and without the token;
  - script it with the foreign photo's URL → text only;
  - script it with `https://example.com/x.jpg` → the backend tries to send it as before; the Zernio stub records it (the stub does not fetch it, so no egress);
  - **no request leaves loopback** (egress log empty).
- **Prompt:** with `LJoteckClient` pointed at a loopback stub (`l-admin-stub` paths for agents, prompts and mcp-servers on :4249), `POST /joteck/workspaces/<test ws>/agent-setup` appends the photos section once, and a second call reports `already-present`. If the Joteck route needs a real Joteck secret, cover it with the jest spec only and record that.
- **Migration rerun:** execute the SP-17 migration SQL again inside a transaction that is always rolled back: no errors and 0 rows changed. If the tool safety layer refuses DDL even in a rolled-back transaction (as in SP-13), record it and ask the user; do not reroute.
- **Main compatibility:** a row inserted with only the pre-SP-17 columns (as `main` does) gets `tags = {}` and `approvedForAgent = false` (read back by id).
- **UI through the `verify` skill**, against :4240 with the Vite dev server proxied to it:
  - the Gallery: search, the approval filter, the "Agent" badge, the details dialog with the blocked-switch reasons;
  - the Media screen's "Details" action;
  - the Photos tab: default "Approved for agent" filter, the switch, the empty state, and the agent's read-only view;
  - English and Arabic (RTL), including Arabic tags and `dir="auto"` inputs;
  - screenshots.

**Cleanup:**
- Delete only the recorded test rows: the two workspaces (the cascade covers members, channels, contacts, conversations, messages and media rows), then the users.
- Delete `sp17-run/uploads` and the outDir.
- Run a residue sweep over every table with a `workspaceId` column, including `Media`, `Message` and `Conversation`.
- Read-only counts before and after: `Workspace`, `User`, `Media`, `Message`, `Conversation`, `Contact`, `Channel`, `WorkspaceMember`. Every count must be identical.
- Stop :4240, both stubs, and confirm no process holds :4239, :4240 or :4249.

Then tick SP-17's "Detailed plan written" and "Shipped" boxes in the roadmap, noting the rulings taken and the deviations. Add the deferred items to the roadmap:
- agent sending of videos and PDFs (ruling 3);
- Arabic letter folding and stemming in media search (ruling 7);
- keeping agent-sent photos visible in the inbox past the URL lifetime (ruling 9);
- the prompt rollout to already-linked agents, if the user chooses a backfill (ruling 10);
- links from photos to knowledge documents and products (SP-21);
- the pending real-l checks (ruling 14).
