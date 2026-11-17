import type { Workspace } from "@/lib/types";

/**
 * SP-26 review M6: the workspace to show after adopting a new session (2FA
 * on/off reissues the token for the same workspace). The workspace on screen
 * stays when it is still one of the user's; otherwise the response's active
 * workspace, else the first one (when the response names one), else none.
 */
export function pickActiveWorkspace(
  currentId: string | null | undefined,
  res: { workspaces: Workspace[]; activeWorkspaceId: string | null },
): Workspace | null {
  const keep = currentId ? res.workspaces.find((w) => w.id === currentId) : undefined;
  if (keep) return keep;
  return res.workspaces.find((w) => w.id === res.activeWorkspaceId) ?? (res.activeWorkspaceId ? (res.workspaces[0] ?? null) : null);
}

export type SessionNoticeValue = "session_expired" | null;

/**
 * SP-26 review I1: the sign-in notice after a forced sign-out. Only
 * `auth.session_expired` sets it; any other (or a late) 401 keeps it.
 */
export function nextSessionNotice(prev: SessionNoticeValue, reason: string | undefined): SessionNoticeValue {
  return reason === "auth.session_expired" ? "session_expired" : prev;
}
