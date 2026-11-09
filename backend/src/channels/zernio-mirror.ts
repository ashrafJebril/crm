import type { PrismaService } from "../prisma/prisma.service";
import type { ZernioAccount } from "../integrations/zernio.client";
import { accountHealth } from "../integrations/zernio-account-health";
import type { Channel } from "@prisma/client";
import {
  alignLegacyChannel,
  MERGED,
  revival,
  USER_DISCONNECTED,
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
 * `main` (their primary is sticky: see ZernioService.syncAccounts). An
 * Integration's legacy slot (its linked channel, or the unlinked
 * deterministic `chi_<integrationId>`) follows the Integration's current
 * account only when that is safe (`slotMove`):
 *  - while the slot's old account is still LISTED (healthy or not): only on
 *    strong identity — the same WhatsApp phone, or the same IG/FB/TikTok
 *    username. Display names never count (two numbers of one business share
 *    the verified name). No strong identifier → no move;
 *  - once the old account is ABSENT (or the slot is a Meta row switched to
 *    Zernio), unless the user disconnected it: re-point in place when the new
 *    account has no row of its own, else merge the slot's conversations into
 *    the Integration's current channel and retire the slot (`merged`).
 * This keeps `main`'s behaviour, where replies always followed the
 * Integration's pageId — including the accepted parity case "A deleted in
 * Zernio, a different B added → A's threads reply from B".
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
  // With no usable account list, every old account would look "absent":
  // never move or merge slots on such a response (same guard as step 5).
  const live = valid.length > 0 ? primaries.filter((p) => p?.id && p.pageId) : [];

  // 1. Decide, per legacy slot, before any row for the new account exists.
  const before = await prisma.channel.findMany({ where: { workspaceId, provider: "zernio" } });
  const hasRow = new Set(before.map((c) => c.externalId));
  const merges: Array<{ slot: Channel; p: IntegrationLike }> = [];
  for (const p of live) {
    const slots = await prisma.channel.findMany({
      where: { workspaceId, OR: [{ integrationId: p.id }, { id: `chi_${p.id}` }] },
    });
    for (const slot of slots) {
      const move = slotMove(slot, p, listed, hasRow);
      if (move === "merge") merges.push({ slot, p });
      if (move !== "inPlace") continue;
      await prisma.channel.updateMany({
        where: { integrationId: p.id, id: { not: slot.id } },
        data: { integrationId: null },
      });
      await prisma.channel.update({
        where: { id: slot.id },
        data: {
          provider: "zernio",
          externalId: p.pageId,
          kind: p.platform.toLowerCase(),
          integrationId: p.id,
          ...revival(slot, false),
        },
      });
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

  // 4. Merge retired slots into the Integration's current channel. Raw SQL so
  //    the inbox order (Conversation.updatedAt) is untouched.
  for (const { slot, p } of merges) {
    const target = await prisma.channel.findFirst({ where: { integrationId: p.id } });
    if (!target || target.id === slot.id || target.externalId !== p.pageId) continue;
    await prisma.$executeRaw`
      UPDATE "Conversation" SET "channelId" = ${target.id}
      WHERE "workspaceId" = ${workspaceId} AND "channelId" = ${slot.id}`;
    await prisma.channel.update({
      where: { id: slot.id },
      data: { status: "disconnected", statusReason: MERGED, disconnectedAt: new Date(), isDefault: false, integrationId: null },
    });
  }

  // 5. Mark accounts Zernio no longer lists (skipped on an empty list).
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

/** What happens to an Integration's legacy slot during a sync (see
 *  mirrorZernioAccounts). */
function slotMove(
  slot: Pick<Channel, "provider" | "externalId" | "kind" | "status" | "statusReason">,
  p: IntegrationLike,
  listed: Map<string, ZernioAccount>,
  hasRow: Set<string | null>,
): "keep" | "inPlace" | "merge" {
  if (!p.pageId) return "keep";
  if (slot.provider === "zernio" && slot.externalId === p.pageId) return "keep"; // aligned
  if (slot.status === "disconnected" && slot.statusReason === USER_DISCONNECTED) return "keep";
  if (slot.status === "disconnected" && slot.statusReason === MERGED) return "keep";
  const kind = p.platform.toLowerCase();
  if (slot.kind !== kind) return "keep";
  const old = slot.provider === "zernio" && slot.externalId ? listed.get(slot.externalId) : undefined;
  if (old) {
    // Old account still listed: move only when it provably is the same number.
    const a = strongIdentity(old, kind);
    const b = strongIdentity(listed.get(p.pageId), kind);
    if (!a || a !== b) return "keep";
  }
  return hasRow.has(p.pageId) ? "merge" : "inPlace";
}

/** A per-account identity that survives a re-auth: the WhatsApp phone (from
 *  the account metadata, when Zernio provides it) or the IG/FB/TikTok
 *  username. Never the display name. Null when there is none. */
export function strongIdentity(a: ZernioAccount | undefined, kind: string): string | null {
  if (!a) return null;
  if (kind === "whatsapp") {
    const m = (a.metadata ?? {}) as Record<string, unknown>;
    for (const k of ["phoneNumber", "displayPhoneNumber", "display_phone_number", "phone"]) {
      const v = m[k];
      if (typeof v === "string") {
        const digits = v.replace(/\D/g, "");
        if (digits.length >= 8) return digits;
      }
    }
    return null;
  }
  const u = a.username?.trim().toLowerCase().replace(/^@/, "");
  return u || null;
}
