# SP-25 Roles & Permissions: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Workspaces get custom roles, each with a resource × action permission matrix and a conversation visibility of all or assigned-only.
- The backend enforces those permissions on every authenticated workspace route.
- The UI hides or disables what a member can't do.
- The mock Roles tab is replaced with a real editor.

**Architecture:**
- **Roles and assignment:** a new `Role` table. `WorkspaceMember` gains a nullable `roleId`, and the legacy `role` string stays because the currently deployed code reads it.
  - A member's effective role is `roleId`, falling back to the workspace's system role whose `key` equals the legacy `role` string.
  - The four system roles (owner, admin, agent, viewer) are seeded per workspace by the migration and created lazily for workspaces made later.
- **One global `PermissionGuard` (`APP_GUARD`) reads a single route→permission map** (`permission-map.ts`, keyed by controller path and HTTP method). `@RequirePermission(resource, action)` overrides the map per handler.
  - Routes without a workspace user (webhooks, auth, public) are untouched.
  - A table test enumerates every registered route and fails when a route has no mapping, so new routes can't ship unguarded.
- **Conversation visibility "assigned"** is applied in one place: `visibleConversationWhere(userCtx)`. It is used by the conversations, search, notes, records and notification paths.

**Tech Stack:** NestJS 10, Prisma 5, jest; React 18, vitest.

**Spec:** `docs/superpowers/plans/2026-11-08-tkana-parity-roadmap.md` §SP-25 and §2.5, plus Review Focus 1. Tkana reference: `apps/web/app/routes/settings.roles.tsx`, `components/RolePermissionMatrix.tsx`, `lib/permissions/role-matrix*`.

## Global Constraints
- **Resources**, exactly as in roadmap §2.5: `conversations, contacts, tickets, pipelines, bookings, campaigns, templates, audiences, knowledge, agent, channels, connectors, members, roles, billing, settings, api_keys, reports`.
- **Actions:** `view, create, update, delete, manage`.
- **Permissions** are stored as JSON `{ [resource]: Action[] }`. Unknown resources or actions are rejected with 400.
- **System role matrices.** These are binding, and they reproduce what the UI allows today:
  - **owner:** every action on every resource.
  - **admin:** every action on every resource except `billing.manage` and `roles.manage`.
  - **agent:**
    - `view, create, update` on conversations, contacts, tickets, bookings, audiences;
    - `view` on pipelines, campaigns, templates, knowledge, agent, channels, reports, members;
    - `delete` on contacts and tickets is NOT granted.
  - **viewer:** `view` on everything except `billing`, `api_keys`, `roles`.
  - **Visibility:** owner, admin and viewer see all conversations; agent sees all, which keeps today's behaviour.
  - System roles can't be deleted. Owner can't be edited at all. Admin, agent and viewer permissions are editable, but their `key` is fixed.
- **Last owner:** there must always be at least one member with the owner role. Demoting or removing the last owner returns 400.
- **Super-admin and impersonation sessions** (`isSuperAdmin` or `impersonating` in the JWT) bypass permission checks, the same as `WorkspaceRolesGuard` does today.
- **Hidden records:** a record a member can't see returns 404, not 403. A missing permission returns 403 `{ message: "Missing permission", permission: "contacts.delete" }`.
- **Migration:** hand-written `backend/prisma/migrations/20261109180000_roles/migration.sql`. It is additive and idempotent, and it must not change behaviour for the deployed code. Both `role` and `roleId` coexist.
- **Copy and layout:** every user-facing string goes through `tx("English","العربية")` with real Arabic; use logical CSS.
- **Tests:** backend `npx jest src/permissions src/roles src/workspaces src/conversations src/search src/notes src/notifications src/common` plus tsc. Frontend `npx vitest run` plus `npm run typecheck`. The known unrelated failure is `src/hjz-sync/hjz-client-sync.service.spec.ts`.
- **Commits:** selective `git add`; trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus
1. **Side doors for assigned-only members.** With `conversationVisibility = "assigned"`, an unassigned conversation must return 404 or be absent through every path below. The test is `permission-sidedoors.spec.ts`, with one case per path.
   - `GET /conversations` and `/conversations/:id`
   - `/conversations/:id/messages`
   - `GET /search`
   - `/notes?conversationId=`
   - `canOpenRecord`, used by mentions and notifications
   - `PATCH` and labels on the conversation
   - board, table and counts, which are all the same list endpoint
2. **Every route is mapped.** `permission-map.spec.ts` boots the Nest app metadata, or scans the controllers, lists every route, and asserts each is either in the map or explicitly public. New routes then fail CI until they are mapped.
3. **The system roles reproduce today's decisions:**
   - owner and admin can do what `@WorkspaceRoles("owner","admin")` allowed;
   - agents can still work the inbox, contacts and tickets as they do today;
   - viewers can't mutate anything.

   The test is a table over sample routes for each role.
