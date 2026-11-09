import type { PrismaService } from "../prisma/prisma.service";
import type { ZernioAccount } from "../integrations/zernio.client";
import { accountHealth } from "../integrations/zernio-account-health";
import { alignLegacyChannel, ensureDefaultPerKind, initcap, isUniqueViolation, type IntegrationLike } from "./legacy-mirror";

/** statusReason of a channel disconnected because Zernio stopped listing it.
 *  Such rows come back to life when the account reappears. */
export const ZERNIO_MISSING = "zernio_account_missing";
/** statusReason of a channel the user disconnected in the hub. A plain
 *  resync never revives it; only a reconnect (a fresh or changed
 *  Integration link, or an explicit connect) does. */
export const USER_DISCONNECTED = "disconnected_by_user";
/** statusReason of a channel whose legacy Integration was deleted through the
 *  old Settings disconnect routes. Like `main` — where any later sync simply
 *  re-created the Integration — a sync that lists the account revives it. */
export const INTEGRATION_REMOVED = "integration_removed";

const REVIVABLE = new Set([ZERNIO_MISSING, INTEGRATION_REMOVED]);

/**
 * Mirror a Zernio profile's accounts into Channels: one row per ACCOUNT
 * (`provider "zernio"`, `externalId = account._id`), not one per platform as
 * the legacy Integration does (ruling 2). Every Zernio account is mirrored
 * whatever the number limit — the limit gates only our own add flows.
 *
 * `primaries` are the Integration rows `syncAccounts` just upserted for
 * `main`. Their legacy channels are aligned FIRST, so a re-auth onto a new
 * account id or a Meta→Zernio switch moves the existing channel (and its
 * threads) instead of spawning a sibling.
 *
 * Accounts Zernio no longer lists are marked disconnected — except when the
 * list is empty or carries no usable account, which is far more likely a bad
 * response than every account vanishing at once.
 */
export async function mirrorZernioAccounts(
  prisma: PrismaService,
  workspaceId: string,
  accounts: ZernioAccount[],
  primaries: IntegrationLike[],
): Promise<void> {
  const valid = (accounts ?? []).filter((a): a is ZernioAccount => !!a?._id && !!a.platform);

  for (const p of primaries) {
    if (p?.id) await alignLegacyChannel(prisma, p);
  }

  const existing = await prisma.channel.findMany({ where: { workspaceId, provider: "zernio" } });
  const byExternal = new Map(existing.map((c) => [c.externalId, c]));

  for (const a of valid) {
    const kind = a.platform.toLowerCase();
    const h = accountHealth(a);
    const status = h.health === "ok" ? "active" : "needs_attention";
    const displayName = a.displayName ?? a.username ?? a.name ?? initcap(kind);
    const row = byExternal.get(a._id);
    if (!row) {
      try {
        await prisma.channel.create({
          data: { workspaceId, kind, provider: "zernio", externalId: a._id, displayName, status, statusReason: h.reason },
        });
      } catch (e) {
        if (!isUniqueViolation(e)) throw e; // created concurrently (webhook + redirect sync)
      }
      continue;
    }
    if (row.status === "disconnected" && !REVIVABLE.has(row.statusReason ?? "")) continue;
    await prisma.channel.update({
      where: { id: row.id },
      data: { kind, displayName, status, statusReason: h.reason, disconnectedAt: null },
    });
  }

  if (valid.length > 0) {
    await prisma.channel.updateMany({
      where: {
        workspaceId,
        provider: "zernio",
        status: { not: "disconnected" },
        externalId: { notIn: valid.map((a) => a._id) },
      },
      data: { status: "disconnected", statusReason: ZERNIO_MISSING, disconnectedAt: new Date(), isDefault: false },
    });
  }

  await ensureDefaultPerKind(prisma, workspaceId);
}
