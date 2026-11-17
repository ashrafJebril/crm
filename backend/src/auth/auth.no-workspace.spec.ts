import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcryptjs";
import { AuthService } from "./auth.service";

/** SP-26: login may return a 2FA challenge; these specs only cover sessions. */
type Session = Extract<Awaited<ReturnType<AuthService["login"]>>, { token: string }>;
type SessionAuth = Omit<AuthService, "login"> & { login: (...a: Parameters<AuthService["login"]>) => Promise<Session> };
/** SP-26 constructor deps: 2FA challenges and session versions. */
const sp26Deps = [{ challengeFor: jest.fn() } as never, { invalidate: jest.fn() } as never] as const;
import { WorkspacesService } from "../workspaces/workspaces.service";
import { seedWorkspaceDefaults } from "../workspaces/workspace-defaults";

jest.mock("../workspaces/workspace-defaults", () => ({
  ...jest.requireActual("../workspaces/workspace-defaults"),
  seedWorkspaceDefaults: jest.fn().mockResolvedValue(undefined),
}));
void seedWorkspaceDefaults;

const PASSWORD = "secret123";
const HASH = bcrypt.hashSync(PASSWORD, 4);

/** SP-26 ruling 6: login with no membership. */
function setup(opts: { pendingInvite?: boolean; removed?: boolean }) {
  process.env.AUTH_SOURCE = "local";
  const user = {
    id: "u1", email: "noor@example.com", name: "Noor", role: "Agent", initials: "N", color: "150",
    isSuperAdmin: false, password: HASH, kewyAccountId: null, memberships: [] as unknown[],
  };
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue(user) },
    invitation: { findFirst: jest.fn().mockResolvedValue(opts.pendingInvite ? { id: "i1" } : null) },
    auditLog: { findFirst: jest.fn().mockResolvedValue(opts.removed ? { id: "a1" } : null) },
  };
  const workspaces = { create: jest.fn().mockResolvedValue({ id: "ws-new", name: "Noor's workspace", slug: "n", timezone: "Asia/Riyadh", lang: "ar", plan: "free" }) };
  const jwt = new JwtService({ secret: "test" });
  const svc = new AuthService(prisma as never, jwt, workspaces as never, {} as never, { backfill: jest.fn() } as never, ...sp26Deps);
  return { svc: svc as unknown as SessionAuth, prisma, workspaces, jwt };
}

afterEach(() => {
  delete process.env.AUTH_SOURCE;
});

