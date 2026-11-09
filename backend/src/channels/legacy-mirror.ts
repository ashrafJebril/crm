import { Logger } from "@nestjs/common";
import type { Channel } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";

/**
 * Legacy Integration → Channel mirroring.
 *
 * `main` still writes `Integration` (one row per platform per workspace). Each
 * Integration owns exactly one Channel (`integrationId`): its "legacy slot".
 * The migration SQL backfills existing rows; `ensureLegacyChannels` mirrors
 * rows written after it. Both use the SAME mapping — `channelFromIntegration`
 * is the TS copy of the SQL INSERT in 20261112120000_channels, pinned by
 * legacy-mirror.spec.ts.
 *
 * The slot follows its Integration (`alignLegacyChannel`): when `main` re-points
 * the row (Zernio re-auth, Meta↔Zernio switch, new pageId) the SAME channel is
 * updated in place, so stamped conversations keep replying and new inbound
 * keeps landing in them. A fresh link (reconnect after a legacy disconnect)
 * or an identity change reactivates the channel.
 */

const log = new Logger("LegacyChannelMirror");

export interface IntegrationLike {
  id: string;
  workspaceId: string;
  platform: string;
  provider: string;
  pageId: string | null;
  pageName: string | null;
  createdAt: Date;
}

/** Postgres `initcap`: first letter of each alphanumeric run upper, rest lower. */
export function initcap(s: string): string {
  return s.toLowerCase().replace(/(^|[^a-z0-9])([a-z])/g, (_m, sep: string, c: string) => sep + c.toUpperCase());
}

/** The Channel row the migration creates for an Integration (minus isDefault). */
export function channelFromIntegration(i: IntegrationLike) {
  return {
    id: `chi_${i.id}`,
    workspaceId: i.workspaceId,
    kind: i.platform.toLowerCase(),
    provider: i.provider,
    externalId: i.pageId,
    displayName: i.pageName !== null && i.pageName !== "" ? i.pageName : initcap(i.platform),
    status: "active" as const,
    integrationId: i.id,
    createdAt: i.createdAt,
  };
}

export function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: unknown } | null)?.code === "P2002";
}

/** Clears a disconnect: the shape every reactivation writes. */
const REVIVE = { status: "active", statusReason: null, disconnectedAt: null } as const;

/**
 * Make the Integration's legacy channel match the Integration.
 *  - linked, same identity: unchanged (an `explicit` user connect revives a
 *    disconnected row; a plain resync never does);
 *  - linked, identity changed, no other row has the new identity: updated IN
 *    PLACE (provider/externalId) and reactivated;
 *  - a row with the new identity exists (a genuine other number became the
 *    primary, or the reconnected number's old row): the link moves to it and
 *    it is reactivated; the old slot keeps its threads;
 *  - nothing: create the deterministic `chi_` row.
 * Callers run `ensureDefaultPerKind` afterwards.
 */
export async function alignLegacyChannel(
  prisma: PrismaService,
  i: IntegrationLike,
  opts: { explicit?: boolean } = {},
): Promise<Channel | null> {
  const want = channelFromIntegration(i);
  const linked = await prisma.channel.findFirst({ where: { integrationId: i.id } });
  if (linked && linked.provider === want.provider && linked.externalId === want.externalId) {
    if (opts.explicit && linked.status === "disconnected") {
      return prisma.channel.update({ where: { id: linked.id }, data: { ...REVIVE } });
    }
    return linked;
  }
  const twin = want.externalId
    ? await prisma.channel.findFirst({
        where: { workspaceId: i.workspaceId, provider: want.provider, externalId: want.externalId },
      })
    : null;
  if (linked && !twin) {
    try {
      return await prisma.channel.update({
        where: { id: linked.id },
        data: { provider: want.provider, externalId: want.externalId, kind: want.kind, ...REVIVE },
      });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e; // a twin appeared concurrently: relink below
    }
  }
  const target =
    twin ??
    (want.externalId
      ? await prisma.channel.findFirst({
          where: { workspaceId: i.workspaceId, provider: want.provider, externalId: want.externalId },
        })
      : null);
  if (target) {
    await prisma.channel.updateMany({
      where: { integrationId: i.id, id: { not: target.id } },
      data: { integrationId: null },
    });
    return prisma.channel.update({ where: { id: target.id }, data: { integrationId: i.id, ...REVIVE } });
  }
  const hasDefault = await prisma.channel.findFirst({
    where: { workspaceId: i.workspaceId, kind: want.kind, isDefault: true },
    select: { id: true },
  });
  for (const isDefault of hasDefault ? [false] : [true, false]) {
    try {
      return await prisma.channel.create({ data: { ...want, isDefault } });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
  }
  // Lost every race: a concurrent caller mirrored it. Fine when it exists.
  const now = await prisma.channel.findFirst({ where: { integrationId: i.id } });
  if (!now) log.warn(`could not mirror integration ${i.id} (${want.kind}/${want.provider}) — will retry`);
  else log.debug(`integration ${i.id} was mirrored concurrently`);
  return now;
}

/**
 * Mirror every Integration of the workspace that has no Channel yet. Costs one
 * indexed query when there is nothing to do. Returns how many were mirrored
 * (created or linked).
 */
export async function ensureLegacyChannels(prisma: PrismaService, workspaceId: string): Promise<number> {
  const missing = (await prisma.integration.findMany({
    where: { workspaceId, channel: { is: null } },
  })) as IntegrationLike[];
  let mirrored = 0;
  for (const i of missing) {
    if (await alignLegacyChannel(prisma, i)) mirrored++;
  }
  if (mirrored > 0) await ensureDefaultPerKind(prisma, workspaceId);
  return mirrored;
}

/**
 * Keep "the first active channel of a kind is the default": for every kind
 * with no default, promote the Integration-linked active channel, else the
 * oldest active one. Never touches a kind that already has a default.
 */
export async function ensureDefaultPerKind(prisma: PrismaService, workspaceId: string): Promise<void> {
  const rows = await prisma.channel.findMany({
    where: { workspaceId, status: { not: "disconnected" } },
    orderBy: { createdAt: "asc" },
    select: { id: true, kind: true, status: true, isDefault: true, integrationId: true },
  });
  const kinds = new Set(rows.map((r) => r.kind));
  for (const kind of kinds) {
    const ofKind = rows.filter((r) => r.kind === kind);
    if (ofKind.some((r) => r.isDefault)) continue;
    const active = ofKind.filter((r) => r.status === "active");
    const pick = active.find((r) => r.integrationId) ?? active[0];
    if (!pick) continue;
    try {
      await prisma.channel.update({ where: { id: pick.id }, data: { isDefault: true } });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e; // a concurrent writer set one first
    }
  }
}
