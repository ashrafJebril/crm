import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { buildRecipients, chunk } from "../campaign-audience";
import { campaignError } from "../campaign-errors";
import { SKIP_CODES } from "../tracking/failure-codes";
import { streamAudience, type StreamedContact } from "./audience-stream";
import type { LaunchJob, LaunchSender } from "./launch-context";
import { campaignDirectMax, campaignMaxPartitions, partitionKey, planTransport, slotsInOrder } from "./partition";
import { assignSender, splitCounts } from "./senders";
import { type CustomDef, missingSkipCode, resolveVarMap, slotKeys, type VarMap, zernioVariableFor } from "./var-map";

/** At most this many rows per createMany (Review Focus 4). */
export const PLAN_WRITE_CHUNK = 1000;

export interface PlanInput {
  campaign: { id: string; workspaceId: string; segmentId: string | null };
  /**
   * SP-16 (F1): the audience, resolved ONCE by the runner through
   * `resolveCampaignAudience` with the plan start as `now`, so every page is
   * read with the same relative windows.
   */
  audienceWhere: Prisma.ContactWhereInput;
  senders: LaunchSender[];
  varMap: VarMap;
  defs: ReadonlyMap<string, CustomDef>;
  defIds: string[];
  lang: string;
  /** A campaign header file forces direct sends (ruling R8). */
  headerOverride: boolean;
}

export interface PlanResult {
  transport: "broadcast" | "direct";
  reachable: number;
  skipped: number;
}

/** One direct-send batch per sender. */
const directKey = (channelId: string | null) => createHash("sha256").update(JSON.stringify([channelId, "direct"])).digest("hex");

/**
 * Stage 1, plan. No external call, so an interrupted plan restarts from
 * scratch: this campaign's rows and partitions are deleted first (nothing
 * was sent: no stage past planning exists).
 *
 * The audience streams in keyset pages (`streamAudience`); each page goes
 * through `buildRecipients` (opted out, no phone, duplicate phone across
 * pages through one Set), then `resolveVarMap` (missing value → skipped
 * row `skip:missing_value:<source>.<key>`), then `assignSender` (round-robin
 * over reachable recipients in id order; skipped rows take the primary).
 * Rows are written per page with `createMany … skipDuplicates`, at most
 * PLAN_WRITE_CHUNK per call; a heartbeat compare-and-set fences each page
 * and the runner yields between pages.
 *
 * Broadcast partitions (sender + non-native values) are created as they
 * appear, up to CAMPAIGN_MAX_PARTITIONS. Past that the plan switches to
 * direct sends when the campaign is small enough (one batch per sender),
 * else fails with `campaigns.var_map_too_varied` (`campaigns.header_direct_too_large`
 * when a campaign header file forced direct sends). Zero reachable recipients
 * fails with `campaigns.no_reachable_recipients`.
 */
