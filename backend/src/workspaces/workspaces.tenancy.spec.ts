import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { tenancyExtension } from "../common/prisma-tenancy";
import { workspaceContext } from "../common/workspace-context";
import { PermissionService } from "../permissions/permission.service";
import { SYSTEM_ROLES, SYSTEM_ROLE_KEYS } from "../permissions/system-roles";
import { WorkspacesController } from "./workspaces.controller";
import { WorkspacesService } from "./workspaces.service";

/**
 * C1: a request whose tenancy context is workspace A, targeting workspace B.
 * The REAL tenancy extension handler runs over an in-memory store, so every
 * Role query is rewritten to workspace A exactly as in production.
 */

// Prisma.defineExtension(obj) returns `(client) => client.$extends(obj)`.
const def = (tenancyExtension as any)({ $extends: (d: unknown) => d });
const handler = def.query.$allModels.$allOperations as (p: {
  model: string;
  operation: string;
  args: any;
  query: (a: any) => Promise<unknown>;
}) => Promise<unknown>;

const sysRow = (ws: string, key: (typeof SYSTEM_ROLE_KEYS)[number]) => ({
  id: `${ws}_${key}`,
  workspaceId: ws,
  key,
  name: SYSTEM_ROLES[key].name,
  nameAr: SYSTEM_ROLES[key].nameAr,
  isSystem: true,
  permissions: SYSTEM_ROLES[key].permissions,
  conversationVisibility: "all",
});

function makePrisma() {
  // Workspace A has its system roles; workspace B's rows are unreachable
  // (the extension rewrites every Role read to A).
  const roles: any[] = SYSTEM_ROLE_KEYS.map((k) => sysRow("wsA", k));
  const members: any[] = [
    // the caller: a members-only custom role in B
    {
      id: "mB1", userId: "actor", workspaceId: "wsB", role: "viewer", roleId: "rc",
      roleRef: { id: "rc", workspaceId: "wsB", key: null, isSystem: false, name: "Mgr", nameAr: "x",
        permissions: { members: ["view", "create", "update", "delete"] }, conversationVisibility: "all" },
    },
    { id: "mB2", userId: "u2", workspaceId: "wsB", role: "viewer", roleId: null, roleRef: null },
    { id: "mA1", userId: "actor", workspaceId: "wsA", role: "owner", roleId: null, roleRef: null },
  ];
  const writes: string[] = [];
  const match = (row: any, where: any = {}) =>
    Object.entries(where).every(([k, v]) => (typeof v === "object" && v !== null ? true : row[k] === v));
  const roleOps: Record<string, (a: any) => Promise<unknown>> = {
    findFirst: async (a) => roles.find((r) => match(r, a.where)) ?? null,
    createMany: async (a) => {
      for (const d of a.data) {
        if (!roles.some((r) => r.workspaceId === d.workspaceId && r.key === d.key)) roles.push({ id: `new_${d.key}`, ...d });
      }
      return { count: 0 };
    },
  };
  const wrap = (model: string, ops: Record<string, (a: any) => Promise<unknown>>) =>
    Object.fromEntries(
      Object.entries(ops).map(([op, fn]) => [op, (args: any) => handler({ model, operation: op, args, query: fn })]),
    );
  const prisma: any = {
    role: wrap("Role", roleOps),
    workspaceMember: wrap("WorkspaceMember", {
      findUnique: async (a) => {
        const { userId, workspaceId } = a.where.userId_workspaceId;
        return members.find((m) => m.userId === userId && m.workspaceId === workspaceId) ?? null;
      },
      findMany: async () => [],
      count: async () => 0,
      update: async (a) => { writes.push("update"); return a; },
      create: async (a) => { writes.push("create"); return a; },
      delete: async (a) => { writes.push("delete"); return a; },
    }),
  };
  prisma.$transaction = (fn: any) => fn(prisma);
  return { prisma, writes };
}

const inA = <T>(fn: () => Promise<T>) => workspaceContext.run({ workspaceId: "wsA", userId: "actor" }, fn);

describe("C1: tenancy context A targeting workspace B", () => {
  it("the extension really rewrites the role lookup to A (sanity)", async () => {
    const { prisma } = makePrisma();
    const row: any = await inA(() => prisma.role.findFirst({ where: { workspaceId: "wsB", key: "admin" } }));
    expect(row.workspaceId).toBe("wsA");
  });

  it("controller: every member-management route refuses with 400 before any write", async () => {
    const { prisma, writes } = makePrisma();
    const perms = new PermissionService(prisma);
    const svc = new WorkspacesService(prisma, {} as never, perms, {} as never, {} as never);
    const ctl = new WorkspacesController(svc);
    const req = { user: { sub: "actor", workspaceId: "wsA" } } as never;
    const calls: Array<() => Promise<unknown>> = [
      () => ctl.updateMemberRole("wsB", "u2", { role: "admin" }, req),
      () => ctl.addMember("wsB", { userId: "u9", role: "admin" }, req),
      () => ctl.invite("wsB", { email: "x@y.co", role: "admin" }, req),
      () => ctl.resetMemberPassword("wsB", "u2", { password: "secret1" }, req),
      () => ctl.removeMember("wsB", "u2", req),
    ];
    for (const call of calls) {
      const err: any = await inA(call).catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toBe("Switch to this workspace first");
    }
    expect(writes).toEqual([]);
  });

  it("service: the grant check never falls back to an empty permission set", async () => {
    // Even if a caller reaches the service, the rewritten (foreign) role row
    // is discarded and SYSTEM_ROLES.admin is what gets checked.
    const { prisma, writes } = makePrisma();
    const perms = new PermissionService(prisma);
    const svc = new WorkspacesService(prisma, {} as never, perms, {} as never, {} as never);
    const err: any = await inA(() => svc.updateMemberRole("wsB", "u2", { role: "admin" }, { userId: "actor" })).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.message).toBe("Cannot grant permissions you don't have");
    expect(writes).toEqual([]);
  });
});