describe("login with no workspace (SP-26 ruling 6)", () => {
  it("login with no membership after removal returns no active workspace", async () => {
    const { svc, prisma, workspaces, jwt } = setup({ removed: true });
    const res = await svc.login({ email: "noor@example.com", password: PASSWORD });
    expect(res).toMatchObject({ activeWorkspaceId: null, workspaces: [] });
    expect(workspaces.create).not.toHaveBeenCalled();
    const claims = await jwt.verifyAsync(res.token);
    expect(claims.workspaceId).toBeUndefined();
    expect(prisma.auditLog.findFirst).toHaveBeenCalledWith({
      where: { action: "member.removed", targetKind: "member", targetId: "u1" },
      select: { id: true },
    });
  });

  it("a pending invitation also lands on the no-workspace page", async () => {
    const { svc, prisma, workspaces } = setup({ pendingInvite: true });
    const res = await svc.login({ email: "noor@example.com", password: PASSWORD });
    expect(res.activeWorkspaceId).toBeNull();
    expect(workspaces.create).not.toHaveBeenCalled();
    const where = prisma.invitation.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ email: "noor@example.com", acceptedAt: null, revokedAt: null });
    expect(where.expiresAt.gt).toBeInstanceOf(Date);
  });

  it("anyone else with no membership keeps today's auto-created workspace", async () => {
    const { svc, workspaces } = setup({});
    const res = await svc.login({ email: "noor@example.com", password: PASSWORD });
    expect(workspaces.create).toHaveBeenCalledWith({ name: "Noor's workspace" }, "u1");
    expect(res.activeWorkspaceId).toBe("ws-new");
  });

  it("register still auto-creates a workspace", async () => {
    // Even for an email with a pending invitation and a removal record.
    const users: Array<Record<string, unknown>> = [];
    const handle: any = {
      user: {
        findUnique: jest.fn(({ where }: any) => Promise.resolve(users.find((u) => u.email === where.email) ?? null)),
        create: jest.fn(({ data }: any) => {
          const u = { id: "u9", isSuperAdmin: false, ...data };
          users.push(u);
          return Promise.resolve(u);
        }),
      },
      workspace: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(({ data }: any) => Promise.resolve({ id: "w1", plan: "free", ...data })),
      },
      workspaceMember: {
        create: jest.fn(({ data }: any) => Promise.resolve(data)),
        findMany: jest.fn().mockResolvedValue([]),
      },
      invitation: { findFirst: jest.fn().mockResolvedValue({ id: "i1" }) },
      auditLog: { findFirst: jest.fn().mockResolvedValue({ id: "a1" }) },
      $transaction: jest.fn((fn: any) => fn(handle)),
    };
    const kewySync = { userCreated: jest.fn().mockResolvedValue(undefined) };
    const ws = new WorkspacesService(handle, kewySync as never, {} as never, { record: jest.fn() } as never, {} as never);
    const auth = new AuthService(handle, { signAsync: jest.fn().mockResolvedValue("tok") } as never, ws, {} as never, kewySync as never, ...sp26Deps);
    const res = await auth.register({ email: "new@example.com", password: "secret123", name: "New Person" } as never);
    expect(res.activeWorkspaceId).toBe("w1");
    expect(handle.workspace.create).toHaveBeenCalledTimes(1);
    expect(handle.workspaceMember.create).toHaveBeenCalledWith({ data: { userId: "u9", workspaceId: "w1", role: "owner" } });
    expect(handle.invitation.findFirst).not.toHaveBeenCalled();
  });
});

describe("issueFor and by-slug (SP-26)", () => {
  function make() {
    const prisma = {
      user: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: "u1", email: "a@b.co", name: "A", role: "Agent", initials: "A", color: "1", isSuperAdmin: false, password: "h", totpSecretEnc: "enc:v1:x" }) },
      workspace: { findUnique: jest.fn() },
      workspaceMember: { findUnique: jest.fn() },
    };
    const workspaces = { listForUser: jest.fn().mockResolvedValue([{ id: "ws2", name: "Two" }]) };
    const jwt = new JwtService({ secret: "test" });
    return { svc: new AuthService(prisma as never, jwt, workspaces as never, {} as never, {} as never, ...sp26Deps), prisma, jwt };
  }

  it("issueFor signs a session with the invited workspace active and no secrets", async () => {
    const { svc, jwt } = make();
    const res = await svc.issueFor("u1", "ws2");
    expect(res).toMatchObject({ activeWorkspaceId: "ws2", workspaces: [{ id: "ws2" }] });
    expect((await jwt.verifyAsync(res.token)).workspaceId).toBe("ws2");
    expect(JSON.stringify(res.user)).not.toMatch(/password|totp|enc:v1/);
  });

  it("by-slug: unknown 404, non-member { member: false } only, member gets id and name", async () => {
    const { svc, prisma } = make();
    prisma.workspace.findUnique.mockResolvedValueOnce(null);
    await expect(svc.workspaceBySlug("u1", "nope")).rejects.toMatchObject({ response: { message: "workspaces.slug_not_found" } });
    prisma.workspace.findUnique.mockResolvedValue({ id: "ws9", name: "Secret Co" });
    prisma.workspaceMember.findUnique.mockResolvedValueOnce(null);
    expect(await svc.workspaceBySlug("u1", "secret-co")).toEqual({ member: false });
    prisma.workspaceMember.findUnique.mockResolvedValueOnce({ workspaceId: "ws9" });
    expect(await svc.workspaceBySlug("u1", "secret-co")).toEqual({ id: "ws9", name: "Secret Co", member: true });
  });
});
