import { ROUTE_PERMISSIONS } from "./permission-map";
import { SYSTEM_ROLES, SystemRoleKey } from "./system-roles";
import { hasPermission } from "./permission.service";

/** Review Focus 3: the system roles reproduce today's decisions. */
function allowed(role: SystemRoleKey, key: string): boolean {
  const p = ROUTE_PERMISSIONS[key];
  if (p === undefined) throw new Error(`unmapped route in table: ${key}`);
  if (p === "public" || p === "authenticated") return true;
  return hasPermission(SYSTEM_ROLES[role].permissions, p);
}

// Routes that were @WorkspaceRoles("owner","admin") or had an inline
// owner/admin check before SP-25.
const OWNER_ADMIN_ONLY = [
  "POST /custom-fields",
  "PATCH /custom-fields/:id",
  "DELETE /custom-fields/:id",
  "POST /ads/wallet/topup",
  "POST /ads/actions/:id/approve",
  "POST /ads/actions/:id/reject",
  "PATCH /workspaces/:id",
  "POST /workspaces/:id/members",
  "POST /workspaces/:id/invite",
  "PATCH /workspaces/:id/members/:userId",
  "PATCH /workspaces/:id/members/:userId/password",
  "DELETE /workspaces/:id/members/:userId",
  "POST /integrations/l/knowledge",
  "DELETE /integrations/l/knowledge/:documentId",
  "POST /integrations/l/tools",
  "DELETE /integrations/l/tools/:toolId",
  "POST /integrations/l/tools/:toolId/binding",
  "DELETE /integrations/l/tools/:toolId/binding",
  "POST /integrations/l/mcp-servers",
  "DELETE /integrations/l/mcp-servers/:serverId",
  "POST /integrations/l/mcp-servers/:serverId/binding",
  "DELETE /integrations/l/mcp-servers/:serverId/binding",
  "POST /integrations/l/mcp-servers/:serverId/test",
  "POST /integrations/mcp/token",
  "DELETE /integrations/mcp/token",
];

// What an agent does today in the inbox, contacts and tickets.
const AGENT_WORK = [
  "GET /conversations",
  "GET /conversations/:id",
  "GET /conversations/:id/messages",
  "POST /conversations",
  "PATCH /conversations/:id",
  "POST /conversations/:id/read",
  "POST /conversations/:id/messages",
  "POST /conversations/:id/ai",
  "PUT /conversations/:id/labels",
  "GET /conversation-labels",
  "POST /conversation-labels",
  "POST /integrations/whatsapp/conversations/:conversationId/send",
  "POST /integrations/whatsapp/conversations/:conversationId/send-template",
  "POST /integrations/zernio/db-conversations/:id/send",
  "POST /integrations/zernio/db-conversations/:id/send-template",
  "GET /contacts",
  "GET /contacts/:id",
  "POST /contacts",
  "PATCH /contacts/:id",
  "POST /contacts/bulk",
  "PUT /contacts/:id/fields",
  "GET /custom-fields",
  "GET /tags",
  "POST /tags",
  "POST /tags/assign",
  "GET /tickets",
  "POST /tickets",
  "POST /tickets/from-conversation/:conversationId",
  "PATCH /tickets/:id",
  "POST /tickets/:id/move",
  "POST /tickets/:id/notes",
  "GET /pipelines",
  "GET /notes",
  "POST /notes",
  "PATCH /notes/:id",
  "DELETE /notes/:id",
  "POST /notes/:id/seen",
  "POST /appointments",
  "PATCH /appointments/:id",
  "POST /media/upload",
  "GET /media",
  "GET /search",
  "GET /notifications",
  "POST /notifications/read",
  "GET /team",
  "GET /dashboard/summary",
  "GET /workflows",
  "POST /workflows",
  "PATCH /workflows/:id",
  "POST /workflows/:id/activate",
  "POST /workflows/:id/test",
  "POST /templates",
  "PATCH /templates/:id",
  "POST /campaigns",
  "PATCH /campaigns/:id",
  "GET /auth/me",
  "GET /me/permissions",
  "GET /workspaces/:id",
  "GET /workspaces/:id/members",
];

// Non-GET routes that do not change shared business data: personal read
// receipts, previews, or own-account routes. Everything else that is not a
// GET must be denied to a viewer.
const VIEWER_SAFE_NON_GET = new Set([
  "POST /conversations/:id/read",
  "POST /notes/:id/seen",
  "POST /segments/preview",
]);

describe("system-role decision table", () => {
  it.each(OWNER_ADMIN_ONLY)("%s: owner+admin yes, agent+viewer no", (key) => {
    expect(allowed("owner", key)).toBe(true);
    expect(allowed("admin", key)).toBe(true);
    expect(allowed("agent", key)).toBe(false);
    expect(allowed("viewer", key)).toBe(false);
  });

  it.each(AGENT_WORK)("agent can %s", (key) => {
    expect(allowed("agent", key)).toBe(true);
    expect(allowed("admin", key)).toBe(true);
    expect(allowed("owner", key)).toBe(true);
  });

  it.each(["DELETE /contacts/:id", "DELETE /tickets/:id", "DELETE /workflows/:id", "DELETE /templates/:id", "DELETE /campaigns/:id"])("agent cannot %s", (key) => {
    expect(allowed("agent", key)).toBe(false);
    expect(allowed("admin", key)).toBe(true);
  });

  it("viewer cannot mutate anything", () => {
    const leaks = Object.entries(ROUTE_PERMISSIONS)
      .filter(([k, p]) => !k.startsWith("GET ") && p !== "public" && p !== "authenticated")
      .filter(([k]) => !VIEWER_SAFE_NON_GET.has(k))
      .filter(([k]) => allowed("viewer", k))
      .map(([k]) => k);
    expect(leaks).toEqual([]);
  });

  it("viewer non-GET exceptions are read-only permissions", () => {
    for (const k of VIEWER_SAFE_NON_GET) expect(ROUTE_PERMISSIONS[k]).toMatch(/\.view$/);
  });

  it("billing.manage and roles.manage are owner-only", () => {
    expect(hasPermission(SYSTEM_ROLES.admin.permissions, "billing.manage")).toBe(false);
    expect(hasPermission(SYSTEM_ROLES.admin.permissions, "roles.manage")).toBe(false);
    expect(hasPermission(SYSTEM_ROLES.owner.permissions, "roles.manage")).toBe(true);
  });
});
