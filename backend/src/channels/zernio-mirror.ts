import type { PrismaService } from "../prisma/prisma.service";
import type { ZernioAccount } from "../integrations/zernio.client";
import { accountHealth } from "../integrations/zernio-account-health";
import { ensureDefaultPerKind, initcap, isUniqueViolation } from "./legacy-mirror";

/** statusReason of a channel disconnected because Zernio stopped listing it.
 *  Only these come back to life when the account reappears; a channel the
 *  user disconnected stays disconnected until an explicit reconnect. */
export const ZERNIO_MISSING = "zernio_account_missing";
/** statusReason of a channel the user disconnected (hub or legacy route). */
export const USER_DISCONNECTED = "disconnected_by_user";

/**
 * Mirror a Zernio profile's accounts into Channels: one row per ACCOUNT
 * (`provider "zernio"`, `externalId = account._id`), not one per platform as
 * the legacy Integration does (ruling 2). Accounts Zernio no longer lists are
 * marked disconnected. Every Zernio account is mirrored whatever the number
 * limit — the limit gates only our own add flows.
 *
 * `primaries` are the (platform → Integration) rows `syncAccounts` just
 * upserted for `main`; each Integration is linked to its primary account's
 * channel, so legacy credentials and null-channel threads follow the account
 * `main` itself sends from.
 */
export async function mirrorZernioAccounts(
  prisma: PrismaService,
  workspaceId: string,
  accounts: ZernioAccount[],
  primaries: Array<{ integrationId: string; accountId: string }>,
): Promise<void> {
  const existing = await prisma.channel.findMany({ where: { workspaceId, provider: "zernio" } });
  const byExternal = new Map(existing.map((c) => [c.externalId, c]));
  const listed: string[] = [];

  for (const a of accounts) {
    if (!a?._id || !a.platform) continue;
    listed.push(a._id);
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
    if (row.status === "disconnected" && row.statusReason !== ZERNIO_MISSING) continue;
    await prisma.channel.update({
      where: { id: row.id },
      data: { kind, displayName, status, statusReason: h.reason, disconnectedAt: null },
    });
  }

  await prisma.channel.updateMany({
    where: { workspaceId, provider: "zernio", status: { not: "disconnected" }, externalId: { notIn: listed } },
    data: { status: "disconnected", statusReason: ZERNIO_MISSING, disconnectedAt: new Date(), isDefault: false },
  });

  for (const p of primaries) {
    const target = await prisma.channel.findFirst({
      where: { workspaceId, provider: "zernio", externalId: p.accountId },
      select: { id: true, integrationId: true },
    });
    if (!target || target.integrationId === p.integrationId) continue;
    await prisma.channel.updateMany({
      where: { integrationId: p.integrationId, id: { not: target.id } },
      data: { integrationId: null },
    });
    await prisma.channel.update({ where: { id: target.id }, data: { integrationId: p.integrationId } });
  }

  await ensureDefaultPerKind(prisma, workspaceId);
}
