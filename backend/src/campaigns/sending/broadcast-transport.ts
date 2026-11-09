import type { ZernioBroadcastVariable } from "../../integrations/zernio.client";
import type { LaunchJob } from "./launch-context";
import { slotKeys, type VarMap } from "./var-map";

/** A partition row as the transports read it. */
export interface PartitionRow {
  id: string;
  channelId: string | null;
  accountId: string;
  transport: string;
  stage: string;
  variables: unknown;
  importedThroughId: string | null;
  addedThroughId: string | null;
  createAttemptedAt: Date | null;
  zernioBroadcastId: string | null;
}

export interface BroadcastContext {
  profileId: string;
  campaignName: string;
  template: { name: string; lang: string };
  varMap: VarMap;
  scheduledAt: Date | null;
}

/** Drafts listed for adoption (Zernio's page). */
export const ADOPT_LIST_LIMIT = 100;

/** The name marker that lets a resumed runner find the draft it created. */
export const broadcastName = (campaignName: string, partitionId: string) => `${campaignName} · crm:${partitionId}`;

/** The partition's stored variableMapping as Zernio's ordered variable list. */
export function partitionVariables(p: Pick<PartitionRow, "variables">): ZernioBroadcastVariable[] {
  const v = (p.variables && typeof p.variables === "object" ? p.variables : {}) as Record<string, ZernioBroadcastVariable>;
  return slotKeys(v).map((k) => v[k]);
}

/**
 * One broadcast partition up to `recipients_added`:
 * - `pending → contacts_imported`: bulk contact import, keyset-paged by row
 *   id (`importedThroughId`); a repeat is harmless (Zernio skips duplicates).
 *   With `{{n}} = field.name`, the resolved name (fallback included) is what
 *   Zernio stores, so its per-recipient `{field: "name"}` matches (ruling 2).
 * - `→ created`: `createAttemptedAt` is written before the create; a resumed
 *   runner that finds it set (and no id) adopts the draft whose name carries
 *   ` · crm:<partitionId>` instead of creating a second one.
 * - `→ recipients_added`: phones keyset-paged (`addedThroughId`); Zernio
 *   counts a re-added phone as `skipped`.
 * Every Zernio call goes through `job.call` (budget + lease fence), and its
 * result is written (fenced) before the next call.
 */
export async function prepareBroadcastPartition(job: LaunchJob, p: PartitionRow, ctx: BroadcastContext): Promise<void> {
  const { prisma, zernio } = job;
  const base = { workspaceId: job.workspaceId, campaignId: job.campaignId, broadcastId: p.id, status: "queued" };
  const keys = slotKeys(ctx.varMap);
  const nameSlot = keys.findIndex((k) => ctx.varMap[k].source === "field" && (ctx.varMap[k] as { key: string }).key === "name");

  if (p.stage === "pending") {
    let cursor = p.importedThroughId;
    for (;;) {
      const rows = (await prisma.campaignRecipient.findMany({
        where: { ...base, ...(cursor ? { id: { gt: cursor } } : {}) },
        orderBy: { id: "asc" },
        take: job.importPageSize,
        select: { id: true, phone: true, contactName: true, templateParams: true },
      })) as Array<{ id: string; phone: string; contactName: string | null; templateParams: unknown }>;
      if (rows.length === 0) break;
      const contacts = rows.map((r) => {
        const params = Array.isArray(r.templateParams) ? (r.templateParams as string[]) : [];
        const name = nameSlot >= 0 && params[nameSlot] ? params[nameSlot] : r.contactName || "Customer";
        return { name, platformIdentifier: r.phone };
      });
      await job.call(() => zernio.bulkCreateContacts(ctx.profileId, p.accountId, contacts));
      cursor = rows[rows.length - 1].id;
      await job.updatePartition(p.id, { importedThroughId: cursor });
      await job.yieldTick();
    }
    await job.updatePartition(p.id, { stage: "contacts_imported" });
    p.stage = "contacts_imported";
  }

  if (p.stage === "contacts_imported") {
    const name = broadcastName(ctx.campaignName, p.id);
    let id = p.zernioBroadcastId;
    if (!id && p.createAttemptedAt) {
      const drafts = await job.call(() => zernio.listBroadcasts({ profileId: ctx.profileId, status: "draft", limit: ADOPT_LIST_LIMIT }));
      id = drafts.find((b) => b.name.endsWith(` · crm:${p.id}`))?.id ?? null;
    }
    if (!id) {
      const at = new Date(job.now());
      await job.updatePartition(p.id, { createAttemptedAt: at });
      p.createAttemptedAt = at;
      id = await job.call(() =>
        zernio.createWhatsAppBroadcast({
          profileId: ctx.profileId,
          accountId: p.accountId,
          name,
          template: { name: ctx.template.name, language: ctx.template.lang },
          variables: partitionVariables(p),
        }),
      );
    }
    await job.updatePartition(p.id, { zernioBroadcastId: id, stage: "created" });
    p.zernioBroadcastId = id;
    p.stage = "created";
  }

  if (p.stage === "created") {
    let cursor = p.addedThroughId;
    for (;;) {
      const rows = (await prisma.campaignRecipient.findMany({
        where: { ...base, ...(cursor ? { id: { gt: cursor } } : {}) },
        orderBy: { id: "asc" },
        take: job.addPageSize,
        select: { id: true, phone: true },
      })) as Array<{ id: string; phone: string }>;
      if (rows.length === 0) break;
      const bid = p.zernioBroadcastId as string;
      await job.call(() => zernio.addBroadcastRecipients(bid, rows.map((r) => r.phone)));
      cursor = rows[rows.length - 1].id;
      await job.updatePartition(p.id, { addedThroughId: cursor });
      await job.yieldTick();
    }
    await job.updatePartition(p.id, { stage: "recipients_added" });
    p.stage = "recipients_added";
  }
}

/**
 * `recipients_added → sent | scheduled`, guarded by Zernio's own status:
 * the runner reads GET /broadcasts/{id} first, and a broadcast that is no
 * longer a draft was already accepted, so it is recorded without a second
 * send. A broadcast is only ever sent from `draft` (the no-double-send
 * invariant). A `scheduledAt` already past at this point sends now.
 */
export async function sendBroadcastPartition(job: LaunchJob, p: PartitionRow, ctx: BroadcastContext): Promise<void> {
  if (p.stage !== "recipients_added" || !p.zernioBroadcastId) return;
  const bid = p.zernioBroadcastId;
  const { zernio } = job;
  const current = await job.call(() => zernio.getBroadcast(bid));
  let stage: "sent" | "scheduled";
  if (current.status !== "draft") {
    stage = current.status === "scheduled" ? "scheduled" : "sent";
  } else if (ctx.scheduledAt && ctx.scheduledAt.getTime() > job.now()) {
    const at = ctx.scheduledAt.toISOString();
    await job.call(() => zernio.scheduleBroadcast(bid, at));
    stage = "scheduled";
  } else {
    await job.call(() => zernio.sendBroadcast(bid));
    stage = "sent";
  }
  await job.updatePartition(p.id, { stage });
  p.stage = stage;
}
