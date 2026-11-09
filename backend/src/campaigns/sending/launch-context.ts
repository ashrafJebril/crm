import type { PrismaService } from "../../prisma/prisma.service";
import type { ZernioClient } from "../../integrations/zernio.client";
import { campaignSender, campaignSenders } from "../../channels/default-channel";
import type { CustomDef, VarMap } from "./var-map";
import { slotKeys } from "./var-map";

/**
 * SP-13 background launch: the pieces the HTTP validation and the runner
 * share, and the job context the plan and both transports run in.
 */

/** A validated sender: the default number may have no mirrored channel (channelId null). */
export interface LaunchSender {
  channelId: string | null;
  accountId: string;
  displayName: string;
  phoneNumber: string | null;
}

/**
 * The campaign's senders: the explicit list through `campaignSenders`
 * (400 channels.sender_invalid / campaigns.too_many_senders), else the
 * default Zernio WhatsApp number (`campaignSender(…, null)`), else `[]`
 * (not connected).
 */
export async function resolveLaunchSenders(prisma: PrismaService, workspaceId: string, ids: string[]): Promise<LaunchSender[]> {
  if (ids.length > 0) return campaignSenders(prisma, workspaceId, ids);
  const def = await campaignSender(prisma, workspaceId, null);
  if (!def) return [];
  const ch = def.channelId
    ? await prisma.channel.findFirst({ where: { id: def.channelId, workspaceId }, select: { displayName: true, phoneNumber: true } })
    : null;
  return [{ channelId: def.channelId, accountId: def.accountId, displayName: ch?.displayName ?? "WhatsApp", phoneNumber: ch?.phoneNumber ?? null }];
}

/** This workspace's non-archived contact custom fields, by key. */
export async function loadCustomDefs(prisma: PrismaService, workspaceId: string): Promise<Map<string, CustomDef>> {
  const rows = (await prisma.customFieldDef.findMany({
    where: { workspaceId, entity: "contact", archivedAt: null },
    select: { id: true, key: true, label: true, labelAr: true, type: true, options: true },
  })) as CustomDef[];
  return new Map(rows.map((d) => [d.key, d]));
}

/** Def ids a map reads (only keys present in `defs`). */
export function defIdsFor(map: VarMap, defs: ReadonlyMap<string, CustomDef>): string[] {
  const keys = new Set(slotKeys(map).flatMap((k) => (map[k].source === "custom" ? [(map[k] as { key: string }).key] : [])));
  return [...keys].flatMap((k) => (defs.has(k) ? [defs.get(k)!.id] : []));
}

/**
 * Ruling 12: a text header with `{{n}}`, or a URL button with a dynamic
 * parameter, is not supported for campaigns (broadcasts fill body slots only).
 */
export function templateUnsupported(t: { headerType?: string | null; headerContent?: string | null; buttons?: string | null }): boolean {
  const placeholder = /\{\{\s*\d+\s*\}\}/;
  if ((t.headerType ?? "").toLowerCase() === "text" && placeholder.test(t.headerContent ?? "")) return true;
  if (!t.buttons) return false;
  let list: unknown;
  try {
    list = JSON.parse(t.buttons);
  } catch {
    return false;
  }
  return (
    Array.isArray(list) &&
    list.some((b) => b && typeof b === "object" && String((b as { type?: unknown }).type ?? "").toUpperCase() === "URL" && placeholder.test(String((b as { url?: unknown }).url ?? "")))
  );
}

/** The runner's lease was taken by another runner: stop, write nothing. */
export class LeaseLost extends Error {
  constructor() {
    super("campaign launch lease lost");
  }
}

/** The user cancelled the launch: clean up in Zernio, then end as cancelled. */
export class CancelRequested extends Error {
  constructor() {
    super("campaign launch cancelled");
  }
}

/** What the plan stage and the transports run with (built by the runner per run). */
export interface LaunchJob {
  prisma: PrismaService;
  zernio: ZernioClient;
  campaignId: string;
  workspaceId: string;
  /** Lease compare-and-set on `launchHeartbeatAt`; throws LeaseLost or CancelRequested. */
  fence(opts?: { allowCancel?: boolean }): Promise<void>;
  /** Budget token(s), then the fence, then the Zernio call (429s wait out Retry-After). */
  call<T>(fn: () => Promise<T>, opts?: { direct?: boolean; allowCancel?: boolean }): Promise<T>;
  /** Fenced write to one partition. */
  updatePartition(id: string, data: Record<string, unknown>, opts?: { allowCancel?: boolean }): Promise<void>;
  /** The partition being worked on (for a failure's `lastError`). */
  setPartition(id: string | null): void;
  yieldTick(): Promise<void>;
  now(): number;
  pageSize: number;
  importPageSize: number;
  addPageSize: number;
  directPageSize: number;
}
