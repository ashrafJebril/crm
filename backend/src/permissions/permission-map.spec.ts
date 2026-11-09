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

  it("@RequirePermission overrides agree with the map", () => {
    for (const r of routes) {
      const p = Reflect.getMetadata(REQUIRE_PERMISSION_KEY, r.handler) as string | undefined;
      if (p) expect({ key: r.key, p: ROUTE_PERMISSIONS[r.key] }).toEqual({ key: r.key, p });
    }
  });
});
