import { ACTIONS, RESOURCES, type Action, type PermissionsJson, type Resource } from "./catalog";

export type SystemRoleKey = "owner" | "admin" | "agent" | "viewer";
export type ConversationVisibility = "all" | "assigned";

export interface SystemRoleDef {
  name: string;
  nameAr: string;
  permissions: PermissionsJson;
  conversationVisibility: ConversationVisibility;
}

export const SYSTEM_ROLE_KEYS: readonly SystemRoleKey[] = ["owner", "admin", "agent", "viewer"];

function matrix(grant: (r: Resource) => readonly Action[]): PermissionsJson {
  const out: PermissionsJson = {};
  for (const r of RESOURCES) out[r] = ACTIONS.filter((a) => grant(r).includes(a));
  return out;
}

const AGENT_WORK: readonly Resource[] = ["conversations", "contacts", "tickets", "bookings", "audiences"];
const AGENT_VIEW: readonly Resource[] = [
  "pipelines",
  "campaigns",
  "templates",
  "knowledge",
  "agent",
  "channels",
  "reports",
  "members",
];
const VIEWER_HIDDEN: readonly Resource[] = ["billing", "api_keys", "roles"];

/**
 * The four system roles — the single source of truth (plan Global
 * Constraints). backend/prisma/migrations/20261109180000_roles/migration.sql
 * seeds the same JSON; system-roles.spec.ts compares the two.
 */
export const SYSTEM_ROLES: Record<SystemRoleKey, SystemRoleDef> = {
  owner: {
    name: "Owner",
    nameAr: "المالك",
    permissions: matrix(() => ACTIONS),
    conversationVisibility: "all",
  },
  admin: {
    name: "Admin",
    nameAr: "المسؤول",
    permissions: matrix((r) =>
      r === "billing" || r === "roles" ? ACTIONS.filter((a) => a !== "manage") : ACTIONS,
    ),
    conversationVisibility: "all",
  },
  agent: {
    name: "Agent",
    nameAr: "الموظف",
    permissions: matrix((r) =>
      AGENT_WORK.includes(r) ? ["view", "create", "update"] : AGENT_VIEW.includes(r) ? ["view"] : [],
    ),
    conversationVisibility: "all",
  },
  viewer: {
    name: "Viewer",
    nameAr: "المشاهد",
    permissions: matrix((r) => (VIEWER_HIDDEN.includes(r) ? [] : ["view"])),
    conversationVisibility: "all",
  },
};

export function isSystemRoleKey(k: string): k is SystemRoleKey {
  return (SYSTEM_ROLE_KEYS as readonly string[]).includes(k);
}
