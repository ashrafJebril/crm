/** Impersonation (a support session: `impersonating`, NOT `isSuperAdmin` -
 *  AdminService.impersonateWorkspace deliberately omits it) bypasses every
 *  check except spending the tenant's money: billing.* and campaigns.manage
 *  (ads spend approval/rejection, campaign launch). Topping up the ads
 *  wallet is billing.update. */
export function blockedForImpersonation(permission: string): boolean {
  return permission.startsWith("billing.") || permission === "campaigns.manage";
}
