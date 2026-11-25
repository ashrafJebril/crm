import { NotFoundException } from "@nestjs/common";

/**
 * SP-26 workspace routes (invitations, audit): `:id` must be the JWT
 * workspace. PermissionGuard checked the caller's permission there, and the
 * tenancy context is that workspace too, so a foreign :id is a 404 (it
 * reveals nothing about the other workspace). Super-admins switch first,
 * like everyone else: these models are not tenant-scoped.
 */
export function assertJwtWorkspace(id: string, user: { workspaceId?: string } | undefined): void {
  if (!user?.workspaceId || id !== user.workspaceId) {
    throw new NotFoundException({ statusCode: 404, message: "Workspace not found" });
  }
}
