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

    it("@RequirePermission overrides agree with the map", () => {
    for (const r of routes) {
      const p = Reflect.getMetadata(REQUIRE_PERMISSION_KEY, r.handler) as string | undefined;
      if (p) expect({ key: r.key, p: ROUTE_PERMISSIONS[r.key] }).toEqual({ key: r.key, p });
    }
  });
});