4. **No lockout.** The last owner can't be demoted or removed. A role that is in use can't be deleted (409 with `{ members: n }`). An invalid permission key gives 400.
5. **Performance.** The effective role is resolved once per request and cached in memory for 30 s per `(workspaceId, userId)`. The cache is invalidated on role or member changes in this process.

---

### Task 1: Schema, migration and system-role seed
**Files:** `backend/prisma/schema.prisma`, `backend/prisma/migrations/20261109180000_roles/migration.sql`, `backend/src/common/prisma-tenancy.ts` (adds `Role`), `backend/src/prisma/prisma.service.ts` (getters, if that pattern applies).

**Produces:**
- `Role {id, workspaceId, key String? (owner|admin|agent|viewer for system, null for custom), name, nameAr, isSystem Boolean, permissions Json, conversationVisibility String @default("all"), createdAt, updatedAt}`, with `@@unique([workspaceId, key])`, `@@unique([workspaceId, name])`, and the workspace FK cascading.
- `WorkspaceMember.roleId String?`, an FK to `Role` with `onDelete: SetNull`.
- The SQL inserts the 4 system roles for every existing workspace with `INSERT … SELECT … ON CONFLICT DO NOTHING`. Ids come from `md5(random()::text || clock_timestamp()::text)`. The permissions JSON is exactly the Global Constraints matrices.
- The SQL then sets `WorkspaceMember."roleId"` from the system role whose `key` equals `lower(role)`, `WHERE "roleId" IS NULL`.

- [ ] Write the schema and SQL. Run `prisma validate` and `generate`, update `SCOPED_MODELS`, then tsc.
- [ ] Commit `feat(roles): role table, system roles per workspace`.

### Task 2: Permission core and global guard
**Files:** create `backend/src/permissions/{permissions.module.ts, catalog.ts, system-roles.ts, permission.service.ts, permission.guard.ts, require-permission.decorator.ts, permission-map.ts, visibility.ts, permissions.controller.ts}` with specs. Modify `backend/src/app.module.ts` (APP_GUARD; place it after the existing auth guard, and check how AuthGuard is registered).

**Produces:**
- `catalog.ts`: `RESOURCES`, `ACTIONS`, the `Permission` type `` `${Resource}.${Action}` ``, and `validatePermissions(json): PermissionsJson`.
- `system-roles.ts`: `SYSTEM_ROLES: Record<"owner"|"admin"|"agent"|"viewer", {name, nameAr, permissions, conversationVisibility}>`. This is the single source of truth, and the migration's JSON must equal it. A spec reads the migration file and compares the two.
- `PermissionService`:
  - `effective(workspaceId, userId): Promise<{ roleId, key, permissions, conversationVisibility } | null>`. It is cached for 30 s. When system roles are missing for the workspace (created after the migration), it creates them lazily.
  - `can(ctx, permission): boolean`
  - `invalidate(workspaceId, userId?)`
- `permission-map.ts`: `ROUTE_PERMISSIONS: Record<string /* "METHOD /path" */, Permission | "public" | "authenticated">`, covering every route in all 44 controllers. `authenticated` means any member, for example `/auth/me`, the own-notifications routes and `/me/permissions`.
  - Default rule for unlisted mutating routes: there is none. The spec fails instead.
- `PermissionGuard`:
  - It skips when there is no `req.user?.workspaceId`.
  - It resolves the permission from the `@RequirePermission` metadata, otherwise from the map.
  - `"public"` and `"authenticated"` pass.
  - It bypasses super-admins and impersonation.
  - A non-member gets 403 `{message: "Not a member"}`.
  - A missing permission gets 403 with the permission named.
- The existing `@WorkspaceRoles(...)` usages are re-expressed as `@RequirePermission`, using the closest mapping, and listed in the report.
- `visibility.ts`: `visibleConversationWhere(eff, userId): Prisma.ConversationWhereInput`. It returns `{}` for "all" and `{ assigneeId: userId }` for "assigned".
- `GET /me/permissions` returns `{ roleId, key, name, permissions: Permission[], conversationVisibility }`.

- [ ] **Failing tests:**
  - `permission-map covers every route` (Review Focus 2)
  - `system roles in migration equal SYSTEM_ROLES`
  - `guard: viewer cannot POST /contacts → 403 names contacts.create`
  - `guard: agent can PATCH /conversations/:id`
  - `guard: super-admin bypass`
  - `guard: no workspace user → skip`
  - `effective falls back from legacy role string when roleId null`
  - `cache hit avoids second query; invalidate clears`
  - the system-role decision table (Review Focus 3)
