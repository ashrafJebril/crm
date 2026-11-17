import * as fs from "fs";
import * as path from "path";
import { MODULE_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { IS_PUBLIC_KEY } from "../auth/public.decorator";
import { ROUTE_PERMISSIONS, routesOf } from "./permission-map";
import { REQUIRE_PERMISSION_KEY } from "./require-permission.decorator";
import { ACTIONS, RESOURCES } from "./catalog";

// Some modules read secrets at import time (JwtModule.register in AuthModule).
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-permission-map-spec";

const SRC = path.resolve(__dirname, "..");

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts") && !e.name.endsWith(".d.ts") ? [p] : [];
  });
}

/** Every controller class in src: exported controllers, plus the ones that
 *  are only reachable through a module's `controllers` metadata (several
 *  *.module.ts files declare an unexported controller class). */
function collectControllers(): { classes: Set<Function>; declared: number } {
  const files = walk(SRC);
  const classes = new Set<Function>();
  let declared = 0;
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    const hasController = /@Controller\(/.test(text);
    if (hasController) declared += (text.match(/@Controller\(/g) ?? []).length;
    if (!hasController && !/@Module\(/.test(text)) continue;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(f) as Record<string, unknown>;
    for (const v of Object.values(mod)) {
      if (typeof v !== "function") continue;
      if (Reflect.getMetadata(PATH_METADATA, v) !== undefined) classes.add(v);
      const ctrls = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, v) as Function[] | undefined;
      for (const c of ctrls ?? []) classes.add(c);
    }
  }
  return { classes, declared };
}

describe("permission map", () => {
  const { classes, declared } = collectControllers();
  const routes = [...classes].flatMap((c) => routesOf(c));
  const keys = routes.map((r) => r.key);

  it("finds every declared controller", () => {
    expect(declared).toBeGreaterThanOrEqual(44);
    expect(classes.size).toBe(declared);
  });

  it("covers every route", () => {
    const missing = keys.filter((k) => !(k in ROUTE_PERMISSIONS));
    expect(missing).toEqual([]);
  });

  it("has no stale entries", () => {
    const known = new Set(keys);
    expect(Object.keys(ROUTE_PERMISSIONS).filter((k) => !known.has(k))).toEqual([]);
  });

  it("route keys are unique", () => {
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every value is public, authenticated or a catalog permission", () => {
    for (const [k, v] of Object.entries(ROUTE_PERMISSIONS)) {
      if (v === "public" || v === "authenticated") continue;
      const [res, act] = v.split(".");
      expect({ k, ok: (RESOURCES as readonly string[]).includes(res) && (ACTIONS as readonly string[]).includes(act) }).toEqual({ k, ok: true });
    }
  });

  it("marks exactly the @Public() routes public", () => {
    for (const r of routes) {
      const isPublic =
        Reflect.getMetadata(IS_PUBLIC_KEY, r.handler) === true ||
        Reflect.getMetadata(IS_PUBLIC_KEY, r.controller) === true;
      expect({ key: r.key, public: ROUTE_PERMISSIONS[r.key] === "public" }).toEqual({ key: r.key, public: isPublic });
    }
  });

  it("permission map covers SP-12 routes", () => {
    const sp12: Record<string, string> = {
      "GET /campaigns/:id/recipients": "campaigns.view",
      "GET /campaigns/:id/insights": "campaigns.view",
      "GET /campaigns/:id/export": "contacts.manage",
      "POST /campaigns/:id/export": "contacts.manage",
      "POST /campaigns/:id/follow-up/create-group": "audiences.create",
      "POST /campaigns/:id/follow-up/add-to-group": "audiences.update",
      "POST /campaigns/:id/follow-up/tag": "contacts.update",
    };
    for (const [k, p] of Object.entries(sp12)) {
      expect({ k, declared: keys.includes(k), p: ROUTE_PERMISSIONS[k] }).toEqual({ k, declared: true, p });
    }
  });

  it("permission map covers SP-13 routes", () => {
    const sp13: Record<string, string> = {
      "GET /campaigns/senders": "campaigns.view",
      "POST /campaigns/preview": "campaigns.view",
      // Unchanged and re-asserted.
      "GET /campaigns/preview": "campaigns.view",
      "GET /campaigns/:id": "campaigns.view",
      "POST /campaigns": "campaigns.create",
      "PATCH /campaigns/:id": "campaigns.update",
      "POST /campaigns/:id/launch": "campaigns.manage",
      "POST /campaigns/:id/cancel": "campaigns.manage",
      "POST /templates": "templates.create",
      "PATCH /templates/:id": "templates.update",
      "GET /media": "conversations.view",
      "POST /media/upload": "conversations.create",
    };
    for (const [k, p] of Object.entries(sp13)) {
      expect({ k, declared: keys.includes(k), p: ROUTE_PERMISSIONS[k] }).toEqual({ k, declared: true, p });
    }
    // The literal routes are declared before ":id" so they are never captured by it.
    const campaignRoutes = routes.filter((r) => r.key.startsWith("GET /campaigns/") || r.key.startsWith("POST /campaigns/"));
    const at = (k: string) => campaignRoutes.findIndex((r) => r.key === k);
    expect(at("GET /campaigns/senders")).toBeLessThan(at("GET /campaigns/:id"));
    expect(at("GET /campaigns/senders")).toBeGreaterThanOrEqual(0);
  });

  it("permission map covers SP-14 routes", () => {
    // Part 1 (Task 1): the live check. Part 2 (Task 2): the template-health routes.
    const sp14: Record<string, string> = {
      "POST /channels/:id/health/check": "channels.update",
      "GET /channels/:id/templates": "templates.view",
      "GET /templates/:id/health": "templates.view",
      // Reading the cached health stays on the channel DTO (channels.view).
      "GET /channels/:id": "channels.view",
      "GET /channels": "channels.view",
    };
    for (const [k, p] of Object.entries(sp14)) {
      expect({ k, declared: keys.includes(k), p: ROUTE_PERMISSIONS[k] }).toEqual({ k, declared: true, p });
    }
  });

  it("permission map covers SP-16 routes (part 1)", () => {
    const sp16: Record<string, string> = {
      "GET /segments/:id": "audiences.view",
      "GET /segments/:id/contacts": "audiences.view",
      "GET /segments/:id/count": "audiences.view",
      "GET /segments/:id/candidates": "audiences.view",
      // Unchanged and re-asserted.
      "GET /segments": "audiences.view",
      "POST /segments/preview": "audiences.view",
      "POST /segments": "audiences.create",
      "PATCH /segments/:id": "audiences.update",
      "DELETE /segments/:id": "audiences.delete",
      "GET /segments/:id/members": "audiences.view",
    };
    for (const [k, p] of Object.entries(sp16)) {
      expect({ k, declared: keys.includes(k), p: ROUTE_PERMISSIONS[k] }).toEqual({ k, declared: true, p });
    }
  });

  it("permission map covers SP-16 routes (part 2)", () => {
    const sp16: Record<string, string> = {
      "GET /tags/:id/references": "contacts.view",
      // `?confirm=1` does not change the route key (Global Constraints).
      "DELETE /tags/:id": "contacts.update",
      "DELETE /segments/:id": "audiences.delete",
      // Unchanged and re-asserted.
      "PATCH /tags/:id": "contacts.update",
      "POST /tags/merge": "contacts.update",
    };
    for (const [k, p] of Object.entries(sp16)) {
      expect({ k, declared: keys.includes(k), p: ROUTE_PERMISSIONS[k] }).toEqual({ k, declared: true, p });
    }
  });

  it("permission map covers SP-15 routes (part 2)", () => {
    const sp15: Record<string, string> = {
      "GET /ad-sources": "conversations.view",
      "GET /ad-sources/:id/conversations": "conversations.view",
      "GET /ad-sources/overview": "reports.view",
      "GET /ad-sources/:id": "reports.view",
      "GET /meta-ads/connection": "connectors.view",
      "GET /meta-ads/oauth/start": "connectors.manage",
      "GET /meta-ads/oauth/callback": "public",
      "GET /meta-ads/candidates": "connectors.manage",
      "POST /meta-ads/connection": "connectors.manage",
      "POST /meta-ads/check": "connectors.manage",
      "DELETE /meta-ads/connection": "connectors.manage",
    };
    for (const [k, p] of Object.entries(sp15)) {
      expect({ k, declared: keys.includes(k), p: ROUTE_PERMISSIONS[k] }).toEqual({ k, declared: true, p });
    }
    // `overview` is declared before `:id`, so it is never captured as an id.
    const ads = routes.filter((r) => r.key.startsWith("GET /ad-sources/"));
    const at = (k: string) => ads.findIndex((r) => r.key === k);
    expect(at("GET /ad-sources/overview")).toBeGreaterThanOrEqual(0);
    expect(at("GET /ad-sources/overview")).toBeLessThan(at("GET /ad-sources/:id"));
  });

  it("permission map covers SP-09 routes", () => {
    const sp09: Record<string, string> = {
      "GET /tickets/:id/attachments": "tickets.view",
      "GET /tickets/:id/attachments/candidates": "tickets.update",
      "POST /tickets/:id/attachments": "tickets.update",
      "POST /tickets/:id/attachments/upload": "tickets.update",
      "GET /tickets/:id/attachments/:attId": "tickets.view",
      "DELETE /tickets/:id/attachments/:attId": "tickets.update",
      "POST /tickets/:id/resolve": "tickets.update",
      "GET /tickets/:id/bookings": "bookings.view",
    };
    for (const [k, p] of Object.entries(sp09)) {
      expect({ k, declared: keys.includes(k), p: ROUTE_PERMISSIONS[k] }).toEqual({ k, declared: true, p });
    }
    // Route order: the literal segments are declared before `:attId`.
    const att = routes.filter((r) => r.key.includes("/tickets/:id/attachments"));
    const at = (k: string) => att.findIndex((r) => r.key === k);
    expect(at("GET /tickets/:id/attachments/candidates")).toBeLessThan(at("GET /tickets/:id/attachments/:attId"));
    expect(at("POST /tickets/:id/attachments/upload")).toBeGreaterThanOrEqual(0);
    expect(at("POST /tickets/:id/attachments/upload")).toBeLessThan(at("GET /tickets/:id/attachments/:attId"));
  });

  it("permission map covers SP-17 routes", () => {
    const sp17: Record<string, string> = {
      "PATCH /media/:id": "knowledge.update",
      // Unchanged: search and the approval filter ride on the library list.
      "GET /media": "conversations.view",
      "POST /mcp/v1": "public",
    };
    for (const [k, p] of Object.entries(sp17)) {
      expect({ k, declared: keys.includes(k), p: ROUTE_PERMISSIONS[k] }).toEqual({ k, declared: true, p });
    }
  });

  it("permission map covers SP-21 routes", () => {
    const sp21: Record<string, string> = {
      "GET /knowledge/sources": "knowledge.view",
      "GET /knowledge/sources/:id": "knowledge.view",
      "GET /knowledge/sources/:id/preview": "knowledge.view",
      "GET /knowledge/sources/:id/pages": "knowledge.view",
      "GET /knowledge/sources/:id/file": "knowledge.view",
      "GET /knowledge/templates/:kind": "knowledge.view",
      "PUT /knowledge/content": "knowledge.update",
      "PUT /knowledge/guidelines": "knowledge.update",
      "PATCH /knowledge/faqs/:id": "knowledge.update",
      "POST /knowledge/faqs/reorder": "knowledge.update",
      "POST /knowledge/sources/:id/reprocess": "knowledge.update",
      "POST /knowledge/faqs": "knowledge.create",
      "POST /knowledge/files": "knowledge.create",
      "DELETE /knowledge/sources/:id": "knowledge.delete",
      // Task 2: websites.
      "POST /knowledge/websites/check": "knowledge.create",
      "POST /knowledge/websites": "knowledge.create",
      "PATCH /knowledge/websites/:id": "knowledge.update",
      "POST /knowledge/websites/:id/refresh": "knowledge.update",
    };
    for (const [k, p] of Object.entries(sp21)) {
      expect({ k, declared: keys.includes(k), p: ROUTE_PERMISSIONS[k] }).toEqual({ k, declared: true, p });
    }
    // Every declared /knowledge route is in the table (the exact set, websites included).
    expect(keys.filter((k) => / \/knowledge(\/|$)/.test(k)).sort()).toEqual(Object.keys(sp21).sort());
    // Route order: faqs/reorder before faqs/:id.
    const kn = routes.filter((r) => r.key.includes(" /knowledge/faqs"));
    const at = (k: string) => kn.findIndex((r) => r.key === k);
    expect(at("POST /knowledge/faqs/reorder")).toBeLessThan(at("PATCH /knowledge/faqs/:id"));
    // websites/check before the :id routes.
    const web = routes.filter((r) => r.key.includes(" /knowledge/websites"));
    const w = (k: string) => web.findIndex((r) => r.key === k);
    expect(w("POST /knowledge/websites/check")).toBeLessThan(w("POST /knowledge/websites/:id/refresh"));
  });

  it("permission map covers SP-20 routes", () => {
    const sp20: Record<string, string> = {
      "GET /agent/settings": "agent.view",
      "PATCH /agent/settings": "agent.update",
      "POST /agent/settings/resync": "agent.update",
      // Ruling 3: the existing toggle also writes the local stop; unchanged.
      "POST /ai/settings/toggle": "agent.update",
      "GET /ai/settings": "agent.view",
      // Task 2: the sandbox (a turn costs money, ruling 9) and onboarding.
      "GET /agent/sandbox": "agent.update",
      "POST /agent/sandbox/messages": "agent.update",
      "DELETE /agent/sandbox": "agent.update",
      "GET /onboarding": "authenticated",
      "PATCH /onboarding": "settings.update",
      "POST /onboarding/website": "settings.update",
      "POST /onboarding/learn": "settings.update",
      "POST /onboarding/learn/apply": "settings.update",
      // Ruling 11: register stays public (a per-IP limiter guards it).
      "POST /auth/register": "public",
    };
    for (const [k, p] of Object.entries(sp20)) {
      expect({ k, declared: keys.includes(k), p: ROUTE_PERMISSIONS[k] }).toEqual({ k, declared: true, p });
    }
    // Every declared /agent and /onboarding route is in the table (the exact set).
    expect(keys.filter((k) => / \/(agent|onboarding)(\/|$)/.test(k)).sort()).toEqual(
      Object.keys(sp20)
        .filter((k) => / \/(agent|onboarding)(\/|$)/.test(k))
        .sort(),
    );
    // Route order: learn/apply is its own path, never shadowed.
    const ob = routes.filter((r) => r.key.includes(" /onboarding"));
    expect(ob.map((r) => r.key)).toContain("POST /onboarding/learn/apply");
  });

  it("permission map covers SP-10 routes (booking part)", () => {
    const sp10: Record<string, string> = {
      "GET /bookings/availability": "bookings.view",
      "GET /appointments/search": "bookings.view",
      // Existing rows unchanged.
      "GET /appointments": "bookings.view",
      "GET /appointments/:id": "bookings.view",
      "POST /appointments": "bookings.create",
      "PATCH /appointments/:id": "bookings.update",
      "DELETE /appointments/:id": "bookings.delete",
    };
    for (const [k, p] of Object.entries(sp10)) {
      expect({ k, declared: keys.includes(k), p: ROUTE_PERMISSIONS[k] }).toEqual({ k, declared: true, p });
    }
    expect(keys.filter((k) => / \/bookings(\/|$)/.test(k))).toEqual(["GET /bookings/availability"]);
    // Route order: search before :id.
    const appts = routes.filter((r) => r.key.startsWith("GET /appointments/"));
    const at = (k: string) => appts.findIndex((r) => r.key === k);
    expect(at("GET /appointments/search")).toBeLessThan(at("GET /appointments/:id"));
  });

  it("permission map covers SP-10 routes (import part)", () => {
    const sp10: Record<string, string> = {
      "POST /catalog-imports": "bookings.manage",
      "GET /catalog-imports": "bookings.manage",
      "GET /catalog-imports/templates/:kind": "bookings.view",
      "GET /catalog-imports/:id": "bookings.manage",
      "PATCH /catalog-imports/:id/items": "bookings.manage",
      "POST /catalog-imports/:id/run": "bookings.manage",
      "POST /catalog-imports/:id/cancel": "bookings.manage",
    };
    for (const [k, p] of Object.entries(sp10)) {
      expect({ k, declared: keys.includes(k), p: ROUTE_PERMISSIONS[k] }).toEqual({ k, declared: true, p });
    }
    expect(keys.filter((k) => k.includes("/catalog-imports")).sort()).toEqual(Object.keys(sp10).sort());
    // Route order: templates/:kind before :id.
    const imp = routes.filter((r) => r.key.startsWith("GET /catalog-imports/"));
    const at = (k: string) => imp.findIndex((r) => r.key === k);
    expect(at("GET /catalog-imports/templates/:kind")).toBeLessThan(at("GET /catalog-imports/:id"));
  });

  it("permission map covers SP-10 routes (catalog part)", () => {
    const sp10: Record<string, string> = {
      "GET /services": "bookings.view",
      "POST /services": "bookings.manage",
      "PATCH /services/:id": "bookings.manage",
      "PUT /services/:id/staff": "bookings.manage",
      "GET /services/:id/delete-preview": "bookings.manage",
      "DELETE /services/:id": "bookings.manage",
      "POST /services/:id/restore": "bookings.manage",
      "GET /staff": "bookings.view",
      "POST /staff": "bookings.manage",
      "PATCH /staff/:id": "bookings.manage",
      "PUT /staff/:id/services": "bookings.manage",
      "GET /staff/:id/delete-preview": "bookings.manage",
      "DELETE /staff/:id": "bookings.manage",
      "POST /staff/:id/restore": "bookings.manage",
    };
    for (const [k, p] of Object.entries(sp10)) {
      expect({ k, declared: keys.includes(k), p: ROUTE_PERMISSIONS[k] }).toEqual({ k, declared: true, p });
    }
    // Every declared catalog route is in the table above (nothing unmapped or extra).
    // (Booking part below.)
    const catalog = keys.filter((k) => / \/(services|staff)(\/|$)/.test(k)).sort();
    expect(catalog).toEqual(Object.keys(sp10).sort());
  });

  it("permission map covers SP-24 routes", () => {
    const sp24: Record<string, string> = {
      "GET /lifecycle": "workflows.view",
      "POST /lifecycle/:key/setup": "workflows.create",
      "PATCH /lifecycle/:key": "workflows.update",
      "POST /lifecycle/sync": "templates.view",
    };
    for (const [k, p] of Object.entries(sp24)) {
      expect({ k, declared: keys.includes(k), p: ROUTE_PERMISSIONS[k] }).toEqual({ k, declared: true, p });
    }
    expect(keys.filter((k) => / \/lifecycle(\/|$)/.test(k)).sort()).toEqual(Object.keys(sp24).sort());
    // Route order: sync before :key.
    const lc = routes.filter((r) => r.key.startsWith("POST /lifecycle/"));
    const at = (k: string) => lc.findIndex((r) => r.key === k);
    expect(at("POST /lifecycle/sync")).toBeLessThan(at("POST /lifecycle/:key/setup"));
  });

  it("permission map covers SP-11 routes (home part)", () => {
    for (const k of ["GET /home", "POST /home/seen", "POST /home/day1/dismiss"]) {
      expect({ k, declared: keys.includes(k), p: ROUTE_PERMISSIONS[k] }).toEqual({ k, declared: true, p: "authenticated" });
    }
    expect(keys.filter((k) => / \/home(\/|$)/.test(k)).sort()).toEqual(["GET /home", "POST /home/day1/dismiss", "POST /home/seen"]);
  });

  it("permission map covers SP-11 routes (sales part)", () => {
    expect({ declared: keys.includes("GET /insights/sales"), p: ROUTE_PERMISSIONS["GET /insights/sales"] }).toEqual({
      declared: true,
      p: "reports.view",
    });
  });

  it("permission map covers SP-11 routes (support part)", () => {
    expect({ declared: keys.includes("GET /insights/support"), p: ROUTE_PERMISSIONS["GET /insights/support"] }).toEqual({
      declared: true,
      p: "reports.view",
    });
    // Every declared insights route is mapped to reports.view.
    for (const k of keys.filter((x) => / \/insights(\/|$)/.test(x))) expect({ k, p: ROUTE_PERMISSIONS[k] }).toEqual({ k, p: "reports.view" });
  });

  it("permission map covers SP-26 routes", () => {
    const sp26: Record<string, string> = {
      "GET /workspaces/:id/invitations": "members.view",
      "POST /workspaces/:id/invitations": "members.create",
      "POST /workspaces/:id/invitations/:invId/resend": "members.create",
      "DELETE /workspaces/:id/invitations/:invId": "members.delete",
      "GET /invitations/preview": "public",
      "POST /invitations/accept": "public",
      "GET /auth/invitations": "authenticated",
      "POST /auth/invitations/accept": "authenticated",
      "GET /workspaces/:id/members/:userId/open-work": "members.delete",
      "POST /workspaces/:id/members/:userId/handover": "members.update",
      "DELETE /workspaces/:id/members/:userId": "members.delete",
      "GET /workspaces/:id/audit": "members.manage",
      "GET /auth/workspaces/by-slug/:slug": "authenticated",
      // Task 2: reset, two-step verification and the owner 2FA reset.
      "POST /auth/password/forgot": "public",
      "POST /auth/password/reset": "public",
      "POST /auth/2fa/verify": "public",
      "POST /auth/2fa/setup": "authenticated",
      "POST /auth/2fa/enable": "authenticated",
      "POST /auth/2fa/disable": "authenticated",
      "POST /workspaces/:id/members/:userId/2fa/reset": "members.manage",
    };
    for (const [k, p] of Object.entries(sp26)) {
      expect({ k, declared: keys.includes(k), p: ROUTE_PERMISSIONS[k] }).toEqual({ k, declared: true, p });
    }
    // Every declared invitation/audit route is in the table (nothing unmapped or extra).
    expect(keys.filter((k) => /\/(invitations|audit)(\/|$)/.test(k)).sort()).toEqual(
      Object.keys(sp26).filter((k) => /\/(invitations|audit)(\/|$)/.test(k)).sort(),
    );
    // Route order: open-work and handover sit before the :userId catch-alls.
    const ws = routes.filter((r) => r.key.includes("/workspaces/:id/members/:userId"));
    const at = (k: string) => ws.findIndex((r) => r.key === k);
    expect(at("GET /workspaces/:id/members/:userId/open-work")).toBeLessThan(at("PATCH /workspaces/:id/members/:userId"));
    expect(at("POST /workspaces/:id/members/:userId/handover")).toBeLessThan(at("DELETE /workspaces/:id/members/:userId"));
    expect(at("POST /workspaces/:id/members/:userId/2fa/reset")).toBeLessThan(at("PATCH /workspaces/:id/members/:userId"));
    // Every declared password/2FA route is in the table.
    expect(keys.filter((k) => /\/auth\/(password|2fa)\//.test(k)).sort()).toEqual(
      Object.keys(sp26).filter((k) => /\/auth\/(password|2fa)\//.test(k)).sort(),
    );
  });

    it("@RequirePermission overrides agree with the map", () => {
    for (const r of routes) {
      const p = Reflect.getMetadata(REQUIRE_PERMISSION_KEY, r.handler) as string | undefined;
      if (p) expect({ key: r.key, p: ROUTE_PERMISSIONS[r.key] }).toEqual({ key: r.key, p });
    }
  });
});
