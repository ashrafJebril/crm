import { HttpException } from "@nestjs/common";
import { LAUNCH_UNCONFIRMED, providerFailure } from "../tracking/failure-codes";
import type { LaunchJob } from "./launch-context";
import type { PartitionRow } from "./broadcast-transport";

/** Zernio keeps an Idempotency-Key 24 h; past 23 h an unconfirmed attempt is never re-sent. */
export const DIRECT_GIVE_UP_MS = 23 * 3_600_000;

/** The Idempotency-Key of one recipient row (stable across retries and resumes). */
export const directIdempotencyKey = (rowId: string) => `crm-cr-${rowId}`;

/** Zernio refused this one message (bad number, bad parameter): the row fails, the job goes on. */
const isRowRejection = (e: unknown) => e instanceof HttpException && [400, 422].includes(e.getStatus());

export interface DirectContext {
  template: { name: string; lang: string };
  headerMedia?: { link: string };
}

/**
 * One direct batch: every queued row of the partition, one
 * `POST /inbox/conversations` each, in id order.
 * - A row is claimed (`sendAttemptedAt`, compare-and-set on a null value)
 *   before its send, and sent with `Idempotency-Key: crm-cr-<rowId>`.
 * - The returned message id is stamped as `messageId` with status `sent`, so
 *   SP-12's tracker matches the webhooks at once.
 * - On resume, a claimed row without `messageId` is re-sent with the SAME
 *   key while the attempt is under 23 h old (Zernio replays the original
 *   response); past that it is marked `failed` `launch:unconfirmed` and
 *   never re-sent.
 * Sends pass the campaign bucket and the stricter direct bucket.
 */
export async function sendDirectPartition(job: LaunchJob, p: PartitionRow, ctx: DirectContext): Promise<void> {
  const { prisma, zernio } = job;
  const ws = job.workspaceId;
  let cursor: string | null = null;
  for (;;) {
    const rows = (await prisma.campaignRecipient.findMany({
      where: {
        workspaceId: ws,
        campaignId: job.campaignId,
        broadcastId: p.id,
        status: "queued",
        messageId: null,
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      orderBy: { id: "asc" },
      take: job.directPageSize,
      select: { id: true, phone: true, templateParams: true, sendAttemptedAt: true },
    })) as Array<{ id: string; phone: string; templateParams: unknown; sendAttemptedAt: Date | null }>;
    if (rows.length === 0) break;
    for (const r of rows) {
      cursor = r.id;
      const open = { id: r.id, workspaceId: ws, status: "queued", messageId: null };
      if (r.sendAttemptedAt && job.now() - r.sendAttemptedAt.getTime() >= DIRECT_GIVE_UP_MS) {
        await job.fence();
        await prisma.campaignRecipient.updateMany({ where: open, data: { status: "failed", failureCode: LAUNCH_UNCONFIRMED } });
        continue;
      }
      if (!r.sendAttemptedAt) {
        await job.fence();
        const claim = await prisma.campaignRecipient.updateMany({
          where: { ...open, sendAttemptedAt: null },
          data: { sendAttemptedAt: new Date(job.now()) },
        });
        if (claim.count === 0) continue;
      }
      let res: { messageId: string | null };
      try {
        res = await job.call(
          () =>
            zernio.sendTemplateToPhone({
              accountId: p.accountId,
              phone: r.phone,
              templateName: ctx.template.name,
              templateLanguage: ctx.template.lang,
              templateParams: Array.isArray(r.templateParams) ? (r.templateParams as string[]) : [],
              ...(ctx.headerMedia ? { headerMedia: ctx.headerMedia } : {}),
              idempotencyKey: directIdempotencyKey(r.id),
            }),
          { direct: true },
        );
      } catch (e) {
        if (!isRowRejection(e)) throw e;
        await job.fence();
        await prisma.campaignRecipient.updateMany({
          where: { id: r.id, workspaceId: ws, status: "queued" },
          data: { status: "failed", ...providerFailure((e as Error).message, null, null) },
        });
        continue;
      }
      await job.fence();
      await prisma.campaignRecipient.updateMany({
        where: { id: r.id, workspaceId: ws, status: "queued" },
        data: { status: "sent", messageId: res.messageId, sentAt: new Date(job.now()) },
      });
    }
    await job.yieldTick();
  }
  await job.updatePartition(p.id, { stage: "sent" });
  p.stage = "sent";
}
