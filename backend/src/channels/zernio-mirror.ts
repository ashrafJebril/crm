import type { PrismaService } from "../prisma/prisma.service";
import type { ZernioAccount } from "../integrations/zernio.client";
import { accountHealth } from "../integrations/zernio-account-health";
import {
  alignLegacyChannel,
  ensureDefaultPerKind,
  initcap,
  isUniqueViolation,
  REVIVABLE_REASONS,
  ZERNIO_MISSING,
  type IntegrationLike,
} from "./legacy-mirror";

export { INTEGRATION_REMOVED, USER_DISCONNECTED, ZERNIO_MISSING } from "./legacy-mirror";

/**
 * Mirror a Zernio profile's accounts into Channels: one row per ACCOUNT
 * (`provider "zernio"`, `externalId = account._id`), not one per platform as
 * the legacy Integration does (ruling 2). Every Zernio account is mirrored
 * whatever the number limit — the limit gates only our own add flows.
 *
 * `primaries` are the Integration rows `syncAccounts` just upserted for
 * `main` (their primary is sticky: see ZernioService.syncAccounts). A legacy
 * slot is re-pointed IN PLACE to the primary — so its threads follow — only
 * when it looks like the same number re-authenticated (`canRepointInPlace`):
 * the new account has no row of its own, the platform matches, and the old
 * account is gone (not listed, or a Meta row being switched to Zernio) or
 * listed-but-unhealthy under the same name. Otherwise the per-account rows
 * are created first and the Integration is relinked to the primary's row;
 * the old slot keeps its threads on its old account. Number A's threads are
 * never moved onto a second number B.
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
  const listed = new Map(valid.map((a) => [a._id, a]));
  const live = primaries.filter((p) => p?.id && p.pageId);

  // 1. Same number re-authenticated (or switched Meta → Zernio): move the
  //    legacy slot in place before its new account could get a sibling row.
  const before = await prisma.channel.findMany({ where: { workspaceId, provider: "zernio" } });
  const hasRow = new Set(before.map((c) => c.externalId));
  for (const p of live) {
    const slot = await prisma.channel.findFirst({ where: { integrationId: p.id } });
    if (slot && canRepointInPlace(slot, p, listed, hasRow)) {
      await alignLegacyChannel(prisma, p, { allowInPlace: true });
      hasRow.add(p.pageId);
    }
  }

  // 2. One row per listed account (create or refresh).
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
    if (row.status === "disconnected" && !REVIVABLE_REASONS.has(row.statusReason ?? "")) continue;
    await prisma.channel.update({
      where: { id: row.id },
      data: { kind, displayName, status, statusReason: h.reason, disconnectedAt: null },
    });
  }

  // 3. Each Integration links its primary's row (relink or create); a slot
  //    that is not the same number stays on its old account.
  for (const p of live) await alignLegacyChannel(prisma, p, { allowInPlace: false });

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

/** Is `slot` (an Integration's legacy channel) the same number as the
 *  Integration's new primary, re-authenticated? See mirrorZernioAccounts. */
function canRepointInPlace(
  slot: { provider: string; externalId: string | null; kind: string },
  p: IntegrationLike,
  listed: Map<string, ZernioAccount>,
  hasRow: Set<string | null>,
): boolean {
  if (slot.provider === "zernio" && slot.externalId === p.pageId) return false; // already aligned
  if (!p.pageId || hasRow.has(p.pageId)) return false; // the new account has a row of its own
  if (slot.kind !== p.platform.toLowerCase()) return false;
  if (slot.provider !== "zernio" || !slot.externalId) return true; // Meta → Zernio switch
  const old = listed.get(slot.externalId);
  if (!old) return true; // the old account is gone
  if (accountHealth(old).health === "ok") return false; // still a working number
  // Listed but broken: only the same number signed in again (same name).
  const fresh = listed.get(p.pageId);
  const label = (a?: ZernioAccount) => (a?.username ?? a?.displayName ?? a?.name ?? "").trim().toLowerCase();
  return !!fresh && label(old) !== "" && label(old) === label(fresh);
}
