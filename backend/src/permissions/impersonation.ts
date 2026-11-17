/** Impersonation (a support session: `impersonating`, NOT `isSuperAdmin` -
 *  AdminService.impersonateWorkspace deliberately omits it) bypasses every
 *  check except spending the tenant's money: billing.* and campaigns.manage
 *  (ads spend approval/rejection, campaign launch). Topping up the ads
 *  wallet is billing.update. */
export function blockedForImpersonation(permission: string): boolean {
  return permission.startsWith("billing.") || permission === "campaigns.manage";
}

/** SP-26 (ruling 11): routes an impersonator may not call, whatever their
 *  permission. Removing a member and resetting someone's 2FA act on a real
 *  person's access; their permissions (members.delete, members.manage) are
 *  shared with routes support may use, so the block is per route. */
const BLOCKED_ROUTES = new Set([
  "DELETE /workspaces/:id/members/:userId",
  "POST /workspaces/:id/members/:userId/2fa/reset",
]);

export function blockedRouteForImpersonation(routeKey: string | undefined): boolean {
  return routeKey !== undefined && BLOCKED_ROUTES.has(routeKey);
}
