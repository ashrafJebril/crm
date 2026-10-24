import {
  BadRequestException,
  HttpException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcryptjs";
import { AuthService } from "./auth.service";

const PASSWORD = "secret123";
const HASH = bcrypt.hashSync(PASSWORD, 4);

const workspace = {
  id: "ws1",
  name: "Salon Noor",
  slug: "salon-noor",
  timezone: "Asia/Riyadh",
  lang: "ar",
  plan: "free",
};

const localUser = (over: Record<string, unknown> = {}) => ({
  id: "u1",
  email: "noor@example.com",
  name: "Noor",
  role: "Owner",
  initials: "N",
  color: "150",
  isSuperAdmin: false,
  password: HASH,
  kewyAccountId: null as string | null,
  memberships: [{ role: "owner", workspace }],
  ...over,
});

const kewyOk = (over: Record<string, unknown> = {}) => ({
  kind: "ok" as const,
  status: 200,
  data: {
    accountId: "acc-1",
    matched: "account",
    account: { email: "noor@example.com", phone: null, name: "Noor", locale: "ar" },
    identities: [{ externalUserId: "u1", externalTenantId: null }],
    tenants: [
      {
        externalTenantId: "ws1",
        workspaceId: "kw1",
        active: true,
        packageName: "Growth",
        packageKind: "crm",
        enabledModules: ["inbox", "campaigns"],
        trialEndsAt: null,
      },
    ],
    ...over,
  },
});
const rejected = (status: number, code: string, extra: Record<string, unknown> = {}) => ({
  kind: "rejected" as const,
  status,
  code,
  ...extra,
});
const unreachable = { kind: "unreachable" as const, reason: "timeout after 5000ms" };

const flush = () => new Promise((r) => setImmediate(r));

function setup(mode: string, user: ReturnType<typeof localUser> | null = localUser()) {
  process.env.AUTH_SOURCE = mode;
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue(user),
      findMany: jest.fn().mockResolvedValue(user ? [user] : []),
      update: jest.fn().mockResolvedValue(user),
    },
    raw: {
      user: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      workspace: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    },
  };
  const workspaces = {
    create: jest.fn().mockResolvedValue({ ...workspace, id: "ws-new" }),
  };
  const kewy = { authenticate: jest.fn() };
  const kewySync = {
    backfill: jest.fn(),
    passwordChanged: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new AuthService(
    prisma as never,
    new JwtService({ secret: "test" }),
    workspaces as never,
    kewy as never,
    kewySync as never,
  );
  return { svc, prisma, kewy, kewySync, workspaces };
}

const dto = { email: " Noor@Example.com ", password: PASSWORD };

afterEach(() => {
  delete process.env.AUTH_SOURCE;
});

