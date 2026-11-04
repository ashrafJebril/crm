import type { ZernioAccount } from "./zernio.client";

export type AccountHealth = { health: "ok"; reason: null } | { health: "reconnect"; reason: string };

/**
 * Whether a connected account still works on Zernio's side. Our Integration
 * row only records the moment it was connected; Meta can revoke access later
 * (metaDeletedAt) and the row would keep saying "Live" while every send fails.
 */
export function accountHealth(account: ZernioAccount | undefined): AccountHealth {
  if (!account) {
    return { health: "reconnect", reason: "This account is no longer connected in Zernio. Connect it again." };
  }
  const meta = (account.metadata ?? {}) as { metaDeletedAt?: string };
  if (meta.metaDeletedAt) {
    return {
      health: "reconnect",
      reason: `Meta removed access on ${meta.metaDeletedAt.slice(0, 10)}. Connect it again.`,
    };
  }
  if (account.needsReconnection) {
    return { health: "reconnect", reason: "The sign-in expired. Connect it again." };
  }
  if (account.platformStatus && account.platformStatus !== "active") {
    return { health: "reconnect", reason: `The platform reports it as ${account.platformStatus}. Connect it again.` };
  }
  if (account.isActive === false) {
    return { health: "reconnect", reason: "Zernio marked this account inactive. Connect it again." };
  }
  return { health: "ok", reason: null };
}
