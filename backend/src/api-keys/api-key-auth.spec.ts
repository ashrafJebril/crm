import "reflect-metadata";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Body, Controller, Get, HttpCode, INestApplication, Logger, Module, Post, ValidationPipe } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR, NestFactory } from "@nestjs/core";
import { JwtModule, JwtService } from "@nestjs/jwt";
import { PrismaService } from "../prisma/prisma.service";
import { AuthGuard } from "../auth/auth.guard";
import { PermissionGuard } from "../permissions/permission.guard";
import { PermissionService } from "../permissions/permission.service";
import { AuditService } from "../audit/audit.service";
import { PaymentLockService } from "../billing/payment-lock.service";
import { SessionVersionService } from "../auth/session-version.service";
import { WorkspaceInterceptor } from "../common/workspace.interceptor";
import { CurrentUserId, CurrentWorkspace } from "../common/current-workspace.decorator";
import { getWorkspaceContext } from "../common/workspace-context";
import { makeWorld, U, WS } from "../members/__fixtures__/members-world";
import { ApiKeysService, API_KEY_RPM } from "./api-keys.service";
import { ApiKeysController } from "./api-keys.controller";
import { hashApiKey } from "./api-key-format";

/**
 * SP-27 Review Focus 1, through the REAL AuthGuard + PermissionGuard (and
 * the WorkspaceInterceptor) on a Nest app over loopback HTTP, with small
 * controller doubles mapped like the real routes. The Prisma double replaces
 * the database; the real PermissionService, AuditService and ApiKeysService
 * run over it.
 */
const SECRET = "s".repeat(40);

@Controller("contacts")
class ContactsDouble {
  @Get()
  list(@CurrentWorkspace() ws: string) {
    return { items: [], ws };
  }
  @Post()
  create(@CurrentWorkspace() ws: string, @CurrentUserId() userId: string, @Body() body: { name?: string }) {
    const ctx = getWorkspaceContext();
    return { workspaceId: ws, createdById: userId, ctxUserId: ctx?.userId, apiKeyId: ctx?.apiKeyId, name: body.name };
  }
}

@Controller("auth")
class AuthDouble {
  @Get("me")
  me() {
    return { ok: true };
  }
}

@Controller("workspaces")
class WorkspacesDouble {
  @Post()
  create() {
    return { ok: true };
  }
}

/** The Inbox-only Zernio history import (API keys are refused before any permission). */
@Controller()
class ZernioImportDouble {
  @Post("integrations/zernio/db-conversations/:id/import-history")
  @HttpCode(200)
  importHistory() {
    return { imported: 0, skipped: 0 };
  }
}

const world = makeWorld();
const prisma: any = world.prisma;
prisma.db.apiKey = [];
prisma.raw = prisma;
const permissions = new PermissionService(prisma);
const audit = new AuditService(prisma);
const keys = new ApiKeysService(prisma, permissions, audit);

@Module({
  imports: [JwtModule.register({ global: true, secret: SECRET })],
  controllers: [ContactsDouble, AuthDouble, WorkspacesDouble, ZernioImportDouble, ApiKeysController],
  providers: [
    { provide: PrismaService, useValue: prisma },
    { provide: PermissionService, useValue: permissions },
    { provide: AuditService, useValue: audit },
    { provide: ApiKeysService, useValue: keys },
    { provide: PaymentLockService, useValue: { isLocked: async () => false } },
    { provide: SessionVersionService, useValue: { isCurrent: async () => true } },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    { provide: APP_INTERCEPTOR, useClass: WorkspaceInterceptor },
  ],
})
class KeyHttpModule {}

let app: INestApplication;
let base = "";
let jwt: JwtService;

beforeAll(async () => {
  app = await NestFactory.create(KeyHttpModule, { logger: false });
  app.setGlobalPrefix("api");
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  await app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
  jwt = app.get(JwtService);
}, 30_000);

afterAll(async () => {
  await app?.close();
});

