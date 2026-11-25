import type { Action, PermissionsJson, Resource } from "../permissions/catalog";
import { apiKeyError } from "./api-key-errors";

/** SP-27 ruling 1: the scope words stored on a key (Tkana's), mapped to the
 *  SP-25 catalogue actions. */
export const KEY_ACTIONS = ["read", "write", "delete", "admin"] as const;
export type KeyAction = (typeof KEY_ACTIONS)[number];

/** Ruling 3: what a key may ever hold. Never members, roles, billing,
 *  api_keys, settings, connectors, agent, knowledge, channels or workflows
 *  (keys must not mint keys, change people or money, or reconfigure the
 *  channels and the agent). */
export const KEY_RESOURCES = [
  "contacts",
  "conversations",
  "tickets",
  "pipelines",
  "bookings",
  "campaigns",
  "templates",
  "audiences",
  "reports",
] as const satisfies readonly Resource[];
export type KeyResource = (typeof KEY_RESOURCES)[number];

export type KeyScopes = Partial<Record<KeyResource, KeyAction[]>>;

const ACTION_MAP: Record<KeyAction, readonly Action[]> = {
  read: ["view"],
  write: ["view", "create", "update"],
  delete: ["delete"],
  admin: ["view", "create", "update", "delete", "manage"],
};

const RESOURCE_SET = new Set<string>(KEY_RESOURCES);
const ACTION_SET = new Set<string>(KEY_ACTIONS);

/** The catalogue permissions a (validated) scope set maps to. */
export function scopesToPermissions(scopes: KeyScopes): PermissionsJson {
  const out: PermissionsJson = {};
  for (const res of KEY_RESOURCES) {
    const acts = scopes[res];
    if (!acts?.length) continue;
    const set = new Set<Action>();
    for (const a of acts) for (const m of ACTION_MAP[a] ?? []) set.add(m);
    if (set.size) out[res] = [...set];
  }
  return out;
}

/**
 * Validates a scope object from a request or from the DB: an object of
 * allowed resources to non-empty, known action lists. Anything else is 400
 * `api_keys.scope_not_allowed`. Returns a normalised copy (deduplicated, in
 * KEY_ACTIONS order, empty resources dropped); at least one scope required.
 */
export function validateScopes(raw: unknown): KeyScopes {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw apiKeyError("api_keys.scope_not_allowed");
  const out: KeyScopes = {};
  for (const [res, acts] of Object.entries(raw as Record<string, unknown>)) {
    if (!RESOURCE_SET.has(res)) throw apiKeyError("api_keys.scope_not_allowed", { resource: res });
    if (!Array.isArray(acts) || acts.some((a) => typeof a !== "string" || !ACTION_SET.has(a))) {
      throw apiKeyError("api_keys.scope_not_allowed", { resource: res });
    }
    const set = new Set(acts as KeyAction[]);
    if (set.size) out[res as KeyResource] = KEY_ACTIONS.filter((a) => set.has(a));
  }
  if (Object.keys(out).length === 0) throw apiKeyError("api_keys.scope_not_allowed");
  return out;
}

/** Reads a stored scope object without throwing (a malformed row grants
 *  nothing). */
export function storedScopesToPermissions(raw: unknown): PermissionsJson {
  try {
    return scopesToPermissions(validateScopes(raw));
  } catch {
    return {};
  }
}
