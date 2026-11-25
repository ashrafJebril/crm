import { BadRequestException, NotFoundException } from "@nestjs/common";
import { makeFakePrisma } from "../channels/test-prisma";
import { AuditController } from "./audit.controller";
import { AuditService } from "./audit.service";
import { AUDIT_PAGE } from "../members/members-constants";
import { workspaceContext } from "../common/workspace-context";

const WS = "wsA";
const base = new Date("2026-11-17T00:00:00.000Z");

function world() {
  const prisma = makeFakePrisma({
    workspace: [
      { id: WS, name: "Acme" },
      { id: "wsB", name: "Other" },
    ],
    user: [
      { id: "u1", name: "Olivia", email: "o@x.test" },
      { id: "u2", name: "Adam", email: "a@x.test" },
    ],
    role: [{ id: "r1", workspaceId: WS, name: "Billing", nameAr: "x" }],
    invitation: [{ id: "i1", workspaceId: WS, email: "new@x.test" }],
    auditLog: [],
  } as never);
  return { prisma, audit: new AuditService(prisma) };
}

describe("AuditService (SP-26)", () => {
  it("SP-27: a write made through an API key is recorded as api_key with the key id", async () => {
    const { audit } = world();
    const tx = { auditLog: { create: jest.fn().mockResolvedValue({}) } };
    await workspaceContext.run({ workspaceId: WS, userId: "u1", apiKeyId: "k1" }, () =>
      audit.record(tx as never, { workspaceId: WS, actorId: "u1", action: "x", targetKind: "member", meta: { a: 1 } }),
    );
    expect(tx.auditLog.create.mock.calls[0][0].data).toMatchObject({ actorId: "u1", actorKind: "api_key", meta: { a: 1, apiKeyId: "k1" } });
    // Without a key (or for an explicit system actor) nothing changes.
    await audit.record(tx as never, { workspaceId: WS, actorId: "u1", action: "x", targetKind: "member" });
    expect(tx.auditLog.create.mock.calls[1][0].data).toMatchObject({ actorKind: "user" });
    await workspaceContext.run({ workspaceId: WS, userId: "u1", apiKeyId: "k1" }, () =>
      audit.record(tx as never, { workspaceId: WS, actorId: null, actorKind: "system", action: "x", targetKind: "member" }),
    );
    expect(tx.auditLog.create.mock.calls[2][0].data).toMatchObject({ actorKind: "system" });
  });

  it("record writes through the given transaction and strips secret-looking meta", async () => {
    const { prisma, audit } = world();
    const tx = { auditLog: { create: jest.fn().mockResolvedValue({}) } };
    await audit.record(tx, {
      workspaceId: WS,
      actorId: "u1",
      action: "member.added",
      targetKind: "member",
      targetId: "u2",
      meta: { role: "agent", password: "p", token: "t", tokenHash: "h", inviteLink: "l", code: "123456" },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: { workspaceId: WS, actorId: "u1", actorKind: "user", action: "member.added", targetKind: "member", targetId: "u2", meta: { role: "agent" } },
    });
    expect(prisma.db.auditLog).toHaveLength(0);
  });

  it("audit list pages by createdAt desc and filters by action", async () => {
    const { prisma, audit } = world();
    // 60 rows in WS (two share a timestamp: the id breaks the tie), plus noise in wsB.
    for (let i = 0; i < 60; i++) {
      prisma.db.auditLog.push({
        id: `a${String(i).padStart(3, "0")}`,
        workspaceId: WS,
        actorId: i % 2 ? "u1" : "u2",
        actorKind: "user",
        action: i % 3 === 0 ? "member.removed" : "invitation.created",
        targetKind: i % 3 === 0 ? "member" : "invitation",
        targetId: i % 3 === 0 ? "u2" : "i1",
        meta: null,
        createdAt: new Date(base.getTime() + Math.min(i, 58) * 1000),
      });
    }
    prisma.db.auditLog.push({ id: "zz", workspaceId: "wsB", actorId: "u1", actorKind: "user", action: "member.removed", targetKind: "member", targetId: "u2", meta: null, createdAt: new Date(base.getTime() + 999_000) });

    const p1 = await audit.list(WS, {});
    expect(p1.items).toHaveLength(AUDIT_PAGE);
    expect(p1.items[0].id).toBe("a059"); // same createdAt as a058: id desc
    expect(p1.items[1].id).toBe("a058");
    expect(p1.items.every((x) => x.id !== "zz")).toBe(true);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = await audit.list(WS, { cursor: p1.nextCursor as string });
    expect(p2.items).toHaveLength(10);
    expect(p2.nextCursor).toBeNull();
    const ids = [...p1.items, ...p2.items].map((x) => x.id);
    expect(new Set(ids).size).toBe(60);
    for (let i = 1; i < ids.length; i++) {
      const [a, b] = [p1.items.concat(p2.items)[i - 1], p1.items.concat(p2.items)[i]];
      expect(a.createdAt.getTime() > b.createdAt.getTime() || (a.createdAt.getTime() === b.createdAt.getTime() && a.id > b.id)).toBe(true);
    }

    const removed = await audit.list(WS, { action: "member.removed" });
    expect(removed.items).toHaveLength(20);
    expect(removed.items.every((x) => x.action === "member.removed")).toBe(true);
    expect(removed.items[0]).toMatchObject({ actor: { id: expect.any(String), name: expect.any(String) }, targetLabel: "Adam" });
    const invites = await audit.list(WS, { action: "invitation.created", actorId: "u1" });
    expect(invites.items.every((x) => x.actor?.id === "u1" && x.targetLabel === "new@x.test")).toBe(true);
    const ranged = await audit.list(WS, { from: new Date(base.getTime() + 10_000).toISOString(), to: new Date(base.getTime() + 19_000).toISOString() });
    expect(ranged.items).toHaveLength(10);
  });

  it("a bad cursor or date is 400", async () => {
    const { audit } = world();
    await expect(audit.list(WS, { cursor: "!!" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(audit.list(WS, { from: "nope" })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("the controller refuses another workspace's audit log (404)", async () => {
    const { prisma, audit } = world();
    prisma.db.auditLog.push({ id: "a1", workspaceId: WS, actorId: "u1", actorKind: "user", action: "member.removed", targetKind: "member", targetId: "u2", meta: null, createdAt: base });
    const ctl = new AuditController(audit);
    const fromB = { user: { sub: "u2", workspaceId: "wsB" } } as never;
    expect(() => ctl.list(WS, {}, fromB)).toThrow(NotFoundException);
    const res = await ctl.list(WS, {}, { user: { sub: "u1", workspaceId: WS } } as never);
    expect(res.items.map((x) => x.id)).toEqual(["a1"]);
    // Even a direct service call for B never returns A's rows.
    expect((await audit.list("wsB", {})).items).toEqual([]);
  });
});