const call = (method: string, path: string, token: string, body?: unknown) =>
  fetch(`${base}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const mint = async (userId: string, scopes: Record<string, string[]>, extra: Record<string, unknown> = {}) =>
  keys.create(WS, { userId }, { name: "Zapier", scopes, ...extra });

describe("API keys through the real guards", () => {
  it("key without contacts.write gets 403 on POST /contacts", async () => {
    const ro = await mint(U.owner, { contacts: ["read"] });
    expect((await call("GET", "/contacts", ro.key)).status).toBe(200);
    const denied = await call("POST", "/contacts", ro.key, { name: "A" });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ message: "Missing permission", permission: "contacts.create" });

    const rw = await mint(U.owner, { contacts: ["read", "write"] });
    const ok = await call("POST", "/contacts", rw.key, { name: "A" });
    expect(ok.status).toBe(201);
    // Acts as its creator: createdById names a real user; the context carries the key.
    expect(await ok.json()).toMatchObject({ workspaceId: WS, createdById: U.owner, ctxUserId: U.owner, apiKeyId: rw.id });
  });

  it("a key never exceeds its creator's CURRENT role", async () => {
    // Minted by the owner, later the creator is demoted to viewer (no contacts.create).
    const k = await mint(U.admin, { contacts: ["read", "write"] });
    expect((await call("POST", "/contacts", k.key, {})).status).toBe(201);
    const m = prisma.db.workspaceMember.find((x: any) => x.userId === U.admin && x.workspaceId === WS);
    const before = { role: m.role, roleId: m.roleId };
    m.role = "viewer";
    m.roleId = `${WS}_r_viewer`;
    permissions.invalidate(WS, U.admin);
    try {
      expect((await call("POST", "/contacts", k.key, {})).status).toBe(403);
      expect((await call("GET", "/contacts", k.key)).status).toBe(200);
    } finally {
      Object.assign(m, before);
      permissions.invalidate(WS, U.admin);
    }
  });

  it("key of a removed creator is 401", async () => {
    const k = await mint(U.limited, { contacts: ["read"] });
    expect((await call("GET", "/contacts", k.key)).status).toBe(200);
    const idx = prisma.db.workspaceMember.findIndex((x: any) => x.userId === U.limited && x.workspaceId === WS);
    const [row] = prisma.db.workspaceMember.splice(idx, 1);
    try {
      const r = await call("GET", "/contacts", k.key);
      expect(r.status).toBe(401);
      expect(await r.json()).toMatchObject({ message: "api_keys.invalid" });
    } finally {
      prisma.db.workspaceMember.push(row);
    }
  });

  it("revoked key is 401", async () => {
    const k = await mint(U.owner, { contacts: ["read"] });
    expect((await call("GET", "/contacts", k.key)).status).toBe(200);
    await keys.revoke(WS, { userId: U.owner }, k.id);
    const r = await call("GET", "/contacts", k.key);
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ message: "api_keys.invalid" });
  });

  it("expired key is 401", async () => {
    const soon = new Date(Date.now() + 60_000).toISOString();
    const k = await mint(U.owner, { contacts: ["read"] }, { expiresAt: soon });
    expect((await call("GET", "/contacts", k.key)).status).toBe(200);
    const row = prisma.db.apiKey.find((x: any) => x.id === k.id);
    row.expiresAt = new Date(Date.now() - 1000);
    const r = await call("GET", "/contacts", k.key);
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ message: "api_keys.invalid" });
    // Malformed and unknown keys get the very same answer (no oracle).
    for (const bad of ["crm_nothex", `crm_${"a".repeat(12)}_${"b".repeat(43)}`]) {
      const x = await call("GET", "/contacts", bad);
      expect({ bad, status: x.status, body: await x.json() }).toMatchObject({ bad, status: 401, body: { message: "api_keys.invalid" } });
    }
  });

  it("api key cannot call the Inbox-only history import, whatever its scopes; a session can", async () => {
    const k = await mint(U.owner, { conversations: ["admin"] });
    const path = "/integrations/zernio/db-conversations/cv1/import-history";
    const r = await call("POST", path, k.key, {});
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ message: "api_keys.route_not_allowed" });
    const session = await jwt.signAsync({ sub: U.owner, email: "o@x", role: "owner", workspaceId: WS });
    expect((await call("POST", path, session, {})).status).toBe(200);
  });

  it("api key cannot call auth or membership-exempt routes", async () => {
    const k = await mint(U.owner, { contacts: ["admin"] });
    for (const [method, path] of [
      ["GET", "/auth/me"],
      ["POST", "/workspaces"],
      ["GET", "/api-keys"],
      ["POST", "/api-keys"],
    ]) {
      const r = await call(method, path, k.key, method === "POST" ? {} : undefined);
      expect({ path, status: r.status }).toEqual({ path, status: 403 });
    }
    // The auth/workspace routes are refused as routes, before any permission.
    expect(await (await call("GET", "/auth/me", k.key)).json()).toMatchObject({ message: "api_keys.route_not_allowed" });
    expect(await (await call("POST", "/workspaces", k.key, {})).json()).toMatchObject({ message: "api_keys.route_not_allowed" });
    // A session still reaches them.
    const session = await jwt.signAsync({ sub: U.owner, email: "o@x", role: "owner", workspaceId: WS });
    expect((await call("GET", "/auth/me", session)).status).toBe(200);
  });

  it("a forged JWT claim cannot make a session look like a key (or vice versa)", async () => {
    const forged = await jwt.signAsync({
      sub: U.viewer,
      email: "v@x",
      role: "viewer",
      workspaceId: WS,
      apiKeyId: "k",
      apiKeyPermissions: { contacts: ["view", "create"] },
    });
    // Treated as the viewer's own session: no contacts.create.
    expect((await call("POST", "/contacts", forged, {})).status).toBe(403);
    expect((await call("GET", "/auth/me", forged)).status).toBe(200);
  });

  it("rate limit returns 429 with Retry-After", async () => {
    const k = await mint(U.owner, { contacts: ["read"] });
    for (let i = 0; i < API_KEY_RPM - 1; i++) keys.limiter.hit(k.id);
    expect((await call("GET", "/contacts", k.key)).status).toBe(200);
    const r = await call("GET", "/contacts", k.key);
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(await r.json()).toMatchObject({ message: "api_keys.rate_limited" });
  });

  it("key is never stored in plain text and never logged", async () => {
    const lines: string[] = [];
    const spies = (["log", "warn", "error", "debug", "verbose"] as const).flatMap((m) => [
      jest.spyOn(Logger.prototype, m).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" "))),
      jest.spyOn(Logger, m).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" "))),
    ]);
    const cons = (["log", "warn", "error", "info", "debug"] as const).map((m) =>
      jest.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" "))),
    );
    try {
      const k = await mint(U.owner, { contacts: ["read"] });
      const row = prisma.db.apiKey.find((x: any) => x.id === k.id);
      expect(row.hash).toBe(hashApiKey(k.key));
      expect(row.prefix).toBe(k.key.slice(0, 16));
      expect(JSON.stringify(row)).not.toContain(k.key);
      expect(JSON.stringify(row)).not.toContain(k.key.slice(17));
      // The list never returns the key or its hash.
      const listed = JSON.stringify(await keys.list(WS));
      expect(listed).not.toContain(k.key);
      expect(listed).not.toContain(row.hash);
      // Audit rows hold neither.
      expect(JSON.stringify(prisma.db.auditLog)).not.toContain(k.key.slice(17));
      expect(JSON.stringify(prisma.db.auditLog)).not.toContain(row.hash);
      // Requests that pass, fail and throw.
      await call("GET", "/contacts", k.key);
      await call("POST", "/contacts", k.key, {});
      await call("GET", "/auth/me", k.key);
      prisma.apiKey.updateMany.mockImplementationOnce(() => Promise.reject(new Error("db down")));
      (keys as any).lastWrite.clear();
      await call("GET", "/contacts", k.key);
      await keys.revoke(WS, { userId: U.owner }, k.id);
      const refused = await call("GET", "/contacts", k.key);
      expect(await refused.text()).not.toContain(k.key);
    } finally {
      for (const s of [...spies, ...cons]) s.mockRestore();
    }
    const all = lines.join("\n");
    expect(all).not.toMatch(/crm_[0-9a-f]{12}_/);
    expect(all).not.toMatch(/Bearer|authorization/i);
  });
});

describe("ApiKeysService", () => {
  it("scope above creator role is refused at mint", async () => {
    // An agent holds contacts view/create/update, not delete/manage.
    const err = await mint(U.agent, { contacts: ["admin"] }).catch((e) => e);
    expect(err.getStatus()).toBe(403);
    expect(err.getResponse()).toMatchObject({ message: "api_keys.scope_above_role" });
    // Within the role it is fine.
    await expect(mint(U.agent, { contacts: ["read", "write"] })).resolves.toMatchObject({ prefix: expect.stringMatching(/^crm_[0-9a-f]{12}$/) });
    // A non-member cannot mint at all.
    const outsider = await mint("u_other", { contacts: ["read"] }).catch((e) => e);
    expect(outsider.getResponse()).toMatchObject({ message: "api_keys.scope_above_role" });
  });

  it("disallowed resource is 400", async () => {
    for (const scopes of [{ members: ["read"] }, { api_keys: ["read"] }, { billing: ["admin"] }, { contacts: ["owner"] }, {}]) {
      const err = await mint(U.owner, scopes as never).catch((e) => e);
      expect({ scopes, status: err.getStatus(), message: err.getResponse().message }).toEqual({
        scopes,
        status: 400,
        message: "api_keys.scope_not_allowed",
      });
    }
    const past = await mint(U.owner, { contacts: ["read"] }, { expiresAt: "2001-01-01T00:00:00Z" }).catch((e) => e);
    expect(past.getResponse()).toMatchObject({ message: "api_keys.invalid_expiry" });
    const far = await mint(U.owner, { contacts: ["read"] }, { expiresAt: new Date(Date.now() + 3 * 365 * 864e5).toISOString() }).catch((e) => e);
    expect(far.getResponse()).toMatchObject({ message: "api_keys.invalid_expiry" });
  });

  it("lastUsedAt is written at most once per minute", async () => {
    const svc = new ApiKeysService(prisma, permissions, audit);
    let t = Date.parse("2026-11-18T10:00:00Z");
    svc.now = () => new Date(t);
    const k = await svc.create(WS, { userId: U.owner }, { name: "n", scopes: { contacts: ["read"] } });
    const writes = () =>
      prisma.apiKey.updateMany.mock.calls.filter((c: any[]) => c[0]?.where?.id === k.id && c[0]?.data?.lastUsedAt).length;
    await svc.authenticate(k.key);
    await svc.authenticate(k.key);
    t += 59_000;
    await svc.authenticate(k.key);
    expect(writes()).toBe(1);
    t += 2_000;
    await svc.authenticate(k.key);
    expect(writes()).toBe(2);
    expect(prisma.db.apiKey.find((x: any) => x.id === k.id).lastUsedAt).toEqual(new Date(t));
  });

  it("list shows status and creator; revoke is idempotent and a foreign id is 404", async () => {
    const k = await mint(U.owner, { tickets: ["read"] });
    await keys.revoke(WS, { userId: U.owner }, k.id);
    await expect(keys.revoke(WS, { userId: U.owner }, k.id)).resolves.toEqual({ ok: true });
    const item = (await keys.list(WS)).items.find((x) => x.id === k.id)!;
    expect(item).toMatchObject({ status: "revoked", createdBy: { id: U.owner, name: "Olivia Owner" }, scopes: { tickets: ["read"] } });
    expect(Object.keys(item)).not.toContain("hash");
    const err = await keys.revoke("ws2", { userId: U.owner }, k.id).catch((e) => e);
    expect(err.getStatus()).toBe(404);
    expect(prisma.db.auditLog.filter((a: any) => a.targetId === k.id).map((a: any) => a.action)).toEqual(["api_key.created", "api_key.revoked"]);
  });

  it("at most 25 active keys per workspace", async () => {
    const svc = new ApiKeysService(prisma, permissions, audit);
    const active = () => prisma.db.apiKey.filter((x: any) => x.workspaceId === WS && !x.revokedAt && (!x.expiresAt || x.expiresAt > new Date())).length;
    while (active() < 25) await svc.create(WS, { userId: U.owner }, { name: "n", scopes: { contacts: ["read"] } });
    const err = await svc.create(WS, { userId: U.owner }, { name: "n", scopes: { contacts: ["read"] } }).catch((e) => e);
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toMatchObject({ message: "api_keys.limit_reached" });
  });
});
