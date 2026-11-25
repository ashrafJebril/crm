import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useAuth } from "@/auth/context";
import type { ConversationVisibility, Permission } from "@/lib/permissions";

export interface MyPermissions {
  roleId: string | null;
  key: string | null;
  name: string;
  permissions: Permission[];
  conversationVisibility: ConversationVisibility;
}

/** Effective permissions for the active workspace. While loading (or on error)
 *  `can()` denies everything, so mutating controls never flash enabled. */
export function usePermissions(): {
  can: (p: Permission) => boolean;
  loading: boolean;
  visibility: ConversationVisibility;
  roleName: string | null;
} {
  const { activeWorkspace, status } = useAuth();
  const wsId = activeWorkspace?.id ?? null;
  const q = useQuery<MyPermissions, Error>({
    // workspace id in the key: switching workspaces refetches.
    queryKey: ["me", "permissions", wsId],
    queryFn: ({ signal }) => api.get<MyPermissions>("/me/permissions", signal),
    enabled: status === "authenticated" && wsId !== null,
    staleTime: 30_000,
  });
  const data = q.data;
  const flat = useMemo(() => new Set<string>(data?.permissions ?? []), [data]);
  const can = useMemo(() => (p: Permission) => flat.has(p), [flat]);
  return {
    can,
    loading: q.isPending,
    visibility: data?.conversationVisibility ?? "all",
    roleName: data?.name ?? null,
  };
}

export const NO_PERMISSION_EN = "You don't have permission to do this";
export const NO_PERMISSION_AR = "ليست لديك صلاحية للقيام بذلك";
