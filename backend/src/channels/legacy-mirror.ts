import { Logger } from "@nestjs/common";
import type { PrismaService } from "../prisma/prisma.service";

/**
 * Legacy Integration → Channel mirroring.
 *
 * `main` still writes `Integration` (one row per platform per workspace). Each
 * Integration owns exactly one Channel (`integrationId`). The migration SQL
 * backfills existing rows; `ensureLegacyChannels` mirrors rows written after
 * it. Both use the SAME mapping — `channelFromIntegration` is the TS copy of
 * the SQL INSERT in 20261112120000_channels, pinned by legacy-mirror.spec.ts.
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

/**
 * Mirror every Integration of the workspace that has no Channel yet. Costs one
 * indexed query when there is nothing to do. Returns how many were created.
 */
export async function ensureLegacyChannels(prisma: PrismaService, workspaceId: string): Promise<number> {
  const missing = (await prisma.integration.findMany({
    where: { workspaceId, channel: { is: null } },
  })) as IntegrationLike[];
  let created = 0;
  for (const i of missing) {
    const row = channelFromIntegration(i);
    const hasDefault = await prisma.channel.findFirst({
      where: { workspaceId, kind: row.kind, isDefault: true },
      select: { id: true },
    });
    try {
      await prisma.channel.create({ data: { ...row, isDefault: !hasDefault } });
      created++;
      continue;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
    // A channel for the same provider account already exists (e.g. created
    // by a Zernio sync): link it instead of duplicating it.
    if (row.externalId) {
      const linked = await prisma.channel.updateMany({
        where: { workspaceId, provider: row.provider, externalId: row.externalId, integrationId: null },
        data: { integrationId: i.id },
      });
      if (linked.count > 0) continue;
    }
    // Lost a race on the one-default index (or the deterministic id): once
    // more as a non-default row, then give up quietly — the next call retries.
    try {
      await prisma.channel.create({ data: { ...row, isDefault: false } });
      created++;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      log.warn(`could not mirror integration ${i.id} (${row.kind}/${row.provider}) — will retry`);
    }
  }
  return created;
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