- [ ] Implement, then run GREEN, then commit `feat(permissions): catalog, system roles, global permission guard`.

### Task 3: Roles API and member role assignment
**Files:** create `backend/src/roles/{roles.module.ts, roles.service.ts, roles.controller.ts, roles.dto.ts, roles.service.spec.ts}`. Modify `backend/src/workspaces/workspaces.service.ts` and the controller (member role changes), and `backend/src/team/team.module.ts` (return `roleId` and `roleName`).

**Produces:**
- `GET /roles` returns roles with `memberCount`.
- `POST /roles {name, nameAr, permissions, conversationVisibility}`.
- `PATCH /roles/:id`. Owner returns 400; system `key` is immutable.
- `DELETE /roles/:id`. A system role returns 400. A role in use returns 409 `{members}`.
- `PATCH /workspaces/:id/members/:userId {roleId}` sets `roleId` and also keeps the legacy `role` string in sync: the system key, or `"agent"` for custom roles, so old code sees a sensible value. It enforces the last-owner rule and invalidates the cache.
- Inviting with a `role` string keeps working and maps to the system role.

- [ ] **Tests:**
  - `cannot delete a role in use`
  - `cannot delete system role`
  - `owner role immutable`
  - `invalid permission → 400`
  - `demoting last owner → 400`
  - `custom role assignment syncs legacy role string`
  - `foreign role id → 404`
- [ ] Commit `feat(roles): roles API and member role assignment`.

### Task 4: Conversation visibility everywhere
**Files:** modify
- `backend/src/conversations/conversations.service.ts` and `conversations.controller.ts`
- `backend/src/conversations/conversation-labels.service.ts` (setForConversation)
- `backend/src/search/search.service.ts`
- `backend/src/notes/notes.service.ts` (conversation-scoped list and create)
- `backend/src/notifications/record-access.ts` (`canOpenRecord` uses `PermissionService.effective` and the visibility where)
- `backend/src/integrations/*` (only the routes that read DB conversations by id for the inbox: the WhatsApp send and send-template routes check visibility first)

Create `backend/src/permissions/permission-sidedoors.spec.ts`.

**Produces:** every read or mutation of a DB conversation by a member goes through `visibleConversationWhere`. Hidden conversations return 404.
- [ ] **Tests:** `permission-sidedoors.spec.ts` with one case per path in Review Focus 1.
- [ ] Commit `feat(permissions): assigned-only conversation visibility across every path`.

### Task 5: Frontend — permissions hook, Roles editor, gated UI
**Files:**
- Create `src/auth/usePermissions.ts`: `usePermissions(): { can(p: Permission): boolean; loading; visibility }` from `GET /me/permissions`, cached with React Query, and refetched on workspace switch.
- Create `src/lib/permissions.ts` (with a test): the shared `RESOURCES`, `ACTIONS`, `Permission` type, and the matrix helpers `toggleCell`, `toggleRow`, `toggleColumn`, `isRowAll`, `isColumnAll`.
- Create `src/screens/settings/RolesTab.tsx`:
  - a roles list showing member counts;
  - create, rename, duplicate-from and delete (with the 409 message);
  - a matrix editor (resources × actions, with whole-row and whole-column toggles, EN/AR resource labels, and the owner shown read-only);
  - a conversation visibility select.
- Modify:
  - `src/screens/Team.tsx`: replace the mock `PERM_MATRIX` Roles tab with `RolesTab`, or point it there, and remove the mock data import.
  - `src/screens/settings/MembersTab.tsx`: a role select listing the real roles, and the last-owner error shown inline.
  - Every `activeWorkspace?.role === "owner" || … "admin"` check (`Contacts.tsx:450`, `KewyAgent.tsx:21`, `AiKnowledgeTab.tsx:123`, `IntegrationsTab.tsx:31`, `MembersTab.tsx:36`, `WorkspaceTab.tsx:27`) is replaced with `can(...)` and the matching permission.
  - Destructive and mutating controls are hidden or disabled when not allowed: bulk delete and bulk actions in Contacts, the inbox ConversationActions, pipeline and ticket mutations, and Settings saves. Reads stay as they are.
- [ ] **Tests:** vitest for the matrix helpers, then typecheck.
- [ ] Commit `feat(roles): roles editor, permission-gated UI`.

### Task 6: Verification
- Apply the migration after checking that it is safe for the deployed code.
- Live API checks, with every change reverted:
  - a temporary custom role with assigned-only visibility, assigned to a test member;
  - each side door returns 404;
  - a viewer can't POST;
  - the last owner can't be demoted.
- Browser: the Roles tab, and gated controls viewed as an agent.
- Tick SP-25 in the roadmap.
