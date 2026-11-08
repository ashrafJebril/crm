import { BadRequestException } from "@nestjs/common";

/** Resources, exactly as in the tkana-parity roadmap §2.5. */
export const RESOURCES = [
  "conversations",
  "contacts",
  "tickets",
  "pipelines",
  "bookings",
  "campaigns",
  "templates",
  "audiences",
  "knowledge",
  "agent",
  "channels",
  "connectors",
  "members",
  "roles",
  "billing",
  "settings",
  "api_keys",
  "reports",
  // Controller ruling (SP-25): automations get their own resource.
  "workflows",
] as const;

export const ACTIONS = ["view", "create", "update", "delete", "manage"] as const;

export type Resource = (typeof RESOURCES)[number];
export type Action = (typeof ACTIONS)[number];
export type Permission = `${Resource}.${Action}`;
/** Stored shape of Role.permissions. */
export type PermissionsJson = Partial<Record<Resource, Action[]>>;

const RESOURCE_SET = new Set<string>(RESOURCES);
const ACTION_SET = new Set<string>(ACTIONS);

export function isPermission(p: string): p is Permission {
  const [res, act, ...rest] = p.split(".");
  return rest.length === 0 && RESOURCE_SET.has(res) && ACTION_SET.has(act);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validates user-supplied permissions JSON. Unknown resources or actions, or
 *  a malformed shape, are a 400. Returns a normalized copy: actions deduped
 *  and in ACTIONS order. */
export function validatePermissions(json: unknown): PermissionsJson {
  if (!isPlainObject(json)) {
    throw new BadRequestException("permissions must be an object of resource → actions");
  }
  const out: PermissionsJson = {};
  for (const [res, acts] of Object.entries(json)) {
    if (!RESOURCE_SET.has(res)) throw new BadRequestException(`Unknown resource: ${res}`);
    if (!Array.isArray(acts)) throw new BadRequestException(`Actions for ${res} must be an array`);
    for (const a of acts) {
      if (typeof a !== "string" || !ACTION_SET.has(a)) {
        throw new BadRequestException(`Unknown action for ${res}: ${String(a)}`);
      }
    }
    out[res as Resource] = ACTIONS.filter((a) => acts.includes(a));
  }
  return out;
}

/** Lenient read of a stored value: keeps only known resource/action pairs.
 *  Never throws — a bad row must degrade to fewer permissions, not a 500. */
export function sanitizePermissions(json: unknown): PermissionsJson {
  if (!isPlainObject(json)) return {};
  const out: PermissionsJson = {};
  for (const [res, acts] of Object.entries(json)) {
    if (!RESOURCE_SET.has(res) || !Array.isArray(acts)) continue;
    out[res as Resource] = ACTIONS.filter((a) => acts.includes(a));
  }
  return out;
}

/** Flattens `{ contacts: ["view"] }` into `["contacts.view"]`, in catalog order. */
export function flattenPermissions(p: PermissionsJson): Permission[] {
  const out: Permission[] = [];
  for (const r of RESOURCES) for (const a of p[r] ?? []) out.push(`${r}.${a}`);
  return out;
}
