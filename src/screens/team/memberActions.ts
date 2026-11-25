/**
 * SP-26 member row actions (pure). Hidden actions are not rendered.
 * While impersonating (support acting as a member), the irreversible ones,
 * Remove and the 2FA reset, are never offered (review M1).
 */
export type MemberAction = "handover" | "reset2fa" | "remove";

export function memberActions(o: {
  self: boolean;
  twoFA: boolean;
  impersonating: boolean;
  can: (permission: "members.update" | "members.manage" | "members.delete") => boolean;
}): MemberAction[] {
  if (o.self) return [];
  const out: MemberAction[] = [];
  if (o.can("members.update")) out.push("handover");
  if (!o.impersonating && o.twoFA && o.can("members.manage")) out.push("reset2fa");
  if (!o.impersonating && o.can("members.delete")) out.push("remove");
  return out;
}
