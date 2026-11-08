import { SetMetadata } from "@nestjs/common";
import type { Action, Permission, Resource } from "./catalog";

export const REQUIRE_PERMISSION_KEY = "requirePermission";

/** Per-handler override of the route→permission map (permission-map.ts).
 *  PermissionGuard reads it first. Keep the map entry in agreement — the
 *  permission-map spec checks that the two match. */
export const RequirePermission = (resource: Resource, action: Action) =>
  SetMetadata(REQUIRE_PERMISSION_KEY, `${resource}.${action}` as Permission);
