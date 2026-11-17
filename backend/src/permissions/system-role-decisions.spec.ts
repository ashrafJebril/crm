import { ROUTE_PERMISSIONS } from "./permission-map";
import { SYSTEM_ROLES, SystemRoleKey } from "./system-roles";
import { hasPermission } from "./permission.service";
import { blockedForImpersonation } from "./impersonation";
import { assertRequestPermission, PermissionGuard } from "./permission.guard";
import { blockedRouteForImpersonation } from "./impersonation";
import { Reflector } from "@nestjs/core";
import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { WorkspacesController } from "../workspaces/workspaces.controller";
import { InvitationsController } from "../members/invitations.controller";
import { AuditController } from "../audit/audit.controller";
import type { PermissionsJson } from "./catalog";

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
  // SP-13: the campaign review-step preview writes nothing.
  "POST /campaigns/preview",
  // SP-24: Sync is the template reconcile GET /templates already writes (templates.view).
  "POST /lifecycle/sync",
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

  it.each(["DELETE /contacts/:id", "DELETE /tickets/:id", "DELETE /campaigns/:id"])("agent cannot %s", (key) => {
    expect(allowed("agent", key)).toBe(false);
    expect(allowed("admin", key)).toBe(true);
  });

  // Final-review ruling (I3): agent matrix + route remaps.
  it.each([
    "DELETE /templates/:id",
    "DELETE /segments/:id",
    "DELETE /appointments/:id",
    "DELETE /workflows/:id",
    "POST /tags",
    "PATCH /tags/:id",
    "DELETE /tags/:id",
    "POST /tags/merge",
    "POST /conversation-labels",
    "PATCH /conversation-labels/:id",
    "DELETE /conversation-labels/:id",
    "DELETE /media/:id",
    "DELETE /social/scheduled/:id",
  ])("agent can %s (viewer cannot)", (key) => {
    expect(allowed("agent", key)).toBe(true);
    expect(allowed("viewer", key)).toBe(false);
  });

  it("route remaps from the final review", () => {
    for (const k of ["POST /tags", "PATCH /tags/:id", "DELETE /tags/:id", "POST /tags/merge"]) {
      expect([k, ROUTE_PERMISSIONS[k]]).toEqual([k, "contacts.update"]);
    }
    for (const k of ["POST /conversation-labels", "PATCH /conversation-labels/:id", "DELETE /conversation-labels/:id", "DELETE /media/:id"]) {
      expect([k, ROUTE_PERMISSIONS[k]]).toEqual([k, "conversations.update"]);
    }
    expect(ROUTE_PERMISSIONS["DELETE /social/scheduled/:id"]).toBe("campaigns.update");
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

  // SP-12: campaign recipients, insights, export and follow-ups.
  describe("SP-12 campaign report routes", () => {
    const VIEW = ["GET /campaigns/:id/recipients", "GET /campaigns/:id/insights"];
    const EXPORT = ["GET /campaigns/:id/export", "POST /campaigns/:id/export"];
    const FOLLOW_UP = [
      "POST /campaigns/:id/follow-up/tag",
      "POST /campaigns/:id/follow-up/create-group",
      "POST /campaigns/:id/follow-up/add-to-group",
    ];

    it.each([...VIEW, ...FOLLOW_UP])("agent can %s", (key) => {
      expect(allowed("agent", key)).toBe(true);
    });

    it.each(EXPORT)("agent cannot %s (contacts.manage); owner and admin can", (key) => {
      expect(allowed("agent", key)).toBe(false);
      expect(allowed("owner", key)).toBe(true);
      expect(allowed("admin", key)).toBe(true);
    });

    it.each(VIEW)("viewer can %s", (key) => expect(allowed("viewer", key)).toBe(true));
    it.each([...FOLLOW_UP, ...EXPORT])("viewer cannot %s", (key) => expect(allowed("viewer", key)).toBe(false));

    it("impersonation may export and follow up, but launch stays blocked", () => {
      const imp = { user: { workspaceId: "ws1", impersonating: true } } as never;
      for (const k of [...EXPORT, ...FOLLOW_UP, ...VIEW]) {
        const p = ROUTE_PERMISSIONS[k] as string;
        expect({ k, blocked: blockedForImpersonation(p) }).toEqual({ k, blocked: false });
      }
      // The in-service campaigns.view assertion on export passes for a support session.
      expect(() => assertRequestPermission(imp, "campaigns.view")).not.toThrow();
      expect(blockedForImpersonation(ROUTE_PERMISSIONS["POST /campaigns/:id/launch"] as string)).toBe(true);
      expect(() => assertRequestPermission(imp, "campaigns.manage")).toThrow();
    });
  });

  // SP-13: sending numbers and the campaign preview.
  describe("SP-13 campaign sending routes", () => {
    const VIEW = ["GET /campaigns/senders", "POST /campaigns/preview"];
    const MANAGE = ["POST /campaigns/:id/launch", "POST /campaigns/:id/cancel"];

    it.each(VIEW)("agent can %s", (key) => expect(allowed("agent", key)).toBe(true));
    it.each(VIEW)("viewer can %s", (key) => expect(allowed("viewer", key)).toBe(true));
    it.each(MANAGE)("viewer cannot %s", (key) => expect(allowed("viewer", key)).toBe(false));
    it.each(MANAGE)("owner and admin can %s", (key) => {
      expect(allowed("owner", key)).toBe(true);
      expect(allowed("admin", key)).toBe(true);
    });

    it("preview samples need contacts.view: viewer and agent hold it", () => {
      expect(hasPermission(SYSTEM_ROLES.agent.permissions, "contacts.view")).toBe(true);
      expect(hasPermission(SYSTEM_ROLES.viewer.permissions, "contacts.view")).toBe(true);
    });

    it("an impersonated owner may view senders and preview, but cannot launch or cancel", () => {
      const imp = { user: { workspaceId: "ws1", impersonating: true } } as never;
      for (const k of VIEW) {
        expect({ k, blocked: blockedForImpersonation(ROUTE_PERMISSIONS[k] as string) }).toEqual({ k, blocked: false });
      }
      for (const k of MANAGE) {
        expect({ k, blocked: blockedForImpersonation(ROUTE_PERMISSIONS[k] as string) }).toEqual({ k, blocked: true });
      }
      expect(() => assertRequestPermission(imp, "campaigns.manage")).toThrow();
      expect(() => assertRequestPermission(imp, "campaigns.view")).not.toThrow();
    });
  });

  // SP-14 (part 1): the live number-health check (ruling R4).
  describe("SP-14 health routes", () => {
    const CHECK = "POST /channels/:id/health/check";

    it("owner and admin can check", () => {
      expect(allowed("owner", CHECK)).toBe(true);
      expect(allowed("admin", CHECK)).toBe(true);
    });

    it("agent and viewer cannot check, but can read the cached health", () => {
      expect(allowed("agent", CHECK)).toBe(false);
      expect(allowed("viewer", CHECK)).toBe(false);
      for (const role of ["agent", "viewer"] as const) {
        expect(allowed(role, "GET /channels/:id")).toBe(true);
        expect(allowed(role, "GET /channels")).toBe(true);
      }
    });

    it("an impersonated owner is not blocked from checking", () => {
      const imp = { user: { workspaceId: "ws1", impersonating: true } } as never;
      expect(blockedForImpersonation(ROUTE_PERMISSIONS[CHECK] as string)).toBe(false);
      expect(() => assertRequestPermission(imp, "channels.update")).not.toThrow();
    });

    // Part 2 (Task 2): the read-only template-health routes.
    const READS = ["GET /channels/:id/templates", "GET /templates/:id/health"];

    it("every system role can read both template-health routes", () => {
      for (const route of READS) {
        for (const role of ["owner", "admin", "agent", "viewer"] as const) {
          expect({ role, route, ok: allowed(role, route) }).toEqual({ role, route, ok: true });
        }
      }
    });

    it("none of the SP-14 routes is blocked for impersonation", () => {
      for (const route of [CHECK, ...READS]) {
        expect({ route, blocked: blockedForImpersonation(ROUTE_PERMISSIONS[route] as string) }).toEqual({ route, blocked: false });
      }
    });
  });

  // SP-15 (part 1): the ad-source routes Task 1 adds. Task 2 extends this block.
  describe("SP-15 ads routes", () => {
    const READS = ["GET /ad-sources", "GET /ad-sources/:id/conversations"];

    it("permission map covers SP-15 routes", () => {
      expect(ROUTE_PERMISSIONS["GET /ad-sources"]).toBe("conversations.view");
      expect(ROUTE_PERMISSIONS["GET /ad-sources/:id/conversations"]).toBe("conversations.view");
    });

    it("owner, admin, agent and viewer can read the ad filter and the per-ad conversations (scoped)", () => {
      for (const route of READS) {
        for (const role of ["owner", "admin", "agent", "viewer"] as const) {
          expect({ role, route, ok: allowed(role, route) }).toEqual({ role, route, ok: true });
        }
      }
    });

    // Part 2 (Task 2): ad metrics and Meta Ads connect.
    const METRICS = ["GET /ad-sources/overview", "GET /ad-sources/:id"];
    const MANAGE = [
      "GET /meta-ads/oauth/start",
      "GET /meta-ads/candidates",
      "POST /meta-ads/connection",
      "POST /meta-ads/check",
      "DELETE /meta-ads/connection",
    ];

    it("permission map covers SP-15 routes (part 2)", () => {
      for (const route of METRICS) expect({ route, p: ROUTE_PERMISSIONS[route] }).toEqual({ route, p: "reports.view" });
      for (const route of MANAGE) expect({ route, p: ROUTE_PERMISSIONS[route] }).toEqual({ route, p: "connectors.manage" });
      expect(ROUTE_PERMISSIONS["GET /meta-ads/connection"]).toBe("connectors.view");
      expect(ROUTE_PERMISSIONS["GET /meta-ads/oauth/callback"]).toBe("public");
    });

    it("owner and admin can connect, check and disconnect; agent and viewer cannot", () => {
      for (const route of MANAGE) {
        for (const role of ["owner", "admin"] as const) expect({ role, route, ok: allowed(role, route) }).toEqual({ role, route, ok: true });
        for (const role of ["agent", "viewer"] as const) expect({ role, route, ok: allowed(role, route) }).toEqual({ role, route, ok: false });
      }
    });

    it("viewers can read the connection status; agents cannot (no connectors action)", () => {
      const route = "GET /meta-ads/connection";
      expect(["owner", "admin", "agent", "viewer"].map((r) => [r, allowed(r as SystemRoleKey, route)])).toEqual([
        ["owner", true],
        ["admin", true],
        ["agent", false],
        ["viewer", true],
      ]);
    });

    it("owner, admin, agent and viewer can read the overview and the per-ad page (reports.view)", () => {
      for (const route of METRICS) {
        for (const role of ["owner", "admin", "agent", "viewer"] as const) {
          expect({ role, route, ok: allowed(role, route) }).toEqual({ role, route, ok: true });
        }
      }
    });

    it("impersonation is not blocked (ruling 7)", () => {
      for (const route of [...READS, ...METRICS, ...MANAGE, "GET /meta-ads/connection"]) {
        expect({ route, blocked: blockedForImpersonation(ROUTE_PERMISSIONS[route] as string) }).toEqual({ route, blocked: false });
      }
    });
  });

  // SP-16: smart audience routes (part 1) and the tag references route (Task 2).
  describe("SP-16 audience routes", () => {
    const READS = [
      "GET /segments",
      "GET /segments/:id",
      "GET /segments/:id/contacts",
      "GET /segments/:id/count",
      "GET /segments/:id/candidates",
      "POST /segments/preview",
      "GET /tags/:id/references",
    ];
    const MUTATIONS = ["POST /segments", "PATCH /segments/:id", "DELETE /segments/:id"];

    it("every system role can read the audience routes and preview", () => {
      for (const route of READS) {
        for (const role of ["owner", "admin", "agent", "viewer"] as const) {
          expect({ role, route, ok: allowed(role, route) }).toEqual({ role, route, ok: true });
        }
      }
    });

    it("viewer cannot create, update or delete; agent, admin and owner can (SP-25 default)", () => {
      for (const route of MUTATIONS) {
        expect({ route, ok: allowed("viewer", route) }).toEqual({ route, ok: false });
        for (const role of ["owner", "admin", "agent"] as const) {
          expect({ role, route, ok: allowed(role, route) }).toEqual({ role, route, ok: true });
        }
      }
    });

    it("viewer cannot delete a tag (confirmed or not); agent, admin and owner can", () => {
      const route = "DELETE /tags/:id";
      expect({ route, ok: allowed("viewer", route) }).toEqual({ route, ok: false });
      for (const role of ["owner", "admin", "agent"] as const) {
        expect({ role, route, ok: allowed(role, route) }).toEqual({ role, route, ok: true });
      }
    });

    it("none is blocked for impersonation", () => {
      for (const route of [...READS, ...MUTATIONS, "DELETE /tags/:id"]) {
        expect({ route, blocked: blockedForImpersonation(ROUTE_PERMISSIONS[route] as string) }).toEqual({ route, blocked: false });
      }
    });
  });

  // SP-09: ticket attachments, resolve and booking cards.
  describe("SP-09 ticket routes", () => {
    const VIEW = ["GET /tickets/:id/attachments", "GET /tickets/:id/attachments/:attId"];
    const CHANGE = [
      "GET /tickets/:id/attachments/candidates",
      "POST /tickets/:id/attachments",
      "POST /tickets/:id/attachments/upload",
      "DELETE /tickets/:id/attachments/:attId",
      "POST /tickets/:id/resolve",
    ];
    const BOOKINGS = "GET /tickets/:id/bookings";

    it("owner, admin and agent can view, attach, upload, unlink and resolve", () => {
      for (const route of [...VIEW, ...CHANGE]) {
        for (const role of ["owner", "admin", "agent"] as const) {
          expect({ role, route, ok: allowed(role, route) }).toEqual({ role, route, ok: true });
        }
      }
    });

    it("viewer can list and download, but not attach, upload, unlink or resolve", () => {
      for (const route of VIEW) expect({ route, ok: allowed("viewer", route) }).toEqual({ route, ok: true });
      for (const route of CHANGE) expect({ route, ok: allowed("viewer", route) }).toEqual({ route, ok: false });
    });

    it("every role with bookings.view reads the booking cards", () => {
      for (const role of ["owner", "admin", "agent", "viewer"] as const) {
        expect({ role, ok: allowed(role, BOOKINGS) }).toEqual({
          role,
          ok: hasPermission(SYSTEM_ROLES[role].permissions, "bookings.view"),
        });
        expect(allowed(role, BOOKINGS)).toBe(true);
      }
    });

    it("a custom role with tickets.update but not conversations.create can upload a ticket file (not a library file)", () => {
      const custom: PermissionsJson = { tickets: ["view", "update"] };
      expect(hasPermission(custom, ROUTE_PERMISSIONS["POST /tickets/:id/attachments/upload"] as string)).toBe(true);
      expect(hasPermission(custom, ROUTE_PERMISSIONS["POST /media/upload"] as string)).toBe(false);
    });

    it("impersonation is not blocked", () => {
      for (const route of [...VIEW, ...CHANGE, BOOKINGS]) {
        expect({ route, blocked: blockedForImpersonation(ROUTE_PERMISSIONS[route] as string) }).toEqual({ route, blocked: false });
      }
    });
  });

  // SP-10: the bookings catalog (ruling 12). The booking routes join in Task 2.
  describe("SP-10 booking routes", () => {
    const READ = ["GET /services", "GET /staff", "GET /bookings/availability", "GET /appointments/search"];
    const CATALOG_WRITES = [
      "POST /services",
      "PATCH /services/:id",
      "PUT /services/:id/staff",
      "GET /services/:id/delete-preview",
      "DELETE /services/:id",
      "POST /services/:id/restore",
      "POST /staff",
      "PATCH /staff/:id",
      "PUT /staff/:id/services",
      "GET /staff/:id/delete-preview",
      "DELETE /staff/:id",
      "POST /staff/:id/restore",
    ];
    const BOOKING_WORK = ["POST /appointments", "PATCH /appointments/:id", "DELETE /appointments/:id"];

    it("every role reads services, staff, availability and search; agent books, viewer cannot", () => {
      for (const role of ["owner", "admin", "agent", "viewer"] as const) {
        for (const route of [...READ, "GET /appointments", "GET /appointments/:id"]) {
          expect({ role, route, ok: allowed(role, route) }).toEqual({ role, route, ok: true });
        }
      }
      for (const role of ["owner", "admin", "agent"] as const) {
        for (const route of BOOKING_WORK) expect({ role, route, ok: allowed(role, route) }).toEqual({ role, route, ok: true });
      }
    });

    it("owner and admin manage the catalog", () => {
      for (const role of ["owner", "admin"] as const) {
        for (const route of [...READ, ...CATALOG_WRITES]) {
          expect({ role, route, ok: allowed(role, route) }).toEqual({ role, route, ok: true });
        }
      }
    });

    it("agent reads services and staff and books, but gets 403 on every catalog write", () => {
      for (const route of [...READ, ...BOOKING_WORK]) {
        expect({ route, ok: allowed("agent", route) }).toEqual({ route, ok: true });
      }
      for (const route of CATALOG_WRITES) {
        expect({ route, ok: allowed("agent", route) }).toEqual({ route, ok: false });
      }
    });

    it("viewer reads only", () => {
      for (const route of READ) expect({ route, ok: allowed("viewer", route) }).toEqual({ route, ok: true });
      for (const route of [...CATALOG_WRITES, ...BOOKING_WORK]) {
        expect({ route, ok: allowed("viewer", route) }).toEqual({ route, ok: false });
      }
    });

    it("a custom role with bookings.manage manages the catalog; bookings.update alone does not", () => {
      const manager: PermissionsJson = { bookings: ["view", "manage"] };
      const booker: PermissionsJson = { bookings: ["view", "create", "update", "delete"] };
      for (const route of CATALOG_WRITES) {
        expect(hasPermission(manager, ROUTE_PERMISSIONS[route] as string)).toBe(true);
        expect(hasPermission(booker, ROUTE_PERMISSIONS[route] as string)).toBe(false);
      }
    });

    // Import part (Task 3).
    const IMPORTS = [
      "POST /catalog-imports",
      "GET /catalog-imports",
      "GET /catalog-imports/:id",
      "PATCH /catalog-imports/:id/items",
      "POST /catalog-imports/:id/run",
      "POST /catalog-imports/:id/cancel",
    ];
    const TEMPLATE = "GET /catalog-imports/templates/:kind";

    it("owner and admin run imports; agent and viewer get 403 on every import route; all four download templates", () => {
      for (const route of IMPORTS) {
        expect(["owner", "admin", "agent", "viewer"].map((r) => [r, allowed(r as SystemRoleKey, route)])).toEqual([
          ["owner", true],
          ["admin", true],
          ["agent", false],
          ["viewer", false],
        ]);
      }
      for (const role of ["owner", "admin", "agent", "viewer"] as const) {
        expect({ role, ok: allowed(role, TEMPLATE) }).toEqual({ role, ok: true });
      }
    });

    it("impersonation is not blocked", () => {
      for (const route of [...READ, ...CATALOG_WRITES, ...IMPORTS, TEMPLATE]) {
        expect({ route, blocked: blockedForImpersonation(ROUTE_PERMISSIONS[route] as string) }).toEqual({ route, blocked: false });
      }
    });
  });

  // SP-17: media details and the agent switch (ruling 5).
  describe("SP-21 knowledge routes", () => {
    const READS = [
      "GET /knowledge/sources",
      "GET /knowledge/sources/:id",
      "GET /knowledge/sources/:id/preview",
      "GET /knowledge/sources/:id/pages",
      "GET /knowledge/sources/:id/file",
      "GET /knowledge/templates/:kind",
    ];
    const WRITES = [
      "PUT /knowledge/content",
      "PUT /knowledge/guidelines",
      "POST /knowledge/faqs",
      "PATCH /knowledge/faqs/:id",
      "POST /knowledge/faqs/reorder",
      "POST /knowledge/files",
      "POST /knowledge/sources/:id/reprocess",
      "DELETE /knowledge/sources/:id",
      // Task 2: websites.
      "POST /knowledge/websites/check",
      "POST /knowledge/websites",
      "PATCH /knowledge/websites/:id",
      "POST /knowledge/websites/:id/refresh",
    ];

    it("owner and admin do everything", () => {
      for (const role of ["owner", "admin"] as const) {
        for (const route of [...READS, ...WRITES]) expect({ role, route, ok: allowed(role, route) }).toEqual({ role, route, ok: true });
      }
    });

    it("agent and viewer read sources, previews, pages, files and templates; every write is 403", () => {
      for (const role of ["agent", "viewer"] as const) {
        for (const route of READS) expect({ role, route, ok: allowed(role, route) }).toEqual({ role, route, ok: true });
        for (const route of WRITES) expect({ role, route, ok: allowed(role, route) }).toEqual({ role, route, ok: false });
      }
    });

    it("impersonation is not blocked", () => {
      for (const route of [...READS, ...WRITES]) {
        expect({ route, blocked: blockedForImpersonation(ROUTE_PERMISSIONS[route] as string) }).toEqual({ route, blocked: false });
      }
    });
  });

  describe("SP-17 media details", () => {
    const PATCH = "PATCH /media/:id";

    it("permission map covers SP-17 routes", () => {
      expect(ROUTE_PERMISSIONS[PATCH]).toBe("knowledge.update");
      expect(ROUTE_PERMISSIONS["GET /media"]).toBe("conversations.view");
    });

    it("owner and admin can PATCH; agent and viewer cannot", () => {
      expect(["owner", "admin", "agent", "viewer"].map((r) => [r, allowed(r as SystemRoleKey, PATCH)])).toEqual([
        ["owner", true],
        ["admin", true],
        ["agent", false],
        ["viewer", false],
      ]);
    });

    it("all four can GET /media (with q and approved)", () => {
      for (const role of ["owner", "admin", "agent", "viewer"] as const) {
        expect({ role, ok: allowed(role, "GET /media") }).toEqual({ role, ok: true });
      }
    });

    it("impersonation is not blocked", () => {
      const imp = { user: { workspaceId: "ws1", impersonating: true } } as never;
      for (const route of [PATCH, "GET /media"]) {
        expect({ route, blocked: blockedForImpersonation(ROUTE_PERMISSIONS[route] as string) }).toEqual({ route, blocked: false });
      }
      expect(() => assertRequestPermission(imp, "knowledge.update")).not.toThrow();
    });
  });

  // SP-11: insights and the working home. Support part (Task 1); the sales
  // and home routes join in Tasks 2 and 3.
  describe("SP-11 insights and home routes", () => {
    const SUPPORT = "GET /insights/support";

    it("owner, admin, agent and viewer read the support insights (reports.view)", () => {
      expect(ROUTE_PERMISSIONS[SUPPORT]).toBe("reports.view");
      for (const role of ["owner", "admin", "agent", "viewer"] as const) {
        expect({ role, ok: allowed(role, SUPPORT) }).toEqual({ role, ok: true });
      }
    });

    it("a custom role without reports.view gets 403", () => {
      const noReports: PermissionsJson = { conversations: ["view", "update"], tickets: ["view"] };
      expect(hasPermission(noReports, ROUTE_PERMISSIONS[SUPPORT] as string)).toBe(false);
      expect(hasPermission({ ...noReports, reports: ["view"] }, ROUTE_PERMISSIONS[SUPPORT] as string)).toBe(true);
    });

    it("impersonation is not blocked", () => {
      expect(blockedForImpersonation(ROUTE_PERMISSIONS[SUPPORT] as string)).toBe(false);
      expect(blockedForImpersonation(ROUTE_PERMISSIONS[SALES] as string)).toBe(false);
    });

    // Home part (Task 3): every member reads the home; sections are filtered in the service.
    it("every member reads the home, marks it seen and dismisses the Day-1 home", () => {
      for (const route of ["GET /home", "POST /home/seen", "POST /home/day1/dismiss"]) {
        expect(ROUTE_PERMISSIONS[route]).toBe("authenticated");
        for (const role of ["owner", "admin", "agent", "viewer"] as const) {
          expect({ role, route, ok: allowed(role, route) }).toEqual({ role, route, ok: true });
        }
      }
    });

    // Sales part (Task 2).
    const SALES = "GET /insights/sales";

    it("owner, admin, agent and viewer read the sales insights (reports.view), and hold tickets.view for its sections", () => {
      expect(ROUTE_PERMISSIONS[SALES]).toBe("reports.view");
      for (const role of ["owner", "admin", "agent", "viewer"] as const) {
        expect({ role, ok: allowed(role, SALES) }).toEqual({ role, ok: true });
        expect({ role, tickets: hasPermission(SYSTEM_ROLES[role].permissions, "tickets.view") }).toEqual({ role, tickets: true });
      }
    });

    it("a custom role without reports.view gets 403 on sales; reports.view alone gets the route but not ticket sections", () => {
      const noReports: PermissionsJson = { conversations: ["view"], tickets: ["view"] };
      expect(hasPermission(noReports, ROUTE_PERMISSIONS[SALES] as string)).toBe(false);
      const reportsOnly: PermissionsJson = { reports: ["view"] };
      expect(hasPermission(reportsOnly, ROUTE_PERMISSIONS[SALES] as string)).toBe(true);
      expect(hasPermission(reportsOnly, "tickets.view")).toBe(false);
    });
  });

  // SP-24: Automatic messages (system workflows).
  describe("SP-24 lifecycle routes", () => {
    const VIEW = ["GET /lifecycle", "POST /lifecycle/sync"];
    const WRITE = ["POST /lifecycle/:key/setup", "PATCH /lifecycle/:key"];

    it("owner and admin can do everything", () => {
      for (const role of ["owner", "admin"] as const) {
        for (const route of [...VIEW, ...WRITE]) expect({ role, route, ok: allowed(role, route) }).toEqual({ role, route, ok: true });
      }
    });

    it("agent can view, set up and toggle", () => {
      for (const route of [...VIEW, ...WRITE]) expect({ route, ok: allowed("agent", route) }).toEqual({ route, ok: true });
    });

    it("viewer can view and sync but gets 403 on setup and patch", () => {
      for (const route of VIEW) expect({ route, ok: allowed("viewer", route) }).toEqual({ route, ok: true });
      for (const route of WRITE) expect({ route, ok: allowed("viewer", route) }).toEqual({ route, ok: false });
    });

    it("impersonation is not blocked", () => {
      for (const route of [...VIEW, ...WRITE]) {
        expect({ route, blocked: blockedForImpersonation(ROUTE_PERMISSIONS[route] as string) }).toEqual({ route, blocked: false });
      }
    });
  });

  // SP-26: invitations, handover, removal and the audit log.
  describe("SP-26 member routes", () => {
    const LIST = "GET /workspaces/:id/invitations";
    const WRITES = [
      "POST /workspaces/:id/invitations",
      "POST /workspaces/:id/invitations/:invId/resend",
      "DELETE /workspaces/:id/invitations/:invId",
      "GET /workspaces/:id/members/:userId/open-work",
      "POST /workspaces/:id/members/:userId/handover",
      "DELETE /workspaces/:id/members/:userId",
    ];
    const AUDIT = "GET /workspaces/:id/audit";
    const OWN = ["GET /auth/invitations", "POST /auth/invitations/accept", "GET /auth/workspaces/by-slug/:slug"];

    it("owner can do everything", () => {
      for (const route of [LIST, ...WRITES, AUDIT, ...OWN]) expect({ route, ok: allowed("owner", route) }).toEqual({ route, ok: true });
    });

    it("admin can invite, resend, revoke, see open work, hand over, remove and read the audit log", () => {
      for (const route of [LIST, ...WRITES, AUDIT]) expect({ route, ok: allowed("admin", route) }).toEqual({ route, ok: true });
      // ...but inviting into the owner role is refused in the service
      // (403 invitations.role_above_actor; members/invitations.service.spec.ts).
    });

    it("agent and viewer list invitations (members.view) but get 403 on every write and on audit", () => {
      for (const role of ["agent", "viewer"] as const) {
        expect({ role, ok: allowed(role, LIST) }).toEqual({ role, ok: true });
        for (const route of [...WRITES, AUDIT]) expect({ role, route, ok: allowed(role, route) }).toEqual({ role, route, ok: false });
      }
    });

    it("every signed-in user reaches their own invitations and the slug lookup", () => {
      for (const role of ["owner", "admin", "agent", "viewer"] as const) {
        for (const route of OWN) expect({ role, route, ok: allowed(role, route) }).toEqual({ role, route, ok: true });
      }
    });

    it("impersonator cannot remove a member", async () => {
      expect(blockedRouteForImpersonation("DELETE /workspaces/:id/members/:userId")).toBe(true);
      expect(blockedRouteForImpersonation("POST /workspaces/:id/members/:userId/2fa/reset")).toBe(true);
      const perms = { effective: jest.fn(), can: jest.fn() };
      const guard = new PermissionGuard(new Reflector(), perms as never);
      const run = (cls: Function, handler: Function) =>
        guard.canActivate({
          getType: () => "http",
          switchToHttp: () => ({ getRequest: () => ({ user: { sub: "support", workspaceId: "ws1", impersonating: true } }) }),
          getHandler: () => handler,
          getClass: () => cls,
        } as unknown as ExecutionContext);
      const err = await run(WorkspacesController, WorkspacesController.prototype.removeMember).catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.getResponse()).toMatchObject({ message: "Not allowed during impersonation" });
      // Reads and the other member routes stay open to a support session.
      await expect(run(WorkspacesController, WorkspacesController.prototype.openWork)).resolves.toBe(true);
      await expect(run(WorkspacesController, WorkspacesController.prototype.listMembers)).resolves.toBe(true);
      await expect(run(InvitationsController, InvitationsController.prototype.list)).resolves.toBe(true);
      await expect(run(InvitationsController, InvitationsController.prototype.revoke)).resolves.toBe(true);
      await expect(run(AuditController, AuditController.prototype.list)).resolves.toBe(true);
      expect(perms.effective).not.toHaveBeenCalled();
      for (const route of [LIST, ...WRITES, AUDIT]) {
        expect({ route, blocked: blockedForImpersonation(ROUTE_PERMISSIONS[route] as string) }).toEqual({ route, blocked: false });
      }
    });
  });

    it("billing.manage and roles.manage are owner-only", () => {
    expect(hasPermission(SYSTEM_ROLES.admin.permissions, "billing.manage")).toBe(false);
    expect(hasPermission(SYSTEM_ROLES.admin.permissions, "roles.manage")).toBe(false);
    expect(hasPermission(SYSTEM_ROLES.owner.permissions, "roles.manage")).toBe(true);
  });
});
