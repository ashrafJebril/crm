/**
 * SP-26 in-memory world for the members specs (not a runtime file; same
 * convention as src/insights/__fixtures__). The REAL PermissionService,
 * AuditService, InvitationsService and HandoverService run over the
 * channels/test-prisma double; email is a FakeEmailSender.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { makeFakePrisma } from "../../channels/test-prisma";
import { PermissionService } from "../../permissions/permission.service";
import { SYSTEM_ROLES, SYSTEM_ROLE_KEYS } from "../../permissions/system-roles";
import { AuditService } from "../../audit/audit.service";
import { FakeEmailSender } from "../../email/fake-email-sender";
import { InvitationsService } from "../invitations.service";
import { HandoverService } from "../handover.service";

export const WS = "ws1";
export const WS2 = "ws2";
export const NOW = new Date("2026-11-17T10:00:00.000Z");

export const U = {
  owner: "u_owner",
  admin: "u_admin",
  agent: "u_agent",
  viewer: "u_viewer",
  limited: "u_limited",
  other: "u_other", // a member of WS2 only
} as const;

const sysRole = (ws: string, key: (typeof SYSTEM_ROLE_KEYS)[number]) => ({
  id: `${ws}_r_${key}`,
  workspaceId: ws,
  key,
  name: SYSTEM_ROLES[key].name,
  nameAr: SYSTEM_ROLES[key].nameAr,
  isSystem: true,
  permissions: SYSTEM_ROLES[key].permissions,
  conversationVisibility: SYSTEM_ROLES[key].conversationVisibility,
  createdAt: NOW,
  updatedAt: NOW,
});

export const R = {
  owner: `${WS}_r_owner`,
  admin: `${WS}_r_admin`,
  agent: `${WS}_r_agent`,
  viewer: `${WS}_r_viewer`,
  /** Conversations and contacts, but no tickets.update. */
  limited: "r_limited",
  /** billing.manage: beyond an admin. */
  billing: "r_billing",
  temp: "r_temp",
};

const customRole = (id: string, name: string, permissions: Record<string, string[]>) => ({
  id,
  workspaceId: WS,
  key: null,
  name,
  nameAr: `${name} ar`,
  isSystem: false,
  permissions,
  conversationVisibility: "all",
  createdAt: NOW,
  updatedAt: NOW,
});

const user = (id: string, email: string, name: string) => ({
  id,
  email,
  name,
  password: "bcrypt-hash",
  role: "Agent",
  initials: name.slice(0, 2).toUpperCase(),
  color: "180",
  status: "offline",
  twoFA: false,
  isSuperAdmin: false,
  totpRecoveryHashes: [],
  sessionVersion: 0,
  createdAt: NOW,
  updatedAt: NOW,
});

const member = (id: string, userId: string, ws: string, role: string, roleId: string | null) => ({
  id,
  userId,
  workspaceId: ws,
  role,
  roleId,
  createdAt: NOW,
  updatedAt: NOW,
});

export function makeWorld() {
  const prisma = makeFakePrisma({
    workspace: [
      { id: WS, name: "Acme", slug: "acme", createdAt: NOW, updatedAt: NOW },
      { id: WS2, name: "Other Co", slug: "other-co", createdAt: NOW, updatedAt: NOW },
    ],
    role: [
      ...SYSTEM_ROLE_KEYS.map((k) => sysRole(WS, k)),
      ...SYSTEM_ROLE_KEYS.map((k) => sysRole(WS2, k)),
      customRole(R.limited, "Limited", { conversations: ["view", "update"], contacts: ["view", "update"] }),
      customRole(R.billing, "Billing", { billing: ["view", "manage"] }),
      customRole(R.temp, "Temp", { contacts: ["view"] }),
    ],
    user: [
      user(U.owner, "owner@acme.test", "Olivia Owner"),
      user(U.admin, "admin@acme.test", "Adam Admin"),
      user(U.agent, "agent@acme.test", "Aya Agent"),
      user(U.viewer, "viewer@acme.test", "Vic Viewer"),
      user(U.limited, "limited@acme.test", "Lee Limited"),
      user(U.other, "other@else.test", "Omar Other"),
    ],
    workspaceMember: [
      member("m_owner", U.owner, WS, "owner", R.owner),
      member("m_admin", U.admin, WS, "admin", R.admin),
      member("m_agent", U.agent, WS, "agent", R.agent),
      member("m_viewer", U.viewer, WS, "viewer", R.viewer),
      member("m_limited", U.limited, WS, "viewer", R.limited),
      member("m_other", U.other, WS2, "owner", `${WS2}_r_owner`),
    ],
    pipeline: [
      { id: "p_deals", workspaceId: WS, kind: "deals", name: "Sales" },
      { id: "p_leads", workspaceId: WS, kind: "leads", name: "Leads" },
      { id: "p_support", workspaceId: WS, kind: "support", name: "Support" },
    ],
    conversation: [],
    ticket: [],
    activity: [],
    contact: [],
    appointment: [],
    auditLog: [],
    invitation: [],
    notification: [],
  } as never);

  const permissions = new PermissionService(prisma);
  const audit = new AuditService(prisma);
  const email = new FakeEmailSender(true);
  const kewySync = { userCreated: jest.fn().mockResolvedValue(undefined) };
  const notifications = { notify: jest.fn().mockResolvedValue(1) };
  const realtime = { emitToWorkspace: jest.fn() };
  let clock = NOW;
  const invitations = new InvitationsService(prisma, permissions, audit, email, kewySync as never);
  invitations.now = () => clock;
  const handover = new HandoverService(prisma, permissions, audit, notifications as never, realtime as never);
  handover.now = () => clock;

  return {
    prisma,
    db: prisma.db as Record<string, any[]>,
    permissions,
    audit,
    email,
    kewySync,
    notifications,
    realtime,
    invitations,
    handover,
    setClock: (d: Date) => {
      clock = d;
    },
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

/** The token in an emailed (or copy-) link. */
export function tokenOf(linkOrText: string | undefined): string {
  const m = /token=([A-Za-z0-9_-]{43})/.exec(linkOrText ?? "");
  if (!m) throw new Error("no token in link");
  return m[1];
}

/** Like Postgres: a failed function transaction leaves no rows behind. */
export function withRollback(prisma: any): void {
  const base = prisma.$transaction;
  prisma.$transaction = jest.fn(async (arg: any, opts?: any) => {
    if (typeof arg !== "function") return base(arg, opts);
    const db = prisma.db as Record<string, any[]>;
    const saved = Object.fromEntries(Object.entries(db).map(([k, rows]) => [k, rows.map((r) => ({ ...r }))]));
    try {
      return await arg(prisma);
    } catch (e) {
      for (const k of Object.keys(db)) db[k] = (saved[k] ?? []).map((r) => ({ ...r }));
      throw e;
    }
  });
}