describe("AuthService.login — AUTH_SOURCE=local", () => {
  it("checks the local hash, never calls Kewy authenticate, and backfills", async () => {
    const { svc, kewy, kewySync } = setup("local");
    const res = await svc.login(dto, "1.2.3.4");
    expect(res.user.id).toBe("u1");
    expect(res.activeWorkspaceId).toBe("ws1");
    expect(res.workspaces).toEqual([{ ...workspace, role: "owner" }]);
    expect(typeof res.token).toBe("string");
    expect(kewy.authenticate).not.toHaveBeenCalled();
    expect(kewySync.backfill).toHaveBeenCalledWith(expect.objectContaining({ id: "u1" }));
  });

  it("is the default when AUTH_SOURCE is unset", async () => {
    const { svc, kewy } = setup("");
    await svc.login(dto);
    expect(kewy.authenticate).not.toHaveBeenCalled();
  });

  it("rejects a wrong password without backfilling", async () => {
    const { svc, kewySync } = setup("local");
    await expect(svc.login({ ...dto, password: "wrong-pw" })).rejects.toThrow(
      new UnauthorizedException("Invalid credentials"),
    );
    expect(kewySync.backfill).not.toHaveBeenCalled();
  });

  it("still rejects password-less SSO users", async () => {
    const { svc } = setup("local", localUser({ password: null }));
    await expect(svc.login(dto)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe.each(["kewy_with_fallback", "kewy"])("AuthService.login — AUTH_SOURCE=%s", (mode) => {
  it("signs in on Kewy success, forwarding the lowercased email and client IP", async () => {
    const { svc, kewy, prisma, kewySync } = setup(mode);
    kewy.authenticate.mockResolvedValue(kewyOk());
    const res = await svc.login({ ...dto, password: "kewy-password" }, "1.2.3.4");
    expect(kewy.authenticate).toHaveBeenCalledWith({
      identifier: "noor@example.com",
      password: "kewy-password",
      clientIp: "1.2.3.4",
    });
    expect(res.user.id).toBe("u1");
    expect(res.activeWorkspaceId).toBe("ws1");
    expect(prisma.user.findUnique).not.toHaveBeenCalled(); // no local password check
    expect(kewySync.backfill).not.toHaveBeenCalled();
    await flush();
    expect(prisma.raw.user.updateMany).toHaveBeenCalledWith({
      where: { id: "u1", kewyAccountId: null },
      data: { kewyAccountId: "acc-1" },
    });
    expect(prisma.raw.workspace.updateMany).toHaveBeenCalledWith({
      where: { id: "ws1" },
      data: { enabledModules: ["inbox", "campaigns"] },
    });
  });

  it("prefers a user Kewy linked over the email match", async () => {
    const { svc, kewy, prisma } = setup(mode);
    const byEmail = localUser({ id: "u-email" });
    const linked = localUser({ id: "u-linked", email: "other@example.com" });
    prisma.user.findMany.mockResolvedValue([byEmail, linked]);
    kewy.authenticate.mockResolvedValue(
      kewyOk({ identities: [{ externalUserId: "u-linked", externalTenantId: null }] }),
    );
    expect((await svc.login(dto)).user.id).toBe("u-linked");
  });

  it("falls back to the email match when no identity exists locally", async () => {
    const { svc, kewy } = setup(mode);
    kewy.authenticate.mockResolvedValue(kewyOk({ identities: [] }));
    expect((await svc.login(dto)).user.id).toBe("u1");
  });

  it("refuses an email match linked to a different Kewy account", async () => {
    const { svc, kewy } = setup(mode, localUser({ kewyAccountId: "acc-other" }));
    kewy.authenticate.mockResolvedValue(kewyOk({ identities: [] }));
    await expect(svc.login(dto)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("does not re-stamp kewyAccountId, and survives a stamp/cache failure", async () => {
    const { svc, kewy, prisma } = setup(mode, localUser({ kewyAccountId: "acc-1" }));
    kewy.authenticate.mockResolvedValue(kewyOk());
    prisma.raw.workspace.updateMany.mockRejectedValue(new Error("db down"));
    await expect(svc.login(dto)).resolves.toBeDefined();
    await flush();
    expect(prisma.raw.user.updateMany).not.toHaveBeenCalled();
  });

  it("skips caching an empty module list (NULL stays 'all modules')", async () => {
    const { svc, kewy, prisma } = setup(mode);
    kewy.authenticate.mockResolvedValue(
      kewyOk({ tenants: [{ externalTenantId: "ws1", enabledModules: [] }] }),
    );
    await svc.login(dto);
    await flush();
    expect(prisma.raw.workspace.updateMany).not.toHaveBeenCalled();
  });

  it("creates a workspace for a Kewy-authenticated user with no memberships", async () => {
    const { svc, kewy, workspaces } = setup(mode, localUser({ memberships: [] }));
    kewy.authenticate.mockResolvedValue(kewyOk());
    const res = await svc.login(dto);
    expect(workspaces.create).toHaveBeenCalledWith({ name: "Noor's workspace" }, "u1");
    expect(res.activeWorkspaceId).toBe("ws-new");
  });

  it("rejects when Kewy knows the account but crm has no such user", async () => {
    const { svc, kewy } = setup(mode, null);
    kewy.authenticate.mockResolvedValue(kewyOk());
    await expect(svc.login(dto)).rejects.toThrow(new UnauthorizedException("Invalid credentials"));
  });

  it.each([
    [401, "INVALID_CREDENTIALS"],
    [403, "ACCOUNT_DISABLED"],
  ])("maps %i %s to the local bad-credentials error and never falls back", async (status, code) => {
    const { svc, kewy, prisma } = setup(mode);
    kewy.authenticate.mockResolvedValue(rejected(status, code));
    // The local hash WOULD match — proving there is no fallback on a rejection.
    await expect(svc.login(dto)).rejects.toThrow(new UnauthorizedException("Invalid credentials"));
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("maps RATE_LIMITED to a 429", async () => {
    const { svc, kewy, prisma } = setup(mode);
    kewy.authenticate.mockResolvedValue(rejected(429, "RATE_LIMITED", { retryAfterSec: 90 }));
    const err = await svc.login(dto).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    expect((err as HttpException).getResponse()).toMatchObject({ retryAfterSec: 90 });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});

describe("AuthService.login — Kewy unreachable", () => {
  it("kewy_with_fallback: falls back to the local bcrypt check", async () => {
    const { svc, kewy, prisma, kewySync } = setup("kewy_with_fallback");
    kewy.authenticate.mockResolvedValue(unreachable);
    const res = await svc.login(dto);
    expect(res.user.id).toBe("u1");
    expect(prisma.user.findUnique).toHaveBeenCalled();
    expect(kewySync.backfill).not.toHaveBeenCalled();
  });

  it("kewy_with_fallback: the fallback still rejects a wrong password", async () => {
    const { svc, kewy } = setup("kewy_with_fallback");
    kewy.authenticate.mockResolvedValue(unreachable);
    await expect(svc.login({ ...dto, password: "wrong-pw" })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("kewy_with_fallback: a misconfigured call (bad secret) is treated as an outage", async () => {
    const { svc, kewy } = setup("kewy_with_fallback");
    kewy.authenticate.mockResolvedValue(rejected(401, "UNAUTHORIZED_PRODUCT"));
    expect((await svc.login(dto)).user.id).toBe("u1");
  });

  it("kewy: answers 503 and never checks locally", async () => {
    const { svc, kewy, prisma } = setup("kewy");
    kewy.authenticate.mockResolvedValue(unreachable);
    await expect(svc.login(dto)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});

describe("AuthService.changePassword dual-write", () => {
  it("writes Kewy before the local hash", async () => {
    const { svc, prisma, kewySync } = setup("kewy");
    const order: string[] = [];
    kewySync.passwordChanged.mockImplementation(async () => void order.push("kewy"));
    prisma.user.update.mockImplementation(async () => void order.push("local"));
    await svc.changePassword("u1", { currentPassword: PASSWORD, newPassword: "new-secret" });
    expect(order).toEqual(["kewy", "local"]);
    const newHash = kewySync.passwordChanged.mock.calls[0][1];
    expect(bcrypt.compareSync("new-secret", newHash)).toBe(true);
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: "u1" }, data: { password: newHash } });
  });

  it("keeps the local password when the strict Kewy write fails", async () => {
    const { svc, prisma, kewySync } = setup("kewy");
    kewySync.passwordChanged.mockRejectedValue(new ServiceUnavailableException());
    await expect(
      svc.changePassword("u1", { currentPassword: PASSWORD, newPassword: "new-secret" }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("accepts the user's Kewy password as the current one outside local", async () => {
    const { svc, kewy, kewySync } = setup("kewy_with_fallback");
    kewy.authenticate.mockResolvedValue(kewyOk());
    await svc.changePassword("u1", { currentPassword: "kewy-password", newPassword: "new-secret" });
    expect(kewySync.passwordChanged).toHaveBeenCalled();
  });

  it("does not ask Kewy in local mode", async () => {
    const { svc, kewy } = setup("local");
    await expect(
      svc.changePassword("u1", { currentPassword: "kewy-password", newPassword: "new-secret" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(kewy.authenticate).not.toHaveBeenCalled();
  });
});