export async function planLaunch(job: LaunchJob, input: PlanInput): Promise<PlanResult> {
  const { prisma } = job;
  const { campaign, audienceWhere, senders, varMap, defs, defIds, lang, headerOverride } = input;
  const ws = campaign.workspaceId;
  const campaignId = campaign.id;
  if (senders.length === 0) throw campaignError("campaigns.whatsapp_not_connected");
  const primary = senders[0];
  const slots = slotsInOrder(varMap);
  const keys = slotKeys(varMap);

  await job.fence();
  await prisma.campaignRecipient.deleteMany({ where: { workspaceId: ws, campaignId } });
  await prisma.campaignBroadcast.deleteMany({ where: { workspaceId: ws, campaignId } });

  const createPartition = async (s: LaunchSender, key: string, variables: Record<string, unknown>, transport: "broadcast" | "direct") => {
    const row = await prisma.campaignBroadcast.create({
      data: {
        workspaceId: ws,
        campaignId,
        channelId: s.channelId,
        accountId: s.accountId,
        partitionKey: key,
        variables: variables as Prisma.InputJsonValue,
        transport,
      },
      select: { id: true },
    });
    return row.id as string;
  };

  // R8: one direct batch per sender, up front.
  const directBySender = new Map<string | null, string>();
  if (headerOverride) {
    for (const s of senders) directBySender.set(s.channelId, await createPartition(s, directKey(s.channelId), {}, "direct"));
  }

  const maxPartitions = campaignMaxPartitions();
  const partitions = new Map<string, { id: string; count: number }>();
  const allKeys = new Set<string>();
  let overflow = false;
  const seen = new Set<string>();
  /** Phones held by skipped rows (opted out / missing value), in case a later page reaches the same number. */
  const skippedPhones = new Set<string>();
  let reachable = 0;
  let skipped = 0;

  for await (const page of streamAudience(prisma, ws, audienceWhere, defIds, job.pageSize)) {
    await job.fence();
    const built = buildRecipients(page.contacts, seen);
    skipped += built.skipped.noPhone + built.skipped.optedOut + built.skipped.duplicate;
    const byId = new Map(page.contacts.map((c) => [c.id, c]));
    const queued: Array<Record<string, unknown>> = [];
    const left: Array<Record<string, unknown>> = [];
    const freed: string[] = [];

    for (const r of built.recipients) {
      const contact = byId.get(r.contactId as string) as StreamedContact;
      const res = resolveVarMap(varMap, { ...contact, phone: r.phone }, page.customValues.get(contact.id) ?? {}, { lang, defs });
      if (!res.ok) {
        skipped++;
        skippedPhones.add(r.phone);
        left.push({
          workspaceId: ws,
          campaignId,
          contactId: contact.id,
          channelId: primary.channelId,
          phone: r.phone,
          contactName: contact.name.trim() || null,
          status: "skipped",
          failureCode: missingSkipCode(res.missing.source, res.missing.key),
        });
        continue;
      }
      const sender = assignSender(reachable, senders);
      reachable++;
      let broadcastId: string | null = null;
      if (headerOverride) {
        broadcastId = directBySender.get(sender.channelId) ?? null;
      } else {
        const key = partitionKey(sender.channelId, res.values, slots);
        allKeys.add(key);
        let p = partitions.get(key);
        if (!p && !overflow) {
          if (partitions.size < maxPartitions) {
            const variables = Object.fromEntries(keys.map((k, i) => [k, zernioVariableFor(slots[i], res.values[i])]));
            p = { id: await createPartition(sender, key, variables, "broadcast"), count: 0 };
            partitions.set(key, p);
          } else {
            overflow = true;
          }
        }
        if (p) {
          p.count++;
          broadcastId = p.id;
        }
      }
      if (skippedPhones.has(r.phone)) freed.push(r.phone);
      queued.push({
        workspaceId: ws,
        campaignId,
        contactId: contact.id,
        channelId: sender.channelId,
        broadcastId,
        phone: r.phone,
        contactName: r.name,
        status: "queued",
        templateParams: res.values,
      });
    }
    for (const s of built.skippedRows) {
      if (s.phone) skippedPhones.add(s.phone);
      left.push({
        workspaceId: ws,
        campaignId,
        contactId: s.contactId ?? null,
        channelId: primary.channelId,
        phone: s.phone,
        contactName: s.name.trim() || null,
        status: "skipped",
        failureCode: SKIP_CODES[s.reason],
      });
    }
    // A reachable number already held by an earlier page's skipped row: that
    // row gives the number up, so (campaignId, phone) never drops a send.
    if (freed.length > 0) {
      await prisma.campaignRecipient.updateMany({
        where: { workspaceId: ws, campaignId, status: "skipped", phone: { in: freed } },
        data: { phone: null },
      });
      for (const p of freed) skippedPhones.delete(p);
    }
    for (const data of chunk([...queued, ...left], PLAN_WRITE_CHUNK)) {
      await prisma.campaignRecipient.createMany({ data: data as never, skipDuplicates: true });
    }
    await job.yieldTick();
  }

  if (reachable === 0) throw campaignError("campaigns.no_reachable_recipients");
  const kind = headerOverride
    ? planTransport({ partitions: 0, reachable, headerOverride: true })
    : planTransport({ partitions: allKeys.size, reachable });
  if (kind === "too_varied") {
    // Final review (m3): a header file forces direct sends (R8), so the cause is the audience size, not the variables.
    if (headerOverride) throw campaignError("campaigns.header_direct_too_large", { limit: campaignDirectMax(), reachable });
    throw campaignError("campaigns.var_map_too_varied", {
      partitions: allKeys.size,
      limit: campaignMaxPartitions(),
      directLimit: campaignDirectMax(),
      reachable,
    });
  }

  await job.fence();
  const counts = splitCounts(reachable, senders);
  if (kind === "direct" && !headerOverride) {
    // Too many partitions: one direct batch per sender instead.
    await prisma.campaignRecipient.updateMany({ where: { workspaceId: ws, campaignId }, data: { broadcastId: null } });
    await prisma.campaignBroadcast.deleteMany({ where: { workspaceId: ws, campaignId } });
    for (const s of senders) {
      const id = await createPartition(s, directKey(s.channelId), {}, "direct");
      directBySender.set(s.channelId, id);
      await prisma.campaignRecipient.updateMany({
        where: { workspaceId: ws, campaignId, status: "queued", channelId: s.channelId },
        data: { broadcastId: id },
      });
    }
  }
  if (kind === "direct") {
    for (let i = 0; i < senders.length; i++) {
      const id = directBySender.get(senders[i].channelId);
      if (id) await prisma.campaignBroadcast.update({ where: { id }, data: { recipientCount: counts[i] } });
    }
  } else {
    for (const p of partitions.values()) await prisma.campaignBroadcast.update({ where: { id: p.id }, data: { recipientCount: p.count } });
  }
  return { transport: kind, reachable, skipped };
}
