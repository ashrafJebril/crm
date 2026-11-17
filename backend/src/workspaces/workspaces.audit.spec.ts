import * as bcrypt from "bcryptjs";
import { WorkspacesService } from "./workspaces.service";
import { RolesService } from "../roles/roles.service";
import { makeWorld, R, U, WS } from "../members/__fixtures__/members-world";

function make() {
  const w = makeWorld();
  const kewySync = { passwordReset: jest.fn().mockResolvedValue(undefined), userCreated: jest.fn().mockResolvedValue(undefined) };
  const svc = new WorkspacesService(w.prisma, kewySync as never, w.permissions, w.audit, w.handover);
  return { ...w, svc, kewySync };
}

const audits = (w: ReturnType<typeof make>, action: string) => w.db.auditLog.filter((a) => a.action === action);

describe("WorkspacesService audit (SP-26)", () => {
  it("admin set password still works and is audited", async () => {
    const w = make();
    const res = await w.svc.resetMemberPassword(WS, U.agent, { password: "brand-new-pass" }, { userId: U.admin });
    expect(res).toMatchObject({ ok: true, user: { id: U.agent } });
    const user = w.db.user.find((u) => u.id === U.agent);
    expect(await bcrypt.compare("brand-new-pass", user.password)).toBe(true);
    expect(w.kewySync.passwordReset).toHaveBeenCalledTimes(1);
    const rows = audits(w, "member.password_set_by_admin");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workspaceId: WS, actorId: U.admin, targetKind: "member", targetId: U.agent });
    expect(JSON.stringify(rows)).not.toContain("brand-new-pass");
    expect(JSON.stringify(rows)).not.toContain(user.password);
  });

  it("role changes, additions, admin-created accounts and settings are audited", async () => {
    const w = make();
    await w.svc.updateMemberRole(WS, U.viewer, { roleId: R.agent }, { userId: U.owner });
    expect(audits(w, "member.role_changed")[0]).toMatchObject({
      actorId: U.owner,
      targetId: U.viewer,
      meta: { from: { role: "viewer", roleId: R.viewer }, to: { role: "agent", roleId: R.agent } },
    });

    await w.svc.addMember(WS, { userId: U.other, role: "viewer" }, { userId: U.owner });
    expect(audits(w, "member.added")[0]).toMatchObject({ targetId: U.other, meta: { role: "viewer" } });

    await w.svc.inviteByEmail(WS, { email: "made@x.test", role: "agent", name: "Made", password: "temp-pass-1" }, { userId: U.owner });
    const made = audits(w, "member.added")[1];
    expect(made.meta).toMatchObject({ email: "made@x.test", accountCreated: true });
    expect(JSON.stringify(made)).not.toContain("temp-pass-1");

    w.db.workspace[0].timezone = "Asia/Riyadh";
    await w.svc.update(WS, { name: "Acme 2" }, { userId: U.owner });
    expect(audits(w, "workspace.settings_updated")[0]).toMatchObject({ actorId: U.owner, targetKind: "workspace", targetId: WS, meta: { fields: ["name"] } });
  });

  it("removeMember delegates to the handover: open work needs handoverTo", async () => {
    const w = make();
    w.db.contact.push({ id: "c1", workspaceId: WS, ownerId: U.agent });
    const err = await w.svc.removeMember(WS, U.agent, { userId: U.owner }).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ message: "members.handover_required", openWork: { contacts: 1, total: 1 } });
    await expect(w.svc.removeMember(WS, U.agent, { userId: U.owner }, U.admin)).resolves.toMatchObject({ ok: true, moved: { contacts: 1 } });
    expect(w.db.contact[0].ownerId).toBe(U.admin);
  });

  it("role writes are audited (role.created, role.updated, role.deleted)", async () => {
    const w = make();
    const roles = new RolesService(w.prisma, w.permissions, w.audit);
    const owner = { userId: U.owner };
    const role = await roles.create(WS, { name: "Desk", nameAr: "مكتب", permissions: { contacts: ["view"] } } as never, owner);
    await roles.update(WS, role.id, { permissions: { contacts: ["view", "update"] } } as never, owner);
    await roles.remove(WS, role.id, owner);
    expect(w.db.auditLog.map((a) => [a.action, a.targetId, a.actorId])).toEqual([
      ["role.created", role.id, U.owner],
      ["role.updated", role.id, U.owner],
      ["role.deleted", role.id, U.owner],
    ]);
    expect(audits(w, "role.updated")[0].meta).toMatchObject({ fields: ["permissions"], permissions: { contacts: ["view", "update"] } });
  });
});
