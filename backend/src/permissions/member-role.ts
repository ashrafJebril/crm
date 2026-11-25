/**
 * Pure resolution of a member's effective role row, mirroring
 * PermissionService.effective: a custom roleId always wins; a system roleId
 * that disagrees with the legacy `role` string is stale (the legacy string
 * wins); otherwise the workspace's system role for the legacy string.
 */
export interface RoleLike {
  id: string;
  key: string | null;
  isSystem: boolean;
  name: string;
  nameAr: string;
}

export function resolveMemberRole<R extends RoleLike>(
  member: { role: string; roleRef?: R | null },
  systemByKey: Map<string, R>,
): R | null {
  const legacy = (member.role ?? "").toLowerCase();
  const ref = member.roleRef ?? null;
  if (ref && (!ref.isSystem || ref.key === legacy)) return ref;
  return systemByKey.get(legacy) ?? null;
}

/** Effective-owner test that needs no role table lookup. */
export function isEffectiveOwner(member: {
  role: string;
  roleRef?: { isSystem: boolean } | null;
}): boolean {
  if (member.roleRef && !member.roleRef.isSystem) return false;
  return (member.role ?? "").toLowerCase() === "owner";
}
