import { InternalServerErrorException } from "@nestjs/common";
import { AsyncLocalStorage } from "node:async_hooks";

export interface WorkspaceStore {
  workspaceId: string;
  userId: string;
}

export const workspaceContext = new AsyncLocalStorage<WorkspaceStore>();

/** Get the current workspace context, or null if not inside a request scope. */
export function getWorkspaceContext(): WorkspaceStore | null {
  return workspaceContext.getStore() ?? null;
}

/** Throws an HTTP-aware exception when called outside a workspace-scoped
 *  request, so the failure surfaces with a clear message instead of a
 *  generic 500. */
export function requireWorkspaceContext(): WorkspaceStore {
  const ctx = getWorkspaceContext();
  if (!ctx) {
    throw new InternalServerErrorException(
      "Workspace context not set — caller must run inside a request scope",
    );
  }
  return ctx;
}
